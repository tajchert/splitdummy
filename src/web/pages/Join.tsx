import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import type { InvitationPreviewDTO } from "@shared/api";
import { DisplayNameSchema } from "@shared/api";
import { useApi, useSession } from "../api/context";
import { ApiError, errorMessage, fieldErrors } from "../api/errors";
import { useSubmit } from "../api/idempotency";
import { Field } from "../components/Field";
import { PageLoading, useTitle } from "../components/Shell";
import { useToast } from "../components/Toast";
import { Turnstile } from "../components/Turnstile";
import { Icon, Logo } from "../components/ui";
import { currencyName } from "../lib/format";
import { useEmailLinkForm } from "./SignIn";

const UNAVAILABLE: Record<Exclude<InvitationPreviewDTO["status"], "OPEN">, { icon: string; title: string; body: string }> = {
  EXPIRED: { icon: "schedule", title: "This invitation has expired", body: "Ask the group owner for a new link." },
  REVOKED: { icon: "link_off", title: "This invitation was withdrawn", body: "The owner turned this link off. Ask them for a new one." },
  MEMBERSHIP_FROZEN: {
    icon: "lock",
    title: "This group isn't taking new members right now",
    body: "Expenses are frozen while everyone settles up. Ask the owner to invite you once the next round starts.",
  },
};

export function Join() {
  const params = useParams();
  const { hash } = useLocation();
  // Invitation links carry the token in the fragment (/join#<token>) so it never hits server logs.
  const token = params.token ?? decodeURIComponent(hash.slice(1));
  const api = useApi();
  const { me, refresh } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, pending } = useSubmit();
  const [preview, setPreview] = useState<InvitationPreviewDTO | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [search, setSearch] = useSearchParams();
  const verified = !!me?.email;
  const [name, setName] = useState(search.get("name") ?? me?.displayName ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const nextPath = (n: string) => `/join/${encodeURIComponent(token)}?name=${encodeURIComponent(n)}&auto=1`;
  const emailForm = useEmailLinkForm("signin", nextPath(name.trim()));
  const autoStarted = useRef(false);
  useTitle(preview ? `Join ${preview.projectName}` : "Join a group");

  useEffect(() => {
    if (!token) {
      setLoadError(new ApiError(404, "NOT_FOUND", "This invitation link is incomplete."));
      return;
    }
    api.previewInvite(token).then(setPreview, (e) => setLoadError(e instanceof ApiError ? e : null));
  }, [api, token]);

  useEffect(() => {
    if (me?.displayName && !name) setName(me.displayName);
  }, [me, name]);

  const doJoin = async (displayName: string) => {
    try {
      const r = await run({ token, displayName }, (k) => api.join({ token, displayName }, { idempotencyKey: k }));
      await refresh();
      toast(`You joined ${preview?.projectName ?? "the group"}`);
      navigate(`/g/${encodeURIComponent(r.projectId)}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVITE_INVALID") {
        api.previewInvite(token).then(setPreview, () => {});
      }
      // The session lapsed between pages: refreshing drops `me` and shows the email form again.
      if (err instanceof ApiError && err.code === "EMAIL_REQUIRED") await refresh();
      setErrors(err instanceof ApiError ? fieldErrors(err) : { _form: errorMessage(err) });
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const n = DisplayNameSchema.safeParse(name);
    if (!n.success) {
      setErrors({ displayName: n.error.issues[0]?.message ?? "Enter a name" });
      return;
    }
    await doJoin(n.data);
  };

  // Back from the magic link (?name=…&auto=1): join without another click.
  useEffect(() => {
    if (autoStarted.current || search.get("auto") !== "1" || !verified || preview?.status !== "OPEN" || preview.alreadyMemberProjectId) return;
    const n = DisplayNameSchema.safeParse(search.get("name") ?? "");
    if (!n.success) return;
    autoStarted.current = true;
    // Drop auto=1 first so a refresh or StrictMode re-run never submits twice.
    const next = new URLSearchParams(search);
    next.delete("auto");
    setSearch(next, { replace: true });
    void doJoin(n.data);
  }, [search, verified, preview]); // eslint-disable-line react-hooks/exhaustive-deps

  const nameField = (
    <Field label="Your name" error={errors.displayName} hint="How others in the group will see you. Pick something they'll recognise.">
      {(p) => (
        <input
          {...p}
          className="input"
          value={name}
          maxLength={40}
          autoComplete="given-name"
          autoFocus
          onChange={(e) => (setName(e.target.value), setErrors({}))}
        />
      )}
    </Field>
  );
  const formError = (msg: string) => (
    <div className="form-error" role="alert">
      <Icon name="error" size={18} />
      {msg}
    </div>
  );

  return (
    <div className="narrow-page">
      <header className="narrow-head narrow-head-center">
        <Link to="/" aria-label="Splitdummy home" className="appbar-home">
          <Logo size={18} />
        </Link>
      </header>
      <main id="main" className="narrow-main">
        {!preview && !loadError && <PageLoading />}
        {loadError && (
          <div className="stack-12">
            <h1 className="page-h1">This invitation isn't available</h1>
            <p className="muted lede">
              {loadError.status === 404 ? "The link may be mistyped, or the group no longer exists. Ask the owner for a new link." : errorMessage(loadError)}
            </p>
            <Link to="/" className="btn btn-outline">
              Go to the start page
            </Link>
          </div>
        )}
        {preview && preview.alreadyMemberProjectId && (
          <div className="stack-12">
            <p className="muted">You're already in</p>
            <h1 className="page-h1">{preview.projectName}</h1>
            <Link to={`/g/${encodeURIComponent(preview.alreadyMemberProjectId)}`} className="btn btn-primary btn-block">
              Open the group
            </Link>
          </div>
        )}
        {preview && !preview.alreadyMemberProjectId && preview.status !== "OPEN" && (
          <div className="stack-12">
            <span className="inbox-icon" aria-hidden="true">
              <Icon name={UNAVAILABLE[preview.status].icon} size={30} />
            </span>
            <p className="muted">{preview.projectName}</p>
            <h1 className="page-h1">{UNAVAILABLE[preview.status].title}</h1>
            <p className="lede muted">{UNAVAILABLE[preview.status].body}</p>
          </div>
        )}
        {preview && !preview.alreadyMemberProjectId && preview.status === "OPEN" && (
          <>
            <p className="muted">You're invited to</p>
            <h1 className="page-h1 join-title">{preview.projectName}</h1>
            <p className="meta">
              <span className="meta-item">
                <Icon name="payments" size={16} />
                Settles in {preview.baseCurrency} ({currencyName(preview.baseCurrency)})
              </span>
            </p>
            {verified ? (
              <form className="stack-16" onSubmit={onSubmit} noValidate>
                {nameField}
                {errors._form && formError(errors._form)}
                <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
                  {pending ? "Joining…" : "Join"}
                </button>
                <p className="tiny muted">Joining as {me!.email}. You'll be added as a new member; nobody can take over another person's place.</p>
              </form>
            ) : (
              <form
                className="stack-16"
                noValidate
                onSubmit={async (e) => {
                  e.preventDefault();
                  const n = DisplayNameSchema.safeParse(name);
                  if (!n.success) return setErrors({ displayName: n.error.issues[0]?.message ?? "Enter a name" });
                  const sent = await emailForm.submit();
                  if (sent) navigate("/signin/sent", { state: { email: sent.email, devLink: sent.devLink, next: nextPath(n.data) } });
                }}
              >
                {nameField}
                <Field label="Email" error={emailForm.error ?? undefined} hint="We'll email you a link. Opening it confirms your email and adds you to the group.">
                  {(p) => (
                    <input
                      {...p}
                      className="input"
                      type="email"
                      autoComplete="email"
                      inputMode="email"
                      value={emailForm.email}
                      onChange={(e) => emailForm.setEmail(e.target.value)}
                    />
                  )}
                </Field>
                <Turnstile ref={emailForm.ts} onToken={emailForm.setToken} action="sign_in" />
                {errors._form && formError(errors._form)}
                <button type="submit" className="btn btn-primary btn-block" disabled={emailForm.pending}>
                  {emailForm.pending ? "Sending…" : "Email me a link"}
                </button>
              </form>
            )}
          </>
        )}
      </main>
    </div>
  );
}
