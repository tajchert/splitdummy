# Splitdummy — Frontend Design Brief

For: UI/UX and product team · 4 October 2026

## Product and core journey

**Split the costs. Know when you’re done.**

A simple, mobile-first website for friends sharing trip or event expenses. Each group has an owner. People enter expenses and mark **“Everything added from my side.”** The owner freezes expenses, creating fixed repayment instructions. Senders mark money sent; recipients confirm receipt. The group finishes as **“All settled.”**

**Create → Invite → Add expenses → Mark ready → Owner freezes → Repay → All settled**

Groups have independent balances. Payments happen outside the app. A settlement round is one collection-and-repayment cycle; a group can have several rounds, but only one active at a time.

## Pages and required content

Screens may be full pages, sheets, or dialogs where appropriate. The three group states should share a familiar layout.

| Page / view | Content and available actions |
|---|---|
| **Landing** | Short product explanation, the finish-line promise, **Create a group**, **Sign in**, and a way to open an invitation. |
| **Sign-in / account** | Email sign-in link, check-inbox confirmation, resend, expired-link recovery, sign out. Guests can optionally attach a verified email to recover access on another device. |
| **My groups** | Group cards with name, currency, state, and personal next action; create group; open active or settled groups. Empty state explains how to start. No combined debt across groups. |
| **Create group** | Group name, settlement currency, optional **“Allow expenses in other currencies”** toggle. Off by default. Explain that everyone repays in the settlement currency. |
| **Join invitation** | Group name, display-name input, **Join as guest**, optional sign-in. Explain guest recovery briefly. Handle expired/revoked links and groups whose membership is frozen. Never offer to take over an existing member by name. |
| **Group — collecting** | Status, current round, total in settlement currency, your provisional balance, expense/refund list, readiness checklist (**“3 of 5 finished”**), **Add expense**, **Add refund**, and **“Everything added from my side”** with undo. Owner also sees invitation controls and **Review & freeze**. |
| **Add / edit expense** | Description, date, amount, one payer, included members, equal split by default, exact amounts as an alternative. Show allocated shares and validation. Currency controls appear only when enabled. Save/cancel; permitted edits and deletion are available while collecting. |
| **Add / edit refund** | Explicit refund label, description, date, amount, who received the money, and who benefits from it. Same currency and split controls as expenses. Do not present refunds as repayments. |
| **Entry detail** | Who paid/received, who shared the amount, original and converted values where relevant, creator, date, changes, and permitted edit/delete actions. Frozen entries are read-only with an explanation. |
| **Balance explanation** | What you paid, your allocated costs/refunds, and your net position; links to included entries. During settlement, distinguish original obligation, confirmed repayments, and remaining amount. Explain why a simplified transfer goes to a particular person. |
| **Owner review & freeze** | Readiness list, expense/refund totals, currency breakdown, balances, and provisional repayment preview. **Freeze expenses & start settlement** with a clear explanation that entries will lock. If anyone is not ready, require acknowledgement and a reason. If something changed during review, refresh and require another review. |
| **Group — settling** | Frozen status and cutoff, fixed repayment cards, personal send/receive tasks, overall progress, disputes, and read-only expenses. Sender: **“I’ve sent it.”** Recipient after that: **“Received”** or **“Not received.”** Clearly state that the app does not transfer money. |
| **Group — settled** | **All settled**, completion date, completed transfers, read-only entries, history, CSV export. Owner: **Start next round** for another period or forgotten expenses. Zero-balance rounds finish without repayment tasks. |
| **History / rounds** | Round list with dates and states; open previous frozen expenses and repayment plans; activity timeline; CSV export. Keep active and historical rounds clearly separated. |
| **Group settings** | Owner controls for currency mode, reusable exchange-rate defaults, invite creation/revocation, membership, and ownership transfer. Participant view shows relevant information without owner controls. Explain locked or unavailable actions. |
| **Correction flow** | After a round is settled, owner starts a new round. Members add forgotten expenses/refunds there. Owner can correct a historical entry through an explained adjustment referencing it. Show that the old settlement remains unchanged. |

## Currency experience

- **Single currency is the default:** show its code beside the amount; no currency selector or exchange-rate fields.
- Owner can enable multiple currencies at creation or in settings while collecting. Existing expenses keep their saved values.
- When enabled, show a compact currency selector defaulting to the group currency. Base-currency entries need no conversion controls.
- For a foreign expense, show an owner-saved rate if available, or ask for a manual rate / actual amount charged in the settlement currency. Members can override the default for their expense.
- Show **“1 EUR = 4.30 PLN”** and **“100.00 EUR → 430.00 PLN”** before saving. Include **“This saved conversion will not change automatically.”** Identify manual rates clearly.
- Expense cards show original amount first and converted amount below. Group balances and repayment instructions use the settlement currency. Original-currency subtotals stay separate.
- Show currency codes, not symbols alone; respect different decimal precision, including JPY and KWD.
- Disabling multi-currency is blocked if foreign expenses remain in the current round. Settlement currency locks after the first entry. Currency settings lock during settlement; explain these restrictions.

## Roles and behavior designers must preserve

- Everyone can view group data, add expenses/refunds while collecting, and set only their own readiness.
- Participants edit/delete their own entries; the owner can edit others’ entries with visible history.
- Editing an entry clears readiness for the actor and its original creator. Membership or currency-mode changes clear everyone’s readiness. Explain a reset when it happens.
- Only the owner freezes or starts another round. Everyone being ready does not freeze automatically.
- Freeze locks entries and membership. Repayment amounts and recipients stay fixed; progress changes, instructions do not.
- Only the sender marks sent; only the recipient confirms or disputes receipt. Show **To send → Awaiting receipt → Confirmed**, with a **Disputed** state and sender resolution action. A dispute blocks completion until the recipient confirms.
- No partial-payment flow, automatic receipt confirmation, or owner override of someone’s receipt confirmation.
- Frozen rounds cannot reopen. Late expenses enter a later round after the current one finishes.
- Only unreferenced members can be removed while collecting. Ownership transfer requires acceptance by a member with a recoverable account.

## Design priorities and states

Make the next action obvious on a phone. Use plain language, clear amounts, and a visible **Collecting / Settling / Settled** label. Prefer progressive disclosure for exact splits and foreign currencies. Avoid debt graphs as the main view.

Design empty groups, no expenses, no amount owed, waiting for members, everyone ready, early freeze, awaiting receipt, disputes, and completed rounds. Include loading, save success, inline errors, duplicate names, expired links, disconnection/reconnection, and stale edits rejected after freeze. Preserve unsaved input and never imply that an offline draft was accepted.

Use accessible contrast, labels, keyboard navigation, and status text alongside colour. Confirm destructive deletion and irreversible freeze. Provide responsive desktop layouts as well as mobile views.

## Team deliverables and boundaries

Provide a page map, owner and participant journeys, mobile-first wireframes, responsive final designs, reusable components, and annotated state/permission variants. Prototype the single-currency journey, a foreign expense, freeze with someone not ready, receipt dispute, and a later correction round.

First release excludes receipt uploads/OCR, AI entry, live market exchange rates, percentage/itemized splits, multiple payers per expense, bank integrations, in-app money transfers, recurring automation, and cross-group debt simplification.

Detailed behavior and edge cases: [Development handoff](splitdummy-development-handoff.md). This brief condenses that specification; it does not change its product rules.
