# Splitdummy — Architecture & Workstreams

Product spec: [`splitdummy-development-handoff.md`](splitdummy-development-handoff.md) (authoritative).
Frontend brief: [`splitdummy-frontend-design-brief.md`](splitdummy-frontend-design-brief.md).
Visual design: [`../design/SplitDummy.dc.html`](../design/SplitDummy.dc.html) (Claude Design canvas export; option **1a "Paper ledger"** is the base).

## Runtime layout (single Worker, `splitdummy`)

```
browser ──HTTPS──▶ Worker (worker/index.ts, Hono)
                    ├─ static assets (Vite build of src/web, SPA fallback)
                    ├─ /api/*  auth (D1 sessions or personal API keys) → ProjectDO.handle(DoRequest)  [RPC]
                    ├─ /api/projects/:id/live  → WebSocket forwarded to ProjectDO.fetch
                    └─ queue consumer (splitdummy-events): directory projection + email
ProjectDO (worker/do/) — one SQLite DO per project: the ONLY accounting/permission authority
D1 (migrations/) — accounts, sessions, API key hashes, sign-in tokens, guest principals, project directory
R2 BACKUPS — versioned JSON exports for recovery
EMAIL (send_email) — magic links + notifications
```

Environments: `production` → `splitdummy.app`, `staging` → `staging.splitdummy.app` (`wrangler deploy --env staging`).
Account `7e814786800e88ac74b5acc9033370d4`. Resources are already created (see `wrangler.jsonc`).

## Public API

Users create and revoke personal keys in Account. Keys are shown once, stored as SHA-256 hashes, expire after 90 days, and have READ or WRITE access (20 active keys per account).
`Authorization: Bearer sd_…` authenticates the existing group endpoints and `GET /api/me`; ProjectDO remains the membership/role authority. The public allowlist is in `src/shared/public-api.ts`.
Bearer authentication and scope checks run before the origin guard. Only validated keys bypass cookie CSRF checks; account/auth/key-management routes and WebSockets remain unavailable to keys.
Key creation is intentionally not automatically retried because the secret cannot be replayed. Group mutations retain existing idempotency and version checks.
Public user docs: `/docs/api`; machine-readable guide: `/api/docs`; OpenAPI 3.1 schema: `/api/openapi.json` (request schemas generated from the existing Zod contracts).

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

## Deploying

```
scripts/deploy.sh staging                  # → https://staging.splitdummy.app
scripts/deploy.sh production               # → https://splitdummy.app
scripts/deploy.sh <env> --init-secrets     # first deploy of an env: uploads TURNSTILE_SECRET from the widget via `cf`
```

The script typechecks, builds with Vite (`CLOUDFLARE_ENV` selects the env), applies D1 migrations remotely, then deploys.
Local dev: `cp .dev.vars.example .dev.vars && npm run dev` (Turnstile test keys, devLink sign-in). UI-only: `VITE_MOCK=1 npm run dev`.
