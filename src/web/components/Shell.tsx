import { useEffect, useRef, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { useSession } from "../api/context";
import { initial } from "../lib/project";
import { Icon, Loading, Logo, LogoMark } from "./ui";

/** New page → top of page, unless only an overlay route (sheet) changed. */
export function ScrollToTop() {
  const { pathname } = useLocation();
  const prev = useRef(pathname);
  useEffect(() => {
    const overlay = /\/(new|refund|e\/[^/]+(\/edit)?)$/;
    const base = (p: string) => p.replace(overlay, "");
    if (base(prev.current) !== base(pathname)) window.scrollTo(0, 0);
    prev.current = pathname;
  }, [pathname]);
  return null;
}

/** Sets document.title. */
export function useTitle(title: string | null | undefined) {
  useEffect(() => {
    if (title) document.title = `${title} · Splitdummy`;
  }, [title]);
}

export function UserChip({ withName = false }: { withName?: boolean }) {
  const { me } = useSession();
  if (!me) {
    return (
      <Link to="/signin" className="link-strong">
        Sign in
      </Link>
    );
  }
  const name = me.displayName ?? me.email ?? "You";
  return (
    <Link to="/account" className="user-chip" aria-label={`Account: ${name}`}>
      <span className="avatar tone-accent" style={{ width: 30, height: 30, fontSize: 12 }} aria-hidden="true">
        {initial(name)}
      </span>
      {withName && <span className="user-chip-name">{name}</span>}
    </Link>
  );
}

/** Desktop top bar (logo, breadcrumb, actions, account). Hidden on phones unless `mobile`. */
export function AppBar({ crumbs, actions, mobile = false }: { crumbs?: ReactNode; actions?: ReactNode; mobile?: boolean }) {
  return (
    <header className={`appbar${mobile ? " appbar-mobile" : ""}`}>
      <div className="appbar-inner">
        <div className="appbar-left">
          <Link to="/groups" className="appbar-home" aria-label="Splitdummy, my groups">
            {crumbs ? <LogoMark size={20} /> : <Logo size={20} />}
          </Link>
          {crumbs && <nav aria-label="Breadcrumb" className="crumbs">{crumbs}</nav>}
        </div>
        <div className="appbar-right">
          {actions}
          <UserChip withName={!crumbs} />
        </div>
      </div>
    </header>
  );
}

export function BackButton({ to, label = "Back" }: { to?: string; label?: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="round-btn"
      aria-label={label}
      onClick={() => {
        if (to) navigate(to);
        else if (window.history.length > 1) navigate(-1);
        else navigate("/groups");
      }}
    >
      <Icon name="arrow_back" size={20} />
    </button>
  );
}

/** Phone-only sticky action bar at the bottom of the screen. */
export function BottomBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`bottombar${className ? " " + className : ""}`}>{children}</div>;
}

export function RequireSession({ children, account }: { children: ReactNode; account?: boolean }) {
  const { me, loaded } = useSession();
  const loc = useLocation();
  if (!loaded) return <Loading />;
  if (!me || (account && me.kind !== "ACCOUNT" && !me.email)) {
    return <Navigate to={`/signin?next=${encodeURIComponent(loc.pathname + loc.search)}${account && me ? "&reason=account" : ""}`} replace />;
  }
  return <>{children}</>;
}

export function PageLoading() {
  return (
    <div className="page-center">
      <Loading />
    </div>
  );
}
