import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { InvitationDTO, ProjectViewDTO } from "@shared/api";
import { DisplayNameSchema, ProjectNameSchema } from "@shared/api";
import { parseRate, rateToString } from "@shared/money";
import { useApi } from "../../api/context";
import { errorMessage } from "../../api/errors";
import { useSubmit } from "../../api/idempotency";
import { ConfirmDialog } from "../../components/Dialog";
import { CurrencySelect, Field, Toggle } from "../../components/Field";
import { BackButton, useTitle } from "../../components/Shell";
import { useToast } from "../../components/Toast";
import { Banner, Icon } from "../../components/ui";
import { currencyName, decimalSeparator, fmtDate, fmtDateTime, fmtRate } from "../../lib/format";
import { rateErrorText } from "../../lib/entryForm";
import { nameOf } from "../../lib/project";
import { useProject, useView } from "../../state/project";
import { FreezeDateForm, freezeScheduleSentence } from "./FreezeDate";
import { MembersCard, useMutation } from "./MembersCard";
import { groupBase } from "./parts";

export function Settings() {
  const view = useView();
  const loc = useLocation();
  useTitle(`Settings · ${view.project.name}`);
  useEffect(() => {
    if (loc.hash) document.getElementById(loc.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [loc.hash]);
  const base = groupBase(view.project.id);
  const owner = view.me.isOwner;
  return (
    <main id="main" className="page page-mid settings">
      <div className="page-top">
        <BackButton to={base} label="Back to group" />
      </div>
      <h1 className="page-h1">Settings</h1>
      {!owner && (
        <p className="small muted meta-item">
          <Icon name="info" size={16} />
          {nameOf(view, view.project.ownerMemberId)} is the owner and manages these settings.
        </p>
      )}
      <PendingOwnership view={view} />
      <YourName view={view} />
      <GroupName view={view} />
      <FreezeDateSettings view={view} />
      <CurrencySettings view={view} />
      {(view.project.multiCurrencyEnabled || view.rates.length > 0) && <RateDefaults view={view} />}
      {owner && <Invitations view={view} />}
      <MembersCard view={view} />
      {!owner && <LeaveGroup view={view} />}
      <Link to="/account" className="card link-card">
        <span className="meta-item ink">
          <Icon name="person" size={18} />
          Your account &amp; sign-in
        </span>
        <Icon name="chevron_right" size={18} className="muted" />
      </Link>
    </main>
  );
}

/** Members change their own name here unless the owner locked renaming; the change shows in History. */
function YourName({ view }: { view: ProjectViewDTO }) {
  const api = useApi();
  const m = useMutation();
  const current = view.members.find((x) => x.id === view.me.memberId)?.displayName ?? "";
  const locked = !view.project.membersCanRename && !view.me.isOwner;
  const [name, setName] = useState(current);
  const [fieldErr, setFieldErr] = useState<string | undefined>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (locked) return; // Enter in the read-only field still submits the form.
    const p = DisplayNameSchema.safeParse(name);
    if (!p.success) return setFieldErr(p.error.issues[0]?.message);
    if (p.data === current) return;
    const body = { displayName: p.data };
    const ok = await m.run(body, (k) => api.renameMe(view.project.id, body, { idempotencyKey: k }), "Your name is updated");
    if (ok) setName(p.data);
  };
  return (
    <form className="card" id="your-name" onSubmit={submit} noValidate aria-labelledby="s-you">
      <h2 id="s-you" className="card-title">
        Your name in this group
      </h2>
      <div className="inline-form">
        <Field label="Name" error={fieldErr ?? m.error ?? undefined} className="grow">
          {(p) => (
            <input
              {...p}
              className="input"
              value={locked ? current : name}
              maxLength={40}
              autoComplete="nickname"
              readOnly={locked}
              onChange={(e) => (setName(e.target.value), setFieldErr(undefined))}
            />
          )}
        </Field>
        {!locked && (
          <button type="submit" className="btn btn-secondary btn-md" disabled={m.pending || name.trim() === current || !name.trim()}>
            Save
          </button>
        )}
      </div>
      <p className="tiny muted">{locked ? "The owner manages names in this group." : "Everyone in the group sees it. The change is noted in History."}</p>
    </form>
  );
}

function GroupName({ view }: { view: ProjectViewDTO }) {
  const api = useApi();
  const m = useMutation();
  const [name, setName] = useState(view.project.name);
  const [fieldErr, setFieldErr] = useState<string | undefined>();
  const owner = view.me.isOwner;
  if (!owner) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = ProjectNameSchema.safeParse(name);
    if (!p.success) return setFieldErr(p.error.issues[0]?.message);
    if (p.data === view.project.name) return;
    const body = { expectedVersion: view.project.version, name: p.data };
    await m.run(body, (k) => api.updateSettings(view.project.id, body, { idempotencyKey: k }), "Name saved");
  };
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="s-name">
      <h2 id="s-name" className="card-title">
        Group name
      </h2>
      <div className="inline-form">
        <Field label="Name" error={fieldErr ?? m.error ?? undefined} className="grow">
          {(p) => <input {...p} className="input" value={name} maxLength={80} onChange={(e) => (setName(e.target.value), setFieldErr(undefined))} />}
        </Field>
        <button type="submit" className="btn btn-secondary btn-md" disabled={m.pending || name.trim() === view.project.name}>
          Save
        </button>
      </div>
    </form>
  );
}

function FreezeDateSettings({ view }: { view: ProjectViewDTO }) {
  const round = view.current.round;
  if (round.status !== "COLLECTING") return null;
  if (!view.me.isOwner && !round.scheduledFreezeDate) return null;
  return (
    <section className="card" id="freeze-date-card" aria-labelledby="s-freeze">
      <h2 id="s-freeze" className="card-title">
        Freeze date
      </h2>
      {view.me.isOwner ? (
        <FreezeDateForm key={round.scheduledFreezeDate ?? "none"} view={view} />
      ) : (
        <p className="small">{freezeScheduleSentence(round)}</p>
      )}
    </section>
  );
}

function CurrencySettings({ view }: { view: ProjectViewDTO }) {
  const api = useApi();
  const m = useMutation();
  const owner = view.me.isOwner;
  const p = view.project;
  const status = view.current.round.status;
  const settling = status === "SETTLING";
  const foreign = view.current.round.status === "COLLECTING" ? view.current.entries.filter((e) => e.originalCurrency !== p.baseCurrency && e.type !== "ADJUSTMENT").length : 0;
  const [confirmMulti, setConfirmMulti] = useState<boolean | null>(null);
  const [base, setBase] = useState(p.baseCurrency);
  const hintId = useId();

  const toggleBlocked = settling ? "Currency settings are locked while everyone settles up." : p.multiCurrencyEnabled && foreign > 0 ? `${foreign} ${foreign === 1 ? "entry in this round uses" : "entries in this round use"} another currency. Change or delete ${foreign === 1 ? "it" : "them"} before turning this off.` : null;

  const applyMulti = async (v: boolean) => {
    const body = { expectedVersion: p.version, multiCurrencyEnabled: v };
    const ok = await m.run(body, (k) => api.updateSettings(p.id, body, { idempotencyKey: k }), v ? "Other currencies allowed" : "Other currencies turned off");
    if (ok) setConfirmMulti(null);
  };
  const applyBase = async () => {
    const body = { expectedVersion: p.version, baseCurrency: base };
    await m.run(body, (k) => api.updateSettings(p.id, body, { idempotencyKey: k }), `Settlement currency is now ${base}`);
  };

  return (
    <section className="card" aria-labelledby="s-cur">
      <h2 id="s-cur" className="card-title">
        Currency
      </h2>
      <div className="stack-8">
        <div className="kv">
          <span className="muted">Settlement currency</span>
          <b>
            {p.baseCurrency} · {currencyName(p.baseCurrency)}
          </b>
        </div>
        {owner && !p.baseCurrencyLocked && !settling ? (
          <div className="stack-8">
            {/* The hint sits below the row: inside the Field it would push the select up and misalign Save. */}
            <div className="inline-form">
              <Field label="Change settlement currency" className="grow">
                {(fp) => <CurrencySelect {...fp} aria-describedby={hintId} value={base} onChange={setBase} />}
              </Field>
              <button type="button" className="btn btn-secondary btn-md" disabled={base === p.baseCurrency || m.pending} onClick={() => void applyBase()}>
                Save
              </button>
            </div>
            <p id={hintId} className="field-hint">
              Possible only until the first entry is added.
            </p>
          </div>
        ) : (
          <p className="tiny muted meta-item">
            <Icon name="lock" size={14} />
            {p.baseCurrencyLocked ? "Fixed after the first entry, so past balances stay comparable. A different settlement currency needs a new group." : "Locked while settling."}
          </p>
        )}
      </div>
      <div className="dashed-top">
        <Toggle
          checked={p.multiCurrencyEnabled}
          disabled={!owner || !!toggleBlocked || m.pending}
          onChange={(v) => setConfirmMulti(v)}
          label="Allow expenses in other currencies"
          description={
            toggleBlocked ?? `Expenses can use different currencies, each with its own saved conversion. Everyone settles in ${p.baseCurrency}.`
          }
        />
      </div>
      {m.error && (
        <span className="field-error" role="alert">
          <Icon name="error" size={16} />
          {m.error}
        </span>
      )}
      {confirmMulti !== null && (
        <ConfirmDialog
          title={confirmMulti ? "Allow other currencies?" : "Turn off other currencies?"}
          confirmLabel={confirmMulti ? "Allow" : "Turn off"}
          pending={m.pending}
          onCancel={() => setConfirmMulti(null)}
          onConfirm={() => void applyMulti(confirmMulti)}
        >
          <p>
            {confirmMulti
              ? `People can add expenses in any currency with a saved conversion to ${p.baseCurrency}. Existing entries don't change.`
              : `New expenses will only take ${p.baseCurrency}. Earlier rounds keep their currencies and rates.`}
          </p>
          <p>Everyone's “done adding” is cleared so they can check the change.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function RateDefaults({ view }: { view: ProjectViewDTO }) {
  const api = useApi();
  const m = useMutation();
  const owner = view.me.isOwner;
  const p = view.project;
  const sep = decimalSeparator();
  const firstOther = ["USD", "EUR", "GBP"].find((c) => c !== p.baseCurrency) ?? "USD";
  const [cur, setCur] = useState(firstOther);
  const [rate, setRate] = useState("");
  const [rateErr, setRateErr] = useState<string | undefined>();
  const [removing, setRemoving] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = parseRate(rate, sep);
    if (!r.ok) return setRateErr(rateErrorText(r.error, sep));
    const existing = view.rates.find((x) => x.currency === cur);
    const body = { rate: rateToString(r.value), ...(existing ? { expectedRevision: existing.revision } : {}) };
    const ok = await m.run({ cur, ...body }, (k) => api.putRate(p.id, cur, body, { idempotencyKey: k }), `Saved: 1 ${cur} = ${fmtRate(body.rate)} ${p.baseCurrency}`);
    if (ok) setRate("");
  };

  return (
    <section className="card" aria-labelledby="s-rates">
      <h2 id="s-rates" className="card-title">
        Saved exchange rates
      </h2>
      <p className="small muted">Prefilled when someone adds an expense in that currency. Changing a rate only affects new entries; saved entries keep theirs.</p>
      {view.rates.length === 0 ? (
        <p className="small muted">No saved rates. People enter the rate their bank used, or the amount charged.</p>
      ) : (
        <ul className="plain-list">
          {view.rates.map((r) => (
            <li key={r.currency} className="row-plain rate-row">
              <div className="grow">
                <b className="num">
                  1 {r.currency} = {fmtRate(r.rate)} {p.baseCurrency}
                </b>
                <div className="tiny muted">
                  Set by {nameOf(view, r.setByMemberId)}, {fmtDateTime(r.setAt, true)}
                </div>
              </div>
              {owner && view.current.round.status !== "SETTLING" && (
                <>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setCur(r.currency), setRate(fmtRate(r.rate)))}>
                    Edit
                  </button>
                  <button type="button" className="icon-btn" aria-label={`Remove saved rate for ${r.currency}`} onClick={() => setRemoving(r.currency)}>
                    <Icon name="delete" size={18} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {owner && view.current.round.status !== "SETTLING" && (
        <form className="rate-form" onSubmit={save} noValidate>
          <span className="rate-form-eq">1</span>
          <CurrencySelect compact aria-label="Currency" value={cur} onChange={setCur} exclude={[p.baseCurrency]} />
          <span className="rate-form-eq">=</span>
          <input
            className="input rate-input"
            inputMode="decimal"
            aria-label={`Rate in ${p.baseCurrency}`}
            aria-invalid={rateErr ? true : undefined}
            placeholder={`0${sep}00`}
            value={rate}
            onChange={(e) => (setRate(e.target.value), setRateErr(undefined))}
          />
          <span className="rate-form-eq">{p.baseCurrency}</span>
          <button type="submit" className="btn btn-secondary btn-md" disabled={m.pending}>
            Save rate
          </button>
        </form>
      )}
      {(rateErr || m.error) && (
        <span className="field-error" role="alert">
          <Icon name="error" size={16} />
          {rateErr ?? m.error}
        </span>
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove the saved ${removing} rate?`}
          confirmLabel="Remove"
          danger
          pending={m.pending}
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            const c = removing;
            const ok = await m.run({ del: c }, (k) => api.deleteRate(p.id, c, { idempotencyKey: k }), "Rate removed");
            if (ok) setRemoving(null);
          }}
        >
          <p>Existing entries keep their conversion. New {removing} expenses will ask for a rate.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function inviteState(i: InvitationDTO): "active" | "revoked" | "expired" {
  if (i.revokedAt) return "revoked";
  if (new Date(i.expiresAt).getTime() < Date.now()) return "expired";
  return "active";
}

function Invitations({ view }: { view: ProjectViewDTO }) {
  const api = useApi();
  const m = useMutation();
  const { refresh } = useProject();
  const toast = useToast();
  const [fresh, setFresh] = useState<InvitationDTO | null>(null);
  const [copied, setCopied] = useState(false);
  const settling = view.current.round.status === "SETTLING";
  const invitations = (view.invitations ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const create = async () => {
    m.setError(null);
    try {
      // A fresh key every click: each click is a new, distinct invitation.
      const inv = await api.createInvite(view.project.id, { idempotencyKey: crypto.randomUUID() });
      setFresh(inv);
      setCopied(false);
      toast("Invitation link created");
      void refresh();
    } catch (e) {
      m.setError(errorMessage(e));
    }
  };
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast("Link copied");
    } catch {
      setCopied(false);
      m.setError("Couldn't copy automatically. Select the link and copy it.");
    }
  };

  return (
    <section className="card" id="invite" aria-labelledby="s-inv">
      <h2 id="s-inv" className="card-title">
        Invite people
      </h2>
      <p className="small muted">
        Anyone with the link can join after confirming their email. They can't take over someone who's already in the group. To invite a specific person, add them under Members.
      </p>
      {settling && (
        <Banner tone="neutral" icon="lock">
          Joining is paused while settling
          <p>Members are locked until this round is settled. New people can join in the next round.</p>
        </Banner>
      )}
      {fresh?.url && (
        <div className="invite-fresh">
          <label htmlFor="inv-url" className="field-label">
            New invitation link
          </label>
          <div className="inline-form">
            <input id="inv-url" className="input input-mono" readOnly value={fresh.url} onFocus={(e) => e.target.select()} />
            <button type="button" className="btn btn-primary btn-md" onClick={() => void copy(fresh.url!)}>
              <Icon name={copied ? "check" : "content_copy"} size={18} />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <span className="tiny muted">Shown only now. Expires {fmtDate(fresh.expiresAt)}.</span>
          {typeof navigator.share === "function" && (
            <button type="button" className="link-btn small" onClick={() => void navigator.share({ title: view.project.name, url: fresh.url }).catch(() => {})}>
              <Icon name="ios_share" size={16} />
              Share…
            </button>
          )}
        </div>
      )}
      <button type="button" className="btn btn-soft btn-md" onClick={() => void create()} disabled={settling}>
        <Icon name="person_add" size={18} />
        {invitations.length ? "Create another link" : "Create invitation link"}
      </button>
      {m.error && (
        <span className="field-error" role="alert">
          <Icon name="error" size={16} />
          {m.error}
        </span>
      )}
      {invitations.length > 0 && (
        <ul className="plain-list">
          {invitations.map((i) => {
            const st = inviteState(i);
            return (
              <li key={i.id} className="row-plain">
                <Icon name={st === "active" ? "link" : "link_off"} size={18} className="muted" />
                <div className="grow">
                  <span className="small">Created {fmtDate(i.createdAt)}</span>
                  <div className="tiny muted">
                    {st === "active" ? `Expires ${fmtDate(i.expiresAt)}` : st === "revoked" ? `Revoked ${fmtDate(i.revokedAt!)}` : `Expired ${fmtDate(i.expiresAt)}`}
                  </div>
                </div>
                {st === "active" && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={m.pending}
                    onClick={() => void m.run({ revoke: i.id }, (k) => api.revokeInvite(view.project.id, i.id, { idempotencyKey: k }), "Link revoked")}
                  >
                    Revoke
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PendingOwnership({ view }: { view: ProjectViewDTO }) {
  const api = useApi();
  const m = useMutation();
  const pendingId = view.project.pendingOwnerMemberId;
  if (!pendingId) return null;
  if (pendingId === view.me.memberId) {
    return (
      <Banner
        tone="blue"
        icon="workspace_premium"
        action={
          <button
            type="button"
            className="btn btn-sm btn-ink"
            disabled={m.pending}
            onClick={() => void m.run({ accept: pendingId }, (k) => api.acceptOwnership(view.project.id, { idempotencyKey: k }), "You're now the owner")}
          >
            Accept
          </button>
        }
      >
        {nameOf(view, view.project.ownerMemberId)} offered you ownership
        <p>{m.error ?? "You'd manage invitations, currencies and freezing."}</p>
      </Banner>
    );
  }
  if (view.me.isOwner) {
    return (
      <Banner tone="neutral" icon="hourglass_top">
        Waiting for {nameOf(view, pendingId)} to accept ownership
      </Banner>
    );
  }
  return null;
}

function LeaveGroup({ view }: { view: ProjectViewDTO }) {
  const api = useApi();
  const navigate = useNavigate();
  const toast = useToast();
  const sub = useSubmit();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const me = view.members.find((x) => x.id === view.me.memberId);
  return (
    <section className="card" aria-labelledby="s-leave">
      <h2 id="s-leave" className="card-title">
        Leave group
      </h2>
      <p className="small muted">
        {me?.referenced
          ? "You're part of entries here, so leaving only hides the group from your list. Your share and any repayments still count."
          : "You'll lose access. You can rejoin with a new invitation."}
      </p>
      <button type="button" className="btn btn-ghost btn-md danger-text" onClick={() => setConfirm(true)}>
        <Icon name="logout" size={18} />
        Leave group
      </button>
      {error && <span className="field-error">{error}</span>}
      {confirm && (
        <ConfirmDialog
          title={`Leave ${view.project.name}?`}
          confirmLabel="Leave"
          danger
          pending={sub.pending}
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            try {
              await sub.run({ leave: view.project.id }, (k) => api.leave(view.project.id, { idempotencyKey: k }));
              toast(`You left ${view.project.name}`, "info");
              navigate("/groups", { replace: true });
            } catch (e) {
              setConfirm(false);
              setError(errorMessage(e));
            }
          }}
        >
          <p>{me?.referenced ? "Your balances stay in the group." : "Nothing you added remains, because you're not part of any entry."}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
