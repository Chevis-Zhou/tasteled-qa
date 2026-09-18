// Positive and negative controls. A check that cannot fail is not a check: the negative
// fixture plants one defect per check, and this test asserts every one of them is caught.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { htmlToText, runQA, verdictOf } from "../dist/index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const out = () => mkdtempSync(path.join(tmpdir(), "tasteled-qa-"));

test("htmlToText decodes every entity form React and others emit", () => {
  const cases = [
    ["USF&#x27;s", "USF's"],
    ["USF&#39;s", "USF's"],
    ["USF&#039;s", "USF's"],
    ["Founder &amp; tutor", "Founder & tutor"],
    ["&amp;lt;", "&lt;"],
    ["a&nbsp;b", "a b"],
    ["<p>x</p><script>var y</script>", "x"],
    ["&#x1F600;", "😀"],
    ["$<!-- -->500", "$500"],
  ];
  for (const [input, expected] of cases) assert.equal(htmlToText(input), expected, input);
});

test("positive control passes, including Lighthouse at the default bar", { timeout: 180_000 }, async () => {
  const { result } = await runQA({
    target: path.join(fixtures, "pass"),
    outDir: out(),
    widths: [390, 1440],
    checkExternalLinks: false,
  });
  const fails = result.results.flatMap((r) => r.findings.filter((f) => f.severity === "fail"));
  assert.deepEqual(fails, []);
  assert.deepEqual([...result.pages].sort(), ["/", "/about"]);
  assert.notEqual(verdictOf(result), "FAIL");
});

test("negative control trips every planted defect", { timeout: 180_000 }, async () => {
  const { result } = await runQA({
    target: path.join(fixtures, "fail"),
    outDir: out(),
    widths: [390],
    lighthousePages: [],
    checkExternalLinks: false,
    expectedEmails: ["hello@client.example"],
    expectedPhones: ["703-555-0100"],
  });
  assert.equal(verdictOf(result), "FAIL");
  const fired = new Set(result.results.flatMap((r) => r.findings.filter((f) => f.severity === "fail").map((f) => f.check)));
  for (const check of [
    "placeholder-text",
    "links-and-anchors",
    "images",
    "title-meta-h1",
    "duplicate-landmark",
    "contact-identity",
    "layout-horizontal-overflow",
    "layout-overlapping-controls",
    "axe-core",
  ]) {
    assert.ok(fired.has(check), `expected "${check}" to fail; fired: ${[...fired].join(", ")}`);
  }
});
