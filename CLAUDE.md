# tasteled-qa — agent contract

Public MIT repository. Everything committed here is published.

## Publication boundary

Fixtures and examples are fictional. Never commit real client names, client copy, contact
details, local filesystem paths, or references to private repositories and planning documents.
Do not name competing site builders in docs or copy. Grep `src/ test/ *.md` before committing.

## Commands

```bash
pnpm install && npx playwright install chromium
pnpm test        # build + controls (~25s, includes one Lighthouse run)
node dist/cli.js <dir|url>
```

## Rules

- Every check needs a planted defect in `test/fixtures/fail/` and an assertion in
  `test/controls.test.mjs`. A check that cannot fail is not a guard.
- A false positive found on a real site gets a regression case in `test/fixtures/pass/`.
- `page.evaluate` callbacks ship compiled by `tsc`. Do not run the suite from source through
  tsx/esbuild: keep-names `__name` helpers break code serialized into the browser.
- Lighthouse stays in a separate, async child process (`src/lighthouse-runner.mjs`).
