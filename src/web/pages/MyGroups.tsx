import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { ProjectSummaryDTO } from "@shared/api";
import { useApi } from "../api/context";
import { errorMessage } from "../api/errors";
import { AppBar, BottomBar, PageLoading, RequireSession, UserChip, useTitle } from "../components/Shell";
import { Banner, EmptyState, Icon, LogoMark, Meta, StatusPill } from "../components/ui";
import { roundLabel } from "../lib/project";
import { fmtDate } from "../lib/format";

const NEXT: Record<NonNullable<ProjectSummaryDTO["nextAction"]>, { icon: string; text: string; strong: boolean }> = {
  ADD_EXPENSES: { icon: "add", text: "Add your expenses", strong: false },
  MARK_READY: { icon: "task_alt", text: "Mark when you're done adding", strong: true },
  REVIEW_FREEZE: { icon: "lock", text: "Review & freeze", strong: true },
  SEND_MONEY: { icon: "send", text: "Send your repayment", strong: true },
  CONFIRM_RECEIPT: { icon: "call_received", text: "Confirm a repayment", strong: true },
  WAITING: { icon: "hourglass_top", text: "Waiting for others", strong: false },
  DONE: { icon: "sports_score", text: "All settled", strong: false },
};

function GroupCard({ g }: { g: ProjectSummaryDTO }) {
  const next = g.nextAction ? NEXT[g.nextAction] : null;
  const settled = g.roundStatus === "SETTLED";
  return (
    <Link to={`/g/${encodeURIComponent(g.id)}`} className={`card group-card${settled ? " is-settled" : ""}`}>
      <div className="group-card-head">
        <b className="group-card-name">{g.name}</b>
        {g.roundStatus && <StatusPill status={g.roundStatus} />}
      </div>
      <div className="meta group-card-meta">
        <Meta icon="payments" size={16}>
          {g.baseCurrency}
        </Meta>
        {settled ? (
          <Meta icon="event_available" size={16}>
            {fmtDate(g.updatedAt)}
          </Meta>
        ) : (
          g.roundSequence != null && (
            <Meta icon="layers" size={16}>
              {roundLabel(g.roundSequence)}
            </Meta>
          )
        )}
        {g.isOwner && (
          <Meta icon="workspace_premium" size={16}>
            Owner
          </Meta>
        )}
      </div>
      <div className={`next-action${next?.strong ? " next-action-strong" : ""}`}>
        <span className="icon-wrap">{next && <Icon name={next.icon} size={18} />}</span>
        <span className="next-action-text">{next?.text ?? "Open group"}</span>
        <Icon name="chevron_right" size={20} />
      </div>
    </Link>
  );
}

export function MyGroups() {
  useTitle("My groups");
  return (
    <RequireSession>
      <MyGroupsInner />
    </RequireSession>
  );
}

function MyGroupsInner() {
  const api = useApi();
  const [groups, setGroups] = useState<ProjectSummaryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.listProjects().then(
      (g) => live && setGroups(g),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [api]);

  const order = { COLLECTING: 0, SETTLING: 0, SETTLED: 1 } as const;
  const sorted = groups
    ? [...groups].sort((a, b) => (order[a.roundStatus ?? "COLLECTING"] - order[b.roundStatus ?? "COLLECTING"]) || b.updatedAt.localeCompare(a.updatedAt))
    : null;

  return (
    <>
      <AppBar />
      <main id="main" className="page has-bottombar">
        <div className="page-top-m mygroups-top">
          <LogoMark size={20} />
          <UserChip />
        </div>
        <div className="page-head">
          <div>
            <h1 className="page-h1">My groups</h1>
            <p className="muted page-sub">Balances stay per group.</p>
          </div>
          <Link to="/groups/new" className="btn btn-primary btn-md desktop-only">
            <Icon name="add" size={20} />
            Create a group
          </Link>
        </div>
        {error && (
          <Banner tone="red" icon="error" role="alert">
            {error}
          </Banner>
        )}
        {!sorted && !error && <PageLoading />}
        {sorted && sorted.length === 0 && (
          <div className="card">
            <EmptyState
              icon="group_add"
              title="No groups yet"
              action={
                <Link to="/groups/new" className="btn btn-primary btn-md">
                  <Icon name="add" size={20} />
                  Create a group
                </Link>
              }
            >
              Create one for a trip, a flat or an event, then send the invitation link to everyone who shares the costs. Got a link from someone else? Open it to join.
            </EmptyState>
          </div>
        )}
        {sorted && sorted.length > 0 && (
          <div className="group-grid">
            {sorted.map((g) => (
              <GroupCard key={g.id} g={g} />
            ))}
          </div>
        )}
      </main>
      <BottomBar>
        <Link to="/groups/new" className="btn btn-primary btn-block">
          <Icon name="add" size={20} />
          Create a group
        </Link>
      </BottomBar>
    </>
  );
}
