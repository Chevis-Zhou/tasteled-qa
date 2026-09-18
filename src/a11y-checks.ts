import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "playwright";
import type { CheckFinding } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * The accessibility floor: axe-core on every page, Lighthouse on the pages you name.
 *
 * Lighthouse runs in a plain Node child process (`lighthouse-runner.mjs`), not in-process.
 * Two reasons, both learned the hard way:
 *
 * - Lighthouse stringifies its own gatherers and injects them into the page. Under a
 *   TypeScript loader that adds keep-names helpers (tsx/esbuild), that code throws
 *   `__name is not defined` in the browser. An unmodified Node process sidesteps it.
 * - The spawn **must be async**. When the target is served by this process's own static
 *   server, a synchronous spawn blocks the event loop, the server never answers, and
 *   Lighthouse fails with "Target closed".
 */

const LIGHTHOUSE_RUNNER = fileURLToPath(new URL("./lighthouse-runner.mjs", import.meta.url));

export interface LighthouseScores {
  accessibility: number;
  seo: number;
  bestPractices: number;
  performance: number;
}

export interface LighthouseThresholds {
  accessibility: number;
  seo: number;
  bestPractices: number;
}

/**
 * Defaults are the bar TasteLed ships client sites at. Accessibility is 100, not 90: on a
 * site built from a fixed component set, any miss is a component bug to fix once.
 * Performance is recorded and never gates: it measures the network and the machine as much
 * as the site.
 */
export const DEFAULT_THRESHOLDS: LighthouseThresholds = { accessibility: 100, seo: 95, bestPractices: 90 };

export async function runLighthouse(
  url: string,
  cdpPort: number,
  thresholds: LighthouseThresholds = DEFAULT_THRESHOLDS,
): Promise<{ scores: LighthouseScores; findings: CheckFinding[] }> {
  const { stdout } = await execFileAsync(process.execPath, [LIGHTHOUSE_RUNNER, url, String(cdpPort)], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const scores: LighthouseScores = JSON.parse(stdout);
  const findings: CheckFinding[] = [];

  const gate = (key: keyof LighthouseThresholds, label: string, severity: CheckFinding["severity"]) => {
    if (scores[key] >= thresholds[key]) return;
    findings.push({
      severity,
      check: `lighthouse-${key === "bestPractices" ? "best-practices" : key}`,
      message: `Lighthouse ${label} ${scores[key]}, required ${thresholds[key]}.`,
      url,
      expected: `>= ${thresholds[key]}`,
      actual: String(scores[key]),
    });
  };
  gate("accessibility", "accessibility", "fail");
  gate("seo", "SEO", "fail");
  gate("bestPractices", "best practices", "warn");

  return { scores, findings };
}

/** Serious and critical violations fail; moderate ones warn; minor ones are not reported. */
export async function runAxe(page: Page, url: string): Promise<CheckFinding[]> {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical" || v.impact === "moderate")
    .map((v) => ({
      severity: v.impact === "moderate" ? ("warn" as const) : ("fail" as const),
      check: "axe-core",
      message: `axe ${v.impact}: ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"}).`,
      url,
      selector: v.nodes[0]?.target.join(" "),
      expected: "no serious or critical violations",
      actual: v.id,
    }));
}
