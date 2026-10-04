import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { SignInVerifiedDTO } from "@shared/api";
import { useApi, useSession } from "../api/context";
import { ApiError, errorMessage } from "../api/errors";
import { newKey } from "../api/idempotency";
import { useTitle } from "../components/Shell";
import { Icon, Loading, Logo } from "../components/ui";
import type { Api } from "../api/types";

// One verification per token, even if React mounts the page twice.
const inflight = new Map<string, Promise<SignInVerifiedDTO>>();
function verifyOnce(api: Api, token: string) {
  let p = inflight.get(token);
  if (!p) {
    p = api.verifySignIn(token, { idempotencyKey: newKey() });
    inflight.set(token, p);
  }
  return p;
}

/**
 * /auth/confirm#token=… — the link from the sign-in email. The token sits in the fragment
 * so mail scanners can't consume it; only this page, run by a browser, posts it.
 */
export function AuthConfirm() {
  useTitle("Signing in");
  const api = useApi();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState<{ expired: boolean; message: string } | null>(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (!token) {
      setError({ expired: false, message: "This sign-in link is incomplete. Open it straight from the email, or request a new one." });
      return;
    }
    // Keep the token out of history and screenshots.
    window.history.replaceState(null, "", window.location.pathname);
    verifyOnce(api, token).then(
      async (r) => {
        await refresh();
        navigate(r.next && r.next.startsWith("/") ? r.next : "/groups", { replace: true });
      },
      (e) => {
        const expired = e instanceof ApiError && (e.code === "SIGNIN_LINK_INVALID" || e.status === 410);
        setError({ expired, message: errorMessage(e) });
      },
    );
  }, [api, navigate, refresh]);

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
            <Loading />
            <p className="muted lede" style={{ textAlign: "center" }}>
              Signing you in…
            </p>
          </>
        ) : (
          <>
            <span className="inbox-icon" aria-hidden="true">
              <Icon name={error.expired ? "schedule" : "link_off"} size={30} />
            </span>
            <h1 className="page-h1">{error.expired ? "This link has expired" : "We couldn't sign you in"}</h1>
            <p className="muted lede">
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
