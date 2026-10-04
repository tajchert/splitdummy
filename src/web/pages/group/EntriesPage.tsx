import { Outlet } from "react-router";
import type { ProjectViewDTO, RoundViewDTO } from "@shared/api";
import { BackButton } from "../../components/Shell";
import { EmptyState, Icon, StatusPill } from "../../components/ui";
import { fmtMoney, plural } from "../../lib/format";
import { roundLabel } from "../../lib/project";
import { useView } from "../../state/project";
import type { RoundOutletContext } from "./EntryDetail";
import { CurrencySubtotals, EntryRow, groupBase, sortEntries } from "./parts";

/** Read-only entry list for one round (current frozen round, or a historical one). */
export function RoundEntries({ view, round, basePath }: { view: ProjectViewDTO; round: RoundViewDTO; basePath: string }) {
  const code = view.project.baseCurrency;
  const exp = view.project.baseExponent;
  if (round.entries.length === 0) {
    return (
      <div className="card">
        <EmptyState icon="receipt_long" title="No entries in this round" />
      </div>
    );
  }
  return (
    <div className="card card-flush entry-table">
      <div className="entry-thead desktop-only-grid" aria-hidden="true">
        <span />
        <span>Entry</span>
        <span>Date</span>
        <span className="ta-r">Amount</span>
      </div>
      <div className="rows">
        {sortEntries(round.entries).map((e) => (
          <EntryRow key={e.id} view={view} e={e} to={`${basePath}/${encodeURIComponent(e.id)}`} />
        ))}
      </div>
      <div className="entry-tfoot">
        <CurrencySubtotals round={round} />
        <b className="ink amount">
          {fmtMoney(round.totals.expenses, code, exp)} spent
          {round.totals.refunds !== "0" && <> · {fmtMoney(round.totals.refunds, code, exp)} refunded</>}
        </b>
      </div>
    </div>
  );
}

export function EntriesPage() {
  const view = useView();
  const round = view.current;
  const base = groupBase(view.project.id);
  const ctx: RoundOutletContext = { round, basePath: `${base}/entries` };
  const frozen = round.round.status !== "COLLECTING";
  return (
    <main id="main" className="page page-mid">
      <div className="page-top">
        <BackButton to={base} label="Back to group" />
      </div>
      <div className="ghead-title-row">
        <h1 className="page-h1">{frozen ? "Frozen entries" : "Entries"}</h1>
        <StatusPill status={round.round.status} />
      </div>
      <p className="muted small meta-item">
        {frozen && <Icon name="lock" size={16} />}
        {roundLabel(round.round.sequence)} · {plural(round.entries.length, "entry", "entries")}
        {frozen ? " · read-only" : ""}
      </p>
      <RoundEntries view={view} round={round} basePath={`${base}/entries`} />
      <Outlet context={ctx} />
    </main>
  );
}
