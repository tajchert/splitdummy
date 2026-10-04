import { useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { RequestSignInSchema } from "@shared/api";
import { useApi, useSession } from "../api/context";
import { ApiError, errorMessage } from "../api/errors";
import { useSubmit } from "../api/idempotency";
import { Field } from "../components/Field";
import { BackButton, useTitle } from "../components/Shell";
import { Turnstile, useTurnstileRequired, type TurnstileHandle } from "../components/Turnstile";
import { Banner, Icon, Logo } from "../components/ui";

function safeNext(n: string | null): string | undefined {
  return n && /^\/[^/]/.test(n) ? n.slice(0, 200) : undefined;
}

/** Shared by sign-in and "attach email": validate, Turnstile, idempotent submit. */
export function useEmailLinkForm(kind: "signin" | "attach", next?: string) {
  const api = useApi();
  const { run, pending } = useSubmit();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const ts = useRef<TurnstileHandle>(null);
  const needsToken = useTurnstileRequired();

  async function submit(): Promise<{ email: string; devLink?: string } | null> {
    const parsed = RequestSignInSchema.shape.email.safeParse(email);
    if (!parsed.success) {
      setError("Enter an email address like name@example.com.");
      return null;
    }
    if (needsToken && !token) {
      setError("Complete the check below first.");
      return null;
    }
    const body = { email: parsed.data, ...(token ? { turnstileToken: token } : {}), ...(kind === "signin" && next ? { next } : {}) };
    try {
      const r = await run({ email: body.email, next: kind === "signin" ? next : undefined }, (k) =>
        kind === "signin" ? api.requestSignIn(body, { idempotencyKey: k }) : api.attachEmail(body, { idempotencyKey: k }),
      );
      return { email: parsed.data, devLink: r?.devLink };
    } catch (e) {
      if (e instanceof ApiError && e.code === "TURNSTILE_FAILED") ts.current?.reset();
      setError(errorMessage(e));
      return null;
    }
  }

  return { email, setEmail: (v: string) => (setEmail(v), setError(null)), error, pending, submit, setToken, ts };
}

export function SignIn() {
  useTitle("Sign in");
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { me } = useSession();
  const next = safeNext(params.get("next"));
  const linkError = params.get("error");
  const reason = params.get("reason");
  const f = useEmailLinkForm("signin", next);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await f.submit();
    if (r) navigate("/signin/sent", { state: { email: r.email, devLink: r.devLink, next } });
  };

  return (
    <div className="narrow-page">
      <header className="narrow-head">
        <BackButton to="/" />
        <Link to="/" aria-label="Splitdummy home" className="appbar-home">
          <Logo size={18} />
        </Link>
        <span style={{ width: 36 }} />
      </header>
      <main id="main" className="narrow-main">
        {me?.kind === "ACCOUNT" ? (
          <>
            <h1 className="page-h1">You're already signed in</h1>
            <Banner tone="neutral" icon="person">
              You're signed in as <b className="ink">{me.email}</b>.
            </Banner>
            <Link to="/groups" className="btn btn-primary btn-block">
              <Icon name="group" size={20} />
              Go to my groups
            </Link>
            <p className="tiny muted">
              Want to use a different email? Sign out from <Link to="/account">your account</Link> first.
            </p>
          </>
        ) : (
          <>
            <h1 className="page-h1">Sign in</h1>
            <p className="muted lede">We'll email you a sign-in link. No password needed.</p>

            {linkError && (
              <Banner tone="amber" icon="schedule" role="alert">
                That sign-in link has expired, was already used, or isn't valid.
                <p>Links work once and for 15 minutes. Request a new one below.</p>
              </Banner>
            )}
            {reason === "account" && (
              <Banner tone="blue" icon="info">
                Creating a group needs an email address, so you can always get back to it.
              </Banner>
            )}
            {me && !linkError && (
              <Banner tone="neutral" icon="person">
                You're using Splitdummy as a guest. Sign in with your email to keep your groups on any device.{" "}
                <Link to="/groups" className="link-btn">
                  Go to my groups
                </Link>
              </Banner>
            )}

            <form className="stack-16" onSubmit={onSubmit} noValidate>
              <Field label="Email" error={f.error ?? undefined}>
                {(p) => (
                  <input
                    {...p}
                    className="input"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    autoFocus
                    placeholder="name@example.com"
                    value={f.email}
                    onChange={(e) => f.setEmail(e.target.value)}
                  />
                )}
              </Field>
              <Turnstile ref={f.ts} onToken={f.setToken} action="sign_in" />
              <button type="submit" className="btn btn-primary btn-block" disabled={f.pending}>
                <Icon name="mail" size={20} />
                {f.pending ? "Sending…" : "Email me a sign-in link"}
              </button>
            </form>
            <p className="tiny muted">
              Joining a group from an invitation? Open the link you were sent; you can join as a guest without an email.
            </p>
          </>
        )}
      </main>
    </div>
  );
}

export function CheckInbox() {
  useTitle("Check your inbox");
  const loc = useLocation();
  const state = (loc.state ?? {}) as { email?: string; devLink?: string; next?: string };
  const [resent, setResent] = useState(false);
  const [devLink, setDevLink] = useState(state.devLink);

  return (
    <div className="narrow-page">
      <header className="narrow-head">
        <BackButton to="/signin" />
        <Logo size={18} />
        <span style={{ width: 36 }} />
      </header>
      <main id="main" className="narrow-main">
        <span className="inbox-icon" aria-hidden="true">
          <Icon name="mark_email_unread" size={34} />
        </span>
        <h1 className="page-h1">Check your inbox</h1>
        <p className="lede muted">
          {state.email ? (
            <>
              We sent a sign-in link to <b className="ink">{state.email}</b>.
            </>
          ) : (
            "We sent you a sign-in link."
          )}{" "}
          It works once, for 15 minutes. You can close this tab.
        </p>
        {devLink && (
          <Banner tone="amber" icon="science">
            Development only:{" "}
            <a href={devLink} className="link-btn">
              open the sign-in link
            </a>
          </Banner>
        )}
        {resent && (
          <Banner tone="green" icon="check_circle" role="status">
            Sent again. Check spam if it still doesn't show up.
          </Banner>
        )}
        {state.email && (
          <ResendButton
            email={state.email}
            onSent={(d) => {
              setResent(true);
              if (d) setDevLink(d);
            }}
            next={state.next}
          />
        )}
        <Link to="/signin" className="link-btn">
          Use a different email
        </Link>
      </main>
    </div>
  );
}

function ResendButton({ email, next, onSent }: { email: string; next?: string; onSent: (devLink?: string) => void }) {
  const f = useEmailLinkForm("signin", next);
  const [primed, setPrimed] = useState(false);
  if (!primed) {
    // Turnstile tokens are single-use: render a fresh widget only when resending.
    return (
      <button
        type="button"
        className="btn btn-outline btn-block"
        onClick={() => {
          f.setEmail(email);
          setPrimed(true);
        }}
      >
        <Icon name="refresh" size={18} />
        Resend link
      </button>
    );
  }
  return (
    <form
      className="stack-12"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await f.submit();
        if (r) {
          onSent(r.devLink);
          setPrimed(false);
        }
      }}
    >
      <Turnstile ref={f.ts} onToken={f.setToken} action="sign_in" />
      {f.error && <span className="field-error">{f.error}</span>}
      <button type="submit" className="btn btn-primary btn-block" disabled={f.pending}>
        {f.pending ? "Sending…" : `Send again to ${email}`}
      </button>
    </form>
  );
}
