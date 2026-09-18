import type { BrowserContext } from "playwright";

/**
 * Finds the pages to check: breadth-first over same-origin links, starting at `/`. Uses the
 * rendered DOM, not the raw HTML, so client-rendered navigation is followed too.
 */

const SKIP_EXT = /\.(pdf|zip|png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mp3|xml|json|txt|css|js|woff2?)$/i;

export function normalizePath(u: URL): string {
  let p = u.pathname.replace(/\/index\.html$/, "/").replace(/\.html$/, "");
  if (p.length > 1) p = p.replace(/\/$/, "");
  return p || "/";
}

export async function discoverPages(context: BrowserContext, origin: string, maxPages: number): Promise<string[]> {
  const found: string[] = [];
  const queue = ["/"];
  const seen = new Set(queue);

  while (queue.length > 0 && found.length < maxPages) {
    const pathname = queue.shift()!;
    const page = await context.newPage();
    try {
      const res = await page.goto(origin + pathname, { waitUntil: "load" });
      if (!res || res.status() >= 400) continue; // broken links are reported by the link check
      const finalUrl = new URL(page.url());
      if (finalUrl.origin !== origin) continue;
      found.push(pathname);

      const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href));
      for (const href of hrefs) {
        let u: URL;
        try {
          u = new URL(href);
        } catch {
          continue;
        }
        if (u.origin !== origin || SKIP_EXT.test(u.pathname)) continue;
        const p = normalizePath(u);
        if (!seen.has(p)) {
          seen.add(p);
          queue.push(p);
        }
      }
    } finally {
      await page.close();
    }
  }
  return found;
}
