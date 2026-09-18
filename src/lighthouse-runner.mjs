/**
 * Runs one Lighthouse pass against an already-running Chromium (by CDP port) and prints the
 * category scores as JSON on stdout. Spawned by `a11y-checks.ts`; see the note there for
 * why this is a separate plain-Node process.
 *
 * Usage: node lighthouse-runner.mjs <url> <cdp-port>
 */
import lighthouse from "lighthouse";

const [, , url, portArg] = process.argv;
const port = Number(portArg);

if (!url || !Number.isFinite(port)) {
  console.error("Usage: node lighthouse-runner.mjs <url> <cdp-port>");
  process.exit(1);
}

const result = await lighthouse(url, {
  port,
  output: "json",
  logLevel: "error",
  onlyCategories: ["accessibility", "seo", "best-practices", "performance"],
});
if (!result) {
  console.error("Lighthouse produced no result.");
  process.exit(1);
}

const score = (id) => Math.round((result.lhr.categories[id]?.score ?? 0) * 100);
process.stdout.write(
  JSON.stringify({
    accessibility: score("accessibility"),
    seo: score("seo"),
    bestPractices: score("best-practices"),
    performance: score("performance"),
  }),
);
