import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "playwright";
import { settlePage } from "./settle.js";
import type { CheckFinding } from "./types.js";

/**
 * Layout assertions plus screenshots at four widths: 390 (phone), 768 (tablet),
 * 1440 (laptop) and 1920 (desktop). 1920 is there on purpose: most people building a site
 * review it on a laptop, so a `max-width` that breaks above ~1536px is invisible on the
 * machine that built it.
 *
 * Assertions gate; screenshots are evidence only. Both run against the settled page (see
 * `settle.ts`), never the freshly loaded one.
 */

export const LAYOUT_WIDTHS = [390, 768, 1440, 1920] as const;
const VIEWPORT_HEIGHT = 1000;
const MAX_PER_KIND = 20;

interface InPageLayout {
  horizontalOverflow: boolean;
  scrollWidth: number;
  clientWidth: number;
  widerThanViewport: string[];
  clippedText: string[];
  overlappingInteractive: [string, string][];
}

function evaluateLayout(page: Page, viewportWidth: number): Promise<InPageLayout> {
  return page.evaluate(
    ({ viewportWidth, max }) => {
      const describe = (el: Element) => {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : "";
        const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : "";
        return `${tag}${id}${cls}`;
      };

      const doc = document.documentElement;
      const all = Array.from(document.querySelectorAll<HTMLElement>("body *"));

      // Elements that scroll their own overflow (carousels, code blocks) are fine.
      const widerThanViewport: string[] = [];
      for (const el of all) {
        if (el.getBoundingClientRect().width <= viewportWidth + 2) continue;
        const style = getComputedStyle(el);
        if (["hidden", "scroll", "auto", "clip"].includes(style.overflowX)) continue;
        if (el.parentElement && ["hidden", "scroll", "auto", "clip"].includes(getComputedStyle(el.parentElement).overflowX)) continue;
        widerThanViewport.push(describe(el));
        if (widerThanViewport.length >= max) break;
      }

      const clippedText: string[] = [];
      for (const el of all) {
        const style = getComputedStyle(el);
        const hasOwnText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 0);
        if (!hasOwnText) continue;
        if (style.overflow !== "hidden" && style.overflowY !== "hidden") continue;
        if (style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none") continue; // intentional truncation
        // The visually-hidden-but-accessible pattern (`sr-only`: absolute, 1x1px, clipped) is
        // indistinguishable from real clipping by box size alone. Recognised by signature,
        // not class name, so non-Tailwind equivalents are excluded too.
        if (style.position === "absolute" && parseFloat(style.width) <= 1 && parseFloat(style.height) <= 1) continue;
        if (el.scrollHeight > el.clientHeight + 2) {
          clippedText.push(describe(el));
          if (clippedText.length >= max) break;
        }
      }

      const interactive = Array.from(
        document.querySelectorAll<HTMLElement>("a, button, input, select, textarea, [role='button']"),
      ).filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const style = getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      });

      // Per-line boxes, not the bounding box: an inline link that wraps onto two lines has a
      // bounding box spanning the full width of both, which "overlaps" every link beside it.
      // Found by running this against a real site whose prose links wrapped.
      const boxes = interactive.map((el) => Array.from(el.getClientRects()).filter((r) => r.width > 0 && r.height > 0));
      const overlaps = (ra: DOMRect, rb: DOMRect) => {
        const ox = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
        const oy = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
        const minArea = Math.min(ra.width * ra.height, rb.width * rb.height);
        return minArea > 0 && (ox * oy) / minArea > 0.3;
      };

      const overlapping: [string, string][] = [];
      outer: for (let i = 0; i < interactive.length; i++) {
        for (let j = i + 1; j < interactive.length; j++) {
          const a = interactive[i];
          const b = interactive[j];
          if (a.contains(b) || b.contains(a)) continue;
          if (boxes[i].some((ra) => boxes[j].some((rb) => overlaps(ra, rb)))) {
            overlapping.push([describe(a), describe(b)]);
            if (overlapping.length >= max) break outer;
          }
        }
      }

      return {
        horizontalOverflow: doc.scrollWidth > window.innerWidth + 1,
        scrollWidth: doc.scrollWidth,
        clientWidth: window.innerWidth,
        widerThanViewport,
        clippedText,
        overlappingInteractive: overlapping,
      };
    },
    { viewportWidth, max: MAX_PER_KIND },
  );
}

export async function runLayoutChecksForPage(opts: {
  page: Page;
  url: string;
  pathname: string;
  screenshotDir?: string;
  widths?: readonly number[];
}): Promise<{ findings: CheckFinding[]; screenshots: string[] }> {
  const findings: CheckFinding[] = [];
  const screenshots: string[] = [];
  if (opts.screenshotDir) fs.mkdirSync(opts.screenshotDir, { recursive: true });

  for (const width of opts.widths ?? LAYOUT_WIDTHS) {
    await opts.page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    await opts.page.goto(opts.url, { waitUntil: "load" });
    await settlePage(opts.page);

    const r = await evaluateLayout(opts.page, width);

    if (r.horizontalOverflow)
      findings.push({ severity: "fail", check: "layout-horizontal-overflow", message: `Horizontal scroll at ${width}px (page ${r.scrollWidth}px wide).`, url: opts.url });
    for (const selector of r.widerThanViewport)
      findings.push({ severity: "fail", check: "layout-wider-than-viewport", message: `Element wider than the ${width}px viewport.`, url: opts.url, selector });
    for (const selector of r.clippedText)
      findings.push({ severity: "fail", check: "layout-clipped-text", message: `Text clipped at ${width}px.`, url: opts.url, selector });
    for (const [a, b] of r.overlappingInteractive)
      findings.push({ severity: "fail", check: "layout-overlapping-controls", message: `Interactive elements overlap at ${width}px: ${a} / ${b}.`, url: opts.url, selector: `${a}, ${b}` });

    if (opts.screenshotDir) {
      const name = opts.pathname.replace(/^\/|\/$/g, "").replace(/\//g, "_") || "index";
      const shot = path.join(opts.screenshotDir, `${name}-${width}.png`);
      await opts.page.screenshot({ path: shot, fullPage: true });
      screenshots.push(shot);
    }
  }

  return { findings, screenshots };
}
