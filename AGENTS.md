# AGENTS.md

Guide for AI coding agents working in this repo. Humans: see `CONTRIBUTING.md`.

## What this is

Splitdummy is an expense-splitting web app. One Cloudflare Worker (Hono, TypeScript strict, ESM) serves a React / Vite SPA and its API; each group is one SQLite Durable Object, the only accounting and permission authority, while D1 holds accounts, sessions and the group directory. Read `docs/ARCHITECTURE.md` for the full picture and `docs/splitdummy-development-handoff.md` for the product rules.

## Layout

| Path | What |
|---|---|
| `src/shared/` | Contracts used by web and worker: `api.ts` (zod schemas, DTOs, error codes), `money/*` (bigint accounting core) |
| `src/web/` | React SPA: `pages/`, `components/`, `lib/`, `api/` (`http.ts` real client, `mock.ts` in-memory mock), `state/`, `styles/` |
| `worker/` | Worker: `routes/` (HTTP), `auth/`, `lib/`, `do/` (Durable Object, with `ops/`), `queue/` |
| `test/do/`, `test/edge/` | Worker tests, run in workerd |
| `migrations/` | D1 migrations |
| `scripts/deploy.sh` | Deploy wrapper (`production`, `staging`) |
| `docs/` | Architecture, product spec, design notes |

## Commands

| Purpose | Command |
|---|---|
| Install (postinstall runs `npm run cf-typegen`, which generates the gitignored `worker/worker-configuration.d.ts`; typecheck fails without it) | `npm ci` |
| Dev server (full stack; copy `.dev.vars.example` to `.dev.vars` first) | `npm run dev` |
| SPA against the in-memory mock API, no Worker runtime | `VITE_MOCK=1 npm run dev` |
| Typecheck | `npm run typecheck` |
| All tests | `npm test` |
| Shared tests (node) | `npm run test:shared` |
| Web tests (jsdom) | `npm run test:web` |
| Worker tests (workerd) | `npm run test:worker` |
| One web file | `npx vitest run --project web src/web/lib/entryForm.test.ts` |
| One worker file | `npx vitest run --project worker test/do/settlement.test.ts` |
| Apply D1 migrations locally | `npm run db:migrate:local` |
| Production build | `npm run build` |

Typecheck and the relevant tests must pass before every commit. Run only the file or project you touched while iterating; run the full `npm test` before finishing. Deploy scripts (`npm run deploy`, `npm run deploy:staging`) are never run unless the maintainer asks.

## Conventions

- TypeScript strict, ESM. `@shared/*` → `src/shared/*`.
- Money is never a `number`: bigint internally, decimal strings in JSON.
- IDs are opaque `crypto.randomUUID()`-based values with short prefixes (`p_`, `m_`, `r_`, `e_`, `i_`, `inv_`).
- Errors use `ApiErrorBody` with codes from `api.ts`, and field paths for form errors.
- Shared contracts (`src/shared/api.ts`, `worker/do/types.ts`) are extended additively: new optional fields, new ops. Do not change existing shapes.
- Dependencies use exact pins: `npm i -E`.
- No linter or formatter. Match the surrounding style (2 spaces, double quotes, semicolons, trailing commas; long lines are normal). Do not reformat lines you are not changing.
- Logs never contain tokens, cookies, emails, names, amounts or payloads (`worker/lib/log.ts`).
- Secrets live in `.dev.vars` (gitignored; template in `.dev.vars.example`). Never print, log or commit them.
- Comments are short and explain why. No comment that only restates the code.
- Commits: small, conventional, imperative (`feat(web): …`, `fix(do): …`, `docs: …`), no trailing period.

## Testing notes

- Web tests run against the in-memory mock API: `createMockApi()` in `src/web/api/mock.ts`. Import the storage shim first (`src/web/test/storage.ts`), because Node 25+ exposes a global `localStorage` that is undefined unless `--localstorage-file` is set.
- When a web-facing API behaviour changes in the worker, change `mock.ts` to match, or the mock drifts from the real API.
- Worker tests run in workerd via vitest-pool-workers. Helpers: `test/edge/helpers.ts` (HTTP calls, sign-in) and `test/do/helpers.ts` (Durable Object tests).

## Worktrees

`.worktrees/` is gitignored. A fresh worktree needs its own `npm ci` before typecheck or tests will run.
