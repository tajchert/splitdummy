import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useApi, useSession } from "../api/context";
import { errorMessage } from "../api/errors";
import { useSubmit } from "../api/idempotency";
import { Field } from "../components/Field";
import { AppBar, BackButton, RequireSession, useTitle } from "../components/Shell";
import { useToast } from "../components/Toast";
import { Turnstile } from "../components/Turnstile";
import { Banner, Icon } from "../components/ui";
import { getThemePref, setThemePref, type ThemePref } from "../lib/theme";
import { useEmailLinkForm } from "./SignIn";

export function Account() {
  useTitle("Account");
  return (
    <RequireSession>
      <AccountInner />
    </RequireSession>
  );
}

function AccountInner() {
  const api = useApi();
  const { me, setMe } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const signOut = useSubmit();
  const [theme, setTheme] = useState<ThemePref>(getThemePref());
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [params] = useSearchParams();
  if (!me) return null;

  return (
    <>
      <AppBar />
      <main id="main" className="page page-narrow">
        <div className="page-top-m">
          <BackButton to="/groups" />
        </div>
        <h1 className="page-h1">Account</h1>
        {params.get("error") === "email_in_use" && (
          <Banner tone="amber" icon="info" role="alert">
            That email already belongs to another account
            <p>Your guest access is unchanged. To use that account, sign out and sign in with the email; groups you joined as a guest stay with this browser.</p>
          </Banner>
        )}

        <section className="card" aria-labelledby="acc-who">
          <h2 id="acc-who" className="card-title">
            {me.kind === "GUEST" && !me.email ? "Guest on this browser" : "Signed in"}
          </h2>
          {me.email ? (
            <p className="row-plain">
              <Icon name="mail" size={18} className="muted" />
              <span>{me.email}</span>
              <span className="pill pill-green pill-sm">Verified</span>
            </p>
          ) : (
            <p className="small muted">
              Your groups are tied to this browser. Clearing site data or switching devices loses access unless you add an email.
            </p>
          )}
        </section>

        {!me.email && <AttachEmail />}

        <section className="card" aria-labelledby="acc-theme">
          <h2 id="acc-theme" className="card-title">
            Appearance
          </h2>
          <div className="segmented segmented-lg" role="group" aria-label="Theme">
            {(["system", "light", "dark"] as const).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={theme === t}
                onClick={() => {
                  setTheme(t);
                  setThemePref(t);
                }}
              >
                {t === "system" ? "Match device" : t === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </div>
        </section>

        {signOutError && (
          <Banner tone="red" icon="error" role="alert">
            {signOutError}
          </Banner>
        )}
        <button
          type="button"
          className="btn btn-outline btn-block"
          disabled={signOut.pending}
          onClick={async () => {
            try {
              await signOut.run("logout", (k) => api.signOut({ idempotencyKey: k }));
              setMe(null);
              toast("Signed out", "info");
              navigate("/");
            } catch (e) {
              setSignOutError(errorMessage(e));
            }
          }}
        >
          <Icon name="logout" size={18} />
          Sign out
        </button>
        {me.kind === "GUEST" && !me.email && (
          <p className="tiny muted">As a guest, signing out means you can't get back into your groups from this browser without a new invitation.</p>
        )}
      </main>
    </>
  );
}

function AttachEmail() {
  const f = useEmailLinkForm("attach");
  const [sent, setSent] = useState<{ email: string; devLink?: string } | null>(null);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await f.submit();
    if (r) setSent(r);
  };
  if (sent) {
    return (
      <Banner tone="green" icon="mark_email_unread" role="status">
        Check {sent.email} and open the link to confirm it.
        <p>Then you can sign in with this email on any device.</p>
        {sent.devLink && (
          <p>
            <a className="link-btn" href={sent.devLink}>
              Development: open link
            </a>
          </p>
        )}
      </Banner>
    );
  }
  return (
    <form className="card" onSubmit={onSubmit} noValidate aria-labelledby="acc-attach">
      <h2 id="acc-attach" className="card-title">
        Keep access on other devices
      </h2>
      <p className="small muted">Add an email. We'll send a link to confirm it; your name and groups stay the same.</p>
      <Field label="Email" error={f.error ?? undefined}>
        {(p) => (
          <input {...p} className="input" type="email" autoComplete="email" value={f.email} onChange={(e) => f.setEmail(e.target.value)} placeholder="name@example.com" />
        )}
      </Field>
      <Turnstile ref={f.ts} onToken={f.setToken} action="attach_email" />
      <button type="submit" className="btn btn-primary" disabled={f.pending}>
        {f.pending ? "Sending…" : "Send confirmation link"}
      </button>
    </form>
  );
}
