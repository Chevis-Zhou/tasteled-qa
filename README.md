# tasteled-qa

[![ci](https://github.com/Chevis-Zhou/tasteled-qa/actions/workflows/ci.yml/badge.svg)](https://github.com/Chevis-Zhou/tasteled-qa/actions/workflows/ci.yml)

The QA gate every [TasteLed](https://tasteled.com) client site has to pass before it goes live, packaged so you can run it on yours.

Point it at a build folder or a URL. It crawls the site, opens every page in a real browser, and gives you a verdict: **PASS**, **WARN** or **FAIL**. You also get an HTML report with full-page screenshots at four widths.

```bash
npx playwright install chromium   # once
npx tasteled-qa ./out
```

```
  ✗ placeholder-text: Placeholder token "Lorem ipsum" found in shipped text.  /pricing
  ✗ images: <img src="/team.jpg"> has no alt attribute (use alt="" if it is decorative).  /about
  ✗ layout-horizontal-overflow: Horizontal scroll at 390px (page 412px wide).  /
  ! title-meta-h1: Meta description is 210 chars; search results truncate near 160.  /

FAIL  3 failure(s), 1 warning(s)
Report: qa-report/report.html
```

## What it checks

**Content.** Checks run against what the browser receives and renders, not against your source files. A valid content file and a green build are exactly the state these defects ship in.

| Check | Fails when |
|---|---|
| `placeholder-text` | `Lorem ipsum`, `TBD`, `TODO`, `{{`, `NaN` or `[object Object]` reaches the page |
| `links-and-anchors` | An internal link returns 4xx/5xx, or `#anchor` has no matching id. External links only warn |
| `images` | An image fails to load, or has no `alt` attribute. `alt=""` passes, because that is correct for decoration |
| `title-meta-h1` | No `<title>`, no meta description, or anything other than exactly one `<h1>` |
| `duplicate-landmark` | Two page-level `<header>` or `<footer>` elements. Usually a layout and a content block both rendering one |
| `contact-identity` | With `--email`/`--phone`: any *other* address or number on the page. Catches the template's demo inbox and the last client's phone number |
| `server-vs-hydrated-text` | (warn) The served HTML says something different from the page after JavaScript runs. Hydration mismatches, client-only content, counters that ship as "0" to crawlers |

**Layout.** Four widths: 390, 768, 1440, 1920.

| Check | Fails when |
|---|---|
| `layout-horizontal-overflow` | The page scrolls sideways |
| `layout-wider-than-viewport` | An element is wider than the screen and nothing clips or scrolls it |
| `layout-clipped-text` | Text is cut off by `overflow: hidden` (intentional ellipsis and line-clamp are allowed) |
| `layout-overlapping-controls` | Two links or buttons overlap enough to steal each other's taps |

1920 is there on purpose. Most people review their site on a laptop, so a `max-width` that breaks above about 1536px never shows up on the machine that built it.

**Accessibility.**

| Check | Fails when |
|---|---|
| `axe-core` | Any serious or critical violation, on every page. Moderate ones warn |
| `lighthouse-accessibility` | Score below **100** on the homepage (configurable) |
| `lighthouse-seo` | Score below **95** |
| `lighthouse-best-practices` | (warn) Below 90 |

Performance is recorded in the report and never gates. It measures your network and your laptop as much as the site.

## Why the defaults are strict

Accessibility 100, not 90. On a site built from a fixed set of components, an accessibility miss is a component bug. Fix it once and it stays fixed on every site after. A threshold of 90 would let the same bug ship everywhere.

If that bar is wrong for your project, lower it: `--min-a11y 90 --min-seo 90`.

## What running it on real sites taught us

Every check in here found a real defect first. A few of them needed fixing themselves along the way.

- **Screenshots were lying.** Sections that fade in on scroll were photographed at `opacity: 0`: an invisible hero headline, three blank sections, on a site that rendered fine. Waiting for CSS animations to finish did not help either. The stat counters were caught mid-count, showing "11 Topics" and "1792 Tutoring since" where the content said 12 and 2022. The fix was to stop asking *how* the page animates. The tool scrolls the whole page, then waits until the visible text stops changing three samples in a row. Every check runs after that.
- **One apostrophe parked a whole site.** React renders `'` as `&#x27;`. The entity decoder knew `&#39;` and not the hex form, so every page with an apostrophe in its copy reported a false hydration mismatch. Entities are now decoded by form, and a table of escape cases is in the test suite.
- **A page shipped with two footers.** The layout rendered one and a content block added a second. Nothing caught it, because nothing counted landmarks. Now something does.
- **Wrapped links looked like overlapping buttons.** A link that wraps onto two lines has a bounding box covering the full width of both, so it "overlapped" its neighbours. We found that one by running the tool on [tasteled.com](https://tasteled.com) itself. Overlap is now measured per line box.

The test suite keeps a negative control: a fixture page with one planted defect per check. If a check stops firing on it, the build fails. A check that can't fail isn't doing anything.

## Usage

```bash
tasteled-qa <build-dir | url> [options]
```

| Option | Default | |
|---|---|---|
| `--pages / /about` | crawl from `/` | Check specific pages instead of crawling |
| `--max-pages <n>` | 25 | Crawl limit |
| `--only content,layout,a11y` | all | Run a subset |
| `--out <dir>` | `./qa-report` | Report location |
| `--widths 390,1440` | `390,768,1440,1920` | Layout widths |
| `--no-screenshots` | | Skip screenshots |
| `--no-external` | | Don't probe external links |
| `--lighthouse /,/pricing` | `/` | Pages to run Lighthouse on |
| `--no-lighthouse` | | Skip Lighthouse (axe still runs) |
| `--min-a11y <n>` / `--min-seo <n>` | 100 / 95 | Lighthouse thresholds |
| `--email <addr>` / `--phone <n>` | | Expected contact details; repeatable |
| `--strict` | | Exit 1 on warnings too |
| `--json` | | Print the result as JSON |

Exit code `0` on PASS or WARN, `1` on FAIL, `2` if the run itself crashed.

A build directory is served locally with static-host routing (`/about` → `about.html` or `about/index.html`). That covers Next.js static export, Astro, Eleventy, Vite and hand-written HTML. For server-rendered apps, start the server and pass the URL.

### In CI

```yaml
- run: npm run build
- run: npx playwright install --with-deps chromium
- run: npx tasteled-qa ./out --no-external
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: qa-report, path: qa-report }
```

### As a library

```ts
import { runQA, verdictOf } from "tasteled-qa";

const { result } = await runQA({ target: "./out", lighthousePages: [] });
console.log(verdictOf(result)); // "PASS" | "WARN" | "FAIL"
```

Each check is also exported on its own (`checkLinks`, `checkImages`, `runAxe`, `settlePage`…) if you already have a Playwright page open.

## What this is not

It is not a performance audit, a visual regression tool or a replacement for looking at your site. It checks what a machine can check reliably, so the person reviewing the site can spend their time on what a machine can't: whether the copy is right and whether the design holds up.

That second part is what [TasteLed](https://tasteled.com) sells. This part is free.

## Requirements

Node 20+. Chromium via Playwright (`npx playwright install chromium`).

## Licence

MIT. See [LICENSE](LICENSE).
