import { useState, type FormEvent } from "react";
import type { AddMemberResultDTO, MemberDTO, ProjectViewDTO } from "@shared/api";
import { AddMemberSchema } from "@shared/api";
import { useApi } from "../../api/context";
import { ApiError, errorMessage } from "../../api/errors";
import { useSubmit } from "../../api/idempotency";
import { ConfirmDialog, Sheet } from "../../components/Dialog";
import { Field, Select, Toggle } from "../../components/Field";
import { useToast } from "../../components/Toast";
import { Avatar, Icon } from "../../components/ui";
import { fmtDate } from "../../lib/format";
import { activeMembers, nameOf, toneFor } from "../../lib/project";
import { useProject } from "../../state/project";

/** Idempotent settings mutation: refreshes the project afterwards and keeps the last error for display. */
export function useMutation() {
  const { refresh } = useProject();
  const toast = useToast();
  const sub = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const run = async (payload: unknown, fn: (k: string) => Promise<unknown>, success?: string) => {
    setError(null);
    try {
      await sub.run(payload, fn);
      await refresh();
      if (success) toast(success);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && (e.code === "STALE_VERSION" || e.status === 409)) void refresh();
      return false;
    }
  };
  return { run, pending: sub.pending, error, setError };
}

/** Status line under a member's name. */
function memberRole(x: MemberDTO): string {
  if (x.isOwner) return "Owner";
  if (x.kind === "PLACEHOLDER")
    return x.inviteState === "INVITED" ? `Invited · expires ${fmtDate(x.inviteExpiresAt!)}` : x.inviteState === "INVITE_EXPIRED" ? "Invite expired" : "Placeholder";
  return x.isGuest ? (x.hasRecoverableAccount ? "Guest with email" : "Guest") : "Member";
}

export function MembersCard({ view }: { view: ProjectViewDTO }) {
  const api = useApi();
  const m = useMutation();
  const owner = view.me.isOwner;
  const collecting = view.current.round.status === "COLLECTING";
  const settling = view.current.round.status === "SETTLING";
  const members = activeMembers(view);
  const [removing, setRemoving] = useState<MemberDTO | null>(null);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<MemberDTO | null>(null);
  const [transferTo, setTransferTo] = useState<string>("");
  const [confirmTransfer, setConfirmTransfer] = useState(false);
  const candidates = members.filter((x) => !x.isOwner && x.hasRecoverableAccount);

  return (
    <section className="card" aria-labelledby="s-mem">
      <div className="card-head">
        <h2 id="s-mem" className="card-title">
          Members
        </h2>
        <span className="card-sub">{members.length}</span>
      </div>
      {owner && !settling && (
        <button type="button" className="btn btn-soft btn-md" onClick={() => setAdding(true)}>
          <Icon name="person_add" size={18} />
          Add person
        </button>
      )}
      <ul className="plain-list">
        {members.map((x) => (
          <li key={x.id} className="row-plain member-row">
            <Avatar name={x.displayName} tone={toneFor(view, x.id)} size={32} />
            <div className="grow">
              <span className="member-name">{nameOf(view, x.id, { you: true })}</span>
              <div className="tiny muted">
                {x.kind === "PLACEHOLDER" ? <span className={`chip-sm${x.inviteState === "INVITE_EXPIRED" ? " chip-warn" : ""}`}>{memberRole(x)}</span> : memberRole(x)}
                {x.kind === "PERSON" && ` · joined ${fmtDate(x.joinedAt)}`}
              </div>
              {owner && x.invitedEmail && <div className="tiny muted">{x.invitedEmail}</div>}
            </div>
            {owner && !x.isOwner && (
              <button type="button" className="btn btn-ghost btn-sm" aria-label={`Manage ${x.displayName}`} onClick={() => setManaging(x)}>
                Manage
              </button>
            )}
          </li>
        ))}
      </ul>
      {owner && (
        <p className="tiny muted">
          {collecting
            ? "People who are part of any entry or repayment can't be removed, so balances stay correct."
            : "Members are locked while settling."}
        </p>
      )}
      {owner && (
        <div className="dashed-top">
          <Toggle
            checked={view.project.membersCanRename}
            disabled={m.pending}
            onChange={(v) => {
              const body = { expectedVersion: view.project.version, membersCanRename: v };
              void m.run(body, (k) => api.updateSettings(view.project.id, body, { idempotencyKey: k }), v ? "Members can rename themselves" : "Only you can change names now");
            }}
            label="Members can change their own name"
            description="When off, only you can rename people in this group."
          />
        </div>
      )}
      {owner && collecting && (
        <div className="dashed-top stack-8">
          <h3 className="field-label">Transfer ownership</h3>
          {candidates.length === 0 ? (
            <p className="tiny muted">The new owner needs an account with a verified email. Nobody else in the group has one yet.</p>
          ) : (
            <div className="inline-form">
              <Select wrapClassName="grow" aria-label="New owner" value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
                <option value="">Choose a member…</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </Select>
              <button type="button" className="btn btn-secondary btn-md" disabled={!transferTo} onClick={() => setConfirmTransfer(true)}>
                Offer
              </button>
            </div>
          )}
          <p className="tiny muted">They have to accept. Until then you stay the owner.</p>
        </div>
      )}
      {m.error && (
        <span className="field-error" role="alert">
          <Icon name="error" size={16} />
          {m.error}
        </span>
      )}
      {adding && <AddPersonSheet view={view} onClose={() => setAdding(false)} />}
      {managing && (
        <ManageMemberSheet
          view={view}
          member={view.members.find((x) => x.id === managing.id) ?? managing}
          onClose={() => setManaging(null)}
          onRemove={() => (setRemoving(managing), setManaging(null))}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.displayName}?`}
          confirmLabel="Remove"
          danger
          pending={m.pending}
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            const ok = await m.run({ remove: removing.id }, (k) => api.removeMember(view.project.id, removing.id, { idempotencyKey: k }), `${removing.displayName} removed`);
            if (ok) setRemoving(null);
          }}
        >
          <p>They lose access to this group. Everyone's “done adding” is cleared because the members changed.</p>
        </ConfirmDialog>
      )}
      {confirmTransfer && transferTo && (
        <ConfirmDialog
          title={`Offer ownership to ${nameOf(view, transferTo)}?`}
          confirmLabel="Send offer"
          pending={m.pending}
          onCancel={() => setConfirmTransfer(false)}
          onConfirm={async () => {
            const body = { toMemberId: transferTo };
            const ok = await m.run(body, (k) => api.transferOwnership(view.project.id, body, { idempotencyKey: k }), "Ownership offered");
            if (ok) setConfirmTransfer(false);
          }}
        >
          <p>Once they accept, they manage invitations, currencies and freezing, and you become a regular member.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function AddPersonSheet({ view, onClose }: { view: ProjectViewDTO; onClose: () => void }) {
  const api = useApi();
  const m = useMutation();
  const toast = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = AddMemberSchema.safeParse({ displayName: name, ...(email.trim() ? { email } : {}) });
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      return setErrs({ [String(i?.path[0] ?? "_form")]: i?.message ?? "Check this" });
    }
    const out: { result?: AddMemberResultDTO } = {};
    const ok = await m.run(parsed.data, async (k) => (out.result = await api.addMember(view.project.id, parsed.data, { idempotencyKey: k })));
    if (!ok) return;
    // emailSent is null when no email was involved or the request was a replay: don't claim a send.
    if (out.result?.emailSent === false) toast(`Added ${parsed.data.displayName}, but the email didn't send. Use Resend.`, "info");
    else if (out.result?.emailSent === true) toast(`Invitation sent to ${parsed.data.email}`);
    else toast(`Added ${parsed.data.displayName}`);
    onClose();
  };
  return (
    <Sheet title="Add person" onClose={onClose} size="sm">
      <form className="stack-16" onSubmit={submit} noValidate>
        <Field label="Name" error={errs.displayName} hint="How everyone in the group will see them.">
          {(p) => <input {...p} className="input" value={name} maxLength={40} autoFocus onChange={(e) => (setName(e.target.value), setErrs({}))} />}
        </Field>
        <Field label="Email (optional)" error={errs.email} hint="We'll email them an invitation valid for 7 days. Joining lets them take over this spot.">
          {(p) => <input {...p} className="input" type="email" inputMode="email" value={email} onChange={(e) => (setEmail(e.target.value), setErrs({}))} />}
        </Field>
        {m.error && (
          <span className="field-error" role="alert">
            <Icon name="error" size={16} />
            {m.error}
          </span>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={m.pending}>
          {email.trim() ? "Add & send invite" : "Add"}
        </button>
      </form>
    </Sheet>
  );
}

function ManageMemberSheet({ view, member, onClose, onRemove }: { view: ProjectViewDTO; member: MemberDTO; onClose: () => void; onRemove: () => void }) {
  const api = useApi();
  const m = useMutation();
  const [name, setName] = useState(member.displayName);
  const [email, setEmail] = useState(member.invitedEmail ?? "");
  const pid = view.project.id;
  const settling = view.current.round.status === "SETTLING";
  const placeholder = member.kind === "PLACEHOLDER";
  const canRemove = view.current.round.status === "COLLECTING" && !member.referenced;
  return (
    <Sheet title={member.displayName} onClose={onClose} size="sm">
      <div className="stack-16">
        <form
          className="inline-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const body = { displayName: name.trim() };
            void m.run(body, (k) => api.renameMember(pid, member.id, body, { idempotencyKey: k }), "Name saved");
          }}
        >
          <Field label="Name" className="grow">
            {(p) => <input {...p} className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <button type="submit" className="btn btn-secondary btn-md" disabled={m.pending || !name.trim() || name.trim() === member.displayName}>
            Save name
          </button>
        </form>
        {placeholder && !settling && (
          <form
            className="inline-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const body = { email: email.trim() };
              void m.run(body, (k) => api.inviteMember(pid, member.id, body, { idempotencyKey: k }), `Invitation sent to ${body.email}`);
            }}
          >
            <Field label="Invite by email" className="grow">
              {(p) => <input {...p} className="input" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
            <button type="submit" className="btn btn-secondary btn-md" disabled={m.pending || !email.trim()}>
              {member.inviteState ? "Resend" : "Send"}
            </button>
          </form>
        )}
        {placeholder && member.inviteState && !settling && (
          <button
            type="button"
            className="btn btn-ghost btn-md"
            disabled={m.pending}
            onClick={() => void m.run({ cancel: member.id }, (k) => api.cancelMemberInvite(pid, member.id, { idempotencyKey: k }), "Invitation cancelled")}
          >
            Cancel invite
          </button>
        )}
        {canRemove ? (
          <button type="button" className="btn btn-ghost btn-md danger-text" disabled={m.pending} onClick={onRemove}>
            <Icon name="person_remove" size={18} />
            Remove from group
          </button>
        ) : member.referenced ? (
          <p className="tiny muted">In entries, so they can't be removed.</p>
        ) : settling ? (
          <p className="tiny muted">Members are locked while settling.</p>
        ) : null}
        {m.error && (
          <span className="field-error" role="alert">
            <Icon name="error" size={16} />
            {m.error}
          </span>
        )}
      </div>
    </Sheet>
  );
}
