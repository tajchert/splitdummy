import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { EntryDTO, InstructionDTO, ProjectViewDTO, RoundViewDTO } from "@shared/api";
import { useApi } from "../../api/context";
import { errorMessage } from "../../api/errors";
import { useSubmit } from "../../api/idempotency";
import { ConfirmDialog } from "../../components/Dialog";
import { BackButton } from "../../components/Shell";
import { useToast } from "../../components/Toast";
import { Amount, Avatar, Banner, FinishTrack, Icon, Meta, StatusPill } from "../../components/ui";
import { fmtDateTime, fmtDay, fmtMoney, fmtNumber, fmtRate, fmtShortDate, fmtWeekday } from "../../lib/format";
import {
  activeMembers,
  balanceOf,
  confirmedCount,
  isDeleted,
  nameOf,
  notReadyAtFreeze,
  readinessOf,
  roundLabel,
  toneFor,
  trackProgress,
} from "../../lib/project";
import { useProject } from "../../state/project";
import { LiveIndicator } from "./GroupLayout";
import { noteSelfReadyChange } from "./selfChange";

export function groupBase(projectId: string) {
  return `/g/${encodeURIComponent(projectId)}`;
}

/** A member's name; deleted accounts render muted. */
export function Who({ view, id, you }: { view: ProjectViewDTO; id: string | null | undefined; you?: boolean }) {
  const name = nameOf(view, id, { you });
  return isDeleted(view, id) ? <span className="member-deleted">{name}</span> : <>{name}</>;
}

/* ---------- header ---------- */

export function GroupHeader({ view, actions }: { view: ProjectViewDTO; actions?: ReactNode }) {
  const round = view.current;
  const r = round.round;
  const base = groupBase(view.project.id);
  const isOwner = view.me.isOwner;
  const notReady = notReadyAtFreeze(view, round);
  return (
    <div className="ghead">
      <div className="ghead-top-m">
        <BackButton to="/groups" label="My groups" />
        <div className="ghead-top-icons">
          <LiveIndicator mobile />
          <Link to={`${base}/history`} className="round-btn" aria-label="History">
            <Icon name="history" size={20} />
          </Link>
          <Link to={`${base}/settings`} className="round-btn" aria-label="Settings">
            <Icon name="settings" size={20} />
          </Link>
          {isOwner && r.status === "COLLECTING" && (
            <Link to={`${base}/settings#invite`} className="round-btn round-btn-accent" aria-label="Invite people">
              <Icon name="person_add" size={20} />
            </Link>
          )}
        </div>
      </div>
      <div className="ghead-main">
        <div className="ghead-text">
          <div className="ghead-title-row">
            <h1 className="ghead-title">{view.project.name}</h1>
            <StatusPill status={r.status} />
          </div>
          <div className="meta ghead-meta">
            {r.status === "COLLECTING" && (
              <>
                <Meta icon="layers">{roundLabel(r.sequence)}</Meta>
                <Meta icon="payments">{view.project.baseCurrency}</Meta>
                {view.project.multiCurrencyEnabled && (
                  <span className="desktop-only-inline">
                    <Meta icon="currency_exchange">Multi-currency</Meta>
                  </span>
                )}
                {isOwner && <Meta icon="workspace_premium">Owner</Meta>}
              </>
            )}
            {r.status === "SETTLING" && (
              <>
                <span className="desktop-only-inline">
                  <Meta icon="layers">{roundLabel(r.sequence)}</Meta>
                </span>
                {r.frozenAt && (
                  <Meta icon="lock">
                    <span className="sr-only">Frozen </span>
                    <span className="mobile-only-inline">{fmtDateTime(r.frozenAt, true)}</span>
                    <span className="desktop-only-inline">
                      {fmtDateTime(r.frozenAt)}
                      {r.frozenBySchedule ? " · automatically" : r.frozenByMemberId ? ` · ${nameOf(view, r.frozenByMemberId)}` : ""}
                    </span>
                  </Meta>
                )}
                <span className="mobile-only-inline">
                  <Meta icon="check_circle">
                    {confirmedCount(round)} of {round.instructions.length} confirmed
                  </Meta>
                </span>
                {notReady.length > 0 && (
                  <span className="desktop-only-inline">
                    <Meta icon="error">
                      {notReady.map((m) => m.displayName).join(", ")} not finished
                    </Meta>
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        {actions && <div className="ghead-actions">{actions}</div>}
      </div>
      <FinishTrack progress={trackProgress(round)} size="lg" label={trackLabel(round)} />
    </div>
  );
}

/** Explains an early freeze: who hadn't finished and the owner's reason, if they gave one. */
export function FreezeNote({ view, round }: { view: ProjectViewDTO; round: RoundViewDTO }) {
  const r = round.round;
  const notReady = notReadyAtFreeze(view, round);
  const names = notReady.map((m) => nameOf(view, m.id, { short: true })).join(", ");
  if (r.frozenBySchedule) {
    return (
      <Banner tone="neutral" icon="event_available">
        Frozen automatically on the scheduled date
        <p>
          {r.scheduledFreezeDate ? `The list froze at the end of ${fmtWeekday(r.scheduledFreezeDate)}. ` : ""}
          {names ? `${names} hadn't finished adding by then.` : "Everyone had finished adding."}
        </p>
      </Banner>
    );
  }
  if (!notReady.length && !r.earlyFreezeReason) return null;
  return (
    <Banner tone="neutral" icon="info">
      {names ? `Frozen before ${names} finished` : "Frozen before everyone finished"}
      <p>{r.earlyFreezeReason ? `${nameOf(view, r.frozenByMemberId)}: “${r.earlyFreezeReason}”` : `${nameOf(view, r.frozenByMemberId)} froze the list without giving a reason.`}</p>
    </Banner>
  );
}

function trackLabel(round: RoundViewDTO): string {
  const s = round.round.status;
  if (s === "COLLECTING") return "Step 1 of 3: collecting expenses. Next: settling, then settled.";
  if (s === "SETTLING") return `Step 2 of 3: settling, ${confirmedCount(round)} of ${round.instructions.length} transfers confirmed. Next: settled.`;
  return "All 3 steps done: settled.";
}

/* ---------- entries ---------- */

export function EntryAmount({ e, showRate }: { e: EntryDTO; showRate?: boolean }) {
  const sign = e.type === "REFUND" ? -1n : 1n;
  const foreign = e.originalCurrency !== e.baseCurrency;
  if (e.type === "ADJUSTMENT") {
    return (
      <div className="entry-amt">
        <span className="entry-amt-main muted">Correction</span>
      </div>
    );
  }
  return (
    <div className="entry-amt">
      <Amount className="entry-amt-main" minor={BigInt(e.originalAmount) * sign} code={e.originalCurrency} exponent={e.originalExponent} />
      {foreign && (
        <span className="entry-amt-sub">
          <Amount minor={BigInt(e.baseAmount) * sign} code={e.baseCurrency} exponent={e.baseExponent} />
          {showRate && (
            <span className="desktop-only-inline">
              {" "}
              · {fmtRate(e.conversion.rate)}
              {e.conversion.method === "MANUAL_RATE" && e.conversion.rateSource === "ENTRY_OVERRIDE" ? " manual" : e.conversion.method === "ACTUAL_BASE_AMOUNT" ? " charged" : ""}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

export function EntryRow({ view, e, to }: { view: ProjectViewDTO; e: EntryDTO; to: string }) {
  const payer = e.type === "ADJUSTMENT" ? e.creatorMemberId : (e.payerMemberId ?? e.creatorMemberId);
  const pname = nameOf(view, payer);
  const count = e.type === "ADJUSTMENT" ? (e.adjustmentEffects?.filter((x) => x.baseAmount !== "0").length ?? 0) : e.allocations.filter((a) => a.originalAmount !== "0").length;
  return (
    <Link to={to} className="row entry-row">
      <Avatar name={pname} tone={toneFor(view, payer)} />
      <div className="entry-main">
        <div className="entry-title-row">
          <span className="entry-title">{e.description}</span>
          {e.type === "REFUND" && <span className="tag tag-refund">Refund</span>}
          {e.type === "ADJUSTMENT" && <span className="tag tag-adjust">Correction</span>}
        </div>
        <span className="entry-meta">
          <span className="meta-item">
            <Icon name={e.type === "REFUND" ? "call_received" : e.type === "ADJUSTMENT" ? "edit_note" : "credit_card"} size={14} />
            <span className="sr-only">{e.type === "REFUND" ? "Received by" : e.type === "ADJUSTMENT" ? "Added by" : "Paid by"} </span>
            <Who view={view} id={payer} />
          </span>
          <span className="meta-item">
            <Icon name="group" size={14} />
            <span className="sr-only">Shared by </span>
            {count}
          </span>
          <span className="meta-item mobile-only-inline">{fmtDay(e.occurredAt, true)}</span>
        </span>
      </div>
      <span className="entry-date desktop-only-inline">{fmtDay(e.occurredAt, true)}</span>
      <EntryAmount e={e} showRate />
    </Link>
  );
}

export function sortEntries(entries: EntryDTO[]): EntryDTO[] {
  return [...entries].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.createdAt.localeCompare(b.createdAt));
}

/** Original-currency subtotals, never added across currencies. */
export function CurrencySubtotals({ round }: { round: RoundViewDTO }) {
  if (round.currencySubtotals.length < 2 && round.currencySubtotals.every((s) => s.currency === round.entries[0]?.baseCurrency)) return null;
  return (
    <span className="meta-item">
      <Icon name="currency_exchange" size={16} />
      {round.currencySubtotals.map((s, i) => (
        <span key={s.currency}>
          {i > 0 && " · "}
          {fmtMoney(BigInt(s.expenses) - BigInt(s.refunds), s.currency, s.exponent)}
        </span>
      ))}
    </span>
  );
}

/* ---------- balance ---------- */

export function BalanceCard({ view, compactTotals }: { view: ProjectViewDTO; compactTotals?: boolean }) {
  const round = view.current;
  const b = balanceOf(round, view.me.memberId);
  const exp = view.project.baseExponent;
  const code = view.project.baseCurrency;
  const net = BigInt(b?.net ?? "0");
  const base = groupBase(view.project.id);
  return (
    <section className="card card-tight balance-card" aria-labelledby="bal-h">
      <h2 id="bal-h" className="balance-label">
        Your balance so far
      </h2>
      <Amount className="amount-xl" minor={net} code={code} exponent={exp} signed tone="auto" />
      <span className="sr-only">{net > 0n ? "The group owes you this." : net < 0n ? "You owe the group this." : "You're even."}</span>
      <span className="balance-split desktop-only-flex">
        <Meta icon="credit_card">Paid {fmtNumber(b?.paid ?? "0", exp)}</Meta>
        <Meta icon="pie_chart">Share {fmtNumber(b?.share ?? "0", exp)}</Meta>
      </span>
      <div className="balance-chip-row">
        <span className="chip">
          <Icon name="lock_open" size={14} />
          Can still change
        </span>
        <Link to={`${base}/balance`} className="icon-btn" aria-label="How your balance is calculated">
          <Icon name="help" size={19} />
        </Link>
      </div>
      {!compactTotals && (
        <div className="balance-total dashed-top mobile-only-flex">
          <span className="meta-item">
            <Icon name="receipt_long" size={16} />
            <span className="sr-only">Group total </span>
            <b className="ink amount">{fmtMoney(round.totals.expenses, code, exp)}</b>
          </span>
          <span className="tiny muted">spent by the group</span>
        </div>
      )}
    </section>
  );
}

/* ---------- readiness ---------- */

export function ReadyToggle({ view }: { view: ProjectViewDTO }) {
  const api = useApi();
  const { refresh } = useProject();
  const toast = useToast();
  const { run, pending } = useSubmit();
  const round = view.current.round;
  const ready = readinessOf(view.current, view.me.memberId);
  const set = async (value: boolean) => {
    noteSelfReadyChange();
    try {
      await run({ ready: value, round: round.id }, (k) => api.setReadiness(view.project.id, round.id, { ready: value }, { idempotencyKey: k }));
      await refresh();
      toast(value ? "Marked: everything added from your side" : "Marked: you're still adding", value ? "success" : "info");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  if (ready) {
    return (
      <div className="ready-bar" role="status">
        <Icon name="task_alt" size={18} />
        <span className="ready-bar-text">You're done adding</span>
        <button type="button" className="icon-btn ready-undo" onClick={() => void set(false)} disabled={pending} aria-label="Undo: I'm still adding">
          <Icon name="undo" size={18} />
        </button>
      </div>
    );
  }
  return (
    <button type="button" className="btn btn-soft btn-block btn-md-tall" onClick={() => void set(true)} disabled={pending}>
      <Icon name="task_alt" size={18} />
      Everything added from my side
    </button>
  );
}

function readyStatus(round: RoundViewDTO, memberId: string): { text: string; ready: boolean } {
  if (readinessOf(round, memberId)) return { text: "Finished", ready: true };
  const added = round.entries.some((e) => e.creatorMemberId === memberId);
  return { text: added ? "Still adding" : "Not started", ready: false };
}

export function ReadinessCard({ view }: { view: ProjectViewDTO }) {
  const round = view.current;
  const members = activeMembers(view);
  const ready = members.filter((m) => readinessOf(round, m.id));
  const waiting = members.filter((m) => !readinessOf(round, m.id));
  const base = groupBase(view.project.id);
  return (
    <section className="card readiness-card" aria-labelledby="ready-h">
      <div className="card-head">
        <h2 id="ready-h" className="card-title">
          {ready.length} of {members.length} finished
        </h2>
        {waiting.length > 0 ? (
          <span className="card-sub meta-item mobile-only-inline">
            <Icon name="hourglass_top" size={14} />
            <span className="sr-only">Waiting for </span>
            {waiting.map((m) => (m.id === view.me.memberId ? "You" : m.displayName)).join(", ")}
          </span>
        ) : (
          <span className="card-sub mobile-only-inline">Everyone's done</span>
        )}
        <span className="card-sub desktop-only-inline">Readiness</span>
      </div>
      <ul className="ready-avatars mobile-only-flex" aria-label="Who has finished adding">
        {members.map((m) => {
          const st = readyStatus(round, m.id);
          return (
            <li key={m.id} className="ready-avatar">
              <Avatar name={m.displayName} tone={toneFor(view, m.id)} size={40} ready={st.ready} dim={!st.ready} />
              <span className="ready-avatar-name">
                {m.id === view.me.memberId ? "You" : m.displayName}
                <span className="sr-only">: {st.text}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <ul className="ready-list desktop-only-flex">
        {members.map((m) => {
          const st = readyStatus(round, m.id);
          return (
            <li key={m.id} className="ready-list-row">
              <Avatar name={m.displayName} tone={toneFor(view, m.id)} size={30} />
              <span className="ready-list-name">
                {nameOf(view, m.id, { you: true })}
                {m.id === view.me.memberId && (
                  <Link to={`${base}/settings#your-name`} className="icon-btn icon-btn-xs" aria-label="Change your name in this group">
                    <Icon name="edit" size={15} />
                  </Link>
                )}
              </span>
              <span className={`ready-list-status${st.ready ? " is-ready" : ""}`}>{st.text}</span>
            </li>
          );
        })}
      </ul>
      <ReadyToggle view={view} />
      {view.me.isOwner && (
        <Link to={`${base}/review`} className="btn btn-outline btn-md-tall mobile-only-flex">
          <Icon name="lock" size={18} />
          Review &amp; freeze
        </Link>
      )}
    </section>
  );
}

/* ---------- transfers ---------- */

const STATE: Record<InstructionDTO["state"], { label: string; icon: string; cls: string }> = {
  PROPOSED: { label: "To send", icon: "radio_button_unchecked", cls: "pill-neutral" },
  SENT: { label: "Awaiting receipt", icon: "schedule", cls: "pill-blue" },
  CONFIRMED: { label: "Confirmed", icon: "check_circle", cls: "pill-green" },
  DISPUTED: { label: "Disputed", icon: "report", cls: "pill-red" },
};

function transferNote(view: ProjectViewDTO, i: InstructionDTO): string {
  const me = view.me.memberId;
  const from = nameOf(view, i.fromMemberId);
  const to = nameOf(view, i.toMemberId);
  switch (i.state) {
    case "PROPOSED":
      return i.fromMemberId === me ? "Your turn to send" : `Waiting for ${from}`;
    case "SENT":
      return `Sent ${i.sentAt ? fmtShortDate(i.sentAt) : ""}${i.toMemberId === me ? " · your turn" : ` · waiting for ${to}`}`;
    case "CONFIRMED":
      return `Confirmed ${i.confirmedAt ? fmtShortDate(i.confirmedAt) : ""}`;
    case "DISPUTED":
      return `${to}: not received${i.disputeNote ? ` · “${i.disputeNote}”` : ""}`;
  }
}

function stepColors(state: InstructionDTO["state"]): [string, string, string] {
  const g = "var(--green)",
    dim = "var(--line)";
  switch (state) {
    case "PROPOSED":
      return ["var(--ink)", dim, dim];
    case "SENT":
      return [g, "var(--blue)", dim];
    case "CONFIRMED":
      return [g, g, g];
    case "DISPUTED":
      return [g, "var(--red)", dim];
  }
}

export function TransferCard({ view, i }: { view: ProjectViewDTO; i: InstructionDTO }) {
  const me = view.me.memberId;
  const mine = (i.toMemberId === me && i.state === "SENT") || (i.fromMemberId === me && (i.state === "PROPOSED" || i.state === "DISPUTED"));
  const st = STATE[i.state];
  const [c1, c2, c3] = stepColors(i.state);
  return (
    <article className={`transfer${mine ? " transfer-mine" : ""}${i.state === "DISPUTED" ? " transfer-disputed" : ""}`}>
      <div className="transfer-main">
        <div className="transfer-who-row">
          <span className="transfer-who">
            <Who view={view} id={i.fromMemberId} you /> → <Who view={view} id={i.toMemberId} you />
          </span>
          <b className="transfer-amt">
            <Amount minor={i.amount} code={i.currency} exponent={i.exponent} />
          </b>
        </div>
        <ol className="steps desktop-only-grid" aria-label="Steps">
          <li style={{ borderColor: c1, color: c1 }}>To send</li>
          <li style={{ borderColor: c2, color: c2 }}>Awaiting receipt</li>
          <li style={{ borderColor: c3, color: c3 }}>Confirmed</li>
        </ol>
      </div>
      <div className="transfer-status">
        <span className={`pill pill-sm ${st.cls}`}>
          <Icon name={st.icon} size={14} />
          {st.label}
        </span>
        <span className="transfer-note">{transferNote(view, i)}</span>
      </div>
    </article>
  );
}

export function TaskCards({ view }: { view: ProjectViewDTO }) {
  const me = view.me.memberId;
  const tasks = view.current.instructions.filter(
    (i) => (i.toMemberId === me && i.state === "SENT") || (i.fromMemberId === me && (i.state === "PROPOSED" || i.state === "DISPUTED")),
  );
  const order = { SENT: 0, DISPUTED: 1, PROPOSED: 2, CONFIRMED: 3 } as const;
  tasks.sort((a, b) => order[a.state] - order[b.state]);
  if (tasks.length === 0) return null;
  return (
    <>
      {tasks.map((i) => (
        <TaskCard key={i.id} view={view} i={i} />
      ))}
    </>
  );
}

function TaskCard({ view, i }: { view: ProjectViewDTO; i: InstructionDTO }) {
  const api = useApi();
  const { refresh } = useProject();
  const toast = useToast();
  const sub = useSubmit();
  const [disputing, setDisputing] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const me = view.me.memberId;
  const amount = fmtMoney(i.amount, i.currency, i.exponent);
  const pid = view.project.id;
  const rid = i.roundId;

  const act = async (kind: "sent" | "received" | "dispute", body: { note?: string } = {}) => {
    setError(null);
    const payload = { expectedRevision: i.revision, ...body };
    try {
      await sub.run({ kind, id: i.id, ...payload }, (k) => {
        const o = { idempotencyKey: k };
        if (kind === "sent") return api.markSent(pid, rid, i.id, payload, o);
        if (kind === "received") return api.markReceived(pid, rid, i.id, payload, o);
        return api.markDisputed(pid, rid, i.id, payload, o);
      });
      setDisputing(false);
      await refresh();
      toast(kind === "sent" ? "Marked as sent" : kind === "received" ? "Receipt confirmed" : "Marked as not received", kind === "dispute" ? "info" : "success");
    } catch (e) {
      setError(errorMessage(e));
      void refresh();
    }
  };

  let text: ReactNode;
  let actions: ReactNode;
  if (i.toMemberId === me) {
    text = (
      <>
        {nameOf(view, i.fromMemberId)} says they sent you <b className="amount">{amount}</b>
        {i.sentAt ? ` on ${fmtShortDate(i.sentAt)}` : ""}. Did you get it?
      </>
    );
    actions = (
      <div className="task-actions">
        <button type="button" className="btn btn-primary btn-md-tall" disabled={sub.pending} onClick={() => void act("received")}>
          <Icon name="check" size={18} />
          Received
        </button>
        <button type="button" className="btn btn-outline btn-md-tall" disabled={sub.pending} onClick={() => setDisputing(true)}>
          <Icon name="close" size={18} />
          Not received
        </button>
      </div>
    );
  } else if (i.state === "DISPUTED") {
    text = (
      <>
        {nameOf(view, i.toMemberId)} hasn't received your <b className="amount">{amount}</b>
        {i.disputeNote ? `: “${i.disputeNote}”` : "."} Sort it out with them, then mark it sent again.
      </>
    );
    actions = (
      <div className="task-actions">
        <button type="button" className="btn btn-primary btn-md-tall" disabled={sub.pending} onClick={() => void act("sent")}>
          <Icon name="send" size={18} />
          I've sent it again
        </button>
      </div>
    );
  } else {
    text = (
      <>
        Send <b className="amount">{amount}</b> to {nameOf(view, i.toMemberId)}, outside the app, then mark it here.
      </>
    );
    actions = (
      <div className="task-actions">
        <button type="button" className="btn btn-primary btn-md-tall" disabled={sub.pending} onClick={() => void act("sent")}>
          <Icon name="send" size={18} />
          I've sent it
        </button>
      </div>
    );
  }

  return (
    <section className="task-card" aria-label="Your task">
      <div className="task-eyebrow">Your task</div>
      <p className="task-text">{text}</p>
      {actions}
      {error && (
        <span className="field-error" role="alert">
          <Icon name="error" size={16} />
          {error}
        </span>
      )}
      {disputing && (
        <ConfirmDialog
          title={`Not received from ${nameOf(view, i.fromMemberId)}?`}
          confirmLabel="Mark not received"
          confirmIcon="report"
          danger
          pending={sub.pending}
          onCancel={() => setDisputing(false)}
          onConfirm={() => void act("dispute", note.trim() ? { note: note.trim() } : {})}
        >
          <p>
            {nameOf(view, i.fromMemberId)} will see that {amount} hasn't arrived. The round can't finish until you confirm receipt.
          </p>
          <label className="field-label" htmlFor="dispute-note">
            Note for {nameOf(view, i.fromMemberId)} (optional)
          </label>
          <textarea id="dispute-note" className="input" maxLength={280} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: nothing on my account yet" />
        </ConfirmDialog>
      )}
    </section>
  );
}

export function SettlementTotalCard({ view }: { view: ProjectViewDTO }) {
  const round = view.current;
  const b = balanceOf(round, view.me.memberId);
  const net = BigInt(b?.net ?? "0");
  const progress = BigInt(b?.confirmedProgress ?? "0");
  const remaining = BigInt(b?.remaining ?? b?.net ?? "0");
  const code = view.project.baseCurrency;
  const exp = view.project.baseExponent;
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const base = groupBase(view.project.id);
  return (
    <section className="card card-tight">
      <span className="small muted">{net > 0n ? "You'll receive in total" : net < 0n ? "You pay in total" : "Your balance"}</span>
      <Amount className="amount-total" minor={abs(net)} code={code} exponent={exp} tone={net > 0n ? "pos" : undefined} />
      {net !== 0n ? (
        <span className="small muted">
          {fmtNumber(abs(progress), exp)} confirmed · {fmtNumber(abs(remaining), exp)} still to {net > 0n ? "come" : "send"}
        </span>
      ) : (
        <span className="small muted">You don't owe anything and nobody owes you.</span>
      )}
      <Link to={`${base}/balance`} className="link-btn small">
        <Icon name="help" size={16} />
        Why these people?
      </Link>
    </section>
  );
}

