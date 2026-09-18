import type { Page } from "playwright";
import type { CheckFinding } from "./types.js";

/**
 * Rendered-content checks. Every one runs against what the browser actually receives and
 * renders, never against source files: a valid content file and a green build are exactly
 * the state in which these defects ship.
 */

// -- shared text extraction ----------------------------------------------------

/** `&amp;` is applied last so a double-encoded `&amp;lt;` does not collapse into `<`. */
const NAMED_ENTITIES: [RegExp, string][] = [
  [/&nbsp;/g, " "],
  [/&quot;/g, '"'],
  [/&apos;/g, "'"],
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&amp;/g, "&"],
];

export function htmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    // Comments become nothing, not a space: React separates adjacent text nodes with
    // `<!-- -->`, so `$<!-- -->500` renders as "$500". Found on a live pricing page.
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ");

  // Numeric entities are decoded by *form*, not from an enumerated list. The list was a real
  // bug: it carried `&#39;` but not `&#x27;`, which is the form React's SSR emits for an
  // apostrophe, so every page whose copy contained one reported a false hydration diff.
  text = text.replace(/&#(x[0-9a-f]+|\d+);/gi, (whole, code: string) => {
    const point = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : parseInt(code, 10);
    return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  });

  for (const [pattern, char] of NAMED_ENTITIES) text = text.replace(pattern, char);

  return text.replace(/\s+/g, " ").trim();
}

function bodyOf(html: string): string {
  return html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
}

// -- server HTML vs hydrated DOM -------------------------------------------------

/**
 * Text a crawler reads (the served HTML) against text a visitor reads (the DOM after
 * JavaScript ran and the page settled). A difference is a hydration mismatch, content that
 * only exists client-side, or a counter that ships as "0" to every crawler.
 *
 * `warn`, not `fail`: third-party widgets legitimately inject text. Read the diff.
 */
export async function checkServerVsHydrated(page: Page, url: string, rawHtml: string): Promise<CheckFinding[]> {
  const serverText = htmlToText(bodyOf(rawHtml));
  const hydratedText = htmlToText(await page.evaluate(() => document.body.innerHTML));
  if (serverText === hydratedText) return [];

  // Name the first point of divergence rather than dumping both bodies.
  let i = 0;
  const minLen = Math.min(serverText.length, hydratedText.length);
  while (i < minLen && serverText[i] === hydratedText[i]) i++;

  return [
    {
      severity: "warn",
      check: "server-vs-hydrated-text",
      message: "Served HTML text differs from the rendered page text after JavaScript runs.",
      url,
      expected: hydratedText.slice(Math.max(0, i - 20), i + 40),
      actual: serverText.slice(Math.max(0, i - 20), i + 40),
    },
  ];
}

// -- placeholder scan -------------------------------------------------------------

const PLACEHOLDER_PATTERNS: { label: string; pattern: RegExp; severity: CheckFinding["severity"] }[] = [
  { label: "Lorem ipsum", pattern: /lorem ipsum/i, severity: "fail" },
  { label: "TBD", pattern: /\bTBD\b/, severity: "fail" },
  { label: "TODO", pattern: /\bTODO\b/, severity: "fail" },
  { label: "{{", pattern: /\{\{/, severity: "fail" },
  { label: "[object Object]", pattern: /\[object Object]/, severity: "fail" },
  { label: "NaN", pattern: /\bNaN\b/, severity: "fail" },
  // Real words on a developer-docs site, so these only warn.
  { label: "undefined", pattern: /\bundefined\b/, severity: "warn" },
  { label: "null", pattern: /\bnull\b/, severity: "warn" },
];

export function checkPlaceholders(rawHtml: string, url: string): CheckFinding[] {
  const text = htmlToText(bodyOf(rawHtml));
  const findings: CheckFinding[] = [];
  for (const { label, pattern, severity } of PLACEHOLDER_PATTERNS) {
    const match = text.match(pattern);
    if (!match || match.index === undefined) continue;
    findings.push({
      severity,
      check: "placeholder-text",
      message: `Placeholder token "${label}" found in shipped text.`,
      url,
      actual: text.slice(Math.max(0, match.index - 30), match.index + 40),
    });
  }
  return findings;
}

// -- links and anchors ------------------------------------------------------------

/** Shared across pages so a footer link is fetched once per run, not once per page. */
export type LinkCache = Map<string, number | string>;

async function probe(target: string, cache: LinkCache, timeoutMs: number): Promise<number | string> {
  const cached = cache.get(target);
  if (cached !== undefined) return cached;
  let outcome: number | string;
  try {
    const res = await fetch(target, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    outcome = res.status;
    await res.body?.cancel();
  } catch (err) {
    outcome = (err as Error).message;
  }
  cache.set(target, outcome);
  return outcome;
}

export async function checkLinks(
  page: Page,
  url: string,
  origin: string,
  cache: LinkCache,
  opts: { external: boolean; timeoutMs?: number },
): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];
  const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href") ?? ""));
  const ids = new Set(await page.$$eval("[id]", (els) => els.map((e) => e.id)));
  const seenOnPage = new Set<string>();

  for (const href of hrefs) {
    if (!href || /^(mailto|tel|sms|javascript|data):/i.test(href)) continue;
    if (seenOnPage.has(href)) continue;
    seenOnPage.add(href);

    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      if (id && id !== "top" && !ids.has(id)) {
        findings.push({
          severity: "fail",
          check: "links-and-anchors",
          message: `In-page anchor "${href}" does not resolve to any element.`,
          url,
          selector: `a[href="${href}"]`,
        });
      }
      continue;
    }

    let target: URL;
    try {
      target = new URL(href, url);
    } catch {
      findings.push({ severity: "fail", check: "links-and-anchors", message: `Malformed href "${href}".`, url });
      continue;
    }
    if (!/^https?:$/.test(target.protocol)) continue;

    const internal = target.origin === origin;
    if (!internal && !opts.external) continue;
    target.hash = "";

    const outcome = await probe(target.href, cache, opts.timeoutMs ?? 10_000);
    const ok = typeof outcome === "number" && outcome < 400;
    // Many large sites answer bots with 403/429. That is not a broken link.
    const botWall = typeof outcome === "number" && (outcome === 403 || outcome === 429 || outcome === 999);
    if (ok || (!internal && botWall)) continue;

    findings.push({
      severity: internal ? "fail" : "warn",
      check: "links-and-anchors",
      message:
        typeof outcome === "number"
          ? `Link to ${target.href} returned ${outcome}.`
          : `Link to ${target.href} failed: ${outcome}`,
      url,
      expected: "2xx/3xx",
      actual: String(outcome),
    });
  }
  return findings;
}

// -- images ------------------------------------------------------------------------

/**
 * Every `<img>` resolves and carries an `alt` attribute. An empty `alt=""` is correct for a
 * decorative image and passes; a missing attribute does not.
 */
export async function checkImages(page: Page, url: string, cache: LinkCache): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];
  const images = await page.$$eval("img", (imgs) =>
    imgs.map((img) => ({
      src: img.getAttribute("src") ?? "",
      resolved: img.currentSrc || img.src,
      hasAlt: img.hasAttribute("alt"),
      ariaHidden: img.closest("[aria-hidden='true']") !== null,
    })),
  );

  for (const img of images) {
    if (!img.hasAlt && !img.ariaHidden) {
      findings.push({
        severity: "fail",
        check: "images",
        message: `<img src="${img.src}"> has no alt attribute (use alt="" if it is decorative).`,
        url,
        selector: `img[src="${img.src}"]`,
      });
    }
    if (!img.resolved || img.resolved.startsWith("data:") || img.resolved.startsWith("blob:")) continue;
    const outcome = await probe(img.resolved, cache, 10_000);
    if (typeof outcome === "number" && outcome < 400) continue;
    findings.push({
      severity: "fail",
      check: "images",
      message: `Image ${img.resolved} ${typeof outcome === "number" ? `returned ${outcome}` : `failed: ${outcome}`}.`,
      url,
    });
  }
  return findings;
}

// -- title, meta description, one h1, unique landmarks -------------------------------

export async function checkHeadAndStructure(page: Page, url: string): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];
  const check = "title-meta-h1";
  const title = (await page.title()).trim();
  const description = (
    (await page
      .locator('meta[name="description"]')
      .first()
      .getAttribute("content", { timeout: 1000 })
      .catch(() => null)) ?? ""
  ).trim();
  const h1Count = await page.locator("h1").count();

  if (!title) findings.push({ severity: "fail", check, message: "Missing <title>.", url });
  else if (title.length > 70)
    findings.push({ severity: "warn", check, message: `<title> is ${title.length} chars; search results truncate near 60–70.`, url, actual: title });

  if (!description) findings.push({ severity: "fail", check, message: "Missing meta description.", url });
  else if (description.length > 175)
    findings.push({ severity: "warn", check, message: `Meta description is ${description.length} chars; search results truncate near 160.`, url });

  if (h1Count !== 1)
    findings.push({ severity: "fail", check, message: `Page has ${h1Count} <h1> elements, expected exactly 1.`, url });

  // A page-level <header>/<footer> rendered twice: typically a layout that renders one and a
  // content block that adds a second. Invisible to every other check. Headers and footers
  // scoped inside <article>, <section>, <aside>, <nav> or <main> are legitimate and excluded.
  const landmarks = await page.evaluate(() => {
    const scoped = "article, aside, main, nav, section";
    const count = (tag: string) => Array.from(document.querySelectorAll(tag)).filter((el) => !el.parentElement?.closest(scoped)).length;
    return { header: count("header"), footer: count("footer") };
  });
  for (const [tag, n] of Object.entries(landmarks)) {
    if (n > 1)
      findings.push({ severity: "fail", check: "duplicate-landmark", message: `Page has ${n} page-level <${tag}> elements, expected at most 1.`, url });
  }

  return findings;
}

// -- contact details match what you expect ----------------------------------------------

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
const digits = (p: string) => p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

/**
 * Opt-in: only runs when `--email` / `--phone` are passed. Any other address or number in
 * the shipped text fails: the template's demo contact, a previous client's details, a
 * staging inbox. Identity leakage is the target; absence of contact info is not policed.
 */
export function checkContactIdentity(
  rawHtml: string,
  url: string,
  expected: { emails?: string[]; phones?: string[] },
): CheckFinding[] {
  const text = htmlToText(bodyOf(rawHtml)) + " " + (rawHtml.match(/href="(mailto|tel):[^"]+"/gi) ?? []).join(" ");
  const findings: CheckFinding[] = [];

  if (expected.emails?.length) {
    const allowed = new Set(expected.emails.map((e) => e.toLowerCase()));
    for (const email of new Set(text.match(EMAIL_RE) ?? [])) {
      if (!allowed.has(email.toLowerCase()))
        findings.push({ severity: "fail", check: "contact-identity", message: `Unexpected email "${email}" in shipped page.`, url, expected: [...allowed].join(", "), actual: email });
    }
  }
  if (expected.phones?.length) {
    const allowed = new Set(expected.phones.map(digits));
    for (const phone of new Set(text.match(PHONE_RE) ?? [])) {
      if (!allowed.has(digits(phone)))
        findings.push({ severity: "fail", check: "contact-identity", message: `Unexpected phone "${phone}" in shipped page.`, url, expected: expected.phones.join(", "), actual: phone });
    }
  }
  return findings;
}
