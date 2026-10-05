# Splitdummy — Product Specification

Version 1.0 · 4 October 2026

The product rules and first-release scope that the implementation follows. For how it is built, see [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Purpose and product promise

**Split the costs. Know when you’re done.**

Splitdummy is a mobile-first website for sharing expenses within a trip, event, or small group. Its central promise is a clear finish line: members enter expenses, indicate they have finished, and the owner freezes the ledger to start settlement. Payment instructions remain stable while people repay each other.

Product description:

> Create a group, invite your friends, and record who paid for what. Mark “Everything added from my side” when you’re finished. The owner freezes the expenses and Splitdummy creates a clear settlement plan. Track who has sent and received money, then finish with an “All settled” group. For trips abroad, the owner can enable multiple expense currencies while keeping one clear settlement currency.

Success means a participant can understand their position, add a normal expense quickly, and follow repayment instructions without those instructions changing unexpectedly.

### Core requirements

- Product name: Splitdummy.
- A simpler, easier-to-use alternative to Splitwise.
- Every group/project has an owner who can freeze expense entry and begin settlement.
- Participants can mark “Everything added from my side.”
- Default projects use one currency without extra currency-entry friction.
- Owners can opt into multiple currencies at creation or by editing project settings.
- Hosting and application services run entirely on Cloudflare.

### Product decisions in this specification

- Begin with finite trips/events and small groups; ongoing households use successive rounds.
- Payments happen outside Splitdummy; the website records participant confirmations.
- Frozen rounds cannot be reopened or rewritten. Corrections use a subsequent round.
- Multiple expense currencies convert into one project settlement currency.
- Initial conversion uses explicit, saved manual rates or the payer’s known converted amount. An external exchange-rate feed is not a launch dependency.
- Owner accounts are recoverable; participants can join as guests.

## 2. Scope

### Required for first release

1. Owner account creation, sign-in, and recovery.
2. Create a project and share a revocable invitation link.
3. Guest joining, distinct member identities, optional account upgrade.
4. Add expenses with one payer, selected participants, equal or exact splitting.
5. Add refunds using an explicit refund form.
6. Edit/delete entries while the round is collecting.
7. Explainable provisional balances and group expense history.
8. Readiness checklist, owner review, and atomic freeze.
9. Fixed settlement instructions and sent/received/disputed states.
10. Automatic completion when all required transfers are confirmed.
11. Single-currency default and owner-enabled multi-currency support.
12. Separate correction rounds, audit history, and CSV export.
13. Live updates and clear retry/conflict handling.

### Deferred

Receipt attachments/OCR, AI entry, automatic market FX rates, percentage/share/itemized splits, multiple payers on one expense, partial repayments, bank connectivity, payment processing, recurring expense automation, native mobile applications, cross-project simplification, and automatic offline submission.

Keep the database model capable of multiple contributions, but expose one payer in the first-release form. Do not delay the release to implement deferred features.

## 3. Roles and permissions

| Action | Owner | Participant |
|---|---|---|
| View group entries, explanations, settlement, and history | Yes | Yes |
| Add expense/refund while collecting | Yes | Yes |
| Edit/delete own entries while collecting | Yes | Yes |
| Edit/delete another member’s entry while collecting | Yes, audited | No |
| Mark/unmark personal readiness | Yes | Yes |
| Mark someone else ready | No | No |
| Change currency settings or manage invitations | Yes | No |
| Freeze/start settlement | Yes | No |
| Mark a transfer sent | Only when its sender | Only when its sender |
| Confirm receipt or dispute receipt | Only when its recipient | Only when its recipient |
| Start a subsequent round | Yes | No |
| Rewrite a frozen round | No | No |

The creator is the initial owner. Owner reassignment is allowed only while collecting, requires the target member to have a recoverable account and explicitly accept, and leaves exactly one owner. Never use a display name as an identity or permission key.

Participants cannot be removed if any ledger entry or settlement references them. An owner can remove an unreferenced member while collecting. Leaving a referenced group may hide it from a member’s dashboard, but retains their accounting identity and obligations.

## 4. Project and round lifecycle

A project is the lasting container. A round is its accounting period. Only one round is active at a time.

```text
COLLECTING → SETTLING → SETTLED
     owner freezes       all transfers confirmed
```

Review is a screen within collecting, not a separate mutable accounting state. “Freeze expenses” and “All settled” are distinct concepts in the UI.

### Collecting

- Members can add and correct expenses/refunds.
- Balances are provisional; there are no actionable settlement instructions.
- The readiness button says “Everything added from my side.” It can be undone.
- Readiness means the person finished entering their expenses; it is not approval of everyone else’s entries.
- A ledger mutation clears readiness for the actor and original entry creator, if different. It does not clear everyone’s readiness for an unrelated new expense.
- Joining, removal, accepted ownership transfer, or currency-mode changes clear all readiness flags. Changing an FX default alone affects only future entries and does not clear readiness.
- Every financially relevant mutation increments the round ledger version. Readiness changes also increment the review version used for freeze concurrency checks.
- A person who has no expenses can still mark ready.

### Owner review and freeze

Review shows members and readiness, expense/refund totals, currency breakdown, base-currency totals, each person’s net position, and a clearly labelled preview of proposed transfers.

Default action: “Freeze expenses & start settlement.” When some members are not ready, require an explicit acknowledgement listing them. Record an early-freeze reason and expose it in history. Readiness never freezes automatically.

Freeze commits the expense snapshot, contributions/allocations, rates, balances, participant identities, algorithm version, and settlement instructions together with the state transition. If the reviewed version is stale, return a conflict and require review again. If anything fails, the round remains collecting with no partial settlement.

### Settling

- No additions, edits, deletions, membership changes, or currency-setting changes are allowed.
- Fixed instructions show sender, recipient, amount, and settlement currency.
- Settling an instruction updates progress only; it does not reroute other instructions.
- The sender marks “I’ve sent it”; the recipient then selects “Received” or “Not received.”
- Instruction state: `PROPOSED → SENT → CONFIRMED`, or `SENT → DISPUTED → SENT` after sender resolution and a new claim of payment.
- A dispute remains unresolved until the recipient confirms receipt. There is no timeout confirmation or owner override.
- Repeated clicks/retries act on the same instruction. Confirmed transfers cannot be deleted or marked unpaid through the normal UI.
- First release supports confirmation of the full instructed amount. Partial transfers and alternative-currency repayments remain outside the app; members coordinate externally until the full specified amount is received.

### Settled and corrections

When all instructions are confirmed, transition to settled atomically. A zero-balance round becomes settled in the freeze transaction without generating transfers.

The owner can then start a new round. Readiness starts clear. A late expense/refund is entered only in that new collecting round; it never changes a previous round. An erroneous historical entry is corrected with a signed adjustment referencing that entry and explaining the difference. Only owners can create adjustments, with an explicit correction form and audit record.

Corrections use the historical stored base amounts, not today’s exchange rate. For example, reversing a historical foreign expense reverses its exact original base contribution/allocation. Replacement facts form a new entry with a newly agreed rate. Settled rounds are never included again in a new round’s balance calculation.

## 5. Currency behavior — mandatory first-release feature

### One settlement currency per project

Project creation asks for the project currency, which is also the settlement currency. Choose from a maintained ISO 4217 fiat-currency list using currency codes and localized labels. Do not identify currency by symbols alone. Support at least zero-, two-, and three-decimal currencies, including JPY, EUR/PLN/USD, and KWD.

Default `multiCurrencyEnabled = false`. The expense form displays the project currency beside the amount and omits the currency selector and exchange-rate fields.

The owner sees an optional toggle: **“Allow expenses in other currencies.”** Explain: “Expenses can use different currencies. Everyone settles in [project currency].”

### Enabling and disabling later

- The owner can enable multi-currency during creation or while the active round is collecting, including after expenses already exist.
- Existing same-currency entries remain unchanged; their conversion rate is 1.
- The owner can disable it only if the current collecting round contains no non-base-currency entries. Otherwise explain why and reject the change; do not hide or silently convert those entries.
- Previously frozen rounds with foreign expenses retain their currencies and rates even if a later collecting round disables the feature.
- Currency mode cannot change while settling. With no active round, it can change for the next round without modifying history.
- The project’s settlement currency can change only before the project’s first ledger entry. After any entry is committed, keep it fixed across all rounds. Changing the accounting base later requires a separate project.
- Every transition affecting entry capability is server-enforced, audited, and protected against stale settings writes.

### Multi-currency expense entry

Show a compact currency selector, initially defaulting to the project currency. Remember a member’s last foreign currency for a convenience shortcut, but never silently apply it as a new default amount currency. Common project currencies should be easy to select.

When the selected currency differs from the base:

1. If an owner has saved a rate for that currency pair, prefill it and show who set it and when. The member explicitly sees the resulting base amount before saving.
2. Otherwise ask for either an exchange rate or the actual amount charged in the project currency. Do not fabricate a rate.
3. Rate wording is unambiguous: **“1 EUR = 4.30 PLN.”**
4. Example preview: **“100.00 EUR → 430.00 PLN. This saved conversion will not change automatically.”**
5. Members may override a default on an individual expense to record their bank’s actual charge. Preserve the entry creator and rate provenance in history.

Owners manage reusable rate defaults in settings. Updating a default affects new entries only. Editing the rate or converted amount of an existing entry requires a normal explicit expense edit while collecting and resets the relevant readiness flags.

No currency field or FX requirement appears when an expense uses the project currency, even in a multi-currency project.

### Stored conversion and rounding

Each ledger entry records:

- Original integer amount in original minor units; currency code and minor-unit exponent.
- Base integer amount in settlement minor units; base currency and exponent.
- Positive exchange rate as an exact decimal string or rational numerator/denominator, never a binary floating-point calculation.
- Conversion method (`IDENTITY`, `MANUAL_RATE`, or `ACTUAL_BASE_AMOUNT`).
- Rate setter, timestamp, and optional explanatory note. Manual rates must not be labelled market rates.
- Original and base allocations and contributions.

Conversion direction is base major units per one original major unit. Calculate `baseMinor = roundHalfUp(originalMinor × rate × 10^baseExponent / 10^originalExponent)` using exact arithmetic. An actual-base-amount entry instead uses the user-entered base integer as authoritative and derives a display rate.

For equal splits, allocate original minor units deterministically, then apportion the saved base total proportionally to those original allocations. For exact splits, require original allocations to sum to the original amount and apportion the base total proportionally. Use largest remainder with ascending stable member ID as the tie-breaker; zero original shares receive zero base shares. Do not independently round shares and allow the total to drift.

Each payer’s base contribution equals the saved base amount. Refunds use positive magnitudes but reverse the balance effects: the recipient of refunded money is debited and the beneficiaries’ allocations are credited. Preserve the original expense’s conversion for a reversal; a distinct refund with a different actual conversion must display that difference.

### Currency presentation and export

- Expense cards show the original amount prominently and its base equivalent beneath it when different.
- Group totals and balances are in the settlement currency. Provide original-currency subtotals separately; never add EUR and PLN amounts into an unlabelled total.
- Every transfer instruction is in the settlement currency. Paying in a different currency does not trigger any app recalculation; participants agree externally how to deliver the instructed value.
- CSV includes both currencies, original/base amounts, conversion method, rate, timestamp, allocations, and round IDs.
- Formatting is locale-aware, but currency identity is explicit and unrelated to UI language.
- Reject unsupported codes, invalid precision, nonpositive rates, excessive amounts, and malformed decimal input. Support decimal commas according to the input locale; reject ambiguous separators rather than guessing.
- First-release amount limit: each amount and cumulative absolute round total must be at most `1,000,000,000,000` minor units; intermediate arithmetic uses BigInt/rationals. Rates accept up to 12 fractional digits and a positive maximum of `1,000,000,000`. Reject a nonzero foreign expense that rounds to zero base minor units with an explanation.

## 6. Core screens and UX

| Screen | Required content and action |
|---|---|
| Landing | Product promise, create group, join invitation, sign in |
| Create project | Name, settlement currency, optional multi-currency toggle |
| Join | Group name, display name, create distinct guest identity; never claim an existing person by name |
| Group — collecting | Add expense, total, personal provisional balance, readiness checklist, entry list |
| Expense/refund form | Description, date, amount, payer/refund recipient, participants, split mode; foreign currency controls only when relevant |
| Balance explanation | Contributions, allocated costs/refunds, resulting net position, relevant entries |
| Owner review | Readiness, currencies/rates, totals, provisional plan, freeze acknowledgement |
| Group — settling | Fixed instructions, personal send/receive tasks, disputes, progress, read-only expenses |
| Group — settled | All settled, history, export, owner action to start next round |
| Settings | Currency mode and rate defaults, invitations, membership, ownership, account recovery |

Use clear expense/refund/transfer vocabulary. The main add button creates a shared expense, never a repayment disguised as an expense. Explain simplified transfers: “You owe the group X; this payment routes part of that amount to someone the group owes.”

Design for small phone screens, keyboard navigation, screen readers, meaningful loading states, and minimum WCAG 2.2 AA contrast. Every form error identifies the field and preserves entered values. A local unsent draft is allowed, but must never imply acceptance; stale drafts submitted after freeze are rejected and remain available to copy into a later round.

## 7. Cloudflare architecture

| Component | Choice and responsibility |
|---|---|
| Frontend | React + TypeScript + Vite, hosted by Workers Static Assets |
| API | TypeScript Worker, shared request schemas, authenticated routing |
| Group authority | One SQLite-backed Durable Object per project; all rounds, memberships, ledger facts, readiness, snapshots, transfers, audit, and outbox |
| Account directory | D1 for accounts, revocable sessions, hashed sign-in/recovery tokens, and member-to-project directory |
| Live updates | Durable Object WebSockets with hibernation; reconnect fetches authoritative state |
| Background jobs | Queues consumer Worker for notifications and directory projections |
| Email | Cloudflare Email Service for transactional sign-in/recovery and optional notifications; beta dependency |
| File storage | Private R2 for backup/export artifacts; receipt uploads deferred |
| Protection | Turnstile with server validation, endpoint limits, Cloudflare DNS/TLS |
| Operations | Wrangler, Workers Logs, separate staging/production bindings and environments |

All server infrastructure lives on Cloudflare. No external database, identity SaaS, FX provider, or bank integration is required. Owners manually sharing invite links remains available even if email notifications are unavailable. Production owner authentication requires validated Email Service availability and delivery in the target account before launch.

### Authority and transaction boundaries

The Durable Object is the only authority for project permissions and accounting. D1 is a directory, not a second ledger. A stale directory may delay appearance in “My groups,” but must never grant access or affect money.

Authenticate in the API Worker, then pass an authenticated principal through internal bindings. The group object checks current membership and role. Do not expose internal RPC to the browser or trust user-supplied actor IDs.

Perform freeze in a synchronous SQLite storage transaction: recheck owner/state/review version, validate sums and rates, save snapshot and deterministic instructions, transition state, record audit and outbox events. No network calls inside this transaction. Expense/settings edits and repayment transitions likewise validate state and versions inside their mutation transaction.

Write outbox events with the originating change. A Durable Object alarm retries publication to Queues. Consumers deduplicate by event ID and apply directory projections by increasing version; queue ordering is not assumed. Email retries use provider idempotency if available, with duplicate delivery treated as possible; notifications must never be accounting authority. Failed jobs enter a dead-letter queue with an operational alert.

Use WebSockets to announce committed versions and updated views. A missed message cannot lose state: reconnect and fetch. Do not cache private ledger responses on the public CDN.

## 8. Domain model

| Entity | Essential fields |
|---|---|
| Project | ID, name, ownerMemberId, baseCurrency, baseExponent, multiCurrencyEnabled, activeRoundId, version |
| Member | Stable ID, account/guest principal, displayName, joinedAt, visibility status |
| Round | ID, sequence, status, ledgerVersion, reviewVersion, timestamps |
| Readiness | Round/member ID, ready flag, markedAt |
| LedgerEntry | ID, round ID, type EXPENSE/REFUND/ADJUSTMENT, creator, occurredAt, description, original/base amounts and currencies, FX provenance, revision, optional correctedEntryId |
| Contribution | Entry/member ID, original/base minor units |
| Allocation | Entry/member ID, original/base minor units |
| RateDefault | Currency pair, exact rate, setter, timestamp, revision |
| SettlementSnapshot | Round ID, ledger/review version, cutoff, member and entry snapshot, balances, algorithm version |
| SettlementInstruction | ID, round ID, sender/recipient, base amount/currency, state, sent/confirmed timestamps, revision |
| ConfirmedTransfer | Unique instruction ID, sender/recipient, amount/currency, confirmation timestamps |
| AuditEvent | ID, actor, action, entity/revision, before/after as appropriate, timestamp |
| IdempotencyRecord | Principal, operation/key, request hash, committed response |
| OutboxEvent | ID, project version, type, payload, publication/retry state |

Keep identities and referenced historical display labels in snapshots. UI deletion while collecting means exclusion from current calculations with an audited record, not erasing the history. Database constraints enforce unique instruction-to-transfer mapping and valid references.

## 9. Accounting and settlement algorithm

For each expense, `balance[member] += baseContribution - baseAllocation`. For refunds, reverse those effects. Owner adjustments carry explicit signed balanced effects. Positive means the person should receive money; negative means they owe money. The sum must equal exactly zero in integer base minor units.

At freeze, match the largest remaining debtor and creditor, with stable member-ID tie-breaks. Create an instruction for the smaller absolute remaining balance, reduce both positions, and repeat until all positions are zero. This produces at most `n - 1` instructions for `n` nonzero participants; it does not promise the global mathematical minimum. Save the algorithm version and final instructions.

Transfer confirmation credits the sender and debits the recipient for progress explanations only. Never rerun the routing algorithm on confirmation. A later round contains only that round’s new facts and corrections; do not count previous confirmed transfers or expenses again.

## 10. API contract outline

Publish an OpenAPI contract and shared validation schemas. Amounts use decimal-string integer minor units in JSON; rates use decimal strings. All mutation endpoints require authentication and an idempotency key. Edits include expected entity versions; freeze includes expected review version.

| Operation | Suggested endpoint |
|---|---|
| Create/list projects | `POST/GET /api/projects` |
| View project/current state | `GET /api/projects/:projectId` |
| Update settings/rate defaults | `PATCH /api/projects/:projectId/settings`, `PUT /api/projects/:projectId/rates/:currency` |
| Create/revoke invitation | `POST/DELETE /api/projects/:projectId/invitations/:inviteId?` |
| Join using token | `POST /api/invitations/join` |
| Create/update/delete entry | `POST /api/projects/:projectId/rounds/:roundId/entries`, `PATCH/DELETE .../entries/:entryId` |
| Set own readiness | `PUT /api/projects/:projectId/rounds/:roundId/readiness/me` |
| Review/freeze | `GET .../rounds/:roundId/review`, `POST .../rounds/:roundId/freeze` |
| Mark sent/received/disputed | `POST .../rounds/:roundId/instructions/:instructionId/sent`, `/received`, `/dispute` |
| Start next round | `POST /api/projects/:projectId/rounds` |
| History/export/live | `GET /api/projects/:projectId/history`, `/export`, `/live` |

Use 401 for no valid session, 403 for forbidden role, 404 for unavailable resources without leaking membership, 409 for frozen/stale/state conflicts, 422 for invalid amounts/splits/currency, and 429 for limits. Return machine-readable error codes plus user-friendly messages. A reused idempotency key with different content is a conflict; with identical content return the committed result. Retain financial mutation keys for the life of the round/history to prevent delayed duplicate submissions.

## 11. Identity, security, and recovery

- Owners sign in with expiring single-use email links. Store token hashes, not raw tokens; consume them atomically.
- Each guest receives an independent random principal and a Secure, HttpOnly, SameSite cookie session. Joining does not grant access to an existing identity or owner role.
- Offer attaching a verified email for cross-device recovery. Explain that an unrecovered guest session may be lost if browser data is cleared.
- Invitation tokens are high entropy, expire, and can be revoked. Revalidate current group state at join; frozen membership cannot be changed.
- Keep session revocation authoritative in D1, not an eventually consistent cache. Use CSRF/origin checks for cookie-authenticated mutations and authenticated WebSocket upgrades.
- Check all IDs against the requested project/round. Parameterize SQL and bound input sizes.
- Apply Turnstile and rate limits to creation, invitation abuse, and sign-in requests; validate tokens server-side.
- Never log sign-in tokens, guest recovery credentials, session cookies, or full private expense payloads. Keep financial audit history separate from operational logs.
- Export only to authorized members. Escape CSV formula-like cells and use correctly quoted UTF-8 CSV.
- An account deletion removes login/profile data according to policy but must not silently destroy another member’s ledger or transfer evidence. Use pseudonymous historical member labels where appropriate; define retention/deletion policy before public launch.

## 12. Acceptance criteria and test coverage

### Currency and entry simplicity

1. A new project defaults to single currency; adding a base expense requires no currency/rate selection.
2. An owner can enable multiple currencies at creation or after existing open expenses; their saved totals do not change.
3. A participant cannot change currency mode. A stale form cannot save a foreign expense after the owner disables it.
4. With no saved rate, a foreign expense requires a manual rate or actual base amount and displays the conversion before saving.
5. For Alice paying 100 EUR at 4.30 PLN/EUR, split equally with Bob, the saved base total is 430 PLN and Bob owes Alice 215 PLN. Updating the default to 4.50 does not change this entry or transfer.
6. A 100 EUR expense with an actual base charge of 432 PLN settles from 432 PLN, including the saved explanation of that conversion.
7. JPY accepts no fractional minor units; KWD supports three decimal places. Cross-exponent conversion is correct in both directions.
8. Equal division of 100 PLN between three people allocates 33.34/33.33/33.33 by stable tie-break rules; totals and balances sum exactly.
9. Exact foreign splits and base allocation remainders preserve both original and base totals; zero-share members never receive rounding pennies.
10. Disabling multi-currency is blocked when foreign entries remain in the collecting round; enabling/disabling for a later round does not modify frozen history.
11. The settlement currency cannot change after the first committed entry. Freeze preserves rates, original amounts, and base allocations.
12. Refunds and historical reversals preserve the specified conversion and never create unexplained FX drift. CSV identifies every amount’s currency.

### Freeze and settlement correctness

13. Readiness is reversible, visible to the owner, and reset according to the specified mutation rules.
14. Owner freeze with missing readiness requires explicit acknowledgement; nonowners cannot freeze.
15. Racing add-expense and freeze requests have one serializable outcome: the expense is included and review becomes stale, or freeze commits first and the expense is rejected. It can never arrive inside an already frozen snapshot.
16. Freeze failure rolls back the state, snapshot, instructions, audit, and outbox together. Duplicate freeze retries return the same result.
17. Recording one confirmed transfer does not change any other instruction’s ID, recipient, currency, or amount.
18. Duplicate sender/recipient actions create one confirmed transfer. Invalid roles and transitions are rejected.
19. A disputed instruction prevents completion; sender resolution does not automatically confirm receipt.
20. A zero-balance group immediately becomes settled. A nonzero group becomes settled only after every instruction is confirmed.
21. Forgotten expenses and corrections require a new owner-created round after settlement; previous snapshots and transfers remain byte-for-byte unchanged.
22. Ownership/membership changes never erase referenced members or allow participant impersonation.

### Operational and usability checks

23. Duplicate/out-of-order queue delivery does not duplicate directory rows or regress versions; notification failure cannot prevent settlement.
24. A disconnected/reconnected browser retrieves the latest committed state and explains rejected stale drafts.
25. Sign-in/recovery tokens are single-use; revoked sessions/invites no longer work. Unauthorized export and WebSocket attempts fail.
26. Mobile keyboard and screen-reader flows complete create, add, ready, freeze, and confirm without hidden controls or colour-only status.
27. Staging restore exercise successfully recovers a project and verifies ledger/snapshot invariants before release.

Use property-based accounting tests for zero-sum balances, share totals, conversion precision, and deterministic plans; integration tests against local Cloudflare bindings for transactions/races/idempotency; and browser tests for the complete multi-person lifecycle. Include explicit malformed decimals, stale currency settings, failed publication, and lost-session recovery cases.

## 13. Delivery sequence and launch requirements

1. Establish environments, migrations, identity, invitation joining, and authoritative project membership.
2. Build the collecting ledger, explanations, default single-currency flow, and opt-in multi-currency conversion/rounding.
3. Implement readiness, review concurrency, atomic freeze, and fixed settlement instructions.
4. Implement confirmation/disputes, immutable history, correction rounds, and exports.
5. Add live updates, outbox delivery, recovery, observability, backups, and end-to-end validation.

Before public launch: verify Email Service sending access and delivery, document guest recovery and data retention, test migrations/rollback against snapshots, complete the acceptance suite, and perform a staging restore. Monitor failed freezes, rejected stale edits, accounting invariant failures, outbox age, queue failures, authentication delivery, and unresolved disputes. Never ship with an invariant violation hidden by rounding.

Create versioned private R2 exports for recovery in addition to provider point-in-time recovery. A restore is an explicit operational action: compare restored settlement state against externally completed transfers and notify affected members before resuming, rather than silently rolling back confirmations.

Define conservative per-project member/entry limits during load testing before launch and enforce them consistently in the API and UI. Usage limits must reject before a mutation, never truncate a settlement. Cloudflare costs are usage-based; track per-service consumption and configure CPU, upload, and notification limits.

## 14. Official platform references

Consult current documentation during implementation; beta access, limits, and prices must be verified in the deployment account. The architecture intentionally avoids private-beta services and external hosting dependencies.

- [React + Vite on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/)
- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Durable Objects overview](https://developers.cloudflare.com/durable-objects/)
- [SQLite storage transactions and recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [WebSockets and hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [D1](https://developers.cloudflare.com/d1/)
- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Cloudflare Email Service — outbound sending beta](https://developers.cloudflare.com/email-service/)
- [Turnstile server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [R2](https://developers.cloudflare.com/r2/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
