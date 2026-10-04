import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import type { RoundViewDTO } from "@shared/api";
import { DescriptionSchema } from "@shared/api";
import { parseAmount } from "@shared/money";
import { useApi } from "../../api/context";
import { ApiError, errorMessage } from "../../api/errors";
import { useSubmit } from "../../api/idempotency";
import { Field } from "../../components/Field";
import { BackButton, PageLoading, useTitle } from "../../components/Shell";
import { useToast } from "../../components/Toast";
import { Amount, Banner, Icon } from "../../components/ui";
import { decimalSeparator, fmtDay, fmtMoney, minorToInput, todayYmd } from "../../lib/format";
import { effectFor, nameOf, roundLabel } from "../../lib/project";
import { useProject, useView } from "../../state/project";
import { groupBase } from "./parts";

/** Signed base input: "-12.50", "+3", "4,20". Empty means zero. */
function parseSigned(s: string, exp: number, sep: "." | ","): bigint | null {
  const t = s.trim().replace(/^−/, "-");
  if (t === "" || /^[+-]?0+([.,]0*)?$/.test(t)) return 0n;
  const neg = t.startsWith("-");
  const r = parseAmount(t.replace(/^[+-]/, ""), exp, sep);
  if (!r.ok) return null;
  return neg ? -r.value : r.value;
}

export function Correction() {
  const view = useView();
  const { refresh } = useProject();
  const api = useApi();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, pending } = useSubmit();
  const { roundId = "", entryId = "" } = useParams();
  const [round, setRound] = useState<RoundViewDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<"reverse" | "custom">("reverse");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(todayYmd());
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const base = groupBase(view.project.id);
  const code = view.project.baseCurrency;
  const exp = view.project.baseExponent;
  const sep = decimalSeparator();
  useTitle("Correct an entry");

  useEffect(() => {
    api.getRound(view.project.id, roundId).then(setRound, (e) => setLoadError(errorMessage(e)));
  }, [api, view.project.id, roundId]);

  const entry = round?.entries.find((e) => e.id === entryId);
  const people = useMemo(() => {
    if (!entry) return [];
    const ids = new Set([...entry.contributions, ...entry.allocations].map((x) => x.memberId));
    for (const m of view.members) if (m.status === "ACTIVE") ids.add(m.id);
    return [...ids];
  }, [entry, view.members]);

  useEffect(() => {
    if (entry && !description) setDescription(`Correction: ${entry.description}`.slice(0, 140));
  }, [entry, description]);

  if (loadError)
    return (
      <main id="main" className="page page-mid">
        <BackButton />
        <Banner tone="red" icon="error" role="alert">
          {loadError}
        </Banner>
      </main>
    );
  if (!round) return <PageLoading />;
  if (!entry)
    return (
      <main id="main" className="page page-mid">
        <BackButton />
        <h1 className="page-h1">Entry not found</h1>
      </main>
    );

  const cur = view.current.round;
  const blocked = !view.me.isOwner ? "Only the owner can add corrections." : cur.status !== "COLLECTING" ? `Corrections go into a collecting round. ${roundLabel(cur.sequence)} is ${cur.status.toLowerCase()}.` : null;

  const reverse: Record<string, bigint> = {};
  for (const id of people) reverse[id] = -effectFor(entry, id).net;
  const effects: Record<string, bigint | null> = {};
  for (const id of people) effects[id] = mode === "reverse" ? reverse[id]! : parseSigned(custom[id] ?? "", exp, sep);
  const sum = Object.values(effects).reduce<bigint>((a, v) => a + (v ?? 0n), 0n);
  const nonZero = Object.values(effects).filter((v) => v !== null && v !== 0n).length;
  const invalid = Object.entries(effects).filter(([, v]) => v === null).map(([k]) => k);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const d = DescriptionSchema.safeParse(description);
    if (!d.success) errs.description = d.error.issues[0]?.message ?? "Enter a description";
    for (const id of invalid) errs[`m.${id}`] = "Use digits, with - for amounts that reduce a balance";
    if (!invalid.length && sum !== 0n) errs.sum = `Amounts must add up to zero. They're off by ${fmtMoney(sum, code, exp, true)}.`;
    if (!invalid.length && nonZero < 2) errs.sum = "A correction moves money between at least two people.";
    setErrors(errs);
    if (Object.keys(errs).length || blocked) return;
    const body = {
      correctedEntryId: entry.id,
      correctedRoundId: round.round.id,
      description: d.data!,
      occurredAt: date,
      effects: people.filter((id) => effects[id] !== 0n).map((id) => ({ memberId: id, baseAmount: effects[id]!.toString() })),
    };
    try {
      await run(body, (k) => api.createAdjustment(view.project.id, cur.id, body, { idempotencyKey: k }));
      await refresh();
      toast("Correction added");
      navigate(base, { replace: true });
    } catch (err) {
      setErrors({ _form: err instanceof ApiError ? err.message : errorMessage(err) });
    }
  };

  return (
    <main id="main" className="page page-mid">
      <div className="page-top">
        <BackButton />
      </div>
      <h1 className="page-h1">Correct an entry</h1>
      <Banner tone="neutral" icon="history">
        {roundLabel(round.round.sequence)} stays settled as it was
        <p>The correction is a new entry in {roundLabel(cur.sequence)}. It uses the original stored {code} amounts, not today's exchange rate.</p>
      </Banner>
      {blocked && (
        <Banner tone="amber" icon="lock" role="alert">
          {blocked}
        </Banner>
      )}

      <section className="card card-tight" aria-label="Original entry">
        <span className="tiny muted">
          Original · {roundLabel(round.round.sequence)} · {fmtDay(entry.occurredAt)}
        </span>
        <b>{entry.description}</b>
        <Amount minor={entry.originalAmount} code={entry.originalCurrency} exponent={entry.originalExponent} />
        {entry.originalCurrency !== entry.baseCurrency && (
          <span className="small muted">
            Stored as {fmtMoney(entry.baseAmount, code, exp)} at 1 {entry.originalCurrency} = {entry.conversion.rate} {code}
          </span>
        )}
      </section>

      <form className="stack-16" onSubmit={submit} noValidate>
        <Field label="Description" error={errors.description}>
          {(p) => <input {...p} className="input" value={description} maxLength={140} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <Field label="Date">{(p) => <input {...p} type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>

        <div className="segmented segmented-lg" role="group" aria-label="Correction type">
          <button type="button" aria-pressed={mode === "reverse"} onClick={() => setMode("reverse")}>
            Reverse the whole entry
          </button>
          <button
            type="button"
            aria-pressed={mode === "custom"}
            onClick={() => {
              if (Object.keys(custom).length === 0) {
                const seed: Record<string, string> = {};
                for (const id of people) seed[id] = reverse[id] ? minorToInput(reverse[id]!, exp) : "";
                setCustom(seed);
              }
              setMode("custom");
            }}
          >
            Custom amounts
          </button>
        </div>
        <p className="tiny muted">
          {mode === "reverse"
            ? "Undoes the entry's effect on everyone's balance. If it should have been a different amount, add the right one as a new expense afterwards."
            : `Positive amounts raise someone's balance (the group owes them more), negative amounts lower it. In ${code}, adding up to zero.`}
        </p>

        <div className="card card-flush">
          {people.map((id) => (
            <div key={id} className="row correction-row">
              <span className="grow">{nameOf(view, id, { you: true })}</span>
              {mode === "reverse" ? (
                <Amount minor={reverse[id]!} code={code} exponent={exp} signed tone="auto" />
              ) : (
                <span className="split-exact">
                  <input
                    className="input input-sm split-exact-input"
                    inputMode="decimal"
                    aria-label={`Change for ${nameOf(view, id)} in ${code}`}
                    aria-invalid={errors[`m.${id}`] ? true : undefined}
                    value={custom[id] ?? ""}
                    onChange={(e) => setCustom((c) => ({ ...c, [id]: e.target.value }))}
                  />
                  <span className="tiny muted split-code">{code}</span>
                </span>
              )}
            </div>
          ))}
          <div className={`split-foot ${sum === 0n && !invalid.length ? "split-foot-ok" : "split-foot-err"}`} aria-live="polite">
            <Icon name={sum === 0n && !invalid.length ? "check_circle" : "error"} size={16} />
            {invalid.length ? "Some amounts aren't valid" : sum === 0n ? "Adds up to zero" : `Off by ${fmtMoney(sum, code, exp, true)}`}
          </div>
        </div>
        {(errors.sum || errors._form) && (
          <div className="form-error" role="alert">
            <Icon name="error" size={18} />
            {errors.sum ?? errors._form}
          </div>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={pending || !!blocked}>
          {pending ? "Adding…" : `Add correction to ${roundLabel(cur.sequence).toLowerCase()}`}
        </button>
      </form>
    </main>
  );
}
