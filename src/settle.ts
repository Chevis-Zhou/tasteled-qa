import type { Page } from "playwright";

/**
 * Brings a page to the state a visitor actually ends up looking at, before anything
 * measures or photographs it.
 *
 * Two independent staleness sources, both found by replaying a real client build:
 *
 * 1. **Scroll-triggered reveals.** Sections that animate in on `IntersectionObserver`
 *    (`whileInView` and friends) sit at `opacity: 0`, offset by their enter transform, until
 *    scrolled to. A capture taken straight after `load` showed an invisible hero headline and
 *    three empty sections on a site that rendered perfectly — and every
 *    `getBoundingClientRect()` measured geometry that never ships.
 * 2. **Count-up animations.** Stat counters animate from zero. The first "settled"
 *    screenshot still caught them mid-flight, reading "11 Topics" and "1792 Tutoring since"
 *    against real values of 12 and 2022 — numbers that exist nowhere in the content.
 *
 * Waiting on `document.getAnimations()` fixes (1) and not (2): most animation libraries
 * drive numeric counters through `requestAnimationFrame`, which never registers a WAAPI
 * `Animation`. So the settle condition is **rendered-text stability** instead. It is
 * mechanism-agnostic: counters, typewriters and staggered reveals alike, without knowing how
 * any of them work.
 *
 * Deliberately **not** done by emulating `prefers-reduced-motion`: that measures a different
 * site from the one most visitors get.
 */

/** Longest we wait for the page to stop changing before measuring it anyway. */
const SETTLE_TIMEOUT_MS = 8000;
/** Consecutive identical samples required to call it settled. */
const STABLE_SAMPLES = 3;
const SAMPLE_INTERVAL_MS = 150;

export async function settlePage(page: Page): Promise<void> {
  const viewportHeight = page.viewportSize()?.height ?? 1000;
  const pageHeight = await page.evaluate(() => document.body.scrollHeight);

  // Walk the page so every IntersectionObserver fires for real.
  for (let y = 0; y < pageHeight; y += Math.floor(viewportHeight * 0.8)) {
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await page.waitForTimeout(80);
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(120);
  await page.evaluate(() => window.scrollTo(0, 0));

  // Bounded: a permanent looping animation (a marquee, a rotating strapline) must not hang
  // the run. It measures late instead, which is what a reviewer would see anyway.
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let previous = "";
  let stable = 0;

  while (Date.now() < deadline && stable < STABLE_SAMPLES) {
    const current = await page.evaluate(() => document.body.innerText);
    stable = current === previous ? stable + 1 : 0;
    previous = current;
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }
}
