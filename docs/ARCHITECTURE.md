# Splitdummy — Architecture

Product spec: [`splitdummy-development-handoff.md`](splitdummy-development-handoff.md) (source of truth for product rules).
Frontend brief: [`splitdummy-frontend-design-brief.md`](splitdummy-frontend-design-brief.md).
Visual design: [`../design/SplitDummy.dc.html`](../design/SplitDummy.dc.html) (original design exploration; option **1a "Paper ledger"** is the base).

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

Members: ProjectDO also holds placeholders (`kind = PLACEHOLDER`, synthetic `ph:` principal) and their 7-day email invites; invite secrets are stored hashed and leave the DO only via `DoResponse.transient`, which is never persisted. Account deletion anonymizes claimed placeholders and retired rows (`ph:retired:<principalId>:<memberId>`); invited emails are cleared on claim or removal.

Environments: `production` → `splitdummy.app`, `staging` → `staging.splitdummy.app` (`wrangler deploy --env staging`).
Resource IDs for the hosted instance live in `wrangler.jsonc`; the README explains how to deploy your own.

## Public API

Users create and revoke personal keys in Account. Keys are shown once, stored as SHA-256 hashes, expire after 90 days, and have READ or WRITE access (20 active keys per account).
`Authorization: Bearer sd_…` authenticates the existing group endpoints and `GET /api/me`; ProjectDO remains the membership/role authority. The public allowlist is in `src/shared/public-api.ts`.
Bearer authentication and scope checks run before the origin guard. Only validated keys bypass cookie CSRF checks; account/auth/key-management routes and WebSockets remain unavailable to keys.
Key creation is intentionally not automatically retried because the secret cannot be replayed. Group mutations retain existing idempotency and version checks.
Public user docs: `/docs/api`; guide for AI tools (Markdown): `/docs/api.md` (`/api/docs` redirects there); OpenAPI 3.1 schema: `/api/openapi.json` (request schemas generated from the existing Zod contracts).

## Contracts

| File | What |
|---|---|
| `src/shared/api.ts` | HTTP DTOs, zod request schemas, error codes, endpoint list, LiveMessage |
| `src/shared/money.ts` + `src/shared/money/*` | Accounting core signatures (BigInt, exact rationals) |
| `worker/do/types.ts` | Edge ↔ DO RPC (`DoRequest`/`DoResponse`/`Principal`), invite token format, outbox messages |

The web app, Worker and Durable Objects all depend on these. Extend them additively (new optional fields, new ops) rather than changing existing shapes.

## Conventions

- TypeScript strict, ESM, `@shared/*` alias → `src/shared/*`.
- Money: never `number` for amounts; bigint internally, decimal strings in JSON.
- IDs: `crypto.randomUUID()`-based with short prefixes (`p_`, `m_`, `r_`, `e_`, `i_`, `inv_`), opaque.
- Errors: `ApiErrorBody` with codes from `api.ts`; field paths for form errors.
- Tests: `npm run test:shared` (node), `npm run test:worker` (workerd via vitest-pool-workers), `npm run test:web` (jsdom).
- Dependencies: exact versions (`npm i -E`).
- `worker/worker-configuration.d.ts` is generated from `wrangler.jsonc` by `npm run cf-typegen` (runs on install and deploy); it is not committed.
- Commits: small, conventional (`feat(core): …`, `fix(do): …`, `test(edge): …`).

## Deploying

```
scripts/deploy.sh staging                  # → https://staging.splitdummy.app
scripts/deploy.sh production               # → https://splitdummy.app
scripts/deploy.sh <env> --init-secrets     # first deploy of an env: uploads TURNSTILE_SECRET from the widget via `cf`
```

The script regenerates Worker types, typechecks, builds with Vite (`CLOUDFLARE_ENV` selects the env), applies D1 migrations remotely, then deploys.
Local dev: `cp .dev.vars.example .dev.vars && npm run dev` (Turnstile test keys, devLink sign-in). UI-only: `VITE_MOCK=1 npm run dev`.
