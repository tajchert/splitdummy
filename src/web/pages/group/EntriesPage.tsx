import { useEffect, useState } from "react";
import { Outlet } from "react-router";
import type { ProjectViewDTO, RoundViewDTO } from "@shared/api";
import { BackButton } from "../../components/Shell";
import { useToast } from "../../components/Toast";
import { EmptyState, Icon, StatusPill } from "../../components/ui";
import { entriesMarkdown } from "../../lib/entriesMarkdown";
import { fmtMoney, plural } from "../../lib/format";
import { roundLabel } from "../../lib/project";
import { useView } from "../../state/project";
import type { RoundOutletContext } from "./EntryDetail";
import { CurrencySubtotals, EntryRow, groupBase, sortEntries } from "./parts";

function CopyMarkdownButton({ text }: { text: () => string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setCopied(true);
      toast("Table copied as Markdown");
    } catch {
      toast("Couldn't copy the table.", "error");
    }
  };
  return (
    <button type="button" className="icon-btn icon-btn-xs" onClick={() => void copy()} aria-label="Copy table as Markdown" title="Copy table as Markdown">
      <Icon name={copied ? "check" : "content_copy"} size={16} />
    </button>
  );
}

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
  const entries = sortEntries(round.entries);
  return (
    <div className="card card-flush entry-table">
      <div className="entry-thead desktop-only-grid" aria-hidden="true">
        <span />
        <span>Entry</span>
        <span>Date</span>
        <span className="ta-r">Amount</span>
      </div>
      <div className="rows">
        {entries.map((e) => (
          <EntryRow key={e.id} view={view} e={e} to={`${basePath}/${encodeURIComponent(e.id)}`} />
        ))}
      </div>
      <div className="entry-tfoot">
        <span className="entry-tfoot-start">
          <CopyMarkdownButton text={() => entriesMarkdown(view, round, entries)} />
          <CurrencySubtotals round={round} />
        </span>
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
