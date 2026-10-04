import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { AuditEventDTO, HistoryDTO, RoundDTO } from "@shared/api";
import { useApi } from "../../api/context";
import { errorMessage } from "../../api/errors";
import { BackButton, PageLoading, useTitle } from "../../components/Shell";
import { Banner, Icon, StatusPill } from "../../components/ui";
import { fmtDate, fmtDateTime } from "../../lib/format";
import { roundLabel } from "../../lib/project";
import { useProject, useView } from "../../state/project";
import { useCsvExport } from "./GroupHome";
import { groupBase } from "./parts";

const ACTION_ICON: Record<string, string> = {
  PROJECT_CREATED: "flag",
  PROJECT_RENAMED: "edit",
  ENTRY_CREATED: "add_circle",
  REFUND_CREATED: "call_received",
  ENTRY_UPDATED: "edit",
  ENTRY_DELETED: "delete",
  ADJUSTMENT_CREATED: "build",
  READY_SET: "task_alt",
  READY_CLEARED: "undo",
  ROUND_STARTED: "layers",
  ROUND_FROZEN: "lock",
  ROUND_SETTLED: "sports_score",
  INSTRUCTION_SENT: "send",
  INSTRUCTION_CONFIRMED: "check_circle",
  INSTRUCTION_DISPUTED: "report",
  MEMBER_JOINED: "person_add",
  MEMBER_REJOINED: "person_add",
  MEMBER_LEFT: "logout",
  MEMBER_REMOVED: "person_remove",
  MEMBER_ACCOUNT_UPDATED: "verified_user",
  OWNERSHIP_OFFERED: "workspace_premium",
  OWNERSHIP_TRANSFERRED: "workspace_premium",
  INVITATION_CREATED: "link",
  INVITATION_REVOKED: "link_off",
  MULTI_CURRENCY_ENABLED: "currency_exchange",
  MULTI_CURRENCY_DISABLED: "currency_exchange",
  BASE_CURRENCY_CHANGED: "payments",
  RATE_DEFAULT_SET: "currency_exchange",
  RATE_DEFAULT_DELETED: "currency_exchange",
  SETTINGS_UPDATED: "settings",
  MEMBER_RENAMED: "badge",
  MEMBER_ACCOUNT_DELETED: "person_off",
  FREEZE_SCHEDULED: "event",
  FREEZE_SCHEDULE_CLEARED: "event_busy",
};

const iconScheduledFreeze = "lock_clock";

function iconFor(e: AuditEventDTO): string {
  if (e.action === "ROUND_FROZEN" && e.details?.scheduled) return iconScheduledFreeze;
  return ACTION_ICON[e.action] ?? "radio_button_unchecked";
}

function RoundLine({ r, base, current }: { r: RoundDTO; base: string; current: boolean }) {
  return (
    <Link to={current ? base : `${base}/rounds/${encodeURIComponent(r.id)}`} className="row history-round">
      <span className="round-num" aria-hidden="true">
        {r.sequence}
      </span>
      <div className="grow">
        <div className="entry-title-row">
          <span className="entry-title">{roundLabel(r.sequence)}</span>
          <StatusPill status={r.status} />
        </div>
        <span className="tiny muted">
          Started {fmtDate(r.createdAt)}
          {r.frozenAt && ` · frozen ${fmtDate(r.frozenAt)}`}
          {r.settledAt && ` · settled ${fmtDate(r.settledAt)}`}
        </span>
      </div>
      <Icon name="chevron_right" size={20} className="muted" />
    </Link>
  );
}

export function History() {
  const view = useView();
  const { changeTick } = useProject();
  const api = useApi();
  const base = groupBase(view.project.id);
  const [history, setHistory] = useState<HistoryDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const csv = useCsvExport(view);
  useTitle(`History · ${view.project.name}`);

  useEffect(() => {
    let live = true;
    api.getHistory(view.project.id).then(
      (h) => live && setHistory(h),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [api, view.project.id, changeTick]);

  const rounds = history?.rounds ?? view.rounds;
  const active = rounds.find((r) => r.id === view.project.activeRoundId && r.status !== "SETTLED");
  const past = rounds.filter((r) => r !== active).sort((a, b) => b.sequence - a.sequence);
  const events: AuditEventDTO[] = history ? [...history.events].sort((a, b) => b.at.localeCompare(a.at)) : [];
  const roundSeq = (id: string | null) => rounds.find((r) => r.id === id)?.sequence;

  return (
    <main id="main" className="page page-mid">
      <div className="page-top">
        <BackButton to={base} label="Back to group" />
      </div>
      <div className="page-head">
        <h1 className="page-h1">History</h1>
        <button type="button" className="btn btn-secondary btn-md" onClick={() => void csv.run()} disabled={csv.pending}>
          <Icon name="download" size={18} />
          Export CSV
        </button>
      </div>
      {error && (
        <Banner tone="red" icon="error" role="alert">
          {error}
        </Banner>
      )}

      {active && (
        <section className="stack-8" aria-labelledby="h-active">
          <h2 id="h-active" className="section-title">
            Current round
          </h2>
          <div className="card card-flush">
            <RoundLine r={active} base={base} current />
          </div>
        </section>
      )}
      <section className="stack-8" aria-labelledby="h-past">
        <h2 id="h-past" className="section-title">
          {active ? "Previous rounds" : "Rounds"}
        </h2>
        {past.length === 0 ? (
          <p className="small muted">No finished rounds yet.</p>
        ) : (
          <div className="card card-flush">
            {past.map((r) => (
              <RoundLine key={r.id} r={r} base={base} current={false} />
            ))}
          </div>
        )}
      </section>

      <section className="stack-8" aria-labelledby="h-activity">
        <h2 id="h-activity" className="section-title">
          Activity
        </h2>
        {!history && !error && <PageLoading />}
        {history && events.length === 0 && <p className="small muted">Nothing has happened yet.</p>}
        {events.length > 0 && (
          <ol className="activity">
            {events.map((e) => (
              <li key={e.id} className="activity-item">
                <span className="activity-icon">
                  <Icon name={iconFor(e)} size={16} />
                </span>
                <div className="grow">
                  <p className="small">{e.summary}</p>
                  <span className="tiny muted">
                    {fmtDateTime(e.at, true)}
                    {e.roundId && roundSeq(e.roundId) !== undefined ? ` · ${roundLabel(roundSeq(e.roundId)!)}` : ""}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
