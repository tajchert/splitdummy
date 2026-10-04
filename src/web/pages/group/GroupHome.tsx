import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import type { ProjectViewDTO } from "@shared/api";
import { useApi } from "../../api/context";
import { errorMessage } from "../../api/errors";
import { useSubmit } from "../../api/idempotency";
import { BottomBar } from "../../components/Shell";
import { useToast } from "../../components/Toast";
import { Amount, Banner, EmptyState, Icon } from "../../components/ui";
import { fmtDate, fmtDateTime, fmtMoney, plural } from "../../lib/format";
import { activeMembers, balanceOf, confirmedCount, nameOf, readinessOf, roundLabel } from "../../lib/project";
import { useProject, useView } from "../../state/project";
import {
  BalanceCard,
  CurrencySubtotals,
  EntryRow,
  FreezeNote,
  GroupHeader,
  groupBase,
  ReadinessCard,
  SettlementTotalCard,
  sortEntries,
  TaskCards,
  TransferCard,
} from "./parts";
import { RoundsSwitcher } from "./RoundsSwitcher";
import { readyChangedBySelfRecently } from "./selfChange";

export function GroupHome() {
  const view = useView();
  const status = view.current.round.status;
  return (
    <>
      {status === "COLLECTING" && <Collecting view={view} />}
      {status === "SETTLING" && <Settling view={view} />}
      {status === "SETTLED" && <Settled view={view} />}
      <Outlet />
    </>
  );
}

/** Explains a readiness reset caused by someone else's edit or a membership/currency change. */
function useReadinessReset(view: ProjectViewDTO): [boolean, () => void] {
  const ready = readinessOf(view.current, view.me.memberId);
  const prev = useRef<{ ready: boolean; round: string } | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const p = prev.current;
    if (p && p.round === view.current.round.id && p.ready && !ready && !readyChangedBySelfRecently()) setShown(true);
    if (ready) setShown(false);
    prev.current = { ready, round: view.current.round.id };
  }, [ready, view.current.round.id]);
  return [shown, () => setShown(false)];
}

function Collecting({ view }: { view: ProjectViewDTO }) {
  const base = groupBase(view.project.id);
  const round = view.current;
  const loc = useLocation();
  const justCreated = (loc.state as { justCreated?: boolean } | null)?.justCreated;
  const [filter, setFilter] = useState<"all" | "mine" | "refunds">("all");
  const [resetShown, dismissReset] = useReadinessReset(view);
  const entries = sortEntries(round.entries).filter((e) =>
    filter === "mine" ? e.creatorMemberId === view.me.memberId || e.payerMemberId === view.me.memberId : filter === "refunds" ? e.type === "REFUND" : true,
  );
  const code = view.project.baseCurrency;
  const exp = view.project.baseExponent;
  const alone = activeMembers(view).length < 2;

  return (
    <>
      <main id="main" className="page group-page has-bottombar">
        <GroupHeader
          view={view}
          actions={
            view.me.isOwner && (
              <>
                <Link to={`${base}/settings#invite`} className="btn btn-soft btn-md">
                  <Icon name="person_add" size={18} />
                  Invite
                </Link>
                <Link to={`${base}/review`} className="btn btn-outline btn-md">
                  <Icon name="lock" size={18} />
                  Review &amp; freeze
                </Link>
              </>
            )
          }
        />
        {resetShown && (
          <Banner
            tone="amber"
            icon="restart_alt"
            role="status"
            action={
              <button type="button" className="icon-btn" aria-label="Dismiss" onClick={dismissReset}>
                <Icon name="close" size={18} />
              </button>
            }
          >
            Your “done adding” was cleared
            <p>An entry you're part of changed, or the group's members or currency settings changed. Check the list and mark it again.</p>
          </Banner>
        )}
        {view.me.isOwner && (justCreated || alone) && (
          <Banner tone="blue" icon="person_add" action={<Link to={`${base}/settings#invite`} className="btn btn-sm btn-ink">Invite</Link>}>
            {alone ? "You're the only one here" : "Group created"}
            <p>Create an invitation link and send it to everyone who shares the costs.</p>
          </Banner>
        )}

        <div className="group-cols">
          <aside className="group-side">
            <BalanceCard view={view} />
            <ReadinessCard view={view} />
            <RoundsSwitcher view={view} />
          </aside>

          <section className="group-list" aria-labelledby="entries-h">
            <div className="list-toolbar">
              <div className="section-head list-head-m">
                <h2 id="entries-h" className="section-title">
                  Expenses &amp; refunds
                </h2>
                <span className="tiny muted">{plural(round.entries.length, "entry", "entries")}</span>
              </div>
              <div className="filters desktop-only-flex" role="group" aria-label="Filter entries">
                {(
                  [
                    ["all", `All ${round.entries.length}`],
                    ["mine", "Mine"],
                    ["refunds", "Refunds"],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} type="button" className="filter-chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="list-actions desktop-only-flex">
                <Link to={`${base}/refund`} className="btn btn-secondary btn-md">
                  <Icon name="call_received" size={18} />
                  Refund
                </Link>
                <Link to={`${base}/new`} className="btn btn-primary btn-md">
                  <Icon name="add" size={20} />
                  Add expense
                </Link>
              </div>
            </div>

            {round.entries.length === 0 ? (
              <div className="card">
                <EmptyState icon="receipt_long" title="No expenses yet">
                  Add what you paid for the group: who paid, how much, and who shared it. Refunds you received go in as refunds.
                </EmptyState>
              </div>
            ) : (
              <div className="card card-flush entry-table">
                <div className="entry-thead desktop-only-grid" aria-hidden="true">
                  <span />
                  <span>Entry</span>
                  <span>Date</span>
                  <span className="ta-r">Amount</span>
                </div>
                <div className="rows">
                  {entries.map((e) => (
                    <EntryRow key={e.id} view={view} e={e} to={`${base}/e/${encodeURIComponent(e.id)}`} />
                  ))}
                  {entries.length === 0 && <p className="row muted small">Nothing matches this filter.</p>}
                </div>
                <div className="entry-tfoot">
                  <CurrencySubtotals round={round} />
                  <b className="ink amount">
                    {fmtMoney(round.totals.expenses, code, exp)} spent
                    {round.totals.refunds !== "0" && <> · {fmtMoney(round.totals.refunds, code, exp)} refunded</>}
                  </b>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
      <BottomBar>
        <Link to={`${base}/new`} className="btn btn-primary bb-main">
          <Icon name="add" size={20} />
          Add expense
        </Link>
        <Link to={`${base}/refund`} className="btn btn-secondary bb-side">
          <Icon name="call_received" size={18} />
          Refund
        </Link>
      </BottomBar>
    </>
  );
}

function Settling({ view }: { view: ProjectViewDTO }) {
  const base = groupBase(view.project.id);
  const round = view.current;
  const confirmed = confirmedCount(round);
  const order = { DISPUTED: 0, SENT: 1, PROPOSED: 2, CONFIRMED: 3 } as const;
  const me = view.me.memberId;
  const instructions = [...round.instructions].sort((a, b) => {
    const mineA = a.fromMemberId === me || a.toMemberId === me ? 0 : 1;
    const mineB = b.fromMemberId === me || b.toMemberId === me ? 0 : 1;
    return mineA - mineB || order[a.state] - order[b.state];
  });
  const disputes = round.instructions.filter((i) => i.state === "DISPUTED").length;
  return (
    <main id="main" className="page group-page">
      <GroupHeader
        view={view}
        actions={
          <div className="settle-count desktop-only-block">
            <div className="settle-count-num">
              {confirmed} / {round.instructions.length}
            </div>
            <div className="tiny muted">transfers confirmed</div>
          </div>
        }
      />
      <FreezeNote view={view} round={round} />
      {disputes > 0 && (
        <Banner tone="red" icon="report" role="status">
          {plural(disputes, "transfer is", "transfers are")} disputed
          <p>The round can't finish until the recipient confirms receipt.</p>
        </Banner>
      )}
      <div className="group-cols">
        <aside className="group-side">
          <TaskCards view={view} />
          <div className="settle-total">
            <SettlementTotalCard view={view} />
          </div>
          <Link to={`${base}/entries`} className="card link-card desktop-only-flex">
            <span className="meta-item ink">
              <Icon name="lock" size={17} />
              Frozen entries
            </span>
            <span className="meta-item muted">
              {round.entries.length}
              <Icon name="chevron_right" size={18} />
            </span>
          </Link>
          <RoundsSwitcher view={view} />
        </aside>
        <section className="group-list" aria-labelledby="transfers-h">
          <div className="section-head mobile-only-flex">
            <h2 id="transfers-h" className="section-title">
              All repayments
            </h2>
            <span className="tiny muted">Fixed amounts</span>
          </div>
          <div className="transfers">
            {instructions.map((i) => (
              <TransferCard key={i.id} view={view} i={i} />
            ))}
          </div>
          <div className="settle-notes">
            <span className="meta-item desktop-only-inline">
              <Icon name="lock" size={16} />
              Amounts and people are fixed
            </span>
            <span className="meta-item">
              <Icon name="block" size={15} />
              Splitdummy never moves money
            </span>
          </div>
          <Link to={`${base}/entries`} className="frozen-link mobile-only-flex">
            <Icon name="lock" size={16} />
            {plural(round.entries.length, "frozen entry", "frozen entries")}
            <Icon name="chevron_right" size={18} />
          </Link>
        </section>
      </div>
    </main>
  );
}

export function useCsvExport(view: ProjectViewDTO) {
  const api = useApi();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const run = async () => {
    setPending(true);
    try {
      const blob = await api.exportCsv(view.project.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${view.project.name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").toLowerCase() || "group"}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setPending(false);
    }
  };
  return { run, pending };
}

function Settled({ view }: { view: ProjectViewDTO }) {
  const api = useApi();
  const { refresh } = useProject();
  const toast = useToast();
  const base = groupBase(view.project.id);
  const round = view.current;
  const r = round.round;
  const code = view.project.baseCurrency;
  const exp = view.project.baseExponent;
  const b = balanceOf(round, view.me.memberId);
  const net = BigInt(b?.net ?? "0");
  const csv = useCsvExport(view);
  const start = useSubmit();
  const lastConfirmed = [...round.instructions].filter((i) => i.confirmedAt).sort((a, b) => b.confirmedAt!.localeCompare(a.confirmedAt!))[0];

  const startNext = async () => {
    try {
      await start.run({ startAfter: r.id }, (k) => api.startRound(view.project.id, { idempotencyKey: k }));
      await refresh();
      toast(`${roundLabel(r.sequence + 1)} started`);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <>
      <div className="checker-strip" aria-hidden="true" />
      <main id="main" className="page group-page settled-page">
        <div className="ghead-top-m">
          <Link to="/groups" className="round-btn" aria-label="My groups">
            <Icon name="arrow_back" size={20} />
          </Link>
          <div className="ghead-top-icons">
            <Link to={`${base}/settings`} className="round-btn" aria-label="Settings">
              <Icon name="settings" size={20} />
            </Link>
          </div>
        </div>
        <div className="settled-cols">
          <div className="settled-main">
            <span className="pill pill-green">
              <span className="pill-dot" aria-hidden="true" />
              Settled
            </span>
            <h1 className="settled-h1">
              <Icon name="sports_score" size={64} className="settled-flag" />
              All settled.
            </h1>
            <p className="settled-sub">
              {view.project.name} · {roundLabel(r.sequence)}
              {r.settledAt ? ` · Completed ${fmtDate(r.settledAt)}` : ""}
            </p>
            <div className="settled-stats">
              <div className="stat">
                <span className="tiny muted">Spent together</span>
                <b className="stat-v amount">{fmtMoney(round.totals.expenses, code, exp)}</b>
              </div>
              <div className="stat desktop-only-flex">
                <span className="tiny muted">Transfers</span>
                <b className="stat-v">
                  {round.instructions.length === 0 ? "None needed" : `${confirmedCount(round)} of ${round.instructions.length} confirmed`}
                </b>
              </div>
              <div className="stat stat-r">
                <span className="tiny muted">{net > 0n ? "You received" : net < 0n ? "You paid back" : "Your balance"}</span>
                <b className={`stat-v amount${net > 0n ? " amount-pos" : ""}`}>{fmtMoney(net < 0n ? -net : net, code, exp)}</b>
              </div>
            </div>
            <div className="settled-actions desktop-only-flex">
              <button type="button" className="btn btn-secondary btn-md" onClick={() => void csv.run()} disabled={csv.pending}>
                <Icon name="download" size={18} />
                CSV
              </button>
              <Link to={`${base}/entries`} className="btn btn-secondary btn-md">
                <Icon name="lock" size={18} />
                Entries
              </Link>
              <Link to={`${base}/history`} className="btn btn-secondary btn-md">
                <Icon name="history" size={18} />
                History
              </Link>
            </div>
          </div>
          <div className="settled-side">
            <section className="card card-flush" aria-labelledby="done-h">
              <h2 id="done-h" className="card-flush-title">
                Completed transfers
              </h2>
              {round.instructions.length === 0 ? (
                <p className="row small muted">No repayments were needed: everyone's share matched what they paid.</p>
              ) : (
                round.instructions.map((i) => (
                  <div key={i.id} className="row done-row">
                    <Icon name="check_circle" size={18} className="green" />
                    <span className="grow">
                      {nameOf(view, i.fromMemberId, { you: true })} → {nameOf(view, i.toMemberId, { you: true })}
                    </span>
                    <b>
                      <Amount minor={i.amount} code={i.currency} exponent={i.exponent} />
                    </b>
                  </div>
                ))
              )}
              {lastConfirmed && (
                <p className="row tiny muted desktop-only-flex">
                  Last confirmation: {nameOf(view, lastConfirmed.toMemberId)}, {fmtDateTime(lastConfirmed.confirmedAt!, true)}
                </p>
              )}
            </section>
            <div className="settled-actions mobile-only-flex">
              <button type="button" className="btn btn-secondary btn-md-tall grow" onClick={() => void csv.run()} disabled={csv.pending}>
                <Icon name="download" size={18} />
                CSV
              </button>
              <Link to={`${base}/history`} className="btn btn-secondary btn-md-tall grow">
                <Icon name="history" size={18} />
                History
              </Link>
            </div>
            <div className="forgot-card">
              <p className="small">
                <b>Forgot something?</b> {roundLabel(r.sequence)} stays as it is.
              </p>
              {view.me.isOwner ? (
                <button type="button" className="btn btn-primary btn-md-tall" onClick={() => void startNext()} disabled={start.pending}>
                  <Icon name="add" size={18} />
                  {start.pending ? "Starting…" : "Start next round"}
                </button>
              ) : (
                <p className="small muted">Ask {nameOf(view, view.project.ownerMemberId)} (the owner) to start the next round, then add it there.</p>
              )}
            </div>
            <RoundsSwitcher view={view} />
          </div>
        </div>
      </main>
    </>
  );
}
