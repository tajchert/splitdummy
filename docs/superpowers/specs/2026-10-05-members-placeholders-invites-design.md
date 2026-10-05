# Members: placeholders, email invites, verified link joins, renaming

Date: 2026-10-05 · Status: approved design, pending implementation plan

## Goal

Give the group owner control over who is in the group, including people without an account, and make every
real participant a verified-email account.

1. Owner adds **placeholders**: named members without an account, usable in expenses right away.
2. Owner **renames** any member.
3. Owner **invites by email**. The invite is emailed, valid 7 days, visibly stateful (Invited / Invite expired).
   Accepting from the email claims the placeholder and counts as a verified email.
4. **Link joins require a verified email.** No new anonymous guests. The join button reads "Join".
5. Owner can **lock self-renaming** in a group.
6. Fix: Settings › Currency "Save" button misaligned with the currency select.
7. Fix: Settings › Transfer ownership select renders blurred.

Existing unverified guests keep working unchanged (pre-launch; no migration). The new rules apply to new joins only.

## Decisions

| Topic | Decision |
|---|---|
| Placeholder ↔ invite | **Unified.** An email invite is a placeholder member with an invited email. An invite can be added to any placeholder later. Accepting claims that member (same member id, so all entries/transfers carry over). |
| Acting for placeholders | Placeholders are excluded from readiness. In settlement the **owner** marks sent/received/disputed on their behalf, audited "on behalf of". |
| Placeholder storage | Synthetic `principal_id = 'ph:' + memberId` inside the DO (no `members` table rebuild, no D1 rows). |
| Link-join verification | Reuse the existing magic-link sign-in; the link returns to the join page, which auto-completes the join. |

## Data model (ProjectDO, migration #3, append-only)

```sql
ALTER TABLE members ADD COLUMN kind TEXT NOT NULL DEFAULT 'PERSON';      -- 'PERSON' | 'PLACEHOLDER'
ALTER TABLE members ADD COLUMN invited_email TEXT;                        -- lowercased; owner-only visibility
ALTER TABLE members ADD COLUMN invite_secret_hash TEXT;                   -- SHA-256(secret), NULL when no live invite
ALTER TABLE members ADD COLUMN invite_sent_at TEXT;
ALTER TABLE members ADD COLUMN invite_expires_at TEXT;
CREATE UNIQUE INDEX members_invite_secret ON members(invite_secret_hash) WHERE invite_secret_hash IS NOT NULL;
ALTER TABLE project ADD COLUMN members_can_rename INTEGER NOT NULL DEFAULT 1;
```

- Placeholder rows: `principal_id = 'ph:<memberId>'`, `kind = 'PLACEHOLDER'`, `is_guest = 0`,
  `has_recoverable_account = 0`, `status = 'ACTIVE'`. Edge principals are `pr_…` ids, so `ph:` can never collide.
- `MEMBER_INVITE_TTL_MS = 7 days` (separate from the 14-day link `INVITE_TTL_MS`).
- Placeholders count toward `LIMITS.members` / `LIMITS.memberRows`.

### Derived invite state

| State | Condition |
|---|---|
| `null` (placeholder) | `kind = PLACEHOLDER`, no `invited_email` |
| `INVITED` | `kind = PLACEHOLDER`, `invited_email` set, `invite_expires_at > now` |
| `INVITE_EXPIRED` | `kind = PLACEHOLDER`, `invited_email` set, `invite_expires_at <= now` |
| — | `kind = PERSON`: existing Owner/Member/Guest semantics |

## Contract changes (additive)

`src/shared/api.ts`:

- `MemberDTO` + `kind: "PERSON" | "PLACEHOLDER"`, `inviteState: "INVITED" | "INVITE_EXPIRED" | null`,
  `inviteExpiresAt: string | null`, `invitedEmail?: string | null` (owner view only).
- `ProjectDTO` + `membersCanRename: boolean`.
- `UpdateSettingsSchema` + `membersCanRename?: boolean`.
- New schemas: `AddMemberSchema { displayName, email? }`, `InviteMemberSchema { email }`,
  `RenameMemberSchema` reused for owner rename, `AcceptMemberInviteSchema { token, displayName? }`.
- New DTOs: `MemberInvitePreviewDTO { projectName, baseCurrency, displayName, status: "OPEN"|"EXPIRED"|"REVOKED"|"CLAIMED", canRename, alreadyMemberProjectId }`,
  `AddMemberResultDTO = MemberDTO & { emailSent: boolean | null }` (null when no email given).
- New error codes: `EMAIL_REQUIRED` (link join without a verified email), `ALREADY_MEMBER` (accepting an invite
  while already an active member under another identity).
- `RequestSignInSchema.next` max length 200 → 500 (fits `/join/<token>?name=…&auto=1`).

Endpoints:

| Method + path | Op | Who |
|---|---|---|
| `POST /api/projects/:id/members` | `addMember` | owner |
| `PATCH /api/projects/:id/members/:memberId` | `renameMember` | owner |
| `POST /api/projects/:id/members/:memberId/invite` | `inviteMember` (attach email or resend: new secret, new 7 days) | owner |
| `DELETE /api/projects/:id/members/:memberId/invite` | `cancelMemberInvite` (back to plain placeholder) | owner |
| `GET /api/member-invites/:token` | `previewMemberInvite` | public |
| `POST /api/member-invites/accept` | `acceptMemberInvite` | public (email link proves the address) |

`worker/do/types.ts`: add the ops above. `previewMemberInvite` also returns `invitedEmail` **to the edge only**
(the edge strips it before responding). Token format matches link invites: `${projectId}.${secret}`.

Add the new endpoints to the public-API allowlist (`src/shared/public-api.ts`) for the owner member ops only. The
member-invite routes stay cookie/unauthenticated-only, like `/api/invitations/*`.

## Rules

- **Add / invite / cancel / remove** require `COLLECTING` (membership is locked while settling, as today).
- **Accepting** an outstanding invite is allowed in any round state. Claiming changes no accounting.
- **Remove** keeps today's rule: unreferenced only, collecting only. Removing an invited placeholder also clears its invite.
- **Readiness**: `readinessList` excludes `kind = PLACEHOLDER`, so placeholders never block or appear in a freeze.
  When a placeholder is claimed during collecting, readiness is cleared for everyone, as for a join.
- **Settlement**: in `transition()`, if the sender/recipient member is a placeholder, the owner may act for that side.
  Audit summary: "Anna marked … (on behalf of Bob)", with `details.onBehalfOfMemberId`. Once claimed, only the real person acts.
- **Ledger**: placeholders are valid payers/participants everywhere a member is; no change to accounting.
- **Ownership** cannot be offered to a placeholder (it has no recoverable account; the existing check covers it).
- **Rename**: `renameMember` (owner, any member incl. placeholders, any round state). `renameMe` throws 403
  `FORBIDDEN` "The owner manages names in this group." when `members_can_rename = 0` and the caller isn't the owner.
  `acceptMemberInvite.displayName` is ignored when renaming is locked. Audits: `MEMBER_RENAMED` with
  `details.byMemberId` for owner renames; `MEMBER_ADDED`, `MEMBER_INVITED`, `MEMBER_INVITE_CANCELLED`,
  `MEMBER_CLAIMED`, `SETTINGS_UPDATED` (rename lock).
- **Directory/notifications**: `DIRECTORY_UPSERT` and `NOTIFY` skip `ph:` principals. A claim emits a directory
  upsert so the group appears in the new member's "My groups".

## Flows

### Owner adds a person (optionally with email)

1. Owner submits `{ displayName, email? }`. The edge rate-limits (`RL_MUTATION` per principal, plus
   `RL_SIGNIN_EMAIL` per invited address).
2. When an email is present, the edge prepares `{ secret, secretHash }` as for link invites. The DO inserts the
   placeholder and stores the hash, `invited_email`, `invite_sent_at` and `invite_expires_at`, then returns the
   accept URL `${APP_ORIGIN}/invite#${projectId}.${secret}`.
   - The DO rejects the email if an active PERSON member already has it as a verified email, or another
     placeholder already has it as `invited_email` (422 on the `email` field).
3. The edge sends `memberInviteEmail({ inviterName, projectName, displayName, url, expiresAt })` synchronously,
   like sign-in links. The response includes `emailSent`. A failed send leaves the invite in place, and the UI
   offers "Resend". Local dev returns `devLink` as sign-in does.
4. The raw secret is never persisted or logged.

`inviteMember` (attach an email to a placeholder, or resend) follows steps 2–3 and replaces any previous secret.

### Invitee accepts (`/invite#<token>`)

1. The page calls `GET /api/member-invites/:token` and shows "You're invited to **Trip** as **Anna**", with a name
   field (prefilled, editable only if `canRename`) and a **Join** button. Expired/revoked/claimed invites reuse
   the Join page's "ask the owner" screens. No auto-accept on load (mail scanners).
2. `POST /api/member-invites/accept { token, displayName? }`:
   1. The edge calls `previewMemberInvite` to get `invitedEmail` and validate status.
   2. `findOrCreateAccount(invitedEmail)`, which yields an ACCOUNT principal with a verified email.
   3. The DO `acceptMemberInvite` checks atomically that the hash matches, the invite isn't expired, the member is
      still a placeholder, and the principal isn't already an ACTIVE member (otherwise 409 `ALREADY_MEMBER`
      "You're already in this group as X"). It then sets `principal_id`, `kind = PERSON`, `is_guest = 0`,
      `has_recoverable_account = 1`, optionally `display_name`, and clears the invite columns. It audits
      `MEMBER_CLAIMED`.
   4. The edge revokes any current browser session, creates a session for the account, sets the cookie, and
      records the membership in `project_directory`. Returns `{ projectId, memberId }`.
3. If the browser was signed in as a different person, it is now signed in as the invited account (same as
   clicking a sign-in link).

### Link join (`/join#<token>`), changed

- **Signed in, verified email** (`me.email` set): name field plus a **Join** button. The edge `join` route calls
  the DO directly; no Turnstile, since sign-in already passed it.
- **Not signed in, or an un-emailed guest**: name and email fields plus Turnstile, then "Email me a link". It calls
  `POST /api/auth/email` with `next = /join/<token>?name=<name>&auto=1`. An un-emailed guest session is upgraded
  on verify (existing behaviour). Afterwards the page shows "Check your inbox".
- **Return from the magic link**: the Join page sees `auto=1`, a verified `me`, and an OPEN preview. It submits the
  join once with `name`, then strips `auto` from the URL so refreshes don't resubmit.
- **Edge `join` route**: no longer calls `createGuest`. It requires a session whose principal has an email,
  otherwise 401 `EMAIL_REQUIRED`. The Turnstile check is removed from this route.
- **DO `join`**: if an INVITED/INVITE_EXPIRED placeholder's `invited_email` equals the principal's email, it claims
  that member (as in accept) instead of inserting a new one.

## UI

**Settings › Members (owner):**

- Rows show a chip: *Placeholder*, *Invited · expires 12 Oct*, *Invite expired*, or the existing
  Owner/Member/Guest. The owner sees the invited email under the name.
- A row menu offers whatever applies: Rename, Invite by email (placeholder), Resend invite (invited/expired),
  Cancel invite, Remove.
- "Add person" opens a dialog with Name and Email (optional, "We'll email them an invitation valid for 7 days").
  The primary button reads "Add" or "Add & send invite".
- Toggle: "Members can change their own name".

**Settings › Your name (non-owner):** read-only with "The owner manages names in this group." when locked.

**Settings › Invite people (link):** copy changes to "Anyone with the link can join after confirming their
email…".

**Elsewhere:**

- Placeholders render with a small muted tag ("placeholder"/"invited") in member pickers, balances and
  settlement rows. They're absent from readiness lists.
- On settlement rows where a placeholder is a party, the owner sees "Mark sent for Bob" / "Confirm for Bob".

**Pages:**

- New `/invite` page (`src/web/pages/Invite.tsx`), styled like Join.
- Join page states as described in Flows. The guest note and "Join as guest" button are removed.

### Fixes

- **Save alignment:** `.inline-form` uses `align-items: flex-end`, and the field hint sits inside the flex child,
  so the button aligns with the hint instead of the select. Render the hint below the `.inline-form` row (or align
  the button to the control) wherever a hinted Field sits in an inline form.
- **Transfer ownership blur:** reproduce in the browser to find the actual cause, fix it, and make the control use
  the same select component and styling as `CurrencySelect`.

## Error handling

- Invite email send failure: the member and invite remain, `emailSent: false`, and the owner sees "Couldn't send
  the email — Resend".
- Invalid, expired, revoked or claimed member-invite tokens: 404 `INVITE_INVALID` for unknown tokens, and a preview
  `status` for known ones. Accepting a non-OPEN invite returns 409 `INVITE_INVALID` with `{ status }`.
- Concurrency: the DO serialises requests. A double-click on Accept is covered by the idempotency key, and a second
  claim attempt sees `kind = PERSON` and returns 409 `INVITE_INVALID { status: "CLAIMED" }` (or the same result for
  the same principal).
- If `findOrCreateAccount` succeeds but the DO accept fails, an unused account remains. This is harmless; it is
  just an account with a verified email.

## Security

- Member-invite secrets: 32 random bytes, stored only as SHA-256, kept in the URL fragment, single-use (cleared on
  claim), and expiring after 7 days.
- Accepting signs the browser into the invited email's account. This is equivalent to a magic link: possession of
  the emailed link proves control of the address.
- `invitedEmail` is returned only to the owner (in the project view) and to the edge (in the preview). It is never
  returned by the public preview response.
- Email-sending abuse is bounded by owner-only access, `RL_MUTATION`, `RL_SIGNIN_EMAIL` per recipient, and
  `LIMITS.members`.

## Testing

- **`test/do`:**
  - Add a placeholder, with and without an email.
  - Placeholders as payer and participant.
  - Readiness excludes placeholders.
  - Owner acts on behalf of a placeholder in settlement; non-owners are rejected; claimed members can no longer
    be acted for.
  - Accept claims the placeholder and keeps its member id and entries.
  - Accept when expired, cancelled, already claimed, or `ALREADY_MEMBER`.
  - Resend rotates the secret, so the old link fails.
  - Membership ops are rejected while settling; accept is allowed while settling.
  - Rename lock and owner rename, with audits.
  - Directory upsert skips `ph:` principals.
  - Link join with a matching invited email claims the placeholder.
- **`test/edge`:**
  - Add with email sends the email (`devLink`).
  - Accept creates or reuses the account, rotates the session, and writes the directory row.
  - The preview response has no `invitedEmail`.
  - Join without a session or with an un-emailed guest returns 401 `EMAIL_REQUIRED`.
  - Join with a verified session succeeds without Turnstile.
  - `next` up to 500 characters is accepted.
- **`test/web`:**
  - Join page: verified flow, email-request flow, and auto-join on return (single submit).
  - Invite page: open, expired, and locked-name states.
  - Members card: add, invite, resend, cancel, rename, and toggle.
  - Locked "Your name" card.
- Manual check of both visual fixes in the browser (light and dark, mobile width).

## Out of scope

- Merging two existing members. A placeholder can only be claimed through an email invite (or a link join with
  the matching invited email), never by picking a name.
- Forcing existing unverified guests to verify.
- Placeholders marking readiness or the owner marking readiness for them.
