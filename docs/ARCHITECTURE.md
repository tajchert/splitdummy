# Splitdummy — Architecture & Workstreams

Product spec: [`splitdummy-development-handoff.md`](splitdummy-development-handoff.md) (authoritative).
Frontend brief: [`splitdummy-frontend-design-brief.md`](splitdummy-frontend-design-brief.md).
Visual design: [`../design/SplitDummy.dc.html`](../design/SplitDummy.dc.html) (Claude Design canvas export; option **1a "Paper ledger"** is the base).

## Runtime layout (single Worker, `splitdummy`)

```
browser ──HTTPS──▶ Worker (worker/index.ts, Hono)
                    ├─ static assets (Vite build of src/web, SPA fallback)
                    ├─ /api/*  auth (D1 sessions) → ProjectDO.handle(DoRequest)  [RPC]
                    ├─ /api/projects/:id/live  → WebSocket forwarded to ProjectDO.fetch
                    └─ queue consumer (splitdummy-events): directory projection + email
ProjectDO (worker/do/) — one SQLite DO per project: the ONLY accounting/permission authority
D1 (migrations/) — accounts, sessions, sign-in tokens, guest principals, project directory
R2 BACKUPS — versioned JSON exports for recovery
EMAIL (send_email) — magic links + notifications
```

Environments: `production` → `splitdummy.app`, `staging` → `staging.splitdummy.app` (`wrangler deploy --env staging`).
Account `7e814786800e88ac74b5acc9033370d4`. Resources are already created (see `wrangler.jsonc`).

## Contracts (change only with coordinator approval)

| File | What |
|---|---|
| `src/shared/api.ts` | HTTP DTOs, zod request schemas, error codes, endpoint list, LiveMessage |
| `src/shared/money.ts` + `src/shared/money/*` | Accounting core signatures (BigInt, exact rationals) |
| `worker/do/types.ts` | Edge ↔ DO RPC (`DoRequest`/`DoResponse`/`Principal`), invite token format, outbox messages |

If a contract is insufficient, extend it additively (new optional fields / new ops) and mention it in your final report.

## Workstreams & file ownership

| Workstream | Owns |
|---|---|
| **core** | `src/shared/money/**` (+ `*.test.ts`) |
| **authority** | `worker/do/**` (except `types.ts`), `test/do/**` |
| **edge** | `worker/index.ts`, `worker/routes/**`, `worker/auth/**`, `worker/queue/**`, `worker/lib/**`, `migrations/**`, `wrangler.jsonc`, `test/edge/**` |
| **web** | `index.html`, `src/web/**`, `public/**` |

`package.json`: add dependencies with `npm i -E`; keep script names stable. The coordinator resolves merge conflicts.

## Conventions

- TypeScript strict, ESM, `@shared/*` alias → `src/shared/*`.
- Money: never `number` for amounts; bigint internally, decimal strings in JSON.
- IDs: `crypto.randomUUID()`-based with short prefixes (`p_`, `m_`, `r_`, `e_`, `i_`, `inv_`), opaque.
- Errors: `ApiErrorBody` with codes from `api.ts`; field paths for form errors.
- Tests: `npm run test:shared` (node), `npm run test:worker` (workerd via vitest-pool-workers), `npm run test:web` (jsdom).
- Commits: small, conventional (`feat(core): …`, `fix(do): …`, `test(edge): …`).
