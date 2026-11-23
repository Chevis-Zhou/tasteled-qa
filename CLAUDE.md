# tasteled-qa — agent contract

Public MIT repository. Everything committed here is published.

## Map

| Path | What lives there |
|---|---|
| `src/index.ts` | Package entry (public API) |
| `src/cli.ts` | `tasteled-qa` CLI |
| `src/run.ts` | Orchestrates browser, stages and report |
| `src/crawl.ts`, `src/static-server.ts` | Page discovery; static server for directory targets |
| `src/content-checks.ts`, `src/layout-checks.ts`, `src/a11y-checks.ts` | The checks |
| `src/lighthouse-runner.mjs` | Lighthouse in a child process (copied to `dist/` by build) |
| `src/report.ts`, `src/settle.ts`, `src/types.ts` | Report writer, page settling, shared types |
| `test/controls.test.mjs` | Controls: each check against planted-defect fixtures |
| `test/fixtures/fail/`, `test/fixtures/pass/` | Planted defects; false-positive regressions |

## Commands

```bash
pnpm install && npx playwright install chromium
pnpm typecheck
pnpm lint
pnpm test        # build + controls (~25s, includes one Lighthouse run)
node dist/cli.js <dir|url>
```

## Seams / contracts

```seams
module qa src/index.ts
```

## Settled

### Publication boundary

Fixtures and examples are fictional. Never commit real client names, client copy, contact
details, local filesystem paths, or references to private repositories and planning documents.
Do not name competing site builders in docs or copy. Grep `src/ test/ *.md` before committing.

### Rules

- Every check needs a planted defect in `test/fixtures/fail/` and an assertion in
  `test/controls.test.mjs`. A check that cannot fail is not a guard.
- A false positive found on a real site gets a regression case in `test/fixtures/pass/`.
- `page.evaluate` callbacks ship compiled by `tsc`. Do not run the suite from source through
  tsx/esbuild: keep-names `__name` helpers break code serialized into the browser.
- Lighthouse stays in a separate, async child process (`src/lighthouse-runner.mjs`).
