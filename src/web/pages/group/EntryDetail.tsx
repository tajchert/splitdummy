import { useEffect, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router";
import type { AuditEventDTO, EntryDTO, ProjectViewDTO, RoundViewDTO } from "@shared/api";
import { useApi } from "../../api/context";
import { ApiError, errorMessage } from "../../api/errors";
import { useSubmit } from "../../api/idempotency";
import { ConfirmDialog, Sheet } from "../../components/Dialog";
import { useToast } from "../../components/Toast";
import { Amount, Avatar, Banner, Icon } from "../../components/ui";
import { fmtDateTime, fmtDay, fmtMoney, fmtRate } from "../../lib/format";
import { canEditEntry, nameOf, roundLabel, toneFor } from "../../lib/project";
import { useProject, useView } from "../../state/project";
import { groupBase } from "./parts";

/** Provided by routes that show entries of a specific (possibly historical) round. */
export interface RoundOutletContext {
  round: RoundViewDTO;
  basePath: string;
}

export function EntryDetail() {
  const view = useView();
  const outlet = useOutletContext<RoundOutletContext | undefined>();
  const { entryId = "" } = useParams();
  const navigate = useNavigate();
  const round = outlet?.round ?? view.current;
  const back = outlet?.basePath ?? groupBase(view.project.id);
  const entry = round.entries.find((e) => e.id === entryId);
  const close = () => navigate(back, { replace: true });

  if (!entry) {
    return (
      <Sheet title="Entry not available" onClose={close}>
        <p className="muted">It was deleted, or it belongs to another round.</p>
      </Sheet>
    );
  }
  return <EntryDetailInner view={view} round={round} entry={entry} onClose={close} />;
}

function conversionText(view: ProjectViewDTO, e: EntryDTO): { label: string; who: string } {
  const c = e.conversion;
  const who = c.rateSetByMemberId ? `${nameOf(view, c.rateSetByMemberId)}${c.rateSetAt ? `, ${fmtDateTime(c.rateSetAt, true)}` : ""}` : "";
  switch (c.rateSource) {
    case "OWNER_DEFAULT":
      return { label: "Group rate saved by the owner", who };
    case "ENTRY_OVERRIDE":
      return { label: "Manual rate for this entry", who };
    case "ACTUAL_CHARGE":
      return { label: `Actual amount charged in ${e.baseCurrency}; rate derived from it`, who };
    default:
      return { label: "Same currency", who: "" };
  }
}

function EntryDetailInner({ view, round, entry: e, onClose }: { view: ProjectViewDTO; round: RoundViewDTO; entry: EntryDTO; onClose: () => void }) {
  const api = useApi();
  const { refresh } = useProject();
  const toast = useToast();
  const navigate = useNavigate();
  const del = useSubmit();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<AuditEventDTO[] | null>(null);
  const base = groupBase(view.project.id);
  const editable = canEditEntry(view, e);
  const isCurrent = e.roundId === view.current.round.id;
  const frozen = round.round.status !== "COLLECTING";
  const foreign = e.originalCurrency !== e.baseCurrency;
  const sign = e.type === "REFUND" ? -1n : 1n;
  const canCorrect = view.me.isOwner && e.type !== "ADJUSTMENT" && round.round.status === "SETTLED" && view.current.round.status === "COLLECTING" && !isCurrent;
  const kind = e.type === "REFUND" ? "Refund" : e.type === "ADJUSTMENT" ? "Correction" : "Expense";

  useEffect(() => {
    let live = true;
    api.getHistory(view.project.id).then(
      (h) => live && setEvents(h.events.filter((ev) => ev.entityId === e.id).sort((a, b) => b.at.localeCompare(a.at))),
      () => live && setEvents([]),
    );
    return () => {
      live = false;
    };
  }, [api, view.project.id, e.id, e.revision]);

  const doDelete = async () => {
    setError(null);
    try {
      await del.run({ del: e.id, rev: e.revision }, (k) => api.deleteEntry(view.project.id, e.roundId, e.id, { expectedRevision: e.revision }, { idempotencyKey: k }));
      setConfirmDelete(false);
      await refresh();
      toast(`${kind} deleted`);
      navigate(base, { replace: true });
    } catch (err) {
      setConfirmDelete(false);
      setError(err instanceof ApiError && err.code === "STALE_VERSION" ? "Someone changed this entry in the meantime. Check the latest version before deleting." : errorMessage(err));
      void refresh();
    }
  };

  const conv = conversionText(view, e);
  const correctedRound = e.correctedRoundId ? view.rounds.find((r) => r.id === e.correctedRoundId) : undefined;

  return (
    <Sheet
      title={e.description}
      onClose={onClose}
      headerAction={
        editable && e.type !== "ADJUSTMENT" ? (
          <Link to={`${base}/e/${encodeURIComponent(e.id)}/edit`} className="link-btn" replace>
            Edit
          </Link>
        ) : undefined
      }
      footer={
        editable || canCorrect ? (
          <div className="detail-actions">
            {editable && (
              <button type="button" className="btn btn-ghost btn-md danger-text" onClick={() => setConfirmDelete(true)}>
                <Icon name="delete" size={18} />
                Delete
              </button>
            )}
            {editable && e.type !== "ADJUSTMENT" && (
              <Link to={`${base}/e/${encodeURIComponent(e.id)}/edit`} className="btn btn-primary btn-md desktop-only-flex" replace>
                <Icon name="edit" size={18} />
                Edit {kind.toLowerCase()}
              </Link>
            )}
            {canCorrect && (
              <Link to={`${base}/correct/${encodeURIComponent(e.roundId)}/${encodeURIComponent(e.id)}`} className="btn btn-primary btn-md">
                <Icon name="build" size={18} />
                Correct this entry
              </Link>
            )}
          </div>
        ) : undefined
      }
    >
      <div className="detail-hero">
        <div className="entry-title-row">
          <span className={`tag ${e.type === "REFUND" ? "tag-refund" : e.type === "ADJUSTMENT" ? "tag-adjust" : "tag-expense"}`}>{kind}</span>
          <span className="tiny muted">{fmtDay(e.occurredAt)}</span>
        </div>
        {e.type !== "ADJUSTMENT" && (
          <>
            <Amount className="detail-amount" minor={BigInt(e.originalAmount) * sign} code={e.originalCurrency} exponent={e.originalExponent} />
            {foreign && (
              <span className="detail-base">
                = <Amount minor={BigInt(e.baseAmount) * sign} code={e.baseCurrency} exponent={e.baseExponent} />
              </span>
            )}
          </>
        )}
      </div>

      {error && (
        <Banner tone="red" icon="error" role="alert">
          {error}
        </Banner>
      )}
      {frozen && (
        <Banner tone="neutral" icon="lock">
          Frozen in {roundLabel(round.round.sequence)}
          <p>
            Entries can't change once expenses are frozen, so everyone's repayments stay fixed.
            {round.round.status === "SETTLED" ? " If something was wrong, the owner can add a correction in a new round." : ""}
          </p>
        </Banner>
      )}
      {!frozen && !editable && e.type !== "ADJUSTMENT" && (
        <p className="small muted meta-item">
          <Icon name="info" size={16} />
          Only {nameOf(view, e.creatorMemberId)} or the owner can change this entry.
        </p>
      )}

      {foreign && e.type !== "ADJUSTMENT" && (
        <section className="fx fx-static" aria-label="Conversion">
          <span className="fx-preview-line">
            1 {e.originalCurrency} = {fmtRate(e.conversion.rate)} {e.baseCurrency}
          </span>
          <span className="tiny">
            {conv.label}
            {conv.who ? ` · ${conv.who}` : ""}
          </span>
          {e.conversion.note && <span className="tiny">“{e.conversion.note}”</span>}
          <span className="meta-item tiny ink">
            <Icon name="lock" size={14} />
            Saved with the entry. It doesn't follow market rates.
          </span>
        </section>
      )}

      {e.type === "ADJUSTMENT" ? (
        <section className="stack-8">
          {e.correctedEntryId && (
            <p className="small">
              Corrects an entry from {correctedRound ? roundLabel(correctedRound.sequence) : "an earlier round"}.{" "}
              {e.correctedRoundId && (
                <Link to={`${base}/rounds/${encodeURIComponent(e.correctedRoundId)}/e/${encodeURIComponent(e.correctedEntryId)}`} className="link-btn">
                  Open original
                </Link>
              )}
            </p>
          )}
          <p className="tiny muted">That round stays settled as it was. This correction only changes balances in {roundLabel(round.round.sequence)}.</p>
          <div className="card card-flush">
            {(e.adjustmentEffects ?? []).map((x) => (
              <div key={x.memberId} className="row detail-share">
                <Avatar name={nameOf(view, x.memberId)} tone={toneFor(view, x.memberId)} size={28} />
                <span className="grow">{nameOf(view, x.memberId, { you: true })}</span>
                <Amount minor={x.baseAmount} code={e.baseCurrency} exponent={e.baseExponent} signed tone="auto" />
              </div>
            ))}
          </div>
        </section>
      ) : (
        <>
          <section className="detail-kv">
            <span className="muted small">{e.type === "REFUND" ? "Received by" : "Paid by"}</span>
            <span className="detail-person">
              <Avatar name={nameOf(view, e.payerMemberId)} tone={toneFor(view, e.payerMemberId ?? "")} size={26} />
              {nameOf(view, e.payerMemberId, { you: true })}
            </span>
          </section>
          <section aria-labelledby="shares-h" className="stack-8">
            <div className="section-head">
              <h3 id="shares-h" className="section-title">
                {e.type === "REFUND" ? "Money back to" : "Shared by"}
              </h3>
              <span className="tiny muted">{e.splitMode === "EXACT" ? "Exact amounts" : "Equally"}</span>
            </div>
            <div className="card card-flush">
              {e.allocations
                .filter((a) => a.originalAmount !== "0" || e.splitMode === "EXACT")
                .map((a) => (
                  <div key={a.memberId} className="row detail-share">
                    <Avatar name={nameOf(view, a.memberId)} tone={toneFor(view, a.memberId)} size={28} />
                    <span className="grow">{nameOf(view, a.memberId, { you: true })}</span>
                    <span className="detail-share-amt">
                      <Amount minor={a.originalAmount} code={e.originalCurrency} exponent={e.originalExponent} />
                      {foreign && <Amount className="tiny muted" minor={a.baseAmount} code={e.baseCurrency} exponent={e.baseExponent} />}
                    </span>
                  </div>
                ))}
            </div>
          </section>
        </>
      )}

      <section className="stack-8" aria-labelledby="changes-h">
        <h3 id="changes-h" className="section-title">
          Changes
        </h3>
        <ul className="timeline">
          <li>
            <Icon name="add_circle" size={16} />
            <span>
              Added by {nameOf(view, e.creatorMemberId)} · {fmtDateTime(e.createdAt, true)}
            </span>
          </li>
          {events
            ?.filter((ev) => ev.action !== "ENTRY_CREATED" && ev.action !== "REFUND_CREATED")
            .map((ev) => (
              <li key={ev.id}>
                <Icon name="edit" size={16} />
                <span>
                  {ev.summary} · {fmtDateTime(ev.at, true)}
                </span>
              </li>
            ))}
          {events && events.length === 0 && e.revision > 1 && e.lastEditedByMemberId && (
            <li>
              <Icon name="edit" size={16} />
              <span>
                Last edited by {nameOf(view, e.lastEditedByMemberId)} · {fmtDateTime(e.updatedAt, true)}
              </span>
            </li>
          )}
        </ul>
      </section>

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete “${e.description}”?`}
          confirmLabel={`Delete ${kind.toLowerCase()}`}
          confirmIcon="delete"
          danger
          pending={del.pending}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void doDelete()}
        >
          <p>
            {fmtMoney(e.originalAmount, e.originalCurrency, e.originalExponent)} comes off everyone's balances. The deletion is recorded in the group's history.
          </p>
        </ConfirmDialog>
      )}
    </Sheet>
  );
}
