#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runQA, type Stage } from "./run.js";
import { failures, verdictOf, warnings } from "./types.js";

const HELP = `tasteled-qa: pre-launch QA gate for websites

Usage
  tasteled-qa <build-dir | url> [options]

Examples
  tasteled-qa ./out
  tasteled-qa https://example.com --pages / /about --no-lighthouse
  tasteled-qa ./dist --email hello@example.com --strict

Options
  --pages <paths...>     Pages to check (default: crawl same-origin links from /)
  --max-pages <n>        Crawl limit (default 25)
  --only <stages>        Comma list of content,layout,a11y (default: all)
  --out <dir>            Report directory (default ./qa-report)
  --widths <list>        Layout widths (default 390,768,1440,1920)
  --no-screenshots       Skip full-page screenshots
  --no-external          Do not probe external links
  --lighthouse <paths>   Comma list of pages for Lighthouse (default /)
  --no-lighthouse        Skip Lighthouse (axe-core still runs)
  --min-a11y <n>         Lighthouse accessibility threshold (default 100)
  --min-seo <n>          Lighthouse SEO threshold (default 95)
  --email <addr>         Expected contact email; any other email fails (repeatable)
  --phone <number>       Expected phone; any other phone number fails (repeatable)
  --strict               Exit non-zero on warnings, not only failures
  --json                 Print report JSON to stdout
  -h, --help             Show this help

Exit code: 0 on PASS/WARN, 1 on FAIL (or WARN with --strict), 2 on a crashed run.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pages: { type: "string", multiple: true },
    "max-pages": { type: "string" },
    only: { type: "string" },
    out: { type: "string" },
    widths: { type: "string" },
    "no-screenshots": { type: "boolean" },
    "no-external": { type: "boolean" },
    lighthouse: { type: "string" },
    "no-lighthouse": { type: "boolean" },
    "min-a11y": { type: "string" },
    "min-seo": { type: "string" },
    email: { type: "string", multiple: true },
    phone: { type: "string", multiple: true },
    strict: { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

// `--pages / /about` puts the extra paths in positionals; fold them back in.
const [target, ...extraPages] = positionals;
if (values.help || !target) {
  process.stdout.write(HELP);
  process.exit(values.help ? 0 : 2);
}

const list = (s?: string) => s?.split(",").map((x) => x.trim()).filter(Boolean);
const num = (s?: string) => (s === undefined ? undefined : Number(s));
const pages = [...(values.pages ?? []), ...extraPages];

try {
  const { result, report } = await runQA({
    target,
    pages: pages.length ? pages : undefined,
    maxPages: num(values["max-pages"]),
    stages: list(values.only) as Stage[] | undefined,
    outDir: values.out,
    widths: list(values.widths)?.map(Number),
    screenshots: !values["no-screenshots"],
    checkExternalLinks: !values["no-external"],
    lighthousePages: values["no-lighthouse"] ? [] : list(values.lighthouse),
    thresholds: {
      ...(values["min-a11y"] ? { accessibility: Number(values["min-a11y"]) } : {}),
      ...(values["min-seo"] ? { seo: Number(values["min-seo"]) } : {}),
    },
    expectedEmails: values.email,
    expectedPhones: values.phone,
    log: values.json ? undefined : (line) => process.stderr.write(`  ${line}\n`),
  });

  const verdict = verdictOf(result);
  const fails = failures(result);
  const warns = warnings(result);

  if (values.json) {
    process.stdout.write(JSON.stringify({ verdict, ...result }, null, 2) + "\n");
  } else {
    for (const f of fails) process.stdout.write(`  ✗ ${f.check}: ${f.message}${f.url ? `  ${f.url}` : ""}\n`);
    for (const w of warns) process.stdout.write(`  ! ${w.check}: ${w.message}${w.url ? `  ${w.url}` : ""}\n`);
    process.stdout.write(`\n${verdict}  ${fails.length} failure(s), ${warns.length} warning(s)\n`);
    if (report) process.stdout.write(`Report: ${report.html}\n`);
  }

  process.exit(verdict === "FAIL" || (values.strict && verdict === "WARN") ? 1 : 0);
} catch (err) {
  process.stderr.write(`tasteled-qa: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
