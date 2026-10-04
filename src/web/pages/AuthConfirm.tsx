import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useApi, useSession } from "../api/context";
import { ApiError, errorMessage } from "../api/errors";
import { useSubmit } from "../api/idempotency";
import { useTitle } from "../components/Shell";
import { Icon, Logo, LogoMark } from "../components/ui";

/**
 * /auth/confirm#token=…: the link from the sign-in email. The token sits in the fragment,
 * and signing in takes a click, so mail scanners that prefetch links can't use it up.
 */
export function AuthConfirm() {
  useTitle("Sign in");
  const api = useApi();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const { run, pending } = useSubmit();
  const token = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<{ expired: boolean; message: string } | null>(null);

  useEffect(() => {
    token.current ??= new URLSearchParams(window.location.hash.slice(1)).get("token");
    // Keep the token out of history, bookmarks and screenshots.
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    if (!token.current) setError({ expired: false, message: "This sign-in link is incomplete. Open it straight from the email, or request a new one." });
    setReady(true);
  }, []);

  const signIn = async () => {
    const t = token.current;
    if (!t) return;
    try {
      const r = await run({ token: t }, (k) => api.verifySignIn(t, { idempotencyKey: k }));
      await refresh();
      navigate(r.next && r.next.startsWith("/") ? r.next : "/groups", { replace: true });
    } catch (e) {
      const expired = e instanceof ApiError && (e.code === "SIGNIN_LINK_INVALID" || e.status === 410);
      setError({ expired, message: errorMessage(e) });
    }
  };

  return (
    <div className="narrow-page">
      <header className="narrow-head narrow-head-center">
        <Link to="/" className="appbar-home" aria-label="Splitdummy home">
          <Logo size={18} />
        </Link>
      </header>
      <main id="main" className="narrow-main">
        {!error ? (
          <>
            <div className="confirm-hero" aria-hidden="true">
              <span className="confirm-coin">
                <LogoMark size={56} className="logo-mark-joined" />
                <span className="confirm-badge">
                  <Icon name="check" size={20} />
                </span>
              </span>
            </div>
            <span className="pill pill-green confirm-pill">
              <Icon name="verified_user" size={16} />
              Link confirmed
            </span>
            <h1 className="page-h1">Welcome back</h1>
            <p className="muted lede">Your link checks out. One tap and you're in on this device.</p>
            <button type="button" className="btn btn-primary btn-block" onClick={() => void signIn()} disabled={!ready || pending} autoFocus>
              {pending ? "Signing in…" : "Sign in to Splitdummy"}
            </button>
          </>
        ) : (
          <>
            <span className="inbox-icon" aria-hidden="true">
              <Icon name={error.expired ? "schedule" : "link_off"} size={30} />
            </span>
            <h1 className="page-h1">{error.expired ? "This link has expired or was already used" : "We couldn't sign you in"}</h1>
            <p className="muted lede" role="alert">
              {error.expired ? "Sign-in links work once and for 15 minutes. Request a new one and open it on this device." : error.message}
            </p>
            <Link to="/signin" className="btn btn-primary btn-block">
              <Icon name="mail" size={20} />
              Send a new link
            </Link>
          </>
        )}
      </main>
    </div>
  );
}
