# Members: placeholders, email invites, verified link joins — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners can add named placeholders, invite people by email (7-day invite that claims the placeholder and verifies the email), rename anyone, and lock self-renaming. Link joins require a verified email. Two Settings UI bugs are fixed.

**Architecture:** ProjectDO stays the only authority. Placeholders are ordinary `members` rows with `kind = 'PLACEHOLDER'` and a synthetic `principal_id = 'ph:<memberId>'`. A claim rewrites that column to the real principal, so expenses and transfers carry over. Email-invite secrets are generated in `ProjectDO.prepare()`, like link invites, and stored as SHA-256. The raw URL leaves the DO only in a new `DoResponse.transient` field, which is never written to the idempotency table. The edge sends the email and drops it. Link joins reuse the existing magic-link sign-in, and the Join page finishes the join automatically on return.

**Tech Stack:** Cloudflare Workers + Hono (edge), Durable Objects with SQLite (`worker/do`), D1, zod contracts in `src/shared/api.ts`, React + react-router SPA (`src/web`), vitest (projects `shared`, `worker`, `web`).

**Spec:** `docs/superpowers/specs/2026-10-05-members-placeholders-invites-design.md`

## Global Constraints

- Contracts change additively only (`src/shared/api.ts`, `worker/do/types.ts`); DO schema migrations are append-only (`worker/do/schema.ts`).
- Email invite TTL is exactly 7 days: `MEMBER_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000`. Link invites keep `INVITE_TTL_MS` (14 days).
- The raw invite secret is never persisted (not in `members`, `idempotency`, audit, or logs) and never logged.
- `invitedEmail` reaches browsers only in the owner's project view. It is never in history/audit details or the public preview.
- The Join button label is "Join". The words "Join as guest" must not appear anywhere in `src/web`.
- Placeholders never appear in readiness lists, the D1 directory, or notification recipients.
- Money/accounting code is untouched. Claiming a placeholder keeps its member id.
- Commits: small conventional commits (`feat(do): …`, `feat(edge): …`, `feat(web): …`, `fix(web): …`, `test(...)`). End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test commands: `npx vitest run --project worker <file>`, `npx vitest run --project web <file>`, full suite `npx vitest run`, types `npx tsc -b`. The baseline is 479 passing tests and a clean `tsc -b`.

## Review Focus

1. **Replayed add/invite request.** When a request with the same Idempotency-Key is replayed, it must not resend the email or expose the URL, and must answer `emailSent: null`. Covered in Task 3 (DO stores no `transient`) and Task 5 (edge replay test).
2. **Old link after resend.** After a resend, the previous link must stop working. Covered in Task 3 ("resend rotates the secret").
3. **Claiming while removed.** If the accepting account previously joined and was removed, the claim must succeed instead of hitting the `principal_id` UNIQUE constraint. Covered in Task 3 ("re-claim after removal").
4. **Auto-join loop.** On returning from the magic link, auto-join must submit exactly once, even with React StrictMode double effects or a refresh. Covered in Task 8 (single-submit test).
5. **Owner acting for a claimed member.** Once a placeholder is claimed, the owner can no longer act for it in settlement. Covered in Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/api.ts` (modify) | DTO fields, new schemas/DTOs/error codes/endpoints, `next` max 500 |
| `worker/do/types.ts` (modify) | new DoOps, `DoResponse.transient`, `MemberInviteMail` |
| `worker/do/schema.ts` (modify) | migration #3 |
| `worker/do/limits.ts` (modify) | `MEMBER_INVITE_TTL_MS` |
| `worker/do/store.ts` (modify) | row fields, `PLACEHOLDER_PREFIX`, `isPlaceholderPrincipal` |
| `worker/do/views.ts` (modify) | `memberDto`/`projectDto` new fields, readiness excludes placeholders |
| `worker/do/ops/members.ts` (**create**) | addMember, renameMember, inviteMember, cancelMemberInvite, previewMemberInvite, acceptMemberInvite, claimPlaceholder |
| `worker/do/ops/project.ts` (modify) | rename lock in `renameMe`, `membersCanRename` in `updateSettings`, join claims invited placeholder |
| `worker/do/ops/settlement.ts` (modify) | owner acts on behalf of placeholders |
| `worker/do/tx.ts` (modify) | directory/notify skip `ph:` principals |
| `worker/do/ProjectDO.ts` (modify) | dispatch new ops, prepare secrets, strip `transient` from idempotency record |
| `worker/lib/email.ts` (modify) | `memberInviteEmail` |
| `worker/lib/errors.ts` (modify) | statuses for `EMAIL_REQUIRED`, `ALREADY_MEMBER` |
| `worker/routes/members.ts` (**create**) | add/invite routes that email; member-invite preview/accept |
| `worker/routes/projects.ts` (modify) | generic routes for renameMember, cancelMemberInvite |
| `worker/routes/invitations.ts` (modify) | join requires verified email; no guest creation, no Turnstile |
| `worker/routes/openapi.ts` (modify) | document new fields/ops |
| `worker/auth/principals.ts` (modify) | drop unused `deleteGuest` |
| `worker/index.ts` (modify) | mount `memberRoutes` before `projectRoutes` |
| `test/do/members.test.ts` (**create**) | DO tests for placeholders/invites/rename/settlement |
| `test/edge/members.test.ts` (**create**) | edge tests for email + accept + join gate |
| `test/edge/helpers.ts` + existing edge tests (modify) | `guestSession()`; tests that joined as guests |
| `src/web/api/types.ts`, `http.ts`, `mock.ts` (modify) | client surface + mock |
| `src/web/pages/Join.tsx` (modify) | verified join + email-link flow + auto-join |
| `src/web/pages/Invite.tsx` (**create**) | accept an email invite |
| `src/web/App.tsx` (modify) | `/invite` route |
| `src/web/pages/group/MembersCard.tsx` (**create**) | Members card (moved out of Settings) + add/manage dialogs + rename toggle |
| `src/web/pages/group/Settings.tsx` (modify) | use MembersCard; YourName lock; Save alignment |
| `src/web/pages/group/parts.tsx` (modify) | placeholder tag in `Who`; owner task cards for placeholders |
| `src/web/styles/pages.css`, `components.css` (modify) | chips, inline-form alignment, select fix |
| `src/web/pages/Join.test.tsx`, `Invite.test.tsx`, `group/MembersCard.test.tsx` (**create**) | web tests |

---

### Task 1: Contracts, DO schema and DTO mapping

**Files:**
- Modify: `src/shared/api.ts` (MemberDTO ~L124, ProjectDTO ~L240, error codes L32-54, RequestSignInSchema ~L335, UpdateSettingsSchema, ENDPOINTS ~L465)
- Modify: `worker/do/types.ts`, `worker/do/schema.ts`, `worker/do/limits.ts`, `worker/do/store.ts`, `worker/do/views.ts`, `worker/lib/errors.ts`, `worker/routes/openapi.ts`
- Modify: `src/web/api/mock.ts` (member/project literals only, so `tsc` stays green)
- Test: `test/do/members.test.ts` (create)

**Interfaces:**
- Produces (used by every later task):
  - `MemberDTO.kind: "PERSON" | "PLACEHOLDER"`, `inviteState: "INVITED" | "INVITE_EXPIRED" | null`, `inviteExpiresAt: string | null`, `invitedEmail?: string | null`
  - `ProjectDTO.membersCanRename: boolean`
  - `AddMemberSchema`, `InviteMemberSchema`, `AcceptMemberInviteSchema`, `MemberInvitePreviewDTO`, `AddMemberResultDTO`
  - `ApiErrorCode` gains `"EMAIL_REQUIRED" | "ALREADY_MEMBER"`
  - `ENDPOINTS.addMember | renameMember | inviteMember | cancelMemberInvite | previewMemberInvite | acceptMemberInvite`
  - `DoOp` gains the same six names. `DoResponse.transient?: DoTransient`. `MemberInviteMail`.
  - `store.ts`: `PLACEHOLDER_PREFIX = "ph:"`, `isPlaceholderPrincipal(id: string): boolean`, `MemberRow.kind/invited_email/invite_secret_hash/invite_sent_at/invite_expires_at`, `ProjectRow.members_can_rename`
  - `views.ts`: `memberDto(m, p, referenced, viewerIsOwner = false, now = new Date().toISOString())`
  - `limits.ts`: `MEMBER_INVITE_TTL_MS`

- [ ] **Step 1: Write the failing test**

Create `test/do/members.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createGroup } from "./helpers";

describe("member contract defaults", () => {
  it("existing members are PERSONs without invites; renaming is allowed by default", async () => {
    const g = await createGroup({ members: 1 });
    const view = await g.owner.view();
    expect(view.project.membersCanRename).toBe(true);
    for (const m of view.members) {
      expect(m).toMatchObject({ kind: "PERSON", inviteState: null, inviteExpiresAt: null, invitedEmail: null });
    }
    const bobView = await g.members[0]!.view();
    expect("invitedEmail" in bobView.members[0]!).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project worker test/do/members.test.ts`
Expected: FAIL. `membersCanRename` is `undefined`.

- [ ] **Step 3: Implement the contracts**

`src/shared/api.ts`. Add to `ApiErrorCode` after `"SIGNIN_LINK_INVALID"`:

```ts
  | "SIGNIN_LINK_INVALID"
  /** Joining by link needs a signed-in account with a verified email. */
  | "EMAIL_REQUIRED"
  /** Accepting an email invite while already in the group under another identity. */
  | "ALREADY_MEMBER";
```

Extend `MemberDTO` (after `accountDeleted`):

```ts
  /** PLACEHOLDER: added by the owner by name; no account until someone claims it through an email invite. */
  kind: "PERSON" | "PLACEHOLDER";
  /** Placeholders with an email invite: INVITED until it expires, then INVITE_EXPIRED. */
  inviteState: "INVITED" | "INVITE_EXPIRED" | null;
  inviteExpiresAt: string | null;
  /** Owner view only (absent for everyone else). */
  invitedEmail?: string | null;
```

Extend `ProjectDTO` (after `multiCurrencyEnabled`):

```ts
  /** When false only the owner changes display names (renameMe is 403 for others). */
  membersCanRename: boolean;
```

In `RequestSignInSchema` change `next: z.string().regex(/^\/[^/]/).max(200).optional()` to `.max(500)`.

In `UpdateSettingsSchema` add `membersCanRename: z.boolean().optional(),`.

After `TransferOwnershipSchema` add:

```ts
const InviteEmailSchema = z.string().trim().toLowerCase().email("Enter an email address like name@example.com").max(254);

/** POST /api/projects/:projectId/members → 201 AddMemberResultDTO. Owner only; email sends a 7-day invite. */
export const AddMemberSchema = z.object({ displayName: DisplayNameSchema, email: InviteEmailSchema.optional() });
/** POST /api/projects/:projectId/members/:memberId/invite → AddMemberResultDTO. Attach an email or resend (new link). */
export const InviteMemberSchema = z.object({ email: InviteEmailSchema });
/** POST /api/member-invites/accept → JoinResultDTO + session cookie for the invited email's account. */
export const AcceptMemberInviteSchema = z.object({
  token: z.string().min(16).max(200),
  displayName: DisplayNameSchema.optional(),
});

/** GET /api/member-invites/:token (public; never includes the invited email). */
export interface MemberInvitePreviewDTO {
  projectName: string;
  baseCurrency: string;
  /** The placeholder's current name. */
  displayName: string;
  status: "OPEN" | "EXPIRED" | "CLAIMED";
  /** Whether the invitee may change the name while accepting. */
  canRename: boolean;
  alreadyMemberProjectId: string | null;
}

export interface AddMemberResultDTO extends MemberDTO {
  /** null when no email was involved or this was a replay; false when sending failed (owner can resend). */
  emailSent: boolean | null;
  /** Local dev only: the invite link, since there may be no inbox. */
  devLink?: string;
}
```

In `ENDPOINTS` after `removeMember`:

```ts
  addMember: "POST /api/projects/:projectId/members", // -> 201 AddMemberResultDTO
  renameMember: "PATCH /api/projects/:projectId/members/:memberId/name", // -> MemberDTO (owner)
  inviteMember: "POST /api/projects/:projectId/members/:memberId/invite", // -> AddMemberResultDTO
  cancelMemberInvite: "DELETE /api/projects/:projectId/members/:memberId/invite", // -> MemberDTO
  previewMemberInvite: "GET /api/member-invites/:token", // -> MemberInvitePreviewDTO
  acceptMemberInvite: "POST /api/member-invites/accept", // -> JoinResultDTO
```

`worker/lib/errors.ts` `DEFAULT_STATUS`: add `EMAIL_REQUIRED: 401, ALREADY_MEMBER: 409,`.

`worker/do/types.ts`: add to `DoOp` before `"principalUpdated"`:

```ts
  | "addMember" // owner; body AddMemberSchema; prepared secret used only when body.email is set
  | "renameMember" // owner; params.memberId; body RenameMemberSchema
  | "inviteMember" // owner; params.memberId (a placeholder); body InviteMemberSchema; rotates the secret
  | "cancelMemberInvite" // owner; params.memberId
  | "previewMemberInvite" // read; principal may be null; params.tokenSecret; transient.invitedEmail for the edge
  | "acceptMemberInvite" // principal = the invited email's account; params.tokenSecret; body { displayName? }
```

and replace `DoResponse` with:

```ts
/** Invitation email the edge sends after an addMember/inviteMember commit. */
export interface MemberInviteMail {
  to: string;
  /** `${APP_ORIGIN}/invite#${projectId}.${secret}` — carries the raw secret. */
  url: string;
  projectName: string;
  inviterName: string;
  displayName: string;
  expiresAt: string;
}

/** Edge-only data. Never stored with the idempotency record, never returned to browsers. */
export interface DoTransient {
  inviteMail?: MemberInviteMail;
  /** previewMemberInvite: the address the invite was sent to. */
  invitedEmail?: string;
}

export interface DoResponse {
  status: number;
  /** JSON-serializable body (ApiErrorBody on error), or a string for CSV. */
  body: unknown;
  headers?: Record<string, string>;
  transient?: DoTransient;
}
```

`worker/do/schema.ts`: append a third migration string to `MIGRATIONS`:

```ts
  `
  ALTER TABLE members ADD COLUMN kind TEXT NOT NULL DEFAULT 'PERSON';
  ALTER TABLE members ADD COLUMN invited_email TEXT;
  ALTER TABLE members ADD COLUMN invite_secret_hash TEXT;
  ALTER TABLE members ADD COLUMN invite_sent_at TEXT;
  ALTER TABLE members ADD COLUMN invite_expires_at TEXT;
  CREATE UNIQUE INDEX members_invite_secret ON members(invite_secret_hash) WHERE invite_secret_hash IS NOT NULL;
  ALTER TABLE project ADD COLUMN members_can_rename INTEGER NOT NULL DEFAULT 1;
  `,
```

`worker/do/limits.ts` append:

```ts
/** Email invitations to a placeholder. */
export const MEMBER_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
```

`worker/do/store.ts`: add `members_can_rename: number;` to `ProjectRow`. Add to `MemberRow`:

```ts
  kind: "PERSON" | "PLACEHOLDER";
  invited_email: string | null;
  invite_secret_hash: string | null;
  invite_sent_at: string | null;
  invite_expires_at: string | null;
```

and above `MemberStatus`:

```ts
/** Synthetic principal for members without an account (placeholders, retired identities). Never a real login. */
export const PLACEHOLDER_PREFIX = "ph:";
export const isPlaceholderPrincipal = (principalId: string) => principalId.startsWith(PLACEHOLDER_PREFIX);
```

`worker/do/views.ts`: in `projectDto` add `membersCanRename: p.members_can_rename === 1,` after `multiCurrencyEnabled`. Replace `memberDto`:

```ts
export function memberDto(m: MemberRow, p: ProjectRow, referenced: boolean, viewerIsOwner = false, now = new Date().toISOString()): MemberDTO {
  const placeholder = m.kind === "PLACEHOLDER";
  const invited = placeholder && m.invited_email !== null && m.invite_expires_at !== null;
  return {
    id: m.id,
    displayName: m.display_name,
    isOwner: p.owner_member_id === m.id,
    isGuest: m.is_guest === 1,
    hasRecoverableAccount: m.has_recoverable_account === 1,
    joinedAt: m.joined_at,
    status: m.status,
    referenced,
    accountDeleted: m.account_deleted === 1,
    kind: m.kind,
    inviteState: invited ? (Date.parse(m.invite_expires_at!) > Date.parse(now) ? "INVITED" : "INVITE_EXPIRED") : null,
    inviteExpiresAt: invited ? m.invite_expires_at : null,
    ...(viewerIsOwner ? { invitedEmail: placeholder ? m.invited_email : null } : {}),
  };
}
```

In `projectView` change the members line to `members: store.members().map((m) => memberDto(m, project, referenced.has(m.id), isOwner)),`.

`worker/routes/openapi.ts`: add `membersCanRename: z.boolean()` to `project`. Extend `member` with `kind: z.enum(["PERSON", "PLACEHOLDER"]), inviteState: z.enum(["INVITED", "INVITE_EXPIRED"]).nullable(), inviteExpiresAt: nullableText, invitedEmail: nullableText.optional()`. Add `operations` entries:

```ts
  addMember: { summary: "Add a person by name", description: "Owner only. With an email, sends a 7-day invitation that lets them claim this spot.", body: api.AddMemberSchema, response: member.extend({ emailSent: z.boolean().nullable() }), created: true },
  renameMember: { summary: "Rename a member", description: "Owner only.", body: api.RenameMemberSchema, response: member },
  inviteMember: { summary: "Email an invitation to a placeholder", description: "Owner only. Replaces any earlier link.", body: api.InviteMemberSchema, response: member.extend({ emailSent: z.boolean().nullable() }) },
  cancelMemberInvite: { summary: "Cancel a placeholder's email invitation", description: "Owner only.", response: member },
```

`src/web/api/mock.ts`: so `tsc -b` passes, add `kind: "PERSON", inviteState: null, inviteExpiresAt: null,` to every `MemberDTO` literal (`mkProject` ~L372, the `m_sam` push ~L452, `createProject` ~L904, `join` ~L1019). Add `membersCanRename: true,` to both `ProjectDTO` literals (`mkProject` ~L384 and `createProject` ~L903). Change `const STORAGE = "splitdummy-mock-v2"` to `"splitdummy-mock-v3"`, and update the two `"splitdummy-mock-v2"` strings in `src/web/pages/Account.test.tsx` to `"splitdummy-mock-v3"`.

- [ ] **Step 4: Run tests and types**

Run: `npx vitest run --project worker test/do/members.test.ts && npx tsc -b`
Expected: PASS, no type errors. If `tsc` reports more `MemberDTO`/`ProjectDTO` literals (e.g. in tests), add the same fields there.

Run: `npx vitest run`
Expected: all 480 tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(do): member kind, invite columns and rename policy in contracts and schema

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: DO — add placeholders, owner rename, rename lock

**Files:**
- Create: `worker/do/ops/members.ts`
- Modify: `worker/do/ops/project.ts` (`renameMe` ~L399, `updateSettings` ~L86)
- Modify: `worker/do/ProjectDO.ts` (imports, `prepare`, `mutate`)
- Modify: `worker/do/views.ts` (`readinessList` ~L263)
- Test: `test/do/members.test.ts`

**Interfaces:**
- Consumes: Task 1 contracts.
- Produces: `addMember(tx, req, prepared, origin): OpResult`, `renameMember(tx, req): OpResult`, `memberResult(tx, memberId, status?, transient?)`, `issueInvite(...)` (used by Task 3), `type InvitePrepared = { secret: string; secretHash: string }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/do/members.test.ts` (and extend the import to `import { Client, createGroup, errorCode, expense, freezeNow, makePrincipal } from "./helpers";` plus `import type { MemberDTO, ProjectDTO } from "@shared/api";`):

```ts
describe("placeholders", () => {
  it("owner adds a named placeholder usable in expenses but absent from readiness", async () => {
    const g = await createGroup({ members: 1 });
    const added = await g.owner.ok<MemberDTO>("addMember", {}, { displayName: "Zoe" });
    expect(added).toMatchObject({ displayName: "Zoe", kind: "PLACEHOLDER", inviteState: null, isOwner: false, status: "ACTIVE" });
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(added.id, [added.id, g.owner.memberId], "1000"));
    const view = await g.owner.view();
    expect(view.current.readiness.map((r) => r.memberId)).not.toContain(added.id);
    expect(view.current.balances.find((b) => b.memberId === added.id)?.net).toBe("500");
    const history = await g.owner.ok("getHistory", {}, null, null);
    expect(history.events.some((e: { action: string }) => e.action === "MEMBER_ADDED")).toBe(true);
  });

  it("only the owner adds people, and not while settling", async () => {
    const g = await createGroup({ members: 1 });
    expect((await errorCode(g.members[0]!.call("addMember", {}, { displayName: "X" }))).status).toBe(403);
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId, g.members[0]!.memberId], "1000"));
    await freezeNow(g);
    expect((await errorCode(g.owner.call("addMember", {}, { displayName: "X" }))).code).toBe("ROUND_NOT_COLLECTING");
  });

  it("an unreferenced placeholder can be removed", async () => {
    const g = await createGroup({ members: 0 });
    const zoe = await g.owner.ok<MemberDTO>("addMember", {}, { displayName: "Zoe" });
    const removed = await g.owner.ok<MemberDTO>("removeMember", { memberId: zoe.id });
    expect(removed.status).toBe("REMOVED");
  });
});

describe("renaming", () => {
  it("owner renames anyone, audited with byMemberId", async () => {
    const g = await createGroup({ members: 1 });
    const bob = g.members[0]!;
    const renamed = await g.owner.ok<MemberDTO>("renameMember", { memberId: bob.memberId }, { displayName: "Robert" });
    expect(renamed.displayName).toBe("Robert");
    const history = await g.owner.ok("getHistory", {}, null, null);
    expect(history.events[0]).toMatchObject({ action: "MEMBER_RENAMED", details: { from: "Bob", to: "Robert", byMemberId: g.owner.memberId } });
    expect((await errorCode(bob.call("renameMember", { memberId: g.owner.memberId }, { displayName: "X" }))).status).toBe(403);
  });

  it("owner can lock self-renaming; the owner can still rename themselves", async () => {
    const g = await createGroup({ members: 1 });
    const bob = g.members[0]!;
    const before = await g.owner.view();
    const p = await g.owner.ok<ProjectDTO>("updateSettings", {}, { expectedVersion: before.project.version, membersCanRename: false });
    expect(p.membersCanRename).toBe(false);
    expect(await errorCode(bob.call("renameMe", {}, { displayName: "Bobby" }))).toMatchObject({ status: 403, code: "FORBIDDEN" });
    await g.owner.ok("renameMe", {}, { displayName: "Alicia" });
    const history = await g.owner.ok("getHistory", {}, null, null);
    expect(history.events.some((e: { action: string }) => e.action === "MEMBER_RENAME_POLICY_CHANGED")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project worker test/do/members.test.ts`
Expected: FAIL with `Unknown operation addMember` (422) / `renameMember`, and the rename-lock test fails on `membersCanRename`.

- [ ] **Step 3: Implement**

Create `worker/do/ops/members.ts`:

```ts
/** Owner-managed membership: placeholders (no account yet), email invites that claim them, and renames. */
import { AddMemberSchema, RenameMemberSchema } from "@shared/api";
import { invalid, limitExceeded, notFound, parseBody } from "../errors";
import { LIMITS, MEMBER_INVITE_TTL_MS } from "../limits";
import { PLACEHOLDER_PREFIX, type MemberRow } from "../store";
import { newId, type Tx } from "../tx";
import type { DoRequest, DoResponse, DoTransient, MemberInviteMail } from "../types";
import { memberDto } from "../views";
import type { OpResult } from "./project";

export type InvitePrepared = { secret: string; secretHash: string };

/** MemberDTO as the owner sees it, built after finish() so it reflects the commit. */
export function memberResult(tx: Tx, memberId: string, status = 200, transient?: DoTransient): () => DoResponse {
  return () => ({
    status,
    body: memberDto(tx.store.member(memberId)!, tx.project, tx.store.isReferenced(memberId), true, tx.now),
    ...(transient ? { transient } : {}),
  });
}

function assertCapacity(tx: Tx): void {
  if (tx.store.count("SELECT COUNT(*) AS n FROM members WHERE status != 'REMOVED'") >= LIMITS.members) {
    throw limitExceeded(`A group can have at most ${LIMITS.members} members.`);
  }
  if (tx.store.count("SELECT COUNT(*) AS n FROM members") >= LIMITS.memberRows) {
    throw limitExceeded("This group has reached its membership limit.");
  }
}

/** One live invitation per address per group. */
function assertEmailFree(tx: Tx, email: string, exceptMemberId: string | null): void {
  const taken = tx.store.first<{ id: string }>(
    "SELECT id FROM members WHERE kind = 'PLACEHOLDER' AND status != 'REMOVED' AND invited_email = ? AND id != ?",
    email,
    exceptMemberId ?? "",
  );
  if (taken) throw invalid("email", "Someone in this group was already invited with this email.");
}

/** Stores the hash + expiry on the placeholder (replacing any earlier link) and returns the email to send. */
export function issueInvite(tx: Tx, member: MemberRow, email: string, prepared: InvitePrepared, origin: string): MemberInviteMail {
  const expiresAt = new Date(Date.parse(tx.now) + MEMBER_INVITE_TTL_MS).toISOString();
  tx.store.run(
    "UPDATE members SET invited_email = ?, invite_secret_hash = ?, invite_sent_at = ?, invite_expires_at = ? WHERE id = ?",
    email,
    prepared.secretHash,
    tx.now,
    expiresAt,
    member.id,
  );
  // History is visible to every member, so the address stays out of it.
  tx.audit("MEMBER_INVITED", `Invited ${member.display_name} by email`, { entityId: member.id, details: { expiresAt } });
  return {
    to: email,
    url: `${origin}/invite#${tx.project.id}.${prepared.secret}`,
    projectName: tx.project.name,
    inviterName: tx.member().display_name,
    displayName: member.display_name,
    expiresAt,
  };
}

export function addMember(tx: Tx, req: DoRequest, prepared: InvitePrepared, origin: string): OpResult {
  tx.owner("Only the group owner can add people.");
  tx.requireNotSettling();
  const body = parseBody(AddMemberSchema, req.body);
  assertCapacity(tx);
  if (body.email) assertEmailFree(tx, body.email, null);
  const id = newId("m");
  tx.store.run(
    `INSERT INTO members (id, principal_id, display_name, is_guest, has_recoverable_account, joined_at, status, kind)
     VALUES (?, ?, ?, 0, 0, ?, 'ACTIVE', 'PLACEHOLDER')`,
    id,
    `${PLACEHOLDER_PREFIX}${id}`,
    body.displayName,
    tx.now,
  );
  const member = tx.store.member(id)!;
  tx.audit("MEMBER_ADDED", `Added ${member.display_name}`, { roundId: tx.activeRound()?.id ?? null, entityId: id });
  const mail = body.email ? issueInvite(tx, member, body.email, prepared, origin) : undefined;
  return memberResult(tx, id, 201, mail ? { inviteMail: mail } : undefined);
}

export function renameMember(tx: Tx, req: DoRequest): OpResult {
  const owner = tx.owner("Only the group owner can rename other people.");
  const body = parseBody(RenameMemberSchema, req.body);
  const target = tx.store.member(req.params.memberId ?? "");
  if (!target || target.status === "REMOVED" || target.account_deleted === 1) throw notFound("This member isn't available.");
  if (body.displayName !== target.display_name) {
    tx.store.run("UPDATE members SET display_name = ? WHERE id = ?", body.displayName, target.id);
    tx.audit("MEMBER_RENAMED", `${owner.display_name} renamed ${target.display_name} to ${body.displayName}`, {
      roundId: tx.activeRound()?.id ?? null,
      entityId: target.id,
      details: { from: target.display_name, to: body.displayName, byMemberId: owner.id },
    });
  }
  return memberResult(tx, target.id);
}
```

(Task 3 extends these imports.)

`worker/do/ops/project.ts` `renameMe`: after `const me = tx.member();` insert:

```ts
  if (tx.project.members_can_rename !== 1 && tx.project.owner_member_id !== me.id) {
    throw forbidden("The owner manages names in this group.");
  }
```

`updateSettings`: before `return projectResult(tx);` insert:

```ts
  const canRename = project.members_can_rename === 1;
  if (body.membersCanRename !== undefined && body.membersCanRename !== canRename) {
    tx.store.run("UPDATE project SET members_can_rename = ? WHERE id = ?", body.membersCanRename ? 1 : 0, project.id);
    tx.audit(
      "MEMBER_RENAME_POLICY_CHANGED",
      body.membersCanRename ? "Let members change their own names" : "Only the owner can change names now",
      { entityId: project.id, details: { membersCanRename: body.membersCanRename } },
    );
  }
```

`worker/do/views.ts` `readinessList`: change the filter to `.filter((m) => m.status === "ACTIVE" && m.account_deleted !== 1 && m.kind !== "PLACEHOLDER")` and update its doc comment to "currently ACTIVE people (not placeholders) whose account still exists."

`worker/do/ProjectDO.ts`: import `{ addMember, renameMember } from "./ops/members"`. In `prepare()` change the first condition to `if (req.op === "createInvite" || req.op === "addMember" || req.op === "inviteMember") {`. In `mutate()` add:

```ts
      case "addMember":
        return addMember(tx, req, { secret: prepared.secret!, secretHash: prepared.secretHash! }, this.env.APP_ORIGIN);
      case "renameMember":
        return renameMember(tx, req);
```

The `default: never` branch will flag the four ops Task 3 adds. Until then, add them as a temporary group that throws:

```ts
      case "inviteMember":
      case "cancelMemberInvite":
      case "acceptMemberInvite":
        throw invalid(undefined, `Unknown operation ${op}`);
```

Add `"previewMemberInvite"` to the `ReadOp` union and a temporary `previewMemberInvite: () => { throw invalid(undefined, "Unknown operation previewMemberInvite"); },` entry in `READ_OPS`. Task 3 replaces all of these.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project worker test/do/members.test.ts test/do/membership.test.ts && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(do): owner adds placeholders, renames members, can lock self-renaming

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: DO — email invites (issue, resend, cancel, preview, accept/claim)

**Files:**
- Modify: `worker/do/ops/members.ts`, `worker/do/ProjectDO.ts`
- Test: `test/do/members.test.ts`

**Interfaces:**
- Consumes: `issueInvite`, `memberResult`, `InvitePrepared` (Task 2).
- Produces: `inviteMember`, `cancelMemberInvite`, `previewMemberInvite(tx, { secretHash }): DoResponse`, `acceptMemberInvite(tx, req, { secretHash }): OpResult`, `claimPlaceholder(tx, m, principal, displayName?): MemberRow`, `findInvitedPlaceholder(tx, email): MemberRow | undefined` (used by Task 4 join).

- [ ] **Step 1: Write the failing tests**

Append to `test/do/members.test.ts` (add `import type { JoinResultDTO, MemberInvitePreviewDTO } from "@shared/api";`, `import { runInDurableObject } from "cloudflare:test";`, `import type { Principal } from "../../worker/do/types";`):

```ts
/** Adds a placeholder with an email invite; returns it plus the token from the mailed URL. */
async function invite(g: Awaited<ReturnType<typeof createGroup>>, displayName: string, email: string) {
  const res = await g.owner.call("addMember", {}, { displayName, email });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  const url = res.transient!.inviteMail!.url;
  return { member: res.body as MemberDTO, token: url.split("#")[1]!, res };
}

const accountFor = (email: string): Principal => ({ ...makePrincipal(), email });

describe("email invites", () => {
  it("issues a 7-day invite; the URL travels only in transient and is never stored", async () => {
    const g = await createGroup({ members: 0 });
    const { member, token, res } = await invite(g, "Zoe", "Zoe@Example.com");
    expect(member).toMatchObject({ kind: "PLACEHOLDER", inviteState: "INVITED", invitedEmail: "zoe@example.com" });
    const days = (Date.parse(member.inviteExpiresAt!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
    expect(res.transient!.inviteMail).toMatchObject({ to: "zoe@example.com", projectName: "Trip", inviterName: "Alice", displayName: "Zoe" });
    expect(token.startsWith(`${g.projectId}.`)).toBe(true);
    const secret = token.split(".")[1]!;
    const stored = await runInDurableObject(g.stub, (_i, state) =>
      state.storage.sql.exec("SELECT response_json FROM idempotency").toArray().map((r) => String(r.response_json)).join(""),
    );
    expect(stored).not.toContain(secret);
    const history = await g.owner.ok("getHistory", {}, null, null);
    expect(JSON.stringify(history)).not.toContain("zoe@example.com");
  });

  it("a replayed add returns the member without transient", async () => {
    const g = await createGroup({ members: 0 });
    const key = crypto.randomUUID();
    const first = await g.owner.call("addMember", {}, { displayName: "Zoe", email: "z@example.com" }, key);
    const again = await g.owner.call("addMember", {}, { displayName: "Zoe", email: "z@example.com" }, key);
    expect(first.transient?.inviteMail).toBeDefined();
    expect(again.transient).toBeUndefined();
    expect((again.body as MemberDTO).id).toBe((first.body as MemberDTO).id);
  });

  it("non-owners see no invited email; one live invite per address", async () => {
    const g = await createGroup({ members: 1 });
    const { member } = await invite(g, "Zoe", "z@example.com");
    const seen = (await g.members[0]!.view()).members.find((m) => m.id === member.id)!;
    expect(seen.inviteState).toBe("INVITED");
    expect("invitedEmail" in seen).toBe(false);
    expect(await errorCode(g.owner.call("addMember", {}, { displayName: "Z2", email: "z@example.com" }))).toMatchObject({ status: 422, field: "email" });
  });

  it("previews without leaking the email to the body", async () => {
    const g = await createGroup({ members: 0 });
    const { token } = await invite(g, "Zoe", "z@example.com");
    const anon = new Client(g.stub, g.projectId, null);
    const res = await anon.call("previewMemberInvite", { tokenSecret: token }, null, null);
    expect(res.body).toEqual({ projectName: "Trip", baseCurrency: "PLN", displayName: "Zoe", status: "OPEN", canRename: true, alreadyMemberProjectId: null } satisfies MemberInvitePreviewDTO);
    expect(res.transient).toEqual({ invitedEmail: "z@example.com" });
  });

  it("accept claims the placeholder, keeping its id, entries and balance", async () => {
    const g = await createGroup({ members: 0 });
    const { member, token } = await invite(g, "Zoe", "z@example.com");
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId, member.id], "1000"));
    const zoe = new Client(g.stub, g.projectId, accountFor("z@example.com"));
    const joined = await zoe.ok<JoinResultDTO>("acceptMemberInvite", { tokenSecret: token }, { displayName: "Zoë" });
    expect(joined).toEqual({ projectId: g.projectId, memberId: member.id });
    const view = await zoe.view();
    expect(view.me.memberId).toBe(member.id);
    expect(view.members.find((m) => m.id === member.id)).toMatchObject({ kind: "PERSON", displayName: "Zoë", inviteState: null, hasRecoverableAccount: true, isGuest: false });
    expect(view.current.balances.find((b) => b.memberId === member.id)?.net).toBe("-500");
    expect(view.current.readiness.map((r) => r.memberId)).toContain(member.id);
    const preview = await new Client(g.stub, g.projectId, null).ok<MemberInvitePreviewDTO>("previewMemberInvite", { tokenSecret: token }, null, null);
    expect(preview.status).toBe("CLAIMED");
    // Single use: a second accept (different key) fails.
    expect(await errorCode(zoe.call("acceptMemberInvite", { tokenSecret: token }, {}))).toMatchObject({ status: 409, code: "INVITE_INVALID" });
  });

  it("ignores the new name when renaming is locked", async () => {
    const g = await createGroup({ members: 0 });
    const v = await g.owner.view();
    await g.owner.ok("updateSettings", {}, { expectedVersion: v.project.version, membersCanRename: false });
    const { member, token } = await invite(g, "Zoe", "z@example.com");
    const zoe = new Client(g.stub, g.projectId, accountFor("z@example.com"));
    await zoe.ok("acceptMemberInvite", { tokenSecret: token }, { displayName: "Other" });
    expect((await zoe.view()).members.find((m) => m.id === member.id)?.displayName).toBe("Zoe");
  });

  it("rejects expired, cancelled and rotated links, other emails and existing members", async () => {
    const g = await createGroup({ members: 1 });
    const { member, token } = await invite(g, "Zoe", "z@example.com");
    const zoe = new Client(g.stub, g.projectId, accountFor("z@example.com"));

    // Resend rotates: old link is gone.
    const resent = await g.owner.call("inviteMember", { memberId: member.id }, { email: "z@example.com" });
    const fresh = resent.transient!.inviteMail!.url.split("#")[1]!;
    expect(await errorCode(zoe.call("acceptMemberInvite", { tokenSecret: token }, {}))).toMatchObject({ status: 404, code: "INVITE_INVALID" });

    // Wrong email.
    const other = new Client(g.stub, g.projectId, accountFor("x@example.com"));
    expect((await errorCode(other.call("acceptMemberInvite", { tokenSecret: fresh }, {}))).status).toBe(403);

    // Already in the group under another identity.
    const bob = g.members[0]!;
    const bobAsZoe = new Client(g.stub, g.projectId, { ...bob.principal!, email: "z@example.com" });
    expect(await errorCode(bobAsZoe.call("acceptMemberInvite", { tokenSecret: fresh }, {}))).toMatchObject({ status: 409, code: "ALREADY_MEMBER" });

    // Expired.
    await runInDurableObject(g.stub, (_i, state) => {
      state.storage.sql.exec("UPDATE members SET invite_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", member.id);
    });
    expect((await g.owner.view()).members.find((m) => m.id === member.id)?.inviteState).toBe("INVITE_EXPIRED");
    expect(await errorCode(zoe.call("acceptMemberInvite", { tokenSecret: fresh }, {}))).toMatchObject({ status: 409, code: "INVITE_INVALID", details: { status: "EXPIRED" } });

    // Cancel: back to a plain placeholder, link unknown.
    const cancelled = await g.owner.ok<MemberDTO>("cancelMemberInvite", { memberId: member.id });
    expect(cancelled).toMatchObject({ kind: "PLACEHOLDER", inviteState: null, invitedEmail: null });
    expect((await errorCode(zoe.call("acceptMemberInvite", { tokenSecret: fresh }, {}))).status).toBe(404);
  });

  it("accept is allowed while settling (claiming changes no accounting)", async () => {
    const g = await createGroup({ members: 0 });
    const { member, token } = await invite(g, "Zoe", "z@example.com");
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId, member.id], "1000"));
    await freezeNow(g);
    const zoe = new Client(g.stub, g.projectId, accountFor("z@example.com"));
    expect((await zoe.ok<JoinResultDTO>("acceptMemberInvite", { tokenSecret: token }, {})).memberId).toBe(member.id);
    expect((await errorCode(g.owner.call("inviteMember", { memberId: member.id }, { email: "q@example.com" }))).status).toBe(409);
  });

  it("re-claim after the account was removed earlier retires the old row instead of colliding", async () => {
    const g = await createGroup({ members: 0 });
    const zoeAccount = accountFor("z@example.com");
    const inviteToken = (await g.owner.ok<{ url: string }>("createInvite")).url.split("#")[1]!;
    const zoe = new Client(g.stub, g.projectId, zoeAccount);
    const first = await zoe.ok<JoinResultDTO>("join", { tokenSecret: inviteToken }, { displayName: "Zoe" });
    await g.owner.ok("removeMember", { memberId: first.memberId });
    const { member, token } = await invite(g, "Zoe again", "z@example.com");
    expect((await zoe.ok<JoinResultDTO>("acceptMemberInvite", { tokenSecret: token }, {})).memberId).toBe(member.id);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project worker test/do/members.test.ts`
Expected: the new `email invites` tests FAIL (`Unknown operation inviteMember` etc.; previews 422).

- [ ] **Step 3: Implement**

Extend the imports at the top of `worker/do/ops/members.ts` to:

```ts
import { AddMemberSchema, DisplayNameSchema, InviteMemberSchema, RenameMemberSchema, type JoinResultDTO, type MemberInvitePreviewDTO } from "@shared/api";
import { z } from "zod";
import { ApiError, conflict, forbidden, invalid, limitExceeded, notFound, parseBody } from "../errors";
import type { DoRequest, DoResponse, DoTransient, MemberInviteMail, Principal } from "../types";
import { ok, type OpResult } from "./project";
```

(The `limits`, `store`, `tx` and `views` imports stay as they are.) Then append:

```ts
function placeholderParam(tx: Tx, req: DoRequest): MemberRow {
  const target = tx.store.member(req.params.memberId ?? "");
  if (!target || target.status === "REMOVED") throw notFound("This member isn't available.");
  if (target.kind !== "PLACEHOLDER") throw conflict("INVALID_TRANSITION", `${target.display_name} has already joined.`);
  return target;
}

export function inviteMember(tx: Tx, req: DoRequest, prepared: InvitePrepared, origin: string): OpResult {
  tx.owner("Only the group owner can invite people.");
  tx.requireNotSettling();
  const body = parseBody(InviteMemberSchema, req.body);
  const target = placeholderParam(tx, req);
  assertEmailFree(tx, body.email, target.id);
  const mail = issueInvite(tx, target, body.email, prepared, origin);
  return memberResult(tx, target.id, 200, { inviteMail: mail });
}

export function cancelMemberInvite(tx: Tx, req: DoRequest): OpResult {
  tx.owner("Only the group owner can manage invitations.");
  tx.requireNotSettling();
  const target = placeholderParam(tx, req);
  if (target.invited_email !== null) {
    tx.store.run(
      "UPDATE members SET invited_email = NULL, invite_secret_hash = NULL, invite_sent_at = NULL, invite_expires_at = NULL WHERE id = ?",
      target.id,
    );
    tx.audit("MEMBER_INVITE_CANCELLED", `Cancelled the email invitation for ${target.display_name}`, { entityId: target.id });
  }
  return memberResult(tx, target.id);
}

/** Cancelled and rotated links are unknown hashes (404). Claimed links keep their hash and report CLAIMED. */
function inviteByHash(tx: Tx, secretHash: string): MemberRow {
  const m = tx.store.first<MemberRow>("SELECT * FROM members WHERE invite_secret_hash = ?", secretHash);
  if (!m || m.status === "REMOVED" || !tx.store.project()) {
    throw new ApiError(404, "INVITE_INVALID", "This invitation link isn't valid anymore. Ask the owner to send a new one.");
  }
  return m;
}

function memberInviteStatus(tx: Tx, m: MemberRow): MemberInvitePreviewDTO["status"] {
  if (m.kind !== "PLACEHOLDER") return "CLAIMED";
  return Date.parse(m.invite_expires_at!) <= Date.parse(tx.now) ? "EXPIRED" : "OPEN";
}

export function previewMemberInvite(tx: Tx, prepared: { secretHash: string }): DoResponse {
  const m = inviteByHash(tx, prepared.secretHash);
  const project = tx.project;
  const mine = tx.principal ? tx.store.memberByPrincipal(tx.principal.principalId) : undefined;
  const body: MemberInvitePreviewDTO = {
    projectName: project.name,
    baseCurrency: project.base_currency,
    displayName: m.display_name,
    status: memberInviteStatus(tx, m),
    canRename: project.members_can_rename === 1,
    alreadyMemberProjectId: mine && mine.status === "ACTIVE" ? project.id : null,
  };
  return { status: 200, body, transient: { invitedEmail: m.invited_email! } };
}

/** Placeholder whose live email invite matches a verified address (used by link joins too). */
export function findInvitedPlaceholder(tx: Tx, email: string): MemberRow | undefined {
  return tx.store.first<MemberRow>(
    "SELECT * FROM members WHERE kind = 'PLACEHOLDER' AND status = 'ACTIVE' AND invited_email = ?",
    email,
  );
}

/**
 * The principal takes over the placeholder: same member id, so every entry and transfer carries over.
 * Callers guarantee the principal has no ACTIVE/LEFT member here; a REMOVED one is retired first so
 * the UNIQUE principal_id can move.
 */
export function claimPlaceholder(tx: Tx, m: MemberRow, principal: Principal, displayName: string | undefined): MemberRow {
  const previous = tx.store.memberByPrincipal(principal.principalId);
  if (previous && previous.id !== m.id) {
    tx.store.run("UPDATE members SET principal_id = ? WHERE id = ?", `${PLACEHOLDER_PREFIX}${previous.id}`, previous.id);
  }
  const rename = displayName !== undefined && tx.project.members_can_rename === 1 && displayName !== m.display_name;
  tx.store.run(
    "UPDATE members SET principal_id = ?, kind = 'PERSON', is_guest = ?, has_recoverable_account = ?, display_name = ? WHERE id = ?",
    principal.principalId,
    principal.kind === "GUEST" ? 1 : 0,
    principal.hasRecoverableAccount ? 1 : 0,
    rename ? displayName : m.display_name,
    m.id,
  );
  const member = tx.store.member(m.id)!;
  tx.setActor(member);
  tx.audit("MEMBER_CLAIMED", `${member.display_name} joined`, {
    roundId: tx.activeRound()?.id ?? null,
    entityId: member.id,
    details: rename ? { from: m.display_name, to: displayName } : undefined,
  });
  tx.clearReadiness("ALL");
  return member;
}

const AcceptBody = z.object({ displayName: DisplayNameSchema.optional() });

export function acceptMemberInvite(tx: Tx, req: DoRequest, prepared: { secretHash: string }): OpResult {
  const principal = tx.principal;
  if (!principal?.email) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  const body = parseBody(AcceptBody, req.body);
  const m = inviteByHash(tx, prepared.secretHash);
  const status = memberInviteStatus(tx, m);
  if (status === "CLAIMED") throw conflict("INVITE_INVALID", "This invitation was already used.", { status });
  if (status === "EXPIRED") throw conflict("INVITE_INVALID", "This invitation has expired. Ask the owner to send a new one.", { status });
  if (principal.email !== m.invited_email) throw forbidden("This invitation is for a different email address.");
  const mine = tx.store.memberByPrincipal(principal.principalId);
  if (mine && mine.status !== "REMOVED") {
    throw conflict("ALREADY_MEMBER", `You're already in this group as ${mine.display_name}.`, { memberId: mine.id });
  }
  claimPlaceholder(tx, m, principal, body.displayName);
  const result: JoinResultDTO = { projectId: tx.project.id, memberId: m.id };
  return () => ok(result);
}
```

`worker/do/ProjectDO.ts`:
- Import `acceptMemberInvite, addMember, cancelMemberInvite, inviteMember, previewMemberInvite, renameMember` from `./ops/members`.
- `READ_OPS.previewMemberInvite: (tx, _req, p) => previewMemberInvite(tx, { secretHash: p.secretHash! }),` (replacing the temporary entry).
- In `prepare()` change the token branch condition to `if (req.op === "previewInvite" || req.op === "join" || req.op === "previewMemberInvite" || req.op === "acceptMemberInvite") {`.
- Replace the temporary `case` group in `mutate()` with:

```ts
      case "inviteMember":
        return inviteMember(tx, req, { secret: prepared.secret!, secretHash: prepared.secretHash! }, this.env.APP_ORIGIN);
      case "cancelMemberInvite":
        return cancelMemberInvite(tx, req);
      case "acceptMemberInvite":
        return acceptMemberInvite(tx, req, { secretHash: prepared.secretHash! });
```

- In `dispatch()`, the idempotency INSERT stores `JSON.stringify(response)`. Change it so `transient` is never persisted:

```ts
      if (key && response.status < 300) {
        // `transient` (invite URLs, invited emails) is edge-only and must never be stored.
        const { transient: _edgeOnly, ...stored } = response;
        this.store.run(
          "INSERT INTO idempotency (principal_id, op, key, request_hash, status, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          key.p,
          req.op,
          key.k,
          requestHash,
          response.status,
          JSON.stringify(stored),
          tx.now,
        );
      }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project worker test/do && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(do): email invites that claim placeholders; secrets never stored

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: DO — directory/notifications skip placeholders, owner acts for placeholders, link join claims by email

**Files:**
- Modify: `worker/do/tx.ts` (`finish` notifications ~L150, `directoryPayload` members ~L221)
- Modify: `worker/do/ops/settlement.ts` (`transition` ~L213)
- Modify: `worker/do/ops/project.ts` (`join` ~L297)
- Test: `test/do/members.test.ts`

**Interfaces:**
- Consumes: `isPlaceholderPrincipal` (Task 1), `findInvitedPlaceholder`, `claimPlaceholder` (Task 3).

- [ ] **Step 1: Write the failing tests**

Append to `test/do/members.test.ts`:

```ts
describe("placeholders outside the ledger", () => {
  it("never reach the directory projection or notifications", async () => {
    const g = await createGroup({ members: 0 });
    const zoe = await g.owner.ok<MemberDTO>("addMember", {}, { displayName: "Zoe" });
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(zoe.id, [zoe.id, g.owner.memberId], "1000"));
    await freezeNow(g);
    const outbox = await runInDurableObject(g.stub, (_i, state) =>
      state.storage.sql.exec("SELECT message_json FROM outbox").toArray().map((r) => String(r.message_json)),
    );
    expect(outbox.join("")).not.toContain("ph:");
  });

  it("owner marks sent/received on a placeholder's behalf; not after it is claimed", async () => {
    const g = await createGroup({ members: 1 });
    const bob = g.members[0]!;
    const res = await g.owner.call("addMember", {}, { displayName: "Zoe", email: "z@example.com" });
    const zoe = res.body as MemberDTO;
    const token = res.transient!.inviteMail!.url.split("#")[1]!;
    // Zoe paid 900 for three: Bob and Alice each owe her 300.
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(zoe.id, [zoe.id, g.owner.memberId, bob.memberId], "900"));
    const frozen = await freezeNow(g);
    const toZoe = frozen.instructions.filter((i: { toMemberId: string }) => i.toMemberId === zoe.id);
    const fromBob = toZoe.find((i: { fromMemberId: string }) => i.fromMemberId === bob.memberId)!;
    await bob.ok("markSent", { roundId: g.roundId, instructionId: fromBob.id }, {});
    expect((await errorCode(bob.call("markReceived", { roundId: g.roundId, instructionId: fromBob.id }, {}))).status).toBe(403);
    await g.owner.ok("markReceived", { roundId: g.roundId, instructionId: fromBob.id }, {});
    const history = await g.owner.ok("getHistory", {}, null, null);
    expect(history.events[0]).toMatchObject({ action: "INSTRUCTION_CONFIRMED", details: { onBehalfOfMemberId: zoe.id } });

    // Once claimed, only Zoe acts for herself.
    const zoeClient = new Client(g.stub, g.projectId, { ...makePrincipal(), email: "z@example.com" });
    await zoeClient.ok("acceptMemberInvite", { tokenSecret: token }, {});
    const fromAlice = toZoe.find((i: { fromMemberId: string }) => i.fromMemberId === g.owner.memberId)!;
    await g.owner.ok("markSent", { roundId: g.roundId, instructionId: fromAlice.id }, {});
    expect((await errorCode(g.owner.call("markReceived", { roundId: g.roundId, instructionId: fromAlice.id }, {}))).status).toBe(403);
    await zoeClient.ok("markReceived", { roundId: g.roundId, instructionId: fromAlice.id }, {});
  });

  it("a link join with the invited email claims the placeholder instead of duplicating", async () => {
    const g = await createGroup({ members: 0 });
    const zoe = await g.owner.ok<MemberDTO>("addMember", {}, { displayName: "Zoe", email: "z@example.com" });
    const linkToken = (await g.owner.ok<{ url: string }>("createInvite")).url.split("#")[1]!;
    const joiner = new Client(g.stub, g.projectId, { ...makePrincipal(), email: "z@example.com" });
    const res = await joiner.ok<JoinResultDTO>("join", { tokenSecret: linkToken }, { displayName: "Zoe B" });
    expect(res.memberId).toBe(zoe.id);
    const view = await g.owner.view();
    expect(view.members.filter((m) => m.status === "ACTIVE")).toHaveLength(2);
    expect(view.members.find((m) => m.id === zoe.id)).toMatchObject({ kind: "PERSON", displayName: "Zoe B" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project worker test/do/members.test.ts`
Expected: FAIL. The outbox contains `ph:`, the owner's `markReceived` returns 403, and the link join creates a third member.

- [ ] **Step 3: Implement**

`worker/do/tx.ts`: import `isPlaceholderPrincipal` from `./store`. In `finish()` change the notification principal filter to:

```ts
      const principalIds = [
        ...new Set(n.memberIds.map((id) => principals.get(id)).filter((p): p is string => !!p && !isPlaceholderPrincipal(p))),
      ];
```

In `directoryPayload` change the members line to:

```ts
  // Deleted accounts and placeholders have no "My groups" row: there is no real principal behind them.
  const members = store.members().filter((m) => m.account_deleted !== 1 && !isPlaceholderPrincipal(m.principal_id));
```

`worker/do/ops/settlement.ts` `transition()`: replace the `isSender`/`isRecipient` lines and the two `forbidden` checks with:

```ts
  // The owner stands in for placeholders: people in the ledger who have no account yet.
  const isOwner = tx.project.owner_member_id === me.id;
  const actsFor = (memberId: string) => memberId === me.id || (isOwner && tx.store.member(memberId)?.kind === "PLACEHOLDER");
  const isSender = actsFor(instruction.from_member_id);
  const isRecipient = actsFor(instruction.to_member_id);
  if (action === "SENT" && !isSender) throw forbidden("Only the sender can mark this transfer as sent.");
  if (action !== "SENT" && !isRecipient) throw forbidden("Only the recipient can confirm or dispute this transfer.");
  const party = action === "SENT" ? instruction.from_member_id : instruction.to_member_id;
  const onBehalf = party !== me.id ? { onBehalfOfMemberId: party } : null;
```

Then make each of the three audits carry it:

```ts
    tx.audit("INSTRUCTION_SENT", `${from} sent ${amount} to ${to}${onBehalf ? ` (marked by ${me.display_name})` : ""}`, { ...auditOpts, ...(onBehalf ? { details: onBehalf } : {}) });
```

```ts
    tx.audit("INSTRUCTION_DISPUTED", `${to} has not received ${amount} from ${from}${onBehalf ? ` (marked by ${me.display_name})` : ""}`, { ...auditOpts, details: { note, ...onBehalf } });
```

```ts
    tx.audit("INSTRUCTION_CONFIRMED", `${to} received ${amount} from ${from}${onBehalf ? ` (marked by ${me.display_name})` : ""}`, { ...auditOpts, ...(onBehalf ? { details: onBehalf } : {}) });
```

`worker/do/ops/project.ts` `join()`: import `claimPlaceholder, findInvitedPlaceholder` from `./members`. After `const body = parseBody(JoinBody, req.body);` and the `activeCount` check, insert:

```ts
  // An invited person joining by link with the invited email takes over their placeholder.
  const invited = principal.email && (!existing || existing.status === "REMOVED") ? findInvitedPlaceholder(tx, principal.email) : undefined;
  if (invited) {
    const claimed = claimPlaceholder(tx, invited, principal, body.displayName);
    const result: JoinResultDTO = { projectId: project.id, memberId: claimed.id };
    return ok(result);
  }
```

Note: `claimPlaceholder` only renames when `members_can_rename = 1`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project worker test/do && npx tsc -b`
Expected: PASS (including existing settlement/membership suites).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(do): owner acts for placeholders in settlement; link joins claim invited spots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Edge — member routes, invite email, accept endpoint

**Files:**
- Create: `worker/routes/members.ts`
- Modify: `worker/lib/email.ts`, `worker/routes/projects.ts` (`PROJECT_ROUTES`), `worker/index.ts`
- Test: `test/edge/members.test.ts` (create)

**Interfaces:**
- Consumes: `DoResponse.transient`, `AddMemberSchema`, `InviteMemberSchema`, `AcceptMemberInviteSchema`, `parseInviteToken` (exported from `worker/routes/invitations.ts`), `recordMembership` and `validateParams` (from `worker/routes/projects.ts`), `findOrCreateAccount` (`worker/auth/principals.ts`), `createSession`/`revokeSession`/`writeSessionCookie` (`worker/auth/session.ts`).
- Produces: `memberInviteEmail(opts): EmailContent`, `memberRoutes`.

- [ ] **Step 1: Write the failing tests**

Create `test/edge/members.test.ts`. It runs against the real DO, with signed-in sessions from `signIn`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddMemberResultDTO, JoinResultDTO, MeDTO, MemberInvitePreviewDTO, ProjectSummaryDTO, ProjectViewDTO } from "@shared/api";
import { call, mockTurnstile, sessionCookie, signIn, uniqueEmail } from "./helpers";

beforeEach(() => {
  mockTurnstile();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function group(owner: string): Promise<ProjectViewDTO> {
  return json<ProjectViewDTO>(await call("/api/projects", { cookie: owner, body: { name: "Trip", baseCurrency: "PLN", ownerDisplayName: "Ann" } }), 201);
}

const tokenOf = (devLink: string) => decodeURIComponent(new URL(devLink).hash.slice(1));

describe("owner member routes", () => {
  it("adds a placeholder with an email, sends the invite, and a replay sends nothing", async () => {
    const owner = await signIn(uniqueEmail("owner"));
    const g = await group(owner);
    const path = `/api/projects/${g.project.id}/members`;
    const first = await json<AddMemberResultDTO>(await call(path, { cookie: owner, body: { displayName: "Zoe", email: "zoe@example.com" }, idempotencyKey: "add-zoe-1" }), 201);
    expect(first).toMatchObject({ displayName: "Zoe", kind: "PLACEHOLDER", inviteState: "INVITED", emailSent: true });
    expect(first.devLink).toMatch(/^http:\/\/localhost\/invite#p_[0-9a-f]{32}\./);
    const replay = await json<AddMemberResultDTO>(await call(path, { cookie: owner, body: { displayName: "Zoe", email: "zoe@example.com" }, idempotencyKey: "add-zoe-1" }), 201);
    expect(replay).toMatchObject({ id: first.id, emailSent: null });
    expect(replay.devLink).toBeUndefined();

    const plain = await json<AddMemberResultDTO>(await call(path, { cookie: owner, body: { displayName: "Kid" } }), 201);
    expect(plain.emailSent).toBeNull();
  });

  it("renames, resends and cancels through the generic routes", async () => {
    const owner = await signIn(uniqueEmail("owner"));
    const g = await group(owner);
    const added = await json<AddMemberResultDTO>(await call(`/api/projects/${g.project.id}/members`, { cookie: owner, body: { displayName: "Zoe" } }), 201);
    const base = `/api/projects/${g.project.id}/members/${added.id}`;
    expect((await json<{ displayName: string }>(await call(`${base}/name`, { method: "PATCH", cookie: owner, body: { displayName: "Zoë" } }))).displayName).toBe("Zoë");
    const invited = await json<AddMemberResultDTO>(await call(`${base}/invite`, { cookie: owner, body: { email: "z@example.com" } }));
    expect(invited).toMatchObject({ inviteState: "INVITED", emailSent: true });
    expect((await json<{ inviteState: null }>(await call(`${base}/invite`, { method: "DELETE", cookie: owner }))).inviteState).toBeNull();
  });
});

describe("accepting an email invite", () => {
  it("previews without the email, then signs in as the invited address and claims the spot", async () => {
    const owner = await signIn(uniqueEmail("owner"));
    const g = await group(owner);
    const zoeEmail = uniqueEmail("zoe");
    const added = await json<AddMemberResultDTO>(await call(`/api/projects/${g.project.id}/members`, { cookie: owner, body: { displayName: "Zoe", email: zoeEmail } }), 201);
    const token = tokenOf(added.devLink!);

    const preview = await json<MemberInvitePreviewDTO & Record<string, unknown>>(await call(`/api/member-invites/${encodeURIComponent(token)}`));
    expect(preview).toEqual({ projectName: "Trip", baseCurrency: "PLN", displayName: "Zoe", status: "OPEN", canRename: true, alreadyMemberProjectId: null });

    // A different person is signed in on this browser; accepting switches to Zoe's account.
    const someoneElse = await signIn(uniqueEmail("other"));
    const res = await call("/api/member-invites/accept", { cookie: someoneElse, body: { token, displayName: "Zoe K" } });
    const joined = await json<JoinResultDTO>(res);
    expect(joined).toEqual({ projectId: g.project.id, memberId: added.id });
    const cookie = sessionCookie(res)!;
    expect(cookie).toBeTruthy();
    expect((await json<MeDTO>(await call("/api/me", { cookie }))).email).toBe(zoeEmail);
    expect((await call("/api/me", { cookie: someoneElse })).status).toBe(401);
    const groups = await json<ProjectSummaryDTO[]>(await call("/api/projects", { cookie }));
    expect(groups).toEqual([expect.objectContaining({ id: g.project.id, isOwner: false })]);

    // Single use.
    const again = await call("/api/member-invites/accept", { body: { token } });
    expect(again.status).toBe(409);
    expect(sessionCookie(again)).toBeNull();
  });

  it("an expired-or-unknown link creates no account and no session", async () => {
    const res = await call("/api/member-invites/accept", { body: { token: `p_${"a".repeat(32)}.${"S".repeat(43)}` } });
    expect(res.status).toBe(404);
    expect(sessionCookie(res)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project worker test/edge/members.test.ts`
Expected: FAIL with 404s (routes not mounted).

- [ ] **Step 3: Implement**

`worker/lib/email.ts` append:

```ts
export function memberInviteEmail(opts: { inviterName: string; projectName: string; displayName: string; url: string; expiresAt: string }): EmailContent {
  const subject = `${opts.inviterName} invited you to “${opts.projectName}” on Splitdummy`.slice(0, 160);
  const intro = `${opts.inviterName} added you to “${opts.projectName}” as ${opts.displayName} to share expenses.`;
  const footer = `This invitation works until ${opts.expiresAt.slice(0, 10)} (UTC). Joining confirms this email address. If you weren't expecting it, you can ignore this email.`;
  const label = `Join ${opts.projectName}`.slice(0, 60);
  return {
    subject,
    text: `${intro}\n\n${label}: ${opts.url}\n\n${footer}\n`,
    html: layout({ heading: subject, paragraphs: [intro], action: { label, url: opts.url }, footer }),
  };
}
```

Create `worker/routes/members.ts`:

```ts
import { Hono } from "hono";
import type { z } from "zod";
import { AcceptMemberInviteSchema, AddMemberSchema, InviteMemberSchema, type AddMemberResultDTO, type MemberDTO, type ProjectViewDTO } from "@shared/api";
import type { DoOp, DoResponse } from "../do/types";
import { getSession, requireIdempotencyKey, requireSession } from "../auth/middleware";
import { findOrCreateAccount, toPrincipal } from "../auth/principals";
import { createSession, revokeSession, writeSessionCookie } from "../auth/session";
import type { AppContext, AppEnv } from "../lib/context";
import { memberInviteEmail, sendEmail } from "../lib/email";
import { isLocal } from "../lib/env";
import { notFound } from "../lib/errors";
import { clientIp, parseWith, readJsonBody } from "../lib/http";
import { callProject, isOk, toHttpResponse } from "../lib/project";
import { enforceLimit } from "../lib/ratelimit";
import { parseInviteToken } from "./invitations";
import { recordMembership, validateParams } from "./projects";

export const memberRoutes = new Hono<AppEnv>();

/** Edge-only fields never leave the Worker. */
const forBrowser = (res: DoResponse): DoResponse => ({ status: res.status, body: res.body, headers: res.headers });

/** Owner op that may hand back an invitation email (addMember / inviteMember). */
async function ownerInviteOp(c: AppContext, op: DoOp, schema: z.ZodType<{ email?: string }>): Promise<Response> {
  const { principal } = await requireSession(c);
  const params = c.req.param() as Record<string, string>;
  validateParams(params);
  const projectId = params.projectId;
  if (!projectId) throw notFound();
  const idempotencyKey = requireIdempotencyKey(c);
  await enforceLimit(c.env.RL_MUTATION, `principal:${principal.id}`);
  const body = parseWith(schema, await readJsonBody(c.req.raw));
  if (body.email) await enforceLimit(c.env.RL_SIGNIN_EMAIL, `email:${body.email}`);
  const res = await callProject(c.env, { op, projectId, principal: toPrincipal(principal), params, body, idempotencyKey, requestId: c.get("requestId") });
  if (!isOk(res)) return toHttpResponse(c, forBrowser(res), op);

  const mail = res.transient?.inviteMail;
  let emailSent: boolean | null = null;
  let devLink: string | undefined;
  if (mail) {
    // Local dev serves the app from whatever localhost port the browser used.
    const url = isLocal(c.env) ? mail.url.replace(c.env.APP_ORIGIN, new URL(c.req.url).origin) : mail.url;
    emailSent = await sendEmail(c.env, mail.to, memberInviteEmail({ ...mail, url }));
    if (isLocal(c.env)) devLink = url;
  }
  const out: AddMemberResultDTO = { ...(res.body as MemberDTO), emailSent, ...(devLink ? { devLink } : {}) };
  return c.json(out, res.status as 200 | 201);
}

memberRoutes.post("/api/projects/:projectId/members", (c) => ownerInviteOp(c, "addMember", AddMemberSchema));
memberRoutes.post("/api/projects/:projectId/members/:memberId/invite", (c) => ownerInviteOp(c, "inviteMember", InviteMemberSchema));

memberRoutes.get("/api/member-invites/:token", async (c) => {
  const { projectId, tokenSecret } = parseInviteToken(c.req.param("token"));
  const session = await getSession(c);
  const res = await callProject(c.env, {
    op: "previewMemberInvite",
    projectId,
    principal: session ? toPrincipal(session.principal) : null,
    params: { tokenSecret },
    requestId: c.get("requestId"),
  });
  return toHttpResponse(c, forBrowser(res), "previewMemberInvite");
});

/**
 * Possession of the emailed link proves the address (like a magic link): find or create that
 * account, claim the placeholder, then replace whatever session this browser had.
 */
memberRoutes.post("/api/member-invites/accept", async (c) => {
  await enforceLimit(c.env.RL_JOIN, `ip:${clientIp(c.req.raw)}`);
  const idempotencyKey = requireIdempotencyKey(c);
  const input = parseWith(AcceptMemberInviteSchema, await readJsonBody(c.req.raw));
  const { projectId, tokenSecret } = parseInviteToken(input.token);
  const requestId = c.get("requestId");

  const preview = await callProject(c.env, { op: "previewMemberInvite", projectId, principal: null, params: { tokenSecret }, requestId });
  const email = preview.transient?.invitedEmail;
  if (!isOk(preview) || !email) return toHttpResponse(c, forBrowser(preview), "previewMemberInvite");
  const status = (preview.body as { status: string }).status;
  if (status !== "OPEN") {
    return c.json({ error: { code: "INVITE_INVALID", message: status === "EXPIRED" ? "This invitation has expired. Ask the owner to send a new one." : "This invitation was already used.", details: { status } } }, 409);
  }

  const account = await findOrCreateAccount(c.env.DB, email);
  const principal = toPrincipal(account);
  const res = await callProject(c.env, {
    op: "acceptMemberInvite",
    projectId,
    principal,
    params: { tokenSecret },
    body: input.displayName ? { displayName: input.displayName } : {},
    idempotencyKey,
    requestId,
  });
  if (!isOk(res)) return toHttpResponse(c, forBrowser(res), "acceptMemberInvite");

  const previous = await getSession(c);
  if (previous) await revokeSession(c.env.DB, previous.tokenHash);
  const { token, expiresAt } = await createSession(c.env.DB, account);
  writeSessionCookie(c, token, expiresAt);

  const view = await callProject(c.env, { op: "getProject", projectId, principal, requestId }).catch(() => null);
  const body = view && isOk(view) ? (view.body as ProjectViewDTO) : null;
  const name = body?.members.find((m) => m.id === body.me.memberId)?.displayName ?? input.displayName ?? "";
  await recordMembership(c, account.id, body, name);
  return toHttpResponse(c, forBrowser(res), "acceptMemberInvite");
});
```

`worker/routes/projects.ts` `PROJECT_ROUTES` add after `renameMe`:

```ts
  renameMember: { op: "renameMember", schema: RenameMemberSchema },
  cancelMemberInvite: { op: "cancelMemberInvite" },
```

Also apply `forBrowser` in the generic loop so `transient` can never leak from any op. Change its last line to `return toHttpResponse(c, { status: res.status, body: res.body, headers: res.headers }, route.op);`.

`worker/index.ts`: `import { memberRoutes } from "./routes/members";` and add `app.route("/", memberRoutes);` right before `app.route("/", projectRoutes);`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project worker test/edge && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(edge): add/invite members with email, accept invites as the invited account

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Edge — link joins require a verified email

**Files:**
- Modify: `worker/routes/invitations.ts`, `worker/auth/principals.ts` (remove `deleteGuest`)
- Modify: `test/edge/helpers.ts` (add `guestSession`), `test/edge/projects.test.ts`, `test/edge/account.test.ts`, `test/edge/auth.test.ts`, `test/edge/e2e.test.ts`
- Test: `test/edge/members.test.ts`

**Interfaces:**
- Produces: `guestSession(): Promise<{ cookie: string; principalId: string }>` in `test/edge/helpers.ts`.

- [ ] **Step 1: Write the failing tests**

Add the helper to `test/edge/helpers.ts` (it's needed by the tests below):

```ts
import { createGuest } from "../../worker/auth/principals";
import { createSession, sessionCookieName } from "../../worker/auth/session";

/** An un-emailed guest session, as created before joins required a verified email. */
export async function guestSession(): Promise<{ cookie: string; principalId: string }> {
  const guest = await createGuest(testEnv.DB);
  const { token } = await createSession(testEnv.DB, guest);
  return { cookie: `${sessionCookieName(ORIGIN)}=${token}`, principalId: guest.id };
}
```

Append to `test/edge/members.test.ts` (import `guestSession`, `mockProjectDO`, `projectView` from `./helpers`):

```ts
describe("joining by link", () => {
  const P = `p_${"d".repeat(32)}`;
  const token = `${P}.${"S".repeat(43)}`;

  it("401 EMAIL_REQUIRED without a session or as an un-emailed guest; no guest is created", async () => {
    const { calls } = mockProjectDO(() => ({ status: 200, body: { projectId: P } }));
    const anon = await call("/api/invitations/join", { body: { token, displayName: "Bob" } });
    expect(anon.status).toBe(401);
    expect((await anon.json<{ error: { code: string } }>()).error.code).toBe("EMAIL_REQUIRED");
    expect(sessionCookie(anon)).toBeNull();
    const guest = await guestSession();
    expect((await call("/api/invitations/join", { cookie: guest.cookie, body: { token, displayName: "Bob" } })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("a verified account joins without Turnstile", async () => {
    const cookie = await signIn(uniqueEmail("joiner"));
    const { calls } = mockProjectDO((req) => (req.op === "join" ? { status: 200, body: { projectId: P, memberId: "m_1" } } : { status: 200, body: projectView(P, "m_1") }));
    const res = await call("/api/invitations/join", { cookie, body: { token, displayName: "Bob", turnstileToken: "fail" } });
    expect(res.status).toBe(200);
    expect(calls[0]?.principal).toMatchObject({ kind: "ACCOUNT", hasRecoverableAccount: true });
  });

  it("accepts a 500-char sign-in next path (the join page carries the name)", async () => {
    const next = `/join/${token}?name=${"x".repeat(300)}&auto=1`;
    const res = await call("/api/auth/email", { body: { email: uniqueEmail("n"), turnstileToken: "ok", next } });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project worker test/edge/members.test.ts`
Expected: FAIL. The anonymous join gets 200 with a guest cookie, and the Turnstile `fail` gets 403.

- [ ] **Step 3: Implement**

Replace the `invitationRoutes.post("/api/invitations/join", …)` handler in `worker/routes/invitations.ts`:

```ts
invitationRoutes.post("/api/invitations/join", async (c) => {
  const ip = clientIp(c.req.raw);
  await enforceLimit(c.env.RL_JOIN, `ip:${ip}`);
  const idempotencyKey = requireIdempotencyKey(c);
  const input = parseWith(JoinSchema, await readJsonBody(c.req.raw));
  const { projectId, tokenSecret } = parseInviteToken(input.token);

  // Every new member has a verified email: the join page signs people in (magic link) first.
  // That sign-in already passed Turnstile, so the join itself doesn't need it.
  const session = await getSession(c);
  if (!session || !session.principal.email) {
    throw new ApiError("EMAIL_REQUIRED", "Confirm your email to join this group.");
  }
  const principal = session.principal;
  const requestId = c.get("requestId");
  const res = await callProject(c.env, {
    op: "join",
    projectId,
    principal: toPrincipal(principal),
    params: { tokenSecret },
    body: { displayName: input.displayName },
    idempotencyKey,
    requestId,
  });
  if (!isOk(res)) return toHttpResponse(c, res, "join");

  // Join returns { projectId }; fetch the member view to fill the directory row immediately.
  const view = await callProject(c.env, { op: "getProject", projectId, principal: toPrincipal(principal), requestId }).catch(
    () => null,
  );
  await recordMembership(c, principal.id, view && isOk(view) ? view.body : null, input.displayName);
  return toHttpResponse(c, res, "join");
});
```

Fix the imports. Remove `createGuest`, `deleteGuest`, `PrincipalRow`, `createSession`, `writeSessionCookie` and `verifyTurnstile`. Keep `getSession`, `requireIdempotencyKey` and `toPrincipal`. Delete `deleteGuest` from `worker/auth/principals.ts`, since it now has no callers (`grep -rn deleteGuest worker test` must return nothing). Keep `createGuest` for the test helper.

`src/shared/api.ts` `JoinSchema`: leave `turnstileToken` optional and ignored. Update its comment to say so.

Update the existing edge tests that joined as anonymous guests:

- `test/edge/projects.test.ts`:
  - Replace `guestCookie()` with `async function guestCookie() { return (await guestSession()).cookie; }`.
  - Delete the tests "join without a session creates a GUEST principal…", "a rejected join issues no cookie…" and "join Turnstile can come from the X-Turnstile-Token header". The new tests in `members.test.ts` cover them.
  - In "malformed tokens are INVITE_INVALID…", keep the call as is. Token parsing still runs before the session check, so it stays 404.
- `test/edge/account.test.ts` `join()` helper: before the invite, add `cookie ??= await signIn(uniqueEmail(displayName.toLowerCase()));` and pass `cookie` to the join call. Return `{ memberId, cookie }`. Rename the test "lets a guest delete themselves; requires a session" to "lets a joined member delete themselves; requires a session".
- `test/edge/auth.test.ts` `joinAsGuest()`: replace the body with `const g = await guestSession(); return { cookie: g.cookie, principalId: g.principalId };`. Remove the `mockProjectDO` call and the join request inside it. Keep the `/api/me` kind assertion.
- `test/edge/e2e.test.ts`:
  - L57 (main flow): `const guest = await signIn(uniqueEmail("bob"));` then `const joinRes = await call("/api/invitations/join", { cookie: guest, body: { token, displayName: "Bob" } });`. Drop the `sessionCookie(joinRes)` / `expect(guest).not.toBeNull()` lines.
  - L146 ("guest upgrade"): rename it "a legacy guest member becomes recoverable after signing in". Create the guest with `guestSession()`. Add it to the group straight through the DO, with `await projectStub(testEnv, projectId).handle({ op: "join", principal: { principalId: g.principalId, kind: "GUEST", email: null, hasRecoverableAccount: false }, params: { projectId, tokenSecret: token }, body: { displayName: "Bob" }, idempotencyKey: crypto.randomUUID(), requestId: "req_test" })`. Also insert its directory row: `await testEnv.DB.prepare("INSERT INTO project_directory (principal_id, project_id, member_id, status, name, base_currency, project_version, updated_at) VALUES (?, ?, ?, 'ACTIVE', 'Flat', 'EUR', 0, ?)").bind(g.principalId, projectId, memberId, new Date().toISOString()).run();`. The rest of the test (`signIn(uniqueEmail("bob"), guest)` and the poll) is unchanged. Import `projectStub` from `../../worker/lib/project`.
  - L187 ("guests cannot create groups"): replace the join with `const guest = (await guestSession()).cookie;`.
- `test/edge/security.test.ts` L66: unchanged. The idempotency check still runs first and returns 422.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project worker && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(edge): joining by link requires a verified email; no new anonymous guests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web API client and mock

**Files:**
- Modify: `src/web/api/types.ts`, `src/web/api/http.ts`, `src/web/api/mock.ts`, `src/web/pages/SignIn.tsx` (`safeNext` 200 → 500)
- Test: `src/web/api/http.test.ts`

**Interfaces:**
- Produces (on `Api`):
  - `addMember(projectId, body: AddMemberBody, o): Promise<AddMemberResultDTO>`
  - `renameMember(projectId, memberId, body: RenameMemberBody, o): Promise<MemberDTO>`
  - `inviteMember(projectId, memberId, body: InviteMemberBody, o): Promise<AddMemberResultDTO>`
  - `cancelMemberInvite(projectId, memberId, o): Promise<MemberDTO>`
  - `previewMemberInvite(token): Promise<MemberInvitePreviewDTO>`
  - `acceptMemberInvite(body: AcceptMemberInviteBody, o): Promise<JoinResultDTO>`
  - `join` now resolves `{ projectId: string; memberId?: string }`
  - Mock demo seed: project `p_porto` gets a placeholder `m_kid` ("Kid", plain) and an invited placeholder `m_nina` ("Nina", email `nina@example.com`, token `p_porto.demo-member-invite-0001`)

- [ ] **Step 1: Write the failing test**

Append to `src/web/api/http.test.ts`. Follow the file's existing fetch-mock style; read the top of the file and reuse its helper that captures requests:

```ts
it("member endpoints hit the documented paths", async () => {
  const seen: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    seen.push(`${init?.method ?? "GET"} ${new URL(String(input instanceof Request ? input.url : input), "http://x").pathname}`);
    return Response.json({});
  });
  const api = createHttpApi();
  const o = { idempotencyKey: "k-123456789" };
  await api.addMember("p_1", { displayName: "Zoe" }, o);
  await api.renameMember("p_1", "m_1", { displayName: "Z" }, o);
  await api.inviteMember("p_1", "m_1", { email: "z@example.com" }, o);
  await api.cancelMemberInvite("p_1", "m_1", o);
  await api.previewMemberInvite("p_1.secret");
  await api.acceptMemberInvite({ token: "p_1.secretsecretsecret" }, o);
  expect(seen).toEqual([
    "POST /api/projects/p_1/members",
    "PATCH /api/projects/p_1/members/m_1/name",
    "POST /api/projects/p_1/members/m_1/invite",
    "DELETE /api/projects/p_1/members/m_1/invite",
    "GET /api/member-invites/p_1.secret",
    "POST /api/member-invites/accept",
  ]);
});
```

If `http.test.ts` names its factory differently, use the exported factory from `src/web/api/http.ts`, whatever it is called.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project web src/web/api/http.test.ts`
Expected: FAIL with `api.addMember is not a function`.

- [ ] **Step 3: Implement**

`src/web/api/types.ts`: import `AcceptMemberInviteSchema, AddMemberResultDTO, AddMemberSchema, InviteMemberSchema, JoinResultDTO, MemberInvitePreviewDTO`, then add:

```ts
export type AddMemberBody = z.input<typeof AddMemberSchema>;
export type InviteMemberBody = z.input<typeof InviteMemberSchema>;
export type AcceptMemberInviteBody = z.input<typeof AcceptMemberInviteSchema>;
```

In `Api`, change `join(...)` to return `Promise<{ projectId: string; memberId?: string }>` and add after `renameMe`:

```ts
  /** Owner: add someone by name; with an email they get a 7-day invitation to claim the spot. */
  addMember(projectId: string, body: AddMemberBody, o: MutationOptions): Promise<AddMemberResultDTO>;
  renameMember(projectId: string, memberId: string, body: RenameMemberBody, o: MutationOptions): Promise<MemberDTO>;
  /** Owner: email (or re-email) a placeholder; the earlier link stops working. */
  inviteMember(projectId: string, memberId: string, body: InviteMemberBody, o: MutationOptions): Promise<AddMemberResultDTO>;
  cancelMemberInvite(projectId: string, memberId: string, o: MutationOptions): Promise<MemberDTO>;
  previewMemberInvite(token: string): Promise<MemberInvitePreviewDTO>;
  /** Signs this browser in as the invited email's account and claims the placeholder. */
  acceptMemberInvite(body: AcceptMemberInviteBody, o: MutationOptions): Promise<JoinResultDTO>;
```

`src/web/api/http.ts` after `renameMe`:

```ts
    addMember: (id, body, o) => request<AddMemberResultDTO>("POST", `${P(id)}/members`, body, o),
    renameMember: (id, m, body, o) => request<MemberDTO>("PATCH", `${P(id)}/members/${enc(m)}/name`, body, o),
    inviteMember: (id, m, body, o) => request<AddMemberResultDTO>("POST", `${P(id)}/members/${enc(m)}/invite`, body, o),
    cancelMemberInvite: (id, m, o) => request<MemberDTO>("DELETE", `${P(id)}/members/${enc(m)}/invite`, undefined, o),
    previewMemberInvite: (token) => get<MemberInvitePreviewDTO>(`/api/member-invites/${enc(token)}`),
    acceptMemberInvite: (body, o) => request<JoinResultDTO>("POST", "/api/member-invites/accept", body, o),
```

`src/web/pages/SignIn.tsx` `safeNext`: `n.slice(0, 500)`.

`src/web/api/mock.ts`:
1. `interface MockProject` add `memberInvites?: Record<string, { token: string; email: string }>; // memberId → live email invite`.
2. Mock `join`: replace the "no session → create guest" block with:

```ts
        const pr = state.me ? state.principals[state.me] : undefined;
        if (!pr || !pr.email) fail(401, "EMAIL_REQUIRED", "Confirm your email to join this group.");
```

   and remove the later `const pr = me();`. Before pushing a new member, claim an invited placeholder with the same email:

```ts
        const invitedId = Object.entries(p.memberInvites ?? {}).find(([, v]) => v.email === pr.email)?.[0];
        const invited = invitedId ? p.members.find((m) => m.id === invitedId && m.kind === "PLACEHOLDER") : undefined;
        if (invited) {
          claim(p, invited, pr, d.data!.displayName);
          return { projectId, memberId: invited.id };
        }
```

3. Add helpers next to `nameOf`:

```ts
  const ph = (p: MockProject, memberId: string) => p.members.find((m) => m.id === memberId && m.status !== "REMOVED");
  const memberOut = (p: MockProject, m: MemberDTO, owner = true): MemberDTO => ({
    ...m,
    ...(owner ? { invitedEmail: m.kind === "PLACEHOLDER" ? p.memberInvites?.[m.id]?.email ?? null : null } : {}),
  });
  const claim = (p: MockProject, m: MemberDTO, pr: Principal, name?: string) => {
    p.principals[m.id] = pr.id;
    delete p.memberInvites?.[m.id];
    const renamed = name && p.project.membersCanRename ? name : m.displayName;
    Object.assign(m, { kind: "PERSON", inviteState: null, inviteExpiresAt: null, isGuest: false, hasRecoverableAccount: true, displayName: renamed });
    const r = active(p);
    if (r.round.status === "COLLECTING") {
      clearReady(r, "all");
      r.round.reviewVersion++;
    }
    log(p, m.id, "MEMBER_CLAIMED", r.round.id, m.id, `${m.displayName} joined`);
  };
  const sendInvite = (p: MockProject, m: MemberDTO, email: string) => {
    const token = `${p.project.id}.${crypto.randomUUID().replace(/-/g, "")}`;
    p.memberInvites = { ...p.memberInvites, [m.id]: { token, email } };
    Object.assign(m, { inviteState: "INVITED", inviteExpiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() });
    return `${location.origin}/invite#${token}`;
  };
```

4. In `view(p)`, use `members: p.members.map((x) => memberOut(p, x, m.isOwner))`.
5. Add the six methods after `renameMe` (import `AddMemberSchema`, `InviteMemberSchema`, `AcceptMemberInviteSchema`, `MemberInvitePreviewDTO`, `AddMemberResultDTO` from `@shared/api`):

```ts
    addMember: (id, body, o) =>
      mutate(o, id, "MEMBER_ADDED", (): AddMemberResultDTO => {
        const p = proj(id);
        const owner = ownerOnly(p);
        const d = AddMemberSchema.safeParse(body);
        if (!d.success) zodFail(d.error.issues);
        if (active(p).round.status === "SETTLING") fail(409, "ROUND_NOT_COLLECTING", "Members are locked while settling.");
        const mid = uid("m_");
        const m: MemberDTO = { id: mid, displayName: d.data!.displayName, isOwner: false, isGuest: false, hasRecoverableAccount: false, joinedAt: now(), status: "ACTIVE", referenced: false, accountDeleted: false, kind: "PLACEHOLDER", inviteState: null, inviteExpiresAt: null };
        p.members.push(m);
        p.principals[mid] = `ph:${mid}`;
        log(p, owner.id, "MEMBER_ADDED", active(p).round.id, mid, `Added ${m.displayName}`);
        const devLink = d.data!.email ? sendInvite(p, m, d.data!.email) : undefined;
        return { ...memberOut(p, m), emailSent: devLink ? true : null, ...(devLink ? { devLink } : {}) };
      }),
    renameMember: (id, memberId, body, o) =>
      mutate(o, id, "MEMBER_RENAMED", () => {
        const p = proj(id);
        const owner = ownerOnly(p);
        const d = RenameMemberSchema.safeParse(body);
        if (!d.success) zodFail(d.error.issues);
        const m = ph(p, memberId);
        if (!m) fail(404, "NOT_FOUND", "This member isn't available.");
        const prev = m.displayName;
        m.displayName = d.data!.displayName;
        log(p, owner.id, "MEMBER_RENAMED", null, m.id, `${owner.displayName} renamed ${prev} to ${m.displayName}`, { from: prev, to: m.displayName, byMemberId: owner.id });
        return memberOut(p, m);
      }),
    inviteMember: (id, memberId, body, o) =>
      mutate(o, id, "MEMBER_INVITED", (): AddMemberResultDTO => {
        const p = proj(id);
        ownerOnly(p);
        const d = InviteMemberSchema.safeParse(body);
        if (!d.success) zodFail(d.error.issues);
        const m = ph(p, memberId);
        if (!m || m.kind !== "PLACEHOLDER") fail(409, "INVALID_TRANSITION", "This person has already joined.");
        const devLink = sendInvite(p, m, d.data!.email);
        return { ...memberOut(p, m), emailSent: true, devLink };
      }),
    cancelMemberInvite: (id, memberId, o) =>
      mutate(o, id, "MEMBER_INVITE_CANCELLED", () => {
        const p = proj(id);
        ownerOnly(p);
        const m = ph(p, memberId);
        if (!m || m.kind !== "PLACEHOLDER") fail(409, "INVALID_TRANSITION", "This person has already joined.");
        delete p.memberInvites?.[m.id];
        Object.assign(m, { inviteState: null, inviteExpiresAt: null });
        return memberOut(p, m);
      }),
    previewMemberInvite: (token) =>
      delay((): MemberInvitePreviewDTO => {
        const p = state.projects[token.split(".")[0] ?? ""];
        const entry = Object.entries(p?.memberInvites ?? {}).find(([, v]) => v.token === token);
        const m = entry && p ? ph(p, entry[0]) : undefined;
        if (!p || !m) fail(404, "INVITE_INVALID", "This invitation link isn't valid anymore. Ask the owner to send a new one.");
        const already = state.me ? p.members.find((x) => p.principals[x.id] === state.me && x.status === "ACTIVE") : undefined;
        const expired = new Date(m.inviteExpiresAt ?? 0).getTime() < Date.now();
        return { projectName: p.project.name, baseCurrency: p.project.baseCurrency, displayName: m.displayName, status: expired ? "EXPIRED" : "OPEN", canRename: p.project.membersCanRename, alreadyMemberProjectId: already ? p.project.id : null };
      }),
    acceptMemberInvite: (body, o) => {
      const projectId = body.token.split(".")[0] ?? "";
      return mutate(o, projectId, "MEMBER_CLAIMED", () => {
        const d = AcceptMemberInviteSchema.safeParse(body);
        if (!d.success) zodFail(d.error.issues);
        const p = state.projects[projectId];
        const entry = Object.entries(p?.memberInvites ?? {}).find(([, v]) => v.token === body.token);
        const m = entry && p ? ph(p, entry[0]) : undefined;
        if (!p || !entry || !m) fail(404, "INVITE_INVALID", "This invitation link isn't valid anymore.");
        if (new Date(m.inviteExpiresAt ?? 0).getTime() < Date.now()) fail(409, "INVITE_INVALID", "This invitation has expired.", undefined, { status: "EXPIRED" });
        const email = entry[1].email;
        let pr = Object.values(state.principals).find((x) => x.email === email);
        if (!pr) {
          pr = { id: uid("pr_"), kind: "ACCOUNT", email, displayName: m.displayName };
          state.principals[pr.id] = pr;
        }
        const mine = p.members.find((x) => p.principals[x.id] === pr!.id && x.status !== "REMOVED");
        if (mine) fail(409, "ALREADY_MEMBER", `You're already in this group as ${mine.displayName}.`);
        claim(p, m, pr, d.data!.displayName);
        state.me = pr.id;
        return { projectId, memberId: m.id };
      });
    },
```

6. Mock `renameMe`: after `const m = memberOf(p);` add `if (!p.project.membersCanRename && !m.isOwner) fail(403, "FORBIDDEN", "The owner manages names in this group.");`.
7. Mock `updateSettings`: before the `log(...)`, add `if (d.membersCanRename !== undefined) p.project.membersCanRename = d.membersCanRename;`.
8. Readiness excludes placeholders. In `roundView` (~L201) and `runSchedule` (~L332), change `p.members.filter((m) => m.status === "ACTIVE")` to `p.members.filter((m) => m.status === "ACTIVE" && m.kind !== "PLACEHOLDER")`.
9. On-behalf settlement. In `markSent`, change the sender check to:

```ts
        const stands = (mid: string) => mid === m.id || (m.isOwner && p.members.find((x) => x.id === mid)?.kind === "PLACEHOLDER");
        if (!stands(i.fromMemberId)) fail(403, "FORBIDDEN", "Only the sender can mark this as sent.");
```

   and in `markReceived` use the same `stands` helper with `i.toMemberId`. Apply it to `markDisputed` the same way.
10. Demo seed. In the Porto project setup (find `p_porto` near L599), after its members are created, push two placeholders:

```ts
  porto.members.push(
    { id: "m_kid", displayName: "Kid", isOwner: false, isGuest: false, hasRecoverableAccount: false, joinedAt: "2026-09-02T10:00:00.000Z", status: "ACTIVE", referenced: false, accountDeleted: false, kind: "PLACEHOLDER", inviteState: null, inviteExpiresAt: null },
    { id: "m_nina", displayName: "Nina", isOwner: false, isGuest: false, hasRecoverableAccount: false, joinedAt: "2026-09-02T10:05:00.000Z", status: "ACTIVE", referenced: false, accountDeleted: false, kind: "PLACEHOLDER", inviteState: "INVITED", inviteExpiresAt: "2099-01-01T00:00:00.000Z" },
  );
  porto.principals.m_kid = "ph:m_kid";
  porto.principals.m_nina = "ph:m_nina";
  porto.memberInvites = { m_nina: { token: "p_porto.demo-member-invite-0001", email: "nina@example.com" } };
```

   Use whatever variable name the seed uses for the Porto project. Add a second link to the mock dev panel (~L1392) next to "Open demo invitation": `h("a", { style: { ...btn, textDecoration: "none" }, href: "/invite#p_porto.demo-member-invite-0001" }, "Open demo email invite")`.

- [ ] **Step 4: Run tests and types**

Run: `npx vitest run --project web && npx tsc -b`
Expected: PASS. Existing web tests that relied on guest joins in the mock (search for `api.join` / "Join as guest") are fixed in Task 8. If any fail here, note them and continue: Task 8 owns the Join page.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): client and mock for placeholders, email invites and owner renames

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Web — Join page (verified join + email link + auto-join) and Invite page

**Files:**
- Modify: `src/web/pages/Join.tsx`
- Create: `src/web/pages/Invite.tsx`
- Modify: `src/web/App.tsx` (route `/invite`)
- Test: `src/web/pages/Join.test.tsx`, `src/web/pages/Invite.test.tsx` (create)

**Interfaces:**
- Consumes: `useEmailLinkForm(kind, next)` from `src/web/pages/SignIn.tsx`, `api.previewMemberInvite`, `api.acceptMemberInvite`, the mock demo tokens `p_porto.demo-invite-token-0001` (link) and `p_porto.demo-member-invite-0001` (email invite to `nina@example.com`).

- [ ] **Step 1: Write the failing tests**

Create `src/web/pages/Join.test.tsx`. Find the mock's principal for a verified, non-Porto user first: `grep -n "pr_.*ACCOUNT" src/web/api/mock.ts`, then pick one (e.g. `pr_kai`) and confirm in the seed that Kai is not a Porto member. The demo comment says "Maya isn't a member" of Porto, so find Maya's principal id with `grep -n Maya src/web/api/mock.ts` and use that.

```tsx
import "../test/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ApiProvider } from "../api/context";
import { createMockApi, type MockApi } from "../api/mock";
import { ToastProvider } from "../components/Toast";
import { AppRoutes } from "../App";

const TOKEN = "p_porto.demo-invite-token-0001";
const MAYA = "pr_maya"; // replace with Maya's principal id from the mock seed

function renderAt(api: MockApi, path: string) {
  return render(
    <ApiProvider api={api}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ToastProvider>
    </ApiProvider>,
  );
}

function mockAs(principal: string | null): MockApi {
  createMockApi();
  const s = JSON.parse(localStorage.getItem("splitdummy-mock-v3")!);
  s.me = principal;
  localStorage.setItem("splitdummy-mock-v3", JSON.stringify(s));
  return createMockApi();
}

describe("join by link", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
  });
  afterEach(() => cleanup());

  it("a verified account sees one Join button and never 'Join as guest'", async () => {
    const api = mockAs(MAYA);
    const join = vi.spyOn(api, "join");
    renderAt(api, `/join/${TOKEN}`);
    const button = await screen.findByRole("button", { name: "Join" });
    expect(screen.queryByText(/as guest/i)).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(join).toHaveBeenCalledTimes(1));
  });

  it("signed out: asks for name and email and sends a sign-in link that returns to auto-join", async () => {
    const api = mockAs(null);
    const request = vi.spyOn(api, "requestSignIn");
    renderAt(api, `/join/${TOKEN}`);
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Maya" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "maya@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a link" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const body = request.mock.calls[0]![0];
    expect(body.next).toBe(`/join/${encodeURIComponent(TOKEN)}?name=Maya&auto=1`);
    expect(await screen.findByText("Check your inbox")).toBeTruthy();
  });

  it("returning with auto=1 joins exactly once", async () => {
    const api = mockAs(MAYA);
    const join = vi.spyOn(api, "join");
    renderAt(api, `/join/${encodeURIComponent(TOKEN)}?name=Maya&auto=1`);
    await waitFor(() => expect(join).toHaveBeenCalledTimes(1));
    expect(join.mock.calls[0]![0]).toMatchObject({ displayName: "Maya" });
    await new Promise((r) => setTimeout(r, 50));
    expect(join).toHaveBeenCalledTimes(1);
  });
});
```

Create `src/web/pages/Invite.test.tsx` with the same `renderAt`/`mockAs` helpers:

```tsx
describe("accept email invite", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
  });
  afterEach(() => cleanup());

  it("shows the spot name, accepts with Join and lands in the group", async () => {
    const api = mockAs(null);
    const accept = vi.spyOn(api, "acceptMemberInvite");
    renderAt(api, "/invite/p_porto.demo-member-invite-0001");
    const input = (await screen.findByLabelText("Your name")) as HTMLInputElement;
    expect(input.value).toBe("Nina");
    expect(screen.getByRole("heading", { name: "Porto weekend" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith({ token: "p_porto.demo-member-invite-0001", displayName: "Nina" }, expect.anything()));
    expect(await screen.findByText("Porto weekend")).toBeTruthy();
  });

  it("unknown links explain what happened", async () => {
    renderAt(mockAs(null), "/invite/p_porto.nope-nope-nope-nope");
    expect(await screen.findByText("This invitation isn't available")).toBeTruthy();
  });
});
```

(`/invite/:token` mirrors `/join/:token` for testability. The real emails use `/invite#token`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project web src/web/pages/Join.test.tsx src/web/pages/Invite.test.tsx`
Expected: FAIL. There is no "Email me a link" button, and `/invite` is NotFound.

- [ ] **Step 3: Implement**

`src/web/App.tsx`: add `const Invite = lazyPage(() => import("./pages/Invite"), "Invite");` and the routes `<Route path="/invite" element={<Invite />} />` and `<Route path="/invite/:token" element={<Invite />} />` after the join routes.

`src/web/pages/Join.tsx`. Rework the OPEN branch. Keep the loading, error, already-member and UNAVAILABLE branches as they are. Changes:

1. Imports: add `useSearchParams` from `react-router` and `useEmailLinkForm` from `./SignIn`. Drop `Turnstile`, `useTurnstileRequired` and `TurnstileHandle` from the join submit; the email form uses them through `useEmailLinkForm`. Keep importing `Turnstile` for rendering the email form's widget.
2. State:

```tsx
  const [search, setSearch] = useSearchParams();
  const verified = !!me?.email;
  const [name, setName] = useState(search.get("name") ?? me?.displayName ?? "");
  const nextPath = (n: string) => `/join/${encodeURIComponent(token)}?name=${encodeURIComponent(n)}&auto=1`;
  const emailForm = useEmailLinkForm("signin", nextPath(name.trim()));
  const autoStarted = useRef(false);
```

3. Extract the join submit into `const doJoin = async (displayName: string) => { … }`. It is the existing `try { const r = await run(...) … } catch { … }` body without Turnstile, calling `api.join({ token, displayName }, { idempotencyKey: k })`. `onSubmit` validates the name with `DisplayNameSchema`, then calls `doJoin(n.data)`.
4. Auto-join on return from the magic link:

```tsx
  useEffect(() => {
    if (autoStarted.current || search.get("auto") !== "1" || !verified || preview?.status !== "OPEN" || preview.alreadyMemberProjectId) return;
    const n = DisplayNameSchema.safeParse(search.get("name") ?? "");
    if (!n.success) return;
    autoStarted.current = true;
    // Drop auto=1 first so a refresh or StrictMode re-run never submits twice.
    const next = new URLSearchParams(search);
    next.delete("auto");
    setSearch(next, { replace: true });
    void doJoin(n.data);
  }, [search, verified, preview]); // eslint-disable-line react-hooks/exhaustive-deps
```

5. The OPEN form:

```tsx
            {verified ? (
              <form className="stack-16" onSubmit={onSubmit} noValidate>
                {nameField}
                {errors._form && formError(errors._form)}
                <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
                  {pending ? "Joining…" : "Join"}
                </button>
                <p className="tiny muted">Joining as {me!.email}. You'll be added as a new member; nobody can take over another person's place.</p>
              </form>
            ) : (
              <form
                className="stack-16"
                noValidate
                onSubmit={async (e) => {
                  e.preventDefault();
                  const n = DisplayNameSchema.safeParse(name);
                  if (!n.success) return setErrors({ displayName: n.error.issues[0]?.message ?? "Enter a name" });
                  const sent = await emailForm.submit();
                  if (sent) navigate("/signin/sent", { state: { email: sent.email, devLink: sent.devLink, next: nextPath(n.data) } });
                }}
              >
                {nameField}
                <Field label="Email" error={emailForm.error ?? undefined} hint="We'll email you a link. Opening it confirms your email and adds you to the group.">
                  {(p) => <input {...p} className="input" type="email" autoComplete="email" inputMode="email" value={emailForm.email} onChange={(e) => emailForm.setEmail(e.target.value)} />}
                </Field>
                <Turnstile ref={emailForm.ts} onToken={emailForm.setToken} action="signin" />
                <button type="submit" className="btn btn-primary btn-block" disabled={emailForm.pending}>
                  {emailForm.pending ? "Sending…" : "Email me a link"}
                </button>
              </form>
            )}
```

   Here `nameField` is the existing "Your name" `<Field>` hoisted into a const, and `formError(msg)` is the existing `form-error` block. Delete the old guest note card and the "Joining as … a guest on this browser" paragraph.
6. If `api.join` fails with `EMAIL_REQUIRED` (for example, a session expired between pages), call `await refresh()`. The page then re-renders the email form.

Create `src/web/pages/Invite.tsx`:

```tsx
import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import type { MemberInvitePreviewDTO } from "@shared/api";
import { DisplayNameSchema } from "@shared/api";
import { useApi, useSession } from "../api/context";
import { ApiError, errorMessage, fieldErrors } from "../api/errors";
import { useSubmit } from "../api/idempotency";
import { Field } from "../components/Field";
import { PageLoading, useTitle } from "../components/Shell";
import { useToast } from "../components/Toast";
import { Icon, Logo } from "../components/ui";
import { currencyName, fmtDate } from "../lib/format";

/** Accepts an email invitation: claims the placeholder the owner made and confirms this email. */
export function Invite() {
  const params = useParams();
  const { hash } = useLocation();
  // Emailed links carry the token in the fragment (/invite#<token>) so it never hits server logs.
  const token = params.token ?? decodeURIComponent(hash.slice(1));
  const api = useApi();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, pending } = useSubmit();
  const [preview, setPreview] = useState<MemberInvitePreviewDTO | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  useTitle(preview ? `Join ${preview.projectName}` : "Your invitation");

  useEffect(() => {
    if (!token) return setLoadError(new ApiError(404, "NOT_FOUND", "This invitation link is incomplete."));
    api.previewMemberInvite(token).then(
      (p) => (setPreview(p), setName(p.displayName)),
      (e) => setLoadError(e instanceof ApiError ? e : new ApiError(500, "INTERNAL", errorMessage(e))),
    );
  }, [api, token]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const n = DisplayNameSchema.safeParse(name);
    if (!n.success) return setErrors({ displayName: n.error.issues[0]?.message ?? "Enter a name" });
    const body = { token, displayName: n.data };
    try {
      const r = await run(body, (k) => api.acceptMemberInvite(body, { idempotencyKey: k }));
      await refresh();
      toast(`You joined ${preview?.projectName ?? "the group"}`);
      navigate(`/g/${encodeURIComponent(r.projectId)}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVITE_INVALID") api.previewMemberInvite(token).then(setPreview, () => {});
      setErrors(err instanceof ApiError ? fieldErrors(err) : { _form: errorMessage(err) });
    }
  };

  return (
    <div className="narrow-page">
      <header className="narrow-head narrow-head-center">
        <Link to="/" aria-label="Splitdummy home" className="appbar-home">
          <Logo size={18} />
        </Link>
      </header>
      <main id="main" className="narrow-main">
        {!preview && !loadError && <PageLoading />}
        {loadError && (
          <div className="stack-12">
            <h1 className="page-h1">This invitation isn't available</h1>
            <p className="muted lede">
              {loadError.status === 404 ? "It may have been cancelled, replaced by a newer email, or mistyped. Ask the owner to send it again." : errorMessage(loadError)}
            </p>
            <Link to="/" className="btn btn-outline">Go to the start page</Link>
          </div>
        )}
        {preview && preview.alreadyMemberProjectId && (
          <div className="stack-12">
            <p className="muted">You're already in</p>
            <h1 className="page-h1">{preview.projectName}</h1>
            <Link to={`/g/${encodeURIComponent(preview.alreadyMemberProjectId)}`} className="btn btn-primary btn-block">Open the group</Link>
          </div>
        )}
        {preview && !preview.alreadyMemberProjectId && preview.status !== "OPEN" && (
          <div className="stack-12">
            <span className="inbox-icon" aria-hidden="true">
              <Icon name={preview.status === "EXPIRED" ? "schedule" : "how_to_reg"} size={30} />
            </span>
            <p className="muted">{preview.projectName}</p>
            <h1 className="page-h1">{preview.status === "EXPIRED" ? "This invitation has expired" : "This invitation was already used"}</h1>
            <p className="lede muted">
              {preview.status === "EXPIRED" ? "Ask the group owner to send you a new one." : "Sign in with the same email to open the group."}
            </p>
            {preview.status === "CLAIMED" && <Link to="/signin" className="btn btn-outline">Sign in</Link>}
          </div>
        )}
        {preview && !preview.alreadyMemberProjectId && preview.status === "OPEN" && (
          <>
            <p className="muted">You're invited to</p>
            <h1 className="page-h1 join-title">{preview.projectName}</h1>
            <p className="meta">
              <span className="meta-item">
                <Icon name="payments" size={16} />
                Settles in {preview.baseCurrency} ({currencyName(preview.baseCurrency)})
              </span>
            </p>
            <p className="small">
              The owner added you as <b>{preview.displayName}</b>. Anything already split with {preview.displayName} becomes yours.
            </p>
            <form className="stack-16" onSubmit={onSubmit} noValidate>
              <Field
                label="Your name"
                error={errors.displayName}
                hint={preview.canRename ? "How others in the group will see you." : "The owner manages names in this group."}
              >
                {(p) => (
                  <input {...p} className="input" value={name} maxLength={40} readOnly={!preview.canRename} autoComplete="given-name" onChange={(e) => (setName(e.target.value), setErrors({}))} />
                )}
              </Field>
              {errors._form && (
                <div className="form-error" role="alert">
                  <Icon name="error" size={18} />
                  {errors._form}
                </div>
              )}
              <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
                {pending ? "Joining…" : "Join"}
              </button>
              <p className="tiny muted">Joining signs you in with the email this invitation was sent to.</p>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
```

(`fmtDate` is unused here; remove it if lint complains.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project web && npx tsc -b`
Expected: PASS. Also run `grep -rn "as guest" src/web`; it must return nothing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): verified link joins with auto-join, and an accept page for email invites

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Web — Members card (add, manage, rename lock), placeholder tags, on-behalf tasks

**Files:**
- Create: `src/web/pages/group/MembersCard.tsx` (move `Members` out of `Settings.tsx` ~L472-581)
- Modify: `src/web/pages/group/Settings.tsx` (`YourName` lock, Invitations copy, use `MembersCard`)
- Modify: `src/web/pages/group/parts.tsx` (`Who`, `TaskCards`)
- Modify: `src/web/styles/pages.css` (chips)
- Test: `src/web/pages/group/MembersCard.test.tsx` (create)

**Interfaces:**
- Consumes: `api.addMember`, `renameMember`, `inviteMember`, `cancelMemberInvite`, `updateSettings({ membersCanRename })`; the mock seed placeholders `m_kid`, `m_nina` in `p_porto` (owner principal: see the seed, Lea per `Account.test.tsx`).
- Produces: `export function MembersCard({ view }: { view: ProjectViewDTO })`.

- [ ] **Step 1: Write the failing tests**

Create `src/web/pages/group/MembersCard.test.tsx`. Use the same `renderAt`/`mockAs` helpers as `Account.test.tsx`; the import paths are one level deeper (`../../`). Porto's owner is `pr_lea`.

```tsx
describe("members card", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
  });
  afterEach(() => cleanup());

  it("shows placeholder and invited chips and adds a person with an email", async () => {
    const api = mockAs("pr_lea");
    const add = vi.spyOn(api, "addMember");
    renderAt(api, "/g/p_porto/settings");
    expect(await screen.findByText("Placeholder")).toBeTruthy();
    expect(screen.getByText(/^Invited · expires/)).toBeTruthy();
    expect(screen.getByText("nina@example.com")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Omar" } });
    fireEvent.change(within(dialog).getByLabelText(/Email/), { target: { value: "omar2@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add & send invite" }));
    await waitFor(() => expect(add).toHaveBeenCalledWith("p_porto", { displayName: "Omar", email: "omar2@example.com" }, expect.anything()));
  });

  it("manages a member: rename, resend, cancel", async () => {
    const api = mockAs("pr_lea");
    const rename = vi.spyOn(api, "renameMember");
    const cancel = vi.spyOn(api, "cancelMemberInvite");
    renderAt(api, "/g/p_porto/settings");
    fireEvent.click(await screen.findByRole("button", { name: "Manage Nina" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Nina K" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith("p_porto", "m_nina", { displayName: "Nina K" }, expect.anything()));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel invite" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("p_porto", "m_nina", expect.anything()));
  });

  it("locking self-renaming makes 'Your name' read-only for members", async () => {
    const owner = mockAs("pr_lea");
    renderAt(owner, "/g/p_porto/settings");
    fireEvent.click(await screen.findByRole("switch", { name: /Members can change their own name/ }));
    await waitFor(async () => expect((await owner.getProject("p_porto")).project.membersCanRename).toBe(false));
  });
});
```

The `role="switch"` query assumes `Toggle` renders `role="switch"`. Check `src/web/components/Field.tsx` `Toggle` and use the role it actually renders (e.g. `checkbox`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project web src/web/pages/group/MembersCard.test.tsx`
Expected: FAIL. The "Placeholder" text and the "Add person" button don't exist yet.

- [ ] **Step 3: Implement**

Create `src/web/pages/group/MembersCard.tsx`. Move the `Members` function, its `useMutation` usage and its two `ConfirmDialog`s from `Settings.tsx` into it, and export `useMutation` from `Settings.tsx` (or move it into this file and import it back into `Settings.tsx`). Then change the members list and add the dialogs:

```tsx
/** Status line under a member's name. */
function memberRole(x: MemberDTO): string {
  if (x.isOwner) return "Owner";
  if (x.kind === "PLACEHOLDER") return x.inviteState === "INVITED" ? `Invited · expires ${fmtDate(x.inviteExpiresAt!)}` : x.inviteState === "INVITE_EXPIRED" ? "Invite expired" : "Placeholder";
  return x.isGuest ? (x.hasRecoverableAccount ? "Guest with email" : "Guest") : "Member";
}
```

In each row, replace the `tiny muted` line with:

```tsx
              <div className="tiny muted">
                {x.kind === "PLACEHOLDER" ? (
                  <span className={`chip-sm${x.inviteState === "INVITE_EXPIRED" ? " chip-warn" : ""}`}>{memberRole(x)}</span>
                ) : (
                  memberRole(x)
                )}
                {x.kind === "PERSON" && ` · joined ${fmtDate(x.joinedAt)}`}
              </div>
              {owner && x.invitedEmail && <div className="tiny muted">{x.invitedEmail}</div>}
```

and replace the row's Remove button / "In entries" span with one button that opens a manage sheet. The sheet holds Remove, so behaviour is kept:

```tsx
            {owner && !x.isOwner && (
              <button type="button" className="btn btn-ghost btn-sm" aria-label={`Manage ${x.displayName}`} onClick={() => setManaging(x)}>
                Manage
              </button>
            )}
```

Above the list (owner only, collecting or between rounds):

```tsx
      {owner && !settling && (
        <button type="button" className="btn btn-soft btn-md" onClick={() => setAdding(true)}>
          <Icon name="person_add" size={18} />
          Add person
        </button>
      )}
```

Below the list (owner only), the rename policy toggle:

```tsx
      {owner && (
        <div className="dashed-top">
          <Toggle
            checked={view.project.membersCanRename}
            disabled={m.pending}
            onChange={(v) => {
              const body = { expectedVersion: view.project.version, membersCanRename: v };
              void m.run(body, (k) => api.updateSettings(view.project.id, body, { idempotencyKey: k }), v ? "Members can rename themselves" : "Only you can change names now");
            }}
            label="Members can change their own name"
            description="When off, only you can rename people in this group."
          />
        </div>
      )}
```

New components in the same file:

```tsx
function AddPersonSheet({ view, onClose }: { view: ProjectViewDTO; onClose: () => void }) {
  const api = useApi();
  const m = useMutation();
  const toast = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = AddMemberSchema.safeParse({ displayName: name, ...(email.trim() ? { email } : {}) });
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      return setErrs({ [String(i?.path[0] ?? "_form")]: i?.message ?? "Check this" });
    }
    let result: AddMemberResultDTO | null = null;
    const ok = await m.run(parsed.data, async (k) => (result = await api.addMember(view.project.id, parsed.data, { idempotencyKey: k })));
    if (!ok) return;
    if (result && (result as AddMemberResultDTO).emailSent === false) toast(`Added ${parsed.data.displayName}, but the email didn't send. Use Resend.`, "info");
    else toast(parsed.data.email ? `Invitation sent to ${parsed.data.email}` : `Added ${parsed.data.displayName}`);
    onClose();
  };
  return (
    <Sheet title="Add person" onClose={onClose} size="sm">
      <form className="stack-16" onSubmit={submit} noValidate>
        <Field label="Name" error={errs.displayName} hint="How everyone in the group will see them.">
          {(p) => <input {...p} className="input" value={name} maxLength={40} autoFocus onChange={(e) => (setName(e.target.value), setErrs({}))} />}
        </Field>
        <Field label="Email (optional)" error={errs.email} hint="We'll email them an invitation valid for 7 days. Joining lets them take over this spot.">
          {(p) => <input {...p} className="input" type="email" inputMode="email" value={email} onChange={(e) => (setEmail(e.target.value), setErrs({}))} />}
        </Field>
        {m.error && <span className="field-error" role="alert"><Icon name="error" size={16} />{m.error}</span>}
        <button type="submit" className="btn btn-primary btn-block" disabled={m.pending}>
          {email.trim() ? "Add & send invite" : "Add"}
        </button>
      </form>
    </Sheet>
  );
}

function ManageMemberSheet({ view, member, onClose, onRemove }: { view: ProjectViewDTO; member: MemberDTO; onClose: () => void; onRemove: () => void }) {
  const api = useApi();
  const m = useMutation();
  const [name, setName] = useState(member.displayName);
  const [email, setEmail] = useState(member.invitedEmail ?? "");
  const pid = view.project.id;
  const settling = view.current.round.status === "SETTLING";
  const placeholder = member.kind === "PLACEHOLDER";
  const canRemove = view.current.round.status === "COLLECTING" && !member.referenced;
  return (
    <Sheet title={member.displayName} onClose={onClose} size="sm">
      <div className="stack-16">
        <form className="inline-form" noValidate onSubmit={(e) => {
          e.preventDefault();
          const body = { displayName: name.trim() };
          void m.run(body, (k) => api.renameMember(pid, member.id, body, { idempotencyKey: k }), "Name saved");
        }}>
          <Field label="Name" className="grow">
            {(p) => <input {...p} className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <button type="submit" className="btn btn-secondary btn-md" disabled={m.pending || !name.trim() || name.trim() === member.displayName}>Save name</button>
        </form>
        {placeholder && !settling && (
          <form className="inline-form" noValidate onSubmit={(e) => {
            e.preventDefault();
            const body = { email: email.trim() };
            void m.run(body, (k) => api.inviteMember(pid, member.id, body, { idempotencyKey: k }), `Invitation sent to ${body.email}`);
          }}>
            <Field label="Invite by email" className="grow">
              {(p) => <input {...p} className="input" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
            <button type="submit" className="btn btn-secondary btn-md" disabled={m.pending || !email.trim()}>
              {member.inviteState ? "Resend" : "Send"}
            </button>
          </form>
        )}
        {placeholder && member.inviteState && !settling && (
          <button type="button" className="btn btn-ghost btn-md" disabled={m.pending} onClick={() => void m.run({ cancel: member.id }, (k) => api.cancelMemberInvite(pid, member.id, { idempotencyKey: k }), "Invitation cancelled")}>
            Cancel invite
          </button>
        )}
        {canRemove ? (
          <button type="button" className="btn btn-ghost btn-md danger-text" onClick={onRemove}>
            <Icon name="person_remove" size={18} />
            Remove from group
          </button>
        ) : (
          <p className="tiny muted">{member.referenced ? "In entries, so they can't be removed." : "Members are locked while settling."}</p>
        )}
        {m.error && <span className="field-error" role="alert"><Icon name="error" size={16} />{m.error}</span>}
      </div>
    </Sheet>
  );
}
```

In `MembersCard`, add state `const [adding, setAdding] = useState(false); const [managing, setManaging] = useState<MemberDTO | null>(null); const settling = view.current.round.status === "SETTLING";`. Render `{adding && <AddPersonSheet view={view} onClose={() => setAdding(false)} />}` and `{managing && <ManageMemberSheet view={view} member={view.members.find((x) => x.id === managing.id) ?? managing} onClose={() => setManaging(null)} onRemove={() => (setRemoving(managing), setManaging(null))} />}`. Keep the transfer-ownership block; Task 10 fixes it visually. Imports: `Sheet` from `../../components/Dialog`, `Toggle` from `../../components/Field`, `AddMemberSchema`, `type AddMemberResultDTO`.

`Settings.tsx`:
- Replace `<Members view={view} />` with `<MembersCard view={view} />` and delete the old `Members` function.
- In `YourName`, add `const locked = !view.project.membersCanRename && !view.me.isOwner;`. When locked, render the input `readOnly`, hide the Save button, and set the note to "The owner manages names in this group." Otherwise keep the existing note.
- In `Invitations`, change the description to: "Anyone with the link can join after confirming their email. They can't take over someone who's already in the group. To invite a specific person, add them under Members."

`parts.tsx` `Who`:

```tsx
export function Who({ view, id, you }: { view: ProjectViewDTO; id: string | null | undefined; you?: boolean }) {
  const name = nameOf(view, id, { you });
  if (isDeleted(view, id)) return <span className="member-deleted">{name}</span>;
  const m = member(view, id);
  if (m?.kind === "PLACEHOLDER") return <>{name} <span className="chip-sm">{m.inviteState === "INVITED" ? "invited" : "placeholder"}</span></>;
  return <>{name}</>;
}
```

(import `member` from `../../lib/project`.)

`parts.tsx` `TaskCards`: let the owner act for placeholders:

```tsx
export function TaskCards({ view }: { view: ProjectViewDTO }) {
  const me = view.me.memberId;
  const isPh = (id: string) => view.me.isOwner && member(view, id)?.kind === "PLACEHOLDER";
  const tasks = view.current.instructions.filter(
    (i) =>
      ((i.toMemberId === me || isPh(i.toMemberId)) && i.state === "SENT") ||
      ((i.fromMemberId === me || isPh(i.fromMemberId)) && (i.state === "PROPOSED" || i.state === "DISPUTED")),
  );
  …unchanged sort/render…
}
```

In `TaskCard`, compute `const forName = (id: string) => (id === me ? null : nameOf(view, id));`. The recipient branch's condition becomes `if (i.toMemberId === me || (i.state === "SENT" && i.toMemberId !== i.fromMemberId && member(view, i.toMemberId)?.kind === "PLACEHOLDER"))`. When `forName(...)` is non-null, prefix the text with `For {forName(...)}: `. Label the buttons "Received (for X)" / "Mark sent for X" in that case, e.g. `{forName(i.fromMemberId) ? \`Mark sent for ${forName(i.fromMemberId)}\` : "I've sent it"}`.

`pages.css` append:

```css
.chip-sm {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--surface2);
  color: var(--ink2);
  font-size: 12px;
  font-weight: 600;
  vertical-align: 1px;
}
.chip-warn {
  background: color-mix(in srgb, var(--amber, #c98a00) 16%, transparent);
  color: var(--ink);
}
```

(Check `tokens.css` for the real amber token name and use it instead of the fallback.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project web && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): add and manage people, rename lock, placeholder tags and owner stand-in tasks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Web — Settings UI fixes (Save alignment, blurred Transfer ownership select)

**Files:**
- Modify: `src/web/styles/pages.css` (`.inline-form` ~L2019), `src/web/pages/group/Settings.tsx` (`CurrencySettings` ~L202), `src/web/pages/group/MembersCard.tsx` (transfer select), possibly `src/web/styles/components.css`
- Test: manual browser check with screenshots (Playwright is installed: `@playwright/test` 1.63)

- [ ] **Step 1: Reproduce both bugs and capture evidence**

Start the mock app: `VITE_MOCK=1 npx vite --port 5179` (in the background). Write `/private/tmp/claude-501/-Users-mtajchert-coding-priv-splitdummy/50ebdb9f-b992-4395-a0d4-beb26b8db25a/scratchpad/settings-shot.mjs`:

```js
import { chromium } from "@playwright/test";
const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 1600 }, colorScheme: scheme });
    await page.goto("http://localhost:5179/g/p_porto/settings?latency=0");
    await page.waitForSelector("text=Change settlement currency");
    await page.screenshot({ path: `scratch-settings-${scheme}-${width}.png`, fullPage: true });
    const sel = page.locator('select[aria-label="New owner"]');
    if (await sel.count()) {
      console.log(scheme, width, await sel.evaluate((el) => { const s = getComputedStyle(el); return { filter: s.filter, backdrop: s.backdropFilter, opacity: s.opacity, color: s.color, bg: s.backgroundColor, transform: s.transform, textShadow: s.textShadow }; }));
      const wrap = sel.locator("xpath=ancestor::*[contains(@class,'dashed-top')]");
      console.log("ancestor", await wrap.evaluate((el) => { const s = getComputedStyle(el); return { filter: s.filter, opacity: s.opacity, backdrop: s.backdropFilter }; }));
    }
    await page.close();
  }
}
await browser.close();
```

Run it with `node` from the scratchpad (install chromium with `npx playwright install chromium` if missing). Open the screenshots with the Read tool. The mock's "me" must be Porto's owner Lea: set `localStorage["splitdummy-mock-v3"]` `me = "pr_lea"` via `page.addInitScript` before `goto` if the default user isn't the owner. Also make sure Porto has a recoverable non-owner member, so the transfer select renders. Kai is an ACCOUNT in the seed; add Kai to Porto if needed.

Expected evidence:
1. The currency Save button's bottom edge lines up with the hint text, not the select.
2. Computed styles explain the blur. Look for a `filter`/`opacity`/`backdrop-filter` on the select or an ancestor, or a native `<select>` rendered over a translucent background. Record the actual cause before fixing. Use `superpowers:systematic-debugging` if it's not obvious.

- [ ] **Step 2: Fix the Save alignment**

In `CurrencySettings`, move the hint out of the inline row, so that `align-items: flex-end` aligns the button with the select:

```tsx
          <div className="stack-6">
            <div className="inline-form">
              <Field label="Change settlement currency" className="grow">
                {(fp) => <CurrencySelect {...fp} value={base} onChange={setBase} />}
              </Field>
              <button type="button" className="btn btn-secondary btn-md" disabled={base === p.baseCurrency || m.pending} onClick={() => void applyBase()}>
                Save
              </button>
            </div>
            <p className="field-hint">Possible only until the first entry is added.</p>
          </div>
```

If `.stack-6` doesn't exist, use the nearest existing stack class (`grep -n "\.stack-" src/web/styles/*.css`). Grep the other `inline-form` uses (`grep -rn "inline-form" src/web/pages`) and apply the same change to any whose `Field` has a `hint`.

- [ ] **Step 3: Fix the select blur at its cause**

Apply the minimal fix for the cause found in Step 1, and make the control match `CurrencySelect`, so both selects render through the same `.select-wrap > .input.select` markup and CSS. If the cause is in shared CSS (`components.css` `.select`), fix it there so every select benefits. Re-run the screenshot script and confirm by reading the PNGs:
- In light and dark mode, at 390px and 1280px wide, the transfer select is crisp and looks like the currency select.
- The currency Save button lines up with the select.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project web && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(web): align settings Save buttons with their control; un-blur the new-owner select

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Never commit the screenshots; they live in the scratchpad.)

---

### Task 11: Docs and full verification

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `docs/splitdummy-development-handoff.md` (§3 roles, §Join row in the pages table, the guest bullets at ~L297-298)
- Modify: `src/shared/api-guide.ts` if it describes joining or guests (`grep -n -i "guest\|join" src/shared/api-guide.ts`)

- [ ] **Step 1: Update docs**

- `ARCHITECTURE.md`, under "Runtime layout", add one line: "Members: ProjectDO also holds placeholders (`kind = PLACEHOLDER`, synthetic `ph:` principal) and their 7-day email invites; invite secrets are stored hashed and leave the DO only via `DoResponse.transient`, which is never persisted."
- Handoff doc:
  - Replace "participants can join as guests" / "Guest joining" wording with "participants join with a verified email (magic link), or are added by the owner as placeholders and invited by email."
  - In the Join row, write "Group name, display name, email verification; never claim an existing person by name."
  - Update the security bullet about guest principals to "New members always have a verified email; existing guest sessions keep working."
- `api-guide.ts`: mention the four owner member endpoints if it lists endpoints by hand.

- [ ] **Step 2: Full verification**

Run: `npx tsc -b && npx vitest run`
Expected: types clean; all suites pass (479 baseline + new tests, minus the 3 edge tests deleted in Task 6).

Run: `grep -rn "as guest" src/web; grep -rn "deleteGuest" worker test`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: placeholders, email invites and verified joins

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
