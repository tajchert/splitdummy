import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { UpdateMeSchema, type DeletionPreviewDTO } from "@shared/api";
import { useApi, useSession } from "../api/context";
import { ApiError, errorMessage } from "../api/errors";
import { useSubmit } from "../api/idempotency";
import { Field } from "../components/Field";
import { AppBar, BackButton, RequireSession, useTitle } from "../components/Shell";
import { useToast } from "../components/Toast";
import { Turnstile } from "../components/Turnstile";
import { Sheet } from "../components/Dialog";
import { Banner, Icon, Loading } from "../components/ui";
import { plural } from "../lib/format";
import { getThemePref, setThemePref, type ThemePref } from "../lib/theme";
import { useEmailLinkForm } from "./SignIn";
import { ApiKeys } from "./ApiKeys";

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

        <AccountName />

        {!me.email && <AttachEmail />}
        <ApiKeys />

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

        <DangerZone />
      </main>
    </>
  );
}

/** Account-level name: the default for new groups. Each group keeps its own name. */
function AccountName() {
  const api = useApi();
  const { me, setMe, refresh } = useSession();
  const toast = useToast();
  const { run, pending } = useSubmit();
  const saved = me?.displayName ?? "";
  const [name, setName] = useState(saved);
  const [error, setError] = useState<string | undefined>();
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    const trimmed = name.trim();
    const parsed = UpdateMeSchema.safeParse({ displayName: trimmed || null });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message);
    try {
      const updated = await run(parsed.data, (k) => api.updateMe(parsed.data, { idempotencyKey: k }));
      if (updated) setMe(updated);
      void refresh();
      setName(trimmed);
      toast(trimmed ? "Name saved" : "Name removed");
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <form className="card" onSubmit={onSubmit} noValidate aria-labelledby="acc-name">
      <h2 id="acc-name" className="card-title">
        Your name
      </h2>
      <div className="inline-form">
        <Field label="Name" error={error} className="grow">
          {(p) => (
            <input {...p} className="input" value={name} maxLength={40} autoComplete="name" placeholder="For example: Maya" onChange={(e) => (setName(e.target.value), setError(undefined))} />
          )}
        </Field>
        <button type="submit" className="btn btn-secondary btn-md" disabled={pending || name.trim() === saved}>
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="tiny muted">Filled in for you when you create a group. Each group keeps its own name, which you can change in that group's settings.</p>
    </form>
  );
}

function DangerZone() {
  const [open, setOpen] = useState(false);
  return (
    <section className="danger-zone" aria-labelledby="acc-delete">
      <h2 id="acc-delete" className="card-title danger-text">
        Delete account
      </h2>
      <p className="small muted">Groups you own are deleted for everyone. In groups you joined, your entries stay and your name becomes “Deleted account”.</p>
      <button type="button" className="btn btn-md btn-danger-outline align-start" onClick={() => setOpen(true)}>
        <Icon name="delete_forever" size={18} />
        Delete account…
      </button>
      {open && <DeleteAccountDialog onClose={() => setOpen(false)} />}
    </section>
  );
}

export function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const { setMe } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const sub = useSubmit();
  const [preview, setPreview] = useState<DeletionPreviewDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  const load = useCallback(() => {
    setLoadError(null);
    api.getDeletionPreview().then(setPreview, (e) => setLoadError(errorMessage(e)));
  }, [api]);
  useEffect(load, [load]);

  const blocked = !!preview && preview.blockingProjects.length > 0;
  const canDelete = !!preview && !blocked && typed.trim() === "DELETE" && !sub.pending;

  const confirmDelete = async () => {
    if (!canDelete) return;
    setError(null);
    try {
      await sub.run("delete-account", (k) => api.deleteAccount({ confirm: "DELETE" }, { idempotencyKey: k }));
      setMe(null);
      toast("Your account was deleted", "info");
      navigate("/", { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.code === "ACCOUNT_HAS_OPEN_TRANSFERS") load();
      setError(errorMessage(e));
    }
  };

  const groupLink = (g: { id: string; name: string }) => (
    <Link to={`/g/${encodeURIComponent(g.id)}`} onClick={onClose}>
      {g.name}
    </Link>
  );

  return (
    <Sheet
      title="Delete your account?"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost btn-md" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger btn-md" disabled={!canDelete} onClick={() => void confirmDelete()}>
            <Icon name="delete_forever" size={18} />
            {sub.pending ? "Deleting…" : "Delete account"}
          </button>
        </>
      }
    >
      {loadError ? (
        <Banner tone="red" icon="error" role="alert" action={<button type="button" className="btn btn-sm btn-ghost" onClick={load}>Try again</button>}>
          {loadError}
        </Banner>
      ) : !preview ? (
        <Loading label="Checking your groups" inline />
      ) : (
        <>
          {blocked && (
            <Banner tone="red" icon="warning" role="alert">
              You can't delete your account yet
              <p>
                You still have unsettled expenses or transfers in {preview.blockingProjects.map((g, i) => (
                  <span key={g.id}>
                    {i > 0 && ", "}
                    {groupLink(g)}
                  </span>
                ))}
                . Once the round is frozen and your transfers are confirmed, you can delete your account.
              </p>
            </Banner>
          )}
          <section className="stack-8" aria-labelledby="del-owned">
            <h3 id="del-owned" className="field-label">
              Groups you own: deleted for everyone
            </h3>
            {preview.ownedProjects.length === 0 ? (
              <p className="small muted">You don't own any groups.</p>
            ) : (
              <ul className="del-list">
                {preview.ownedProjects.map((g) => (
                  <li key={g.id}>
                    <Icon name="delete" size={16} className="danger-text" />
                    <span className="grow">{g.name}</span>
                    <span className="tiny muted">{plural(g.memberCount, "member", "members")}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="stack-8" aria-labelledby="del-joined">
            <h3 id="del-joined" className="field-label">
              Groups you joined: they stay, your name becomes “Deleted account”
            </h3>
            {preview.memberProjects.length === 0 ? (
              <p className="small muted">You haven't joined any other groups.</p>
            ) : (
              <ul className="del-list">
                {preview.memberProjects.map((g) => (
                  <li key={g.id}>
                    <Icon name="person_off" size={16} className="muted" />
                    <span className="grow">{g.name}</span>
                    {preview.blockingProjects.some((b) => b.id === g.id) && <span className="tiny danger-text strong">Unsettled expenses or transfers</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="small muted">Your email and sign-in are removed. This can't be undone.</p>
          <Field label="Type DELETE to confirm">
            {(p) => (
              <input
                {...p}
                className="input"
                value={typed}
                disabled={blocked}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void confirmDelete()}
              />
            )}
          </Field>
          {error && (
            <div className="form-error" role="alert">
              <Icon name="error" size={18} />
              {error}
            </div>
          )}
        </>
      )}
    </Sheet>
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
