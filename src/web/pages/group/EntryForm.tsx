import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import type { EntryDTO, ProjectViewDTO } from "@shared/api";
import { useApi } from "../../api/context";
import { ApiError, errorMessage } from "../../api/errors";
import { useSubmit } from "../../api/idempotency";
import { Sheet } from "../../components/Dialog";
import { CurrencySelect, Field, Toggle } from "../../components/Field";
import { useToast } from "../../components/Toast";
import { Amount, Banner, Icon } from "../../components/ui";
import { clearDraft, findRejectedDraft, loadDraft, saveDraft } from "../../lib/drafts";
import {
  contextFromView,
  draftFromEntry,
  effectiveRate,
  emptyDraft,
  evaluateEntry,
  formFieldFor,
  savedRateFor,
  showCurrencySelector,
  type EntryDraft,
} from "../../lib/entryForm";
import { decimalSeparator, fmtDateTime, fmtMoney, fmtRate, minorToInput, todayYmd } from "../../lib/format";
import { activeMembers, nameOf, readinessOf, roundLabel } from "../../lib/project";
import { useProject, useView } from "../../state/project";
import { groupBase, PlaceholderTag } from "./parts";
import { noteSelfReadyChange } from "./selfChange";

export function EntryFormRoute({ type }: { type?: "EXPENSE" | "REFUND" }) {
  const view = useView();
  const { entryId } = useParams();
  const navigate = useNavigate();
  const base = groupBase(view.project.id);
  const entry = entryId ? view.current.entries.find((e) => e.id === entryId) : undefined;
  const close = () => navigate(entry ? `${base}/e/${encodeURIComponent(entry.id)}` : base, { replace: true });

  if (entryId && !entry) {
    return (
      <Sheet title="Entry not found" onClose={() => navigate(base, { replace: true })}>
        <p className="muted">This entry was deleted or belongs to another round.</p>
      </Sheet>
    );
  }
  return <EntryForm key={entryId ?? type} view={view} entry={entry} type={entry ? (entry.type === "REFUND" ? "REFUND" : "EXPENSE") : (type ?? "EXPENSE")} onClose={close} />;
}

function EntryForm({ view, entry, type, onClose }: { view: ProjectViewDTO; entry?: EntryDTO; type: "EXPENSE" | "REFUND"; onClose: () => void }) {
  const api = useApi();
  const { refresh } = useProject();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, pending } = useSubmit();
  const sep = decimalSeparator();
  const ctx = useMemo(() => contextFromView(view, sep), [view, sep]);
  const members = activeMembers(view);
  const slot = entry ? `edit-${entry.id}` : `new-${type}`;
  const round = view.current.round;
  const collecting = round.status === "COLLECTING";

  const [restored] = useState(() => {
    const own = loadDraft(view.project.id, slot);
    if (own) return own;
    if (!entry) return findRejectedDraft(view.project.id)?.draft ?? null;
    return null;
  });
  const [d, setD] = useState<EntryDraft>(
    () =>
      (restored ? { ...restored, rejected: restored.rejected && restored.roundSequence === round.sequence } : null) ??
      (entry ? draftFromEntry(entry, sep) : emptyDraft(type, view, todayYmd(), members.map((m) => m.id))),
  );
  const [touched, setTouched] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [stale, setStale] = useState(false);

  const ev = evaluateEntry(d, ctx);
  const errors = { ...(showErrors ? ev.errors : {}), ...serverErrors };
  const showCurrency = showCurrencySelector(ctx, entry);
  const saved = savedRateFor(ctx, d.currency);
  const usingSaved = ev.foreign && d.convMode === "RATE" && !d.rateEdited && !!saved;
  const isRefund = d.type === "REFUND";
  const noun = isRefund ? "refund" : "expense";
  // Collapsed unless the form opens on a refund, so its type is never hidden.
  const [advancedOpen] = useState(isRefund);

  // Persist the unsent draft locally as the user types.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (touched) saveDraft(view.project.id, slot, d);
  }, [d, touched, slot, view.project.id]);

  const update = (patch: Partial<EntryDraft>) => {
    setTouched(true);
    setServerErrors({});
    setD((x) => ({ ...x, ...patch }));
  };

  const discardAndClose = () => {
    if (!d.rejected) clearDraft(view.project.id, slot);
    onClose();
  };

  const myReady = readinessOf(view.current, view.me.memberId);
  const creatorReady = entry && entry.creatorMemberId !== view.me.memberId && readinessOf(view.current, entry.creatorMemberId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (!ev.body) {
      // After the re-render that marks fields invalid, move focus to the first one.
      setTimeout(() => [...document.querySelectorAll<HTMLElement>(".sheet [aria-invalid='true']")].find((el) => el.offsetParent !== null)?.focus(), 0);
      return;
    }
    const body = ev.body;
    noteSelfReadyChange();
    try {
      await run({ body, entry: entry?.id, rev: entry?.revision }, (k) =>
        entry
          ? api.updateEntry(view.project.id, entry.roundId, entry.id, { ...body, expectedRevision: entry.revision }, { idempotencyKey: k })
          : api.createEntry(view.project.id, round.id, body, { idempotencyKey: k }),
      );
      clearDraft(view.project.id, slot);
      await refresh();
      toast(entry ? (isRefund ? "Refund updated" : "Expense updated") : isRefund ? "Refund saved" : "Expense saved");
      navigate(groupBase(view.project.id), { replace: true });
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setServerErrors({ _form: errorMessage(err) });
        return;
      }
      if (err.code === "ROUND_NOT_COLLECTING") {
        const keep = { ...d, rejected: true, roundSequence: round.sequence + 1 };
        saveDraft(view.project.id, entry ? "new-EXPENSE" : slot, keep);
        if (entry) clearDraft(view.project.id, slot);
        setD(keep);
        void refresh();
        return;
      }
      if (err.code === "STALE_VERSION") {
        setStale(true);
        void refresh();
        return;
      }
      if (err.field) setServerErrors({ [formFieldFor(err.field, d.participants)]: err.message });
      else if (err.code === "MULTI_CURRENCY_DISABLED") setServerErrors({ originalCurrency: err.message });
      else setServerErrors({ _form: err.message });
    }
  };

  const title = entry ? `Edit ${noun}` : `New ${noun}`;
  const resetNote = myReady || creatorReady;

  if (!collecting && !d.rejected) {
    return (
      <Sheet title={title} onClose={discardAndClose}>
        <Banner tone="neutral" icon="lock">
          {roundLabel(round.sequence)} is frozen
          <p>Entries can't be added or changed while everyone settles up. Anything you forgot goes into the next round, which the owner starts once this one is settled.</p>
        </Banner>
      </Sheet>
    );
  }

  return (
    <Sheet
      title={title}
      onClose={discardAndClose}
      headerAction={
        <button type="submit" form="entry-form" className="link-btn" disabled={pending || (!collecting && d.rejected)}>
          {pending ? "Saving…" : "Save"}
        </button>
      }
      footer={
        <>
          <span className="meta-item tiny muted">
            {resetNote && (
              <>
                <Icon name="info" size={15} />
                {creatorReady && !myReady
                  ? `Clears ${nameOf(view, entry!.creatorMemberId)}'s “done adding”`
                  : creatorReady
                    ? `Clears your and ${nameOf(view, entry!.creatorMemberId)}'s “done adding”`
                    : "Clears your “done adding”"}
              </>
            )}
          </span>
          <div className="sheet-foot-actions">
            <button type="button" className="btn btn-ghost btn-md" onClick={discardAndClose}>
              Cancel
            </button>
            <button type="submit" form="entry-form" className="btn btn-primary btn-md" disabled={pending || (!collecting && d.rejected)}>
              {pending ? "Saving…" : `Save ${noun}`}
            </button>
          </div>
        </>
      }
    >
      <form id="entry-form" className="entry-form" onSubmit={submit} noValidate>
        {d.rejected && (
          <Banner tone="red" icon="cloud_off" role="alert">
            Not saved
            <p>
              {collecting
                ? `This draft was rejected because the previous round froze. It's kept here so you can add it to ${roundLabel(round.sequence)}.`
                : `${roundLabel(round.sequence)} was frozen before this was saved. Your draft stays on this device; add it once the owner starts the next round.`}
            </p>
          </Banner>
        )}
        {restored && !d.rejected && restored.savedAt && (
          <Banner
            tone="amber"
            icon="edit_note"
            action={
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  clearDraft(view.project.id, slot);
                  setD(entry ? draftFromEntry(entry, sep) : emptyDraft(type, view, todayYmd(), members.map((m) => m.id)));
                }}
              >
                Discard
              </button>
            }
          >
            Unsaved draft restored
            <p>From {fmtDateTime(restored.savedAt, true)}. Not saved yet.</p>
          </Banner>
        )}
        {stale && (
          <Banner tone="amber" icon="sync_problem" role="alert">
            Someone else changed this entry
            <p>Your version wasn't saved. Close and reopen it to see the latest, then make your change again.</p>
          </Banner>
        )}
        <div className="ef-grid ef-grid-desc">
          <Field label={isRefund ? "What was refunded?" : "What was it?"} error={errors.description}>
            {(p) => (
              <input {...p} className="input" value={d.description} maxLength={140} onChange={(e) => update({ description: e.target.value })} autoFocus={!entry} />
            )}
          </Field>
          <Field label="Date" error={errors.occurredAt} className="desktop-only-flex">
            {(p) => <input {...p} type="date" className="input" value={d.date} onChange={(e) => update({ date: e.target.value })} />}
          </Field>
        </div>

        <div className="ef-grid ef-grid-amount">
          <Field label="Amount" error={errors.originalAmount ?? errors.originalCurrency}>
            {(p) => (
              <div className="amount-row">
                <input
                  {...p}
                  className="input input-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder={ev.exponent ? `0${sep}${"0".repeat(ev.exponent)}` : "0"}
                  value={d.amount}
                  onChange={(e) => update({ amount: e.target.value })}
                />
                {showCurrency ? (
                  <CurrencySelect
                    compact
                    aria-label="Currency"
                    value={d.currency}
                    onChange={(c) => update({ currency: c, rate: "", rateEdited: false, baseAmount: "", convMode: "RATE" })}
                  />
                ) : (
                  <span className="amount-fixed-code" aria-label={`in ${d.currency}`}>
                    {d.currency}
                  </span>
                )}
              </div>
            )}
          </Field>
          <Field label={isRefund ? "Received by" : "Paid by"} error={errors.payerMemberId} className="desktop-only-flex">
            {(p) => <PayerSelect {...p} view={view} value={d.payer} onChange={(v) => update({ payer: v })} />}
          </Field>
        </div>

        {ev.foreign && (
          <FxPanel d={d} ctx={ctx} ev={ev} errors={errors} saved={saved} usingSaved={usingSaved} view={view} update={update} sep={sep} />
        )}

        <div className="ef-grid ef-grid-m">
          <Field label="Date" error={errors.occurredAt}>
            {(p) => (
              <div className="input-with-icon">
                <Icon name="calendar_today" size={18} />
                <input {...p} type="date" className="input" value={d.date} onChange={(e) => update({ date: e.target.value })} />
              </div>
            )}
          </Field>
          <Field label={isRefund ? "Received by" : "Paid by"} error={errors.payerMemberId}>
            {(p) => <PayerSelect {...p} view={view} value={d.payer} onChange={(v) => update({ payer: v })} icon={isRefund ? "call_received" : "credit_card"} />}
          </Field>
        </div>

        <SplitEditor d={d} ev={ev} view={view} errors={errors} update={update} ctx={ctx} />

        <details className="ef-advanced" open={advancedOpen}>
          <summary>
            Advanced
            <Icon name="expand_more" size={18} />
          </summary>
          <div className="ef-advanced-body">
            <Toggle
              checked={isRefund}
              onChange={(on) => update({ type: on ? "REFUND" : "EXPENSE" })}
              label="This is a refund"
              description="Money that came back, like a returned deposit. It lowers the cost for the people it's split between instead of adding to it."
            />
          </div>
        </details>

        {errors._form && (
          <div className="form-error" role="alert">
            <Icon name="error" size={18} />
            {errors._form}
          </div>
        )}
        {showErrors && Object.keys(ev.errors).length > 0 && (
          <p className="sr-only" role="alert">
            The {noun} wasn't saved. {Object.keys(ev.errors).length === 1 ? "One field needs" : `${Object.keys(ev.errors).length} fields need`} attention.
          </p>
        )}
      </form>
    </Sheet>
  );
}

function PayerSelect({ view, value, onChange, icon, ...aria }: {
  view: ProjectViewDTO;
  value: string;
  onChange: (v: string) => void;
  icon?: string;
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const members = activeMembers(view);
  const extra = value && !members.some((m) => m.id === value) ? [{ id: value, displayName: nameOf(view, value) }] : [];
  const select = (
    <span className="select-wrap">
      <select {...aria} className="input select" value={value} onChange={(e) => onChange(e.target.value)}>
        {[...members, ...extra].map((m) => (
          <option key={m.id} value={m.id}>
            {m.id === view.me.memberId ? `${m.displayName} (you)` : m.displayName}
          </option>
        ))}
      </select>
      <span className="select-chevron">
        <Icon name="expand_more" size={18} />
      </span>
    </span>
  );
  if (!icon) return select;
  return (
    <div className="input-with-icon">
      <Icon name={icon} size={18} />
      {select}
    </div>
  );
}

type Update = (p: Partial<EntryDraft>) => void;
type Ev = ReturnType<typeof evaluateEntry>;

function FxPanel({ d, ctx, ev, errors, saved, usingSaved, view, update, sep }: {
  d: EntryDraft;
  ctx: ReturnType<typeof contextFromView>;
  ev: Ev;
  errors: Record<string, string>;
  saved: ReturnType<typeof savedRateFor>;
  usingSaved: boolean;
  view: ProjectViewDTO;
  update: Update;
  sep: "." | ",";
}) {
  const base = ctx.baseCurrency;
  const rateText = effectiveRate(d, ctx);
  const preview = ev.baseTotal !== null && ev.amountMinor !== null;
  return (
    <section className="fx" aria-label="Currency conversion">
      <div className="fx-head">
        <span className="fx-title">
          <Icon name="currency_exchange" size={17} />
          {d.convMode === "RATE" ? `Convert to ${base}` : `Charged in ${base}`}
        </span>
        {d.convMode === "RATE" && !usingSaved && (
          <span className="tag-outline">
            <Icon name="edit" size={12} />
            MANUAL
          </span>
        )}
        {d.convMode === "ACTUAL" && (
          <span className="tag-outline">
            <Icon name="account_balance" size={12} />
            ACTUAL
          </span>
        )}
      </div>
      {d.convMode === "RATE" ? (
        <div className="fx-rate">
          <label htmlFor="fx-rate" className="fx-eq">
            1 {d.currency} =
          </label>
          <input
            id="fx-rate"
            className="input input-sm fx-rate-input"
            inputMode="decimal"
            autoComplete="off"
            value={rateText}
            placeholder={`0${sep}00`}
            aria-invalid={errors.rate ? true : undefined}
            aria-describedby={errors.rate ? "fx-rate-err" : "fx-rate-src"}
            onChange={(e) => update({ rate: e.target.value, rateEdited: true })}
          />
          <span>{base}</span>
        </div>
      ) : (
        <div className="fx-rate">
          <label htmlFor="fx-base" className="fx-eq">
            Amount charged
          </label>
          <input
            id="fx-base"
            className="input input-sm fx-rate-input fx-base-input"
            inputMode="decimal"
            autoComplete="off"
            value={d.baseAmount}
            placeholder={`0${sep}${"0".repeat(ctx.baseExponent)}`}
            aria-invalid={errors.baseAmount ? true : undefined}
            aria-describedby={errors.baseAmount ? "fx-base-err" : undefined}
            onChange={(e) => update({ baseAmount: e.target.value })}
          />
          <span>{base}</span>
        </div>
      )}
      {errors.rate && d.convMode === "RATE" && (
        <span id="fx-rate-err" className="field-error">
          <Icon name="error" size={16} />
          {errors.rate}
        </span>
      )}
      {errors.baseAmount && d.convMode === "ACTUAL" && (
        <span id="fx-base-err" className="field-error">
          <Icon name="error" size={16} />
          {errors.baseAmount}
        </span>
      )}
      {d.convMode === "RATE" && (
        <span id="fx-rate-src" className="tiny fx-src">
          {usingSaved && saved
            ? `Group rate saved by ${nameOf(view, saved.setByMemberId)}, ${fmtDateTime(saved.setAt, true)}. You can change it for this ${d.type === "REFUND" ? "refund" : "expense"}.`
            : saved
              ? `Your own rate for this entry. Group rate: 1 ${d.currency} = ${fmtRate(saved.rate)} ${base}.`
              : `No saved group rate for ${d.currency}. Use the rate your bank or card applied.`}
        </span>
      )}
      {preview && (
        <div className="fx-preview" aria-live="polite">
          <span className="fx-preview-line">
            {fmtMoney(ev.amountMinor!, d.currency, ev.exponent)} → {fmtMoney(ev.baseTotal!, base, ctx.baseExponent)}
          </span>
          {d.convMode === "ACTUAL" && (
            <span className="tiny">
              1 {d.currency} = {fmtRate(ev.rateDisplay ?? "")} {base}
            </span>
          )}
        </div>
      )}
      <div className="fx-foot">
        <span className="meta-item ink">
          <Icon name="lock" size={14} />
          This saved conversion will not change automatically.
        </span>
        <button
          type="button"
          className="link-btn tiny"
          onClick={() => update(d.convMode === "RATE" ? { convMode: "ACTUAL" } : { convMode: "RATE" })}
        >
          {d.convMode === "RATE" ? `Use ${base} charged` : "Use an exchange rate"}
        </button>
      </div>
    </section>
  );
}

function SplitEditor({ d, ev, view, errors, update, ctx }: {
  d: EntryDraft;
  ev: Ev;
  view: ProjectViewDTO;
  errors: Record<string, string>;
  update: Update;
  ctx: ReturnType<typeof contextFromView>;
}) {
  const members = activeMembers(view);
  const included = new Set(d.participants);
  const c = ev.computed;
  const showBase = ev.foreign;
  const shareOf = (id: string): string => {
    if (!included.has(id)) return "—";
    if (!c) return "";
    const v = showBase ? c.baseAllocations[id] : c.originalAllocations[id];
    return v === undefined ? "" : fmtMoney(v, showBase ? ctx.baseCurrency : d.currency, showBase ? ctx.baseExponent : ev.exponent);
  };
  const toggle = (id: string, on: boolean) => update({ participants: on ? [...d.participants, id] : d.participants.filter((x) => x !== id) });
  const allOn = members.every((m) => included.has(m.id));
  const label = d.type === "REFUND" ? "Who gets money back?" : "Split between";
  return (
    <fieldset className="split" aria-describedby={errors.participants || errors.split ? "split-err" : undefined}>
      <div className="split-head">
        <legend className="field-label">{label}</legend>
        <div className="segmented" role="group" aria-label="How to split">
          <button type="button" aria-pressed={d.splitMode === "EQUAL"} onClick={() => update({ splitMode: "EQUAL" })}>
            Equally
          </button>
          <button
            type="button"
            aria-pressed={d.splitMode === "EXACT"}
            onClick={() => {
              // Seed exact amounts from the equal split so the user adjusts rather than starts over.
              const seed: Record<string, string> = { ...d.exact };
              if (c && Object.keys(d.exact).length === 0) {
                for (const [m, v] of Object.entries(c.originalAllocations)) seed[m] = minorToInput(v, ev.exponent);
              }
              update({ splitMode: "EXACT", exact: seed });
            }}
          >
            Exact
          </button>
        </div>
      </div>
      <div className="card card-flush split-list">
        {members.length > 2 && (
          <label className="split-row split-all">
            <input type="checkbox" className="check" checked={allOn} onChange={(e) => update({ participants: e.target.checked ? members.map((m) => m.id) : [] })} />
            <span className="grow small muted">Everyone</span>
          </label>
        )}
        {members.map((m) => {
          const on = included.has(m.id);
          const exactErr = errors[`exact.${m.id}`];
          return (
            <div key={m.id} className={`split-row${on ? "" : " is-off"}`}>
              <input
                id={`p-${m.id}`}
                type="checkbox"
                className="check"
                checked={on}
                onChange={(e) => toggle(m.id, e.target.checked)}
              />
              <label htmlFor={`p-${m.id}`} className="grow split-name">
                {nameOf(view, m.id, { you: true })} <PlaceholderTag member={m} hidden />
              </label>
              {d.splitMode === "EQUAL" || !on ? (
                <span className="split-share amount">{shareOf(m.id)}</span>
              ) : (
                <span className="split-exact">
                  <input
                    className="input input-sm split-exact-input"
                    inputMode="decimal"
                    aria-label={`${m.displayName}'s share in ${d.currency}`}
                    aria-invalid={exactErr ? true : undefined}
                    value={d.exact[m.id] ?? ""}
                    onChange={(e) => update({ exact: { ...d.exact, [m.id]: e.target.value } })}
                  />
                  <span className="tiny muted split-code">{d.currency}</span>
                </span>
              )}
            </div>
          );
        })}
        <SplitFooter d={d} ev={ev} errors={errors} ctx={ctx} />
      </div>
    </fieldset>
  );
}

function SplitFooter({ d, ev, errors, ctx }: { d: EntryDraft; ev: Ev; errors: Record<string, string>; ctx: ReturnType<typeof contextFromView> }) {
  const exactErr = Object.entries(errors).find(([k]) => k.startsWith("exact."))?.[1];
  const err = errors.participants ?? errors.split ?? exactErr;
  if (err) {
    return (
      <div id="split-err" className="split-foot split-foot-err" role="alert">
        <Icon name="error" size={18} />
        <span>{err}</span>
      </div>
    );
  }
  if (d.splitMode === "EXACT" && ev.exactAssigned !== null && ev.amountMinor !== null && ev.exactAssigned !== ev.amountMinor) {
    const diff = ev.amountMinor - ev.exactAssigned;
    return (
      <div id="split-err" className="split-foot split-foot-err" role="status">
        <Icon name="error" size={18} />
        <span>
          {fmtMoney(ev.exactAssigned, d.currency, ev.exponent)} of {fmtMoney(ev.amountMinor, d.currency, ev.exponent)} assigned ·{" "}
          {fmtMoney(diff < 0n ? -diff : diff, d.currency, ev.exponent)} {diff > 0n ? "left" : "too much"}
        </span>
      </div>
    );
  }
  if (!ev.computed) return null;
  const n = d.participants.length;
  return (
    <div className="split-foot split-foot-ok" aria-live="polite">
      <span className="meta-item">
        <Icon name="check_circle" size={16} />
        <Amount minor={ev.computed.baseAmount} code={ctx.baseCurrency} exponent={ctx.baseExponent} />
      </span>
      <span className="meta-item">
        <Icon name="group" size={16} />
        {n}
        <span className="sr-only"> {n === 1 ? "person" : "people"}</span>
      </span>
    </div>
  );
}
