import * as fs from "node:fs";
import * as path from "node:path";
import { chromium } from "playwright";
import { DEFAULT_THRESHOLDS, runAxe, runLighthouse, type LighthouseScores, type LighthouseThresholds } from "./a11y-checks.js";
import {
  checkContactIdentity,
  checkHeadAndStructure,
  checkImages,
  checkLinks,
  checkPlaceholders,
  checkServerVsHydrated,
  type LinkCache,
} from "./content-checks.js";
import { discoverPages } from "./crawl.js";
import { LAYOUT_WIDTHS, runLayoutChecksForPage } from "./layout-checks.js";
import { writeReport } from "./report.js";
import { settlePage } from "./settle.js";
import { serveStatic, type StaticServer } from "./static-server.js";
import type { CheckFinding, CheckResult, QAResult } from "./types.js";

export type Stage = "content" | "layout" | "a11y";

export interface RunOptions {
  /** A build directory (served locally) or an http(s) URL. */
  target: string;
  /** Explicit page paths. Omit to crawl from `/`. */
  pages?: string[];
  maxPages?: number;
  stages?: Stage[];
  outDir?: string;
  screenshots?: boolean;
  widths?: readonly number[];
  checkExternalLinks?: boolean;
  /** Paths to run Lighthouse on. Default `["/"]`; `[]` disables Lighthouse. */
  lighthousePages?: string[];
  thresholds?: Partial<LighthouseThresholds>;
  expectedEmails?: string[];
  expectedPhones?: string[];
  log?: (line: string) => void;
}

export async function runQA(opts: RunOptions): Promise<{ result: QAResult; report: { html: string; json: string } | null }> {
  const log = opts.log ?? (() => {});
  const stages = new Set<Stage>(opts.stages ?? ["content", "layout", "a11y"]);
  const isUrl = /^https?:\/\//i.test(opts.target);

  let server: StaticServer | null = null;
  let origin: string;
  if (isUrl) {
    origin = new URL(opts.target).origin;
  } else {
    if (!fs.existsSync(opts.target)) throw new Error(`Target not found: ${opts.target}`);
    server = await serveStatic(opts.target);
    origin = server.url;
  }

  const cdpPort = 9222 + Math.floor(Math.random() * 1000);
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${cdpPort}`] }).catch((err: Error) => {
    if (/Executable doesn't exist|browserType\.launch/.test(err.message)) {
      throw new Error("Chromium is not installed for Playwright. Run: npx playwright install chromium");
    }
    throw err;
  });
  // A normal context, not `browser.newPage()`: axe-core opens an extra page internally, which
  // the single-owner context rejects.
  const context = await browser.newContext();

  const results: CheckResult[] = [];
  const screenshots: string[] = [];
  const outDir = path.resolve(opts.outDir ?? "qa-report");
  const cache: LinkCache = new Map();
  let pages: string[] = [];

  try {
    pages = opts.pages?.length ? opts.pages : await discoverPages(context, origin, opts.maxPages ?? 25);
    log(`${pages.length} page(s): ${pages.join(" ")}`);
    const urlOf = (p: string) => origin + (p.startsWith("/") ? p : `/${p}`);

    if (stages.has("content")) {
      const findings: CheckFinding[] = [];
      for (const p of pages) {
        log(`content  ${p}`);
        const url = urlOf(p);
        const page = await context.newPage();
        try {
          const rawHtml = await (await fetch(url)).text();
          await page.goto(url, { waitUntil: "load" });
          // A count-up caught mid-flight would read as a hydration diff.
          await settlePage(page);
          findings.push(
            ...(await checkServerVsHydrated(page, url, rawHtml)),
            ...checkPlaceholders(rawHtml, url),
            ...(await checkLinks(page, url, origin, cache, { external: opts.checkExternalLinks ?? true })),
            ...(await checkImages(page, url, cache)),
            ...(await checkHeadAndStructure(page, url)),
            ...checkContactIdentity(rawHtml, url, { emails: opts.expectedEmails, phones: opts.expectedPhones }),
          );
        } finally {
          await page.close();
        }
      }
      results.push({ check: "content", ok: !findings.some((f) => f.severity === "fail"), findings });
    }

    if (stages.has("layout")) {
      const findings: CheckFinding[] = [];
      for (const p of pages) {
        log(`layout   ${p}`);
        const page = await context.newPage();
        try {
          const r = await runLayoutChecksForPage({
            page,
            url: urlOf(p),
            pathname: p,
            screenshotDir: opts.screenshots === false ? undefined : path.join(outDir, "screenshots"),
            widths: opts.widths ?? LAYOUT_WIDTHS,
          });
          findings.push(...r.findings);
          screenshots.push(...r.screenshots);
        } finally {
          await page.close();
        }
      }
      results.push({ check: "layout", ok: !findings.some((f) => f.severity === "fail"), findings });
    }

    if (stages.has("a11y")) {
      const findings: CheckFinding[] = [];
      for (const p of pages) {
        log(`axe      ${p}`);
        const page = await context.newPage();
        try {
          await page.goto(urlOf(p), { waitUntil: "load" });
          await settlePage(page);
          findings.push(...(await runAxe(page, urlOf(p))));
        } finally {
          await page.close();
        }
      }
      const lighthouse: Record<string, LighthouseScores> = {};
      const thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
      for (const p of opts.lighthousePages ?? ["/"]) {
        log(`lighthouse ${p}`);
        const r = await runLighthouse(urlOf(p), cdpPort, thresholds);
        lighthouse[p] = r.scores;
        findings.push(...r.findings);
      }
      results.push({
        check: "accessibility",
        ok: !findings.some((f) => f.severity === "fail"),
        findings,
        evidence: Object.keys(lighthouse).length ? { lighthouse } : undefined,
      });
    }
  } finally {
    await context.close();
    await browser.close();
    await server?.close();
  }

  const result: QAResult = {
    target: isUrl ? origin : path.resolve(opts.target),
    pages,
    ranAt: new Date().toISOString(),
    results,
  };
  const report = opts.outDir === "" ? null : writeReport(result, screenshots, outDir);
  return { result, report };
}
