import { useEffect, useState } from "react";
import { Outlet, useParams } from "react-router";
import type { RoundViewDTO } from "@shared/api";
import { useApi } from "../../api/context";
import { errorMessage } from "../../api/errors";
import { BackButton, PageLoading, useTitle } from "../../components/Shell";
import { Amount, Banner, Icon, Meta, StatusPill } from "../../components/ui";
import { fmtDate, fmtDateTime } from "../../lib/format";
import { nameOf, roundLabel } from "../../lib/project";
import { useProject, useView } from "../../state/project";
import type { RoundOutletContext } from "./EntryDetail";
import { RoundEntries } from "./EntriesPage";
import { groupBase, TransferCard } from "./parts";

export function RoundPage() {
  const view = useView();
  const { changeTick } = useProject();
  const api = useApi();
  const { roundId = "" } = useParams();
  const [round, setRound] = useState<RoundViewDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = groupBase(view.project.id);
  useTitle(round ? `${roundLabel(round.round.sequence)} · ${view.project.name}` : null);

  useEffect(() => {
    let live = true;
    api.getRound(view.project.id, roundId).then(
      (r) => live && setRound(r),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [api, view.project.id, roundId, changeTick]);

  if (error)
    return (
      <main id="main" className="page page-mid">
        <BackButton to={`${base}/history`} />
        <Banner tone="red" icon="error" role="alert">
          {error}
        </Banner>
      </main>
    );
  if (!round) return <PageLoading />;

  const r = round.round;
  const path = `${base}/rounds/${encodeURIComponent(r.id)}/e`;
  const ctx: RoundOutletContext = { round, basePath: path };
  const code = view.project.baseCurrency;
  const exp = view.project.baseExponent;
  // TransferCard reads instructions relative to the viewer; point it at this round.
  const shim = { ...view, current: round };

  return (
    <main id="main" className="page page-mid">
      <div className="page-top">
        <BackButton to={`${base}/history`} label="Back to history" />
      </div>
      <div className="ghead-title-row">
        <h1 className="page-h1">{roundLabel(r.sequence)}</h1>
        <StatusPill status={r.status} />
      </div>
      <div className="meta">
        <Meta icon="calendar_today">Started {fmtDate(r.createdAt)}</Meta>
        {r.frozenAt && <Meta icon="lock">Frozen {fmtDateTime(r.frozenAt)}{r.frozenByMemberId ? ` by ${nameOf(view, r.frozenByMemberId)}` : ""}</Meta>}
        {r.settledAt && <Meta icon="sports_score">Settled {fmtDate(r.settledAt)}</Meta>}
      </div>
      {r.id !== view.current.round.id && (
        <Banner tone="neutral" icon="history">
          A previous round, shown read-only
          <p>Nothing here changes. Corrections go into the current round as adjustments.</p>
        </Banner>
      )}
      {r.earlyFreezeReason && (
        <Banner tone="neutral" icon="info">
          Frozen before everyone finished
          <p>“{r.earlyFreezeReason}”</p>
        </Banner>
      )}

      <section className="stack-12" aria-labelledby="r-entries">
        <h2 id="r-entries" className="section-title">
          Entries
        </h2>
        <RoundEntries view={view} round={round} basePath={path} />
      </section>

      {round.instructions.length > 0 && (
        <section className="stack-12" aria-labelledby="r-transfers">
          <h2 id="r-transfers" className="section-title">
            Repayment plan
          </h2>
          <div className="transfers">
            {round.instructions.map((i) => (
              <TransferCard key={i.id} view={shim} i={i} />
            ))}
          </div>
        </section>
      )}

      <section className="stack-12" aria-labelledby="r-bal">
        <h2 id="r-bal" className="section-title">
          Balances
        </h2>
        <div className="card card-flush">
          {round.balances.map((b) => (
            <div key={b.memberId} className="row">
              <span className="grow">{nameOf(view, b.memberId, { you: true })}</span>
              <Amount minor={b.net} code={code} exponent={exp} signed tone="auto" />
            </div>
          ))}
        </div>
        <p className="tiny muted meta-item">
          <Icon name="info" size={14} />
          Positive: received money back. Negative: paid others.
        </p>
      </section>
      <Outlet context={ctx} />
    </main>
  );
}
