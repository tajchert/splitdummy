import { Suspense } from "react";
import { Link, Outlet, useParams } from "react-router";
import { ProjectProvider, useProject } from "../../state/project";
import { AppBar, PageLoading, useTitle } from "../../components/Shell";
import { Banner, Icon } from "../../components/ui";
import { NotFound } from "../NotFound";

export function GroupLayout() {
  const { projectId = "" } = useParams();
  return (
    <ProjectProvider projectId={projectId}>
      <GroupFrame />
    </ProjectProvider>
  );
}

function GroupFrame() {
  const { view, error, refresh, projectId } = useProject();
  useTitle(view?.project.name);

  if (!view && error) {
    if (error.status === 404 || error.status === 403) return <NotFound />;
    if (error.status === 401) {
      return <NotFound title="Sign in to open this group" body="Your session has ended on this browser. Sign in with your email, or open your invitation link again." />;
    }
    return (
      <>
        <AppBar />
        <main id="main" className="page">
          <Banner tone="red" icon="cloud_off" role="alert" action={<button className="btn btn-sm btn-ghost" onClick={() => void refresh()}>Try again</button>}>
            {error.message}
          </Banner>
        </main>
      </>
    );
  }
  if (!view) {
    return (
      <>
        <AppBar />
        <PageLoading />
      </>
    );
  }

  const base = `/g/${encodeURIComponent(projectId)}`;
  return (
    <>
      <AppBar
        crumbs={
          <>
            <Link to="/groups">My groups</Link>
            <span className="muted" aria-hidden="true">
              /
            </span>
            <Link to={base} className="crumb-current">
              <b>{view.project.name}</b>
            </Link>
          </>
        }
        actions={
          <>
            <LiveIndicator />
            <Link to={`${base}/history`} className="appbar-icon" aria-label="History">
              <Icon name="history" size={21} />
            </Link>
            <Link to={`${base}/settings`} className="appbar-icon" aria-label="Settings">
              <Icon name="settings" size={21} />
            </Link>
          </>
        }
      />
      <Suspense fallback={<PageLoading />}>
        <Outlet />
      </Suspense>
    </>
  );
}

/** Shown only when live updates are interrupted; the page keeps working with the last data. */
export function LiveIndicator({ mobile }: { mobile?: boolean }) {
  const { live } = useProject();
  if (live === "open" || live === "connecting") return null;
  return (
    <span className={`live-pill${mobile ? " live-pill-m" : ""}`} role="status">
      <Icon name={live === "offline" ? "cloud_off" : "sync"} size={14} className={live === "offline" ? undefined : "icon-spin"} />
      {live === "offline" ? "Offline: showing last saved data" : "Reconnecting…"}
    </span>
  );
}
