import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import type { MemberInvitePreviewDTO } from "@shared/api";
import { DisplayNameSchema } from "@shared/api";
import { useApi, useSession } from "../api/context";
import { ApiError, errorMessage, fieldErrors } from "../api/errors";
import { useSubmit } from "../api/idempotency";
import { Field } from "../components/Field";
import { PageLoading, useTitle } from "../components/Shell";
import { useToast } from "../components/Toast";
import { Icon, Logo } from "../components/ui";
import { currencyName } from "../lib/format";

/** The token from an /invite#<token> fragment; "" (an incomplete link) when it isn't valid percent-encoding. */
function tokenFromHash(hash: string): string {
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return "";
  }
}

/** Accepts an email invitation: claims the placeholder the owner made and confirms this email. */
export function Invite() {
  const params = useParams();
  const { hash } = useLocation();
  // Emailed links carry the token in the fragment (/invite#<token>) so it never hits server logs.
  const token = params.token ?? tokenFromHash(hash);
  const api = useApi();
  const { refresh, me } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, pending } = useSubmit();
  const [preview, setPreview] = useState<MemberInvitePreviewDTO | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  useTitle(preview ? `Join ${preview.projectName}` : "Your invitation");

  useEffect(() => {
    if (!token) return setLoadError(new ApiError(404, "NOT_FOUND", "This invitation link is incomplete."));
    api.previewMemberInvite(token).then(
      (p) => (setPreview(p), setName(p.displayName)),
      (e) => setLoadError(e instanceof ApiError ? e : new ApiError(500, "INTERNAL", errorMessage(e))),
    );
  }, [api, token]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const n = DisplayNameSchema.safeParse(name);
    if (!n.success) return setErrors({ displayName: n.error.issues[0]?.message ?? "Enter a name" });
    const body = { token, displayName: n.data };
    try {
      const r = await run(body, (k) => api.acceptMemberInvite(body, { idempotencyKey: k }));
      await refresh();
      toast(`You joined ${preview?.projectName ?? "the group"}`);
      navigate(`/g/${encodeURIComponent(r.projectId)}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVITE_INVALID") api.previewMemberInvite(token).then(setPreview, () => {});
      setErrors(err instanceof ApiError ? fieldErrors(err) : { _form: errorMessage(err) });
    }
  };

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
              {loadError.status === 404 ? "It may have been cancelled, replaced by a newer email, or mistyped. Ask the owner to send it again." : errorMessage(loadError)}
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
              <Icon name={preview.status === "EXPIRED" ? "schedule" : "task_alt"} size={30} />
            </span>
            <p className="muted">{preview.projectName}</p>
            <h1 className="page-h1">{preview.status === "EXPIRED" ? "This invitation has expired" : "This invitation was already used"}</h1>
            <p className="lede muted">{preview.status === "EXPIRED" ? "Ask the group owner to send you a new one." : "Sign in with the same email to open the group."}</p>
            {preview.status === "CLAIMED" && (
              <Link to={`/signin?next=${encodeURIComponent("/groups")}`} className="btn btn-outline">
                Sign in
              </Link>
            )}
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
            <p className="small">
              The owner added you as <b>{preview.displayName}</b>. Anything already split with {preview.displayName} becomes yours.
            </p>
            <form className="stack-16" onSubmit={onSubmit} noValidate>
              <Field label="Your name" error={errors.displayName} hint={preview.canRename ? "How others in the group will see you." : "The owner manages names in this group."}>
                {(p) => (
                  <input
                    {...p}
                    className="input"
                    value={name}
                    maxLength={40}
                    readOnly={!preview.canRename}
                    autoComplete="given-name"
                    onChange={(e) => (setName(e.target.value), setErrors({}))}
                  />
                )}
              </Field>
              {errors._form && (
                <div className="form-error" role="alert">
                  <Icon name="error" size={18} />
                  {errors._form}
                </div>
              )}
              <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
                {pending ? "Joining…" : "Join"}
              </button>
              <p className="tiny muted">Joining signs you in with the email this invitation was sent to.</p>
              {me && (
                <p className="tiny muted">
                  You're signed in as {me.email ?? "a guest"}. Joining switches this browser to the invited email's account.
                </p>
              )}
            </form>
          </>
        )}
      </main>
    </div>
  );
}
