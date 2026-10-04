import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { ReviewDTO } from "@shared/api";
import { useApi } from "../../api/context";
import { ApiError, errorMessage } from "../../api/errors";
import { useSubmit } from "../../api/idempotency";
import { ConfirmDialog } from "../../components/Dialog";
import { BackButton, BottomBar, PageLoading, useTitle } from "../../components/Shell";
import { useToast } from "../../components/Toast";
import { Amount, Banner, Icon } from "../../components/ui";
import { fmtMoney, plural } from "../../lib/format";
import { activeMembers, nameOf, roundLabel } from "../../lib/project";
import { describeChange } from "../../lib/reviewDiff";
import { useProject, useView } from "../../state/project";
import { groupBase } from "./parts";

export function Review() {
  const view = useView();
  const { changeTick, refresh } = useProject();
  const api = useApi();
  const navigate = useNavigate();
  const toast = useToast();
  const freeze = useSubmit();
  const round = view.current.round;
  const base = groupBase(view.project.id);
  const [review, setReview] = useState<ReviewDTO | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prev = useRef<ReviewDTO | null>(null);
  const freezing = useRef(false);
  useTitle(`Review & freeze · ${view.project.name}`);

  const load = useCallback(
    async (why?: "live" | "stale") => {
      try {
        const r = await api.getReview(view.project.id, round.id);
        const old = prev.current;
        if (old && why && (old.reviewVersion !== r.reviewVersion || old.ledgerVersion !== r.ledgerVersion)) {
          setChanged(`${describeChange(old.view, r.view, view)} Figures refreshed.`);
          // Not-ready people may differ now; the acknowledgement must be given again.
          if (old.notReadyMemberIds.join() !== r.notReadyMemberIds.join()) setAck(false);
        } else if (why === "stale") {
          setChanged("Something changed while you were reviewing. Figures refreshed; check them again.");
          setAck(false);
        }
        prev.current = r;
        setReview(r);
        setLoadError(null);
      } catch (e) {
        setLoadError(e instanceof ApiError ? e : null);
      }
    },
    [api, view, round.id],
  );

  const firstTick = useRef(changeTick);
  const collecting = round.status === "COLLECTING";
  useEffect(() => {
    // After a freeze (ours or from elsewhere) there is nothing left to review.
    if (!collecting || freezing.current) return;
    void load(changeTick === firstTick.current ? undefined : "live");
  }, [changeTick, round.id, collecting]);

  if (round.status !== "COLLECTING") {
    return (
      <main id="main" className="page page-mid">
        <BackButton to={base} />
        <h1 className="page-h1">{roundLabel(round.sequence)} is already frozen</h1>
        <p className="muted">Repayments are fixed. Open the group to follow progress.</p>
      </main>
    );
  }
  if (!view.me.isOwner) {
    return (
      <main id="main" className="page page-mid">
        <BackButton to={base} />
        <h1 className="page-h1">Only the owner can freeze</h1>
        <p className="muted">{nameOf(view, view.project.ownerMemberId)} decides when to freeze the list. Mark when you're done adding so they know.</p>
      </main>
    );
  }
  if (loadError) {
    return (
      <main id="main" className="page page-mid">
        <BackButton to={base} />
        <Banner tone="red" icon="error" role="alert">
          {loadError.message}
        </Banner>
      </main>
    );
  }
  if (!review) return <PageLoading />;

  const rv = review.view;
  const code = view.project.baseCurrency;
  const exp = view.project.baseExponent;
  const members = activeMembers(view);
  const notReady = review.notReadyMemberIds;
  const notReadyNames = notReady.map((id) => nameOf(view, id)).join(", ");
  const needsAck = notReady.length > 0;
  // The acknowledgement is required; the reason is optional.
  const canFreeze = !needsAck || ack;
  const reasonText = reason.trim();
  const readyCount = members.length - notReady.filter((id) => members.some((m) => m.id === id)).length;

  const doFreeze = async () => {
    setError(null);
    const body = {
      expectedReviewVersion: review.reviewVersion,
      acknowledgeNotReady: needsAck ? notReady : [],
      ...(needsAck && reasonText ? { earlyFreezeReason: reasonText } : {}),
    };
    freezing.current = true;
    try {
      await freeze.run(body, (k) => api.freeze(view.project.id, round.id, body, { idempotencyKey: k }));
      setConfirming(false);
      await refresh();
      toast(review.proposedTransfers.length ? "Frozen. Repayments are ready." : "Frozen and settled: no repayments needed.");
      navigate(base, { replace: true });
    } catch (e) {
      freezing.current = false;
      setConfirming(false);
      if (e instanceof ApiError && (e.code === "REVIEW_STALE" || e.code === "NOT_READY_UNACKNOWLEDGED" || e.code === "STALE_VERSION")) {
        await load("stale");
        return;
      }
      setError(errorMessage(e));
    }
  };

  const perCurrency = rv.currencySubtotals.map((s) => ({ ...s, count: rv.entries.filter((e) => e.originalCurrency === s.currency && e.type !== "ADJUSTMENT").length }));

  const ackBox = needsAck && (
    <div className="ack-box">
      <label className="ack-check">
        <input type="checkbox" className="check check-ink" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>
          I'm freezing even though {notReadyNames} {notReady.length === 1 ? "isn't" : "aren't"} finished
        </span>
      </label>
      <div className="field">
        <label htmlFor="freeze-reason" className="field-label">
          Reason (optional)
        </label>
        <textarea
          id="freeze-reason"
          className="input"
          maxLength={280}
          rows={2}
          value={reason}
          aria-describedby="freeze-reason-hint"
          onChange={(e) => setReason(e.target.value)}
          placeholder={`For example: ${nameOf(view, notReady[0])} confirmed in chat there's nothing else to add.`}
        />
        <span id="freeze-reason-hint" className="field-hint">
          Shown to the whole group if you add one.
        </span>
      </div>
      <FreezeNotes />
      <FreezeButton disabled={!canFreeze} onClick={() => setConfirming(true)} className="desktop-only-flex" />
    </div>
  );

  return (
    <>
      <main id="main" className="page page-review has-bottombar-tall">
        <div className="page-top">
          <BackButton to={base} label="Back to group" />
        </div>
        <h1 className="page-h1">
          Review &amp; freeze<span className="desktop-only-inline"> {roundLabel(round.sequence).toLowerCase()}</span>
        </h1>
        {changed && (
          <Banner tone="blue" icon="sync" role="status">
            {changed}
          </Banner>
        )}
        {error && (
          <Banner tone="red" icon="error" role="alert">
            {error}
          </Banner>
        )}

        <div className="review-grid">
          <section className="card card-tight" aria-labelledby="rv-ready">
            <h2 id="rv-ready" className="card-title">
              <span className="desktop-only-inline">Readiness · </span>
              {readyCount} of {members.length}
              <span className="mobile-only-inline"> finished</span>
            </h2>
            {members.map((m) => {
              const ok = !notReady.includes(m.id);
              return (
                <div key={m.id} className="ready-line">
                  <Icon name={ok ? "check_circle" : "error"} size={20} className={ok ? "green" : "amber"} />
                  <span className="grow">{nameOf(view, m.id, { you: true })}</span>
                  {!ok && <span className="tiny amber strong">Not finished</span>}
                </div>
              );
            })}
          </section>

          <section className="card card-tight" aria-labelledby="rv-totals">
            <h2 id="rv-totals" className="card-title desktop-only-block">
              Totals &amp; currencies
            </h2>
            <span id="rv-totals-m" className="sr-only">
              Totals
            </span>
            <div className="kv">
              <span className="muted">Expenses</span>
              <b className="amount">{fmtMoney(rv.totals.expenses, code, exp)}</b>
            </div>
            <div className="kv">
              <span className="muted">Refunds</span>
              <b className="amount">{fmtMoney(-BigInt(rv.totals.refunds), code, exp)}</b>
            </div>
            {rv.totals.adjustments !== "0" && (
              <div className="kv">
                <span className="muted">Corrections</span>
                <b className="amount">{fmtMoney(rv.totals.adjustments, code, exp, true)}</b>
              </div>
            )}
            {perCurrency.length > 1 || perCurrency.some((s) => s.currency !== code) ? (
              <div className="kv-group dashed-top">
                {perCurrency.map((s) => (
                  <div key={s.currency} className="kv small">
                    <span className="muted">
                      In {s.currency}
                      {s.currency !== code ? ` (${plural(s.count, "entry", "entries")})` : ""}
                    </span>
                    <span className="amount">
                      {s.currency === code
                        ? fmtMoney(s.baseEquivalent, code, exp)
                        : `${fmtMoney(BigInt(s.expenses) - BigInt(s.refunds), s.currency, s.exponent)} → ${fmtMoney(s.baseEquivalent, code, exp)}`}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <section className="card card-tight desktop-only-flex" aria-labelledby="rv-bal">
            <h2 id="rv-bal" className="card-title">
              Balances
            </h2>
            {rv.balances
              .slice()
              .sort((a, b) => Number(BigInt(b.net) - BigInt(a.net)))
              .map((b) => (
                <div key={b.memberId} className="kv">
                  <span>{nameOf(view, b.memberId, { you: true })}</span>
                  <b>
                    <Amount minor={b.net} code={code} exponent={exp} signed tone="auto" />
                  </b>
                </div>
              ))}
          </section>
        </div>

        <div className={`review-grid-2${needsAck ? "" : " no-ack"}`}>
          <section className="review-plan" aria-labelledby="rv-plan">
            <div className="card-head">
              <h2 id="rv-plan" className="card-title">
                Who will pay whom<span className="mobile-only-inline"> (preview)</span>
              </h2>
              <span className="tiny muted meta-item plan-preview desktop-only-inline">
                <Icon name="visibility" size={15} />
                Preview
              </span>
            </div>
            {review.proposedTransfers.length === 0 ? (
              <p className="small muted">No repayments needed: everyone's share matches what they paid. Freezing settles this round straight away.</p>
            ) : (
              <div className="plan-grid">
                {review.proposedTransfers.map((t) => (
                  <div key={`${t.fromMemberId}-${t.toMemberId}`} className="plan-row">
                    <span>
                      {nameOf(view, t.fromMemberId)} → {nameOf(view, t.toMemberId)}
                    </span>
                    <b className="amount">{fmtMoney(t.amount, code, exp)}</b>
                  </div>
                ))}
              </div>
            )}
            <p className="tiny muted">Amounts are fixed when you freeze. Members mark transfers as sent and received; the app never moves money.</p>
          </section>
          {ackBox}
          {!needsAck && (
            <div className="card review-go desktop-only-flex">
              <p className="small">
                <b>Everyone has finished adding.</b> Freezing locks the list and creates the repayments above.
              </p>
              <FreezeNotes />
              <FreezeButton disabled={false} onClick={() => setConfirming(true)} />
            </div>
          )}
        </div>
      </main>
      <BottomBar className="bottombar-col">
        <FreezeNotes />
        <FreezeButton disabled={!canFreeze} onClick={() => setConfirming(true)} />
      </BottomBar>
      {confirming && (
        <ConfirmDialog
          title={`Freeze ${roundLabel(round.sequence).toLowerCase()}?`}
          confirmLabel="Freeze & start settling"
          confirmIcon="lock"
          pending={freeze.pending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void doFreeze()}
        >
          <p>
            Entries and members lock, and {review.proposedTransfers.length ? `${plural(review.proposedTransfers.length, "repayment", "repayments")} become fixed` : "the round settles right away"}. This can't be undone.
          </p>
          {needsAck &&
            (reasonText ? (
              <p>
                {notReadyNames} will see your reason: “{reasonText}”
              </p>
            ) : (
              <p>Everyone will see that you froze before {notReadyNames} finished.</p>
            ))}
        </ConfirmDialog>
      )}
    </>
  );
}

function FreezeNotes() {
  return (
    <div className="freeze-notes">
      <span className="meta-item">
        <Icon name="lock" size={14} />
        Locks entries &amp; members
      </span>
      <b className="meta-item ink">
        <Icon name="block" size={14} />
        Can't undo
      </b>
    </div>
  );
}

function FreezeButton({ disabled, onClick, className }: { disabled: boolean; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={`btn btn-primary btn-block${className ? " " + className : ""}`} disabled={disabled} onClick={onClick}>
      <Icon name="lock" size={18} />
      Freeze &amp; start settling
    </button>
  );
}
