import type { EntryDTO, EntryInput, ProjectViewDTO, RateDefaultDTO } from "@shared/api";
import { DescriptionSchema, NoteSchema } from "@shared/api";
import {
  computeEntry,
  parseAmount,
  parseRate,
  rateToString,
  type AmountParseError,
  type ComputedEntry,
  type ConversionInput,
  type RateParseError,
  type Shares,
} from "@shared/money";
import { exponentOf, fmtMoney, minorToInput } from "./format";

export interface EntryDraft {
  type: "EXPENSE" | "REFUND";
  description: string;
  date: string;
  amount: string;
  currency: string;
  payer: string;
  participants: string[];
  splitMode: "EQUAL" | "EXACT";
  /** EXACT: per member original amounts as typed. */
  exact: Record<string, string>;
  /** Foreign currency only: a rate, or the actual amount charged in the base currency. */
  convMode: "RATE" | "ACTUAL";
  rate: string;
  baseAmount: string;
  /** False while the rate field still shows the owner's saved default. */
  rateEdited: boolean;
  /** Free text; "" when none. */
  note: string;
  /** Uploaded photo ids in display order. */
  attachmentIds: string[];
  /** Local-only bookkeeping, never sent. */
  savedAt?: string;
  rejected?: boolean;
  roundSequence?: number;
}

export interface FormContext {
  baseCurrency: string;
  baseExponent: number;
  multiCurrencyEnabled: boolean;
  rates: RateDefaultDTO[];
  decimalSeparator: "." | ",";
}

export function contextFromView(view: ProjectViewDTO, decimalSeparator: "." | ","): FormContext {
  return {
    baseCurrency: view.project.baseCurrency,
    baseExponent: view.project.baseExponent,
    multiCurrencyEnabled: view.project.multiCurrencyEnabled,
    rates: view.rates,
    decimalSeparator,
  };
}

/**
 * The currency selector appears only when the group allows other currencies, or when
 * an existing entry already uses one (so its value stays visible and editable).
 */
export function showCurrencySelector(ctx: Pick<FormContext, "multiCurrencyEnabled" | "baseCurrency">, entry?: Pick<EntryDTO, "originalCurrency"> | null): boolean {
  return ctx.multiCurrencyEnabled || (!!entry && entry.originalCurrency !== ctx.baseCurrency);
}

export function savedRateFor(ctx: Pick<FormContext, "rates">, currency: string): RateDefaultDTO | undefined {
  return ctx.rates.find((r) => r.currency === currency);
}

export function emptyDraft(type: EntryDraft["type"], view: ProjectViewDTO, today: string, members: string[]): EntryDraft {
  return {
    type,
    description: "",
    date: today,
    amount: "",
    currency: view.project.baseCurrency,
    payer: view.me.memberId,
    participants: members,
    splitMode: "EQUAL",
    exact: {},
    convMode: "RATE",
    rate: "",
    baseAmount: "",
    rateEdited: false,
    note: "",
    attachmentIds: [],
  };
}

export function draftFromEntry(e: EntryDTO, sep: "." | ","): EntryDraft {
  const exact: Record<string, string> = {};
  for (const a of e.allocations) exact[a.memberId] = minorToInput(a.originalAmount, e.originalExponent);
  const foreign = e.originalCurrency !== e.baseCurrency;
  return {
    type: e.type === "REFUND" ? "REFUND" : "EXPENSE",
    description: e.description,
    date: e.occurredAt,
    amount: minorToInput(e.originalAmount, e.originalExponent),
    currency: e.originalCurrency,
    payer: e.payerMemberId ?? e.creatorMemberId,
    participants: e.allocations.filter((a) => e.splitMode === "EXACT" || a.originalAmount !== "0").map((a) => a.memberId),
    splitMode: e.splitMode ?? "EQUAL",
    exact,
    convMode: foreign && e.conversion.method === "ACTUAL_BASE_AMOUNT" ? "ACTUAL" : "RATE",
    rate: foreign && e.conversion.method === "MANUAL_RATE" ? (sep === "," ? e.conversion.rate.replace(".", ",") : e.conversion.rate) : "",
    baseAmount: foreign && e.conversion.method === "ACTUAL_BASE_AMOUNT" ? minorToInput(e.baseAmount, e.baseExponent) : "",
    rateEdited: true,
    note: e.note ?? "",
    attachmentIds: e.attachments.map((a) => a.id),
  };
}

/** Drafts stored before notes/photos existed lack those fields. */
export function withDraftDefaults(d: Omit<EntryDraft, "note" | "attachmentIds"> & Partial<Pick<EntryDraft, "note" | "attachmentIds">>): EntryDraft {
  return { ...d, note: d.note ?? "", attachmentIds: d.attachmentIds ?? [] };
}

export function amountErrorText(err: AmountParseError, code: string, exponent: number, sep: string): string {
  switch (err) {
    case "EMPTY":
      return "Enter an amount";
    case "MALFORMED":
      return `Use digits only, with “${sep}” for decimals`;
    case "AMBIGUOUS_SEPARATOR":
      return `Not sure if that's a decimal. Use “${sep}” for decimals, like 12${sep}50`;
    case "TOO_PRECISE":
      return exponent === 0 ? `${code} has no decimals` : `${code} has at most ${exponent} decimal places`;
    case "NOT_POSITIVE":
      return "Enter an amount above zero";
    case "TOO_LARGE":
      return "That amount is too large";
  }
}

export function rateErrorText(err: RateParseError, sep: string): string {
  switch (err) {
    case "EMPTY":
      return "Enter the exchange rate";
    case "MALFORMED":
    case "AMBIGUOUS_SEPARATOR":
      return `Use digits with “${sep}” for decimals, like 4${sep}30`;
    case "TOO_PRECISE":
      return "Use at most 12 decimal places";
    case "NOT_POSITIVE":
      return "The rate must be above zero";
    case "TOO_LARGE":
      return "That rate is too large";
  }
}

/** Effective rate text for the conversion: the typed one, or the saved default while untouched. */
export function effectiveRate(d: EntryDraft, ctx: FormContext): string {
  if (!d.rateEdited && !d.rate) {
    const saved = savedRateFor(ctx, d.currency);
    if (saved) return ctx.decimalSeparator === "," ? saved.rate.replace(".", ",") : saved.rate;
  }
  return d.rate;
}

export interface EntryEvaluation {
  errors: Record<string, string>;
  /** Present when the amount parsed. */
  amountMinor: bigint | null;
  exponent: number;
  foreign: boolean;
  /** Present when everything computes; drives the live shares. */
  computed: ComputedEntry | null;
  /** Converted total, available as soon as amount and conversion are valid (split may still be off). */
  baseTotal: bigint | null;
  /** Rate for display (derived for an actual charged amount). */
  rateDisplay: string | null;
  /** Exact mode: sum of typed shares, for the "assigned / left" line. */
  exactAssigned: bigint | null;
  body: EntryInput | null;
}

/** Pure validation + preview; the form renders straight from this. */
export function evaluateEntry(d: EntryDraft, ctx: FormContext): EntryEvaluation {
  const errors: Record<string, string> = {};
  const sep = ctx.decimalSeparator;
  const exponent = exponentOf(d.currency);
  const foreign = d.currency !== ctx.baseCurrency;

  const desc = DescriptionSchema.safeParse(d.description);
  if (!desc.success) errors.description = desc.error.issues[0]?.message ?? "Enter a description";
  const note = NoteSchema.safeParse(d.note);
  if (!note.success) errors.note = note.error.issues[0]?.message ?? "This note is too long";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) errors.occurredAt = "Pick a date";
  if (!d.payer) errors.payerMemberId = d.type === "REFUND" ? "Pick who received the money" : "Pick who paid";

  const amt = parseAmount(d.amount, exponent, sep);
  const amountMinor = amt.ok ? amt.value : null;
  if (!amt.ok) errors.originalAmount = amountErrorText(amt.error, d.currency, exponent, sep);

  if (foreign && !ctx.multiCurrencyEnabled) errors.originalCurrency = `This group only takes ${ctx.baseCurrency}. Ask the owner to allow other currencies.`;

  let conversion: ConversionInput | null = { method: "IDENTITY" };
  let conversionReq: EntryInput["conversion"] | null = { method: "IDENTITY" };
  if (foreign) {
    if (d.convMode === "RATE") {
      const r = parseRate(effectiveRate(d, ctx), sep);
      if (r.ok) {
        conversion = { method: "MANUAL_RATE", rate: r.value };
        conversionReq = { method: "MANUAL_RATE", rate: rateToString(r.value) };
      } else {
        conversion = conversionReq = null;
        errors.rate = rateErrorText(r.error, sep);
      }
    } else {
      const b = parseAmount(d.baseAmount, ctx.baseExponent, sep);
      if (b.ok) {
        conversion = { method: "ACTUAL_BASE_AMOUNT", baseAmount: b.value };
        conversionReq = { method: "ACTUAL_BASE_AMOUNT", baseAmount: b.value.toString() };
      } else {
        conversion = conversionReq = null;
        errors.baseAmount = amountErrorText(b.error, ctx.baseCurrency, ctx.baseExponent, sep).replace("Enter an amount", `Enter the amount charged in ${ctx.baseCurrency}`);
      }
    }
  }

  const people = [...new Set(d.participants)];
  if (people.length === 0) errors.participants = d.type === "REFUND" ? "Pick at least one person who gets money back" : "Pick at least one person";

  let shares: Shares | null = null;
  let exactAssigned: bigint | null = null;
  if (d.splitMode === "EXACT" && people.length > 0) {
    shares = {};
    let sum = 0n;
    for (const m of people) {
      const raw = (d.exact[m] ?? "").trim();
      if (raw === "" || /^0+([.,]0*)?$/.test(raw)) {
        shares[m] = 0n;
        continue;
      }
      const p = parseAmount(raw, exponent, sep);
      if (!p.ok) {
        errors[`exact.${m}`] = amountErrorText(p.error, d.currency, exponent, sep);
        shares = null;
        break;
      }
      shares[m] = p.value;
      sum += p.value;
    }
    exactAssigned = shares ? sum : null;
    if (shares && amountMinor !== null && sum !== amountMinor) {
      const diff = amountMinor - sum;
      errors.split = `${fmtMoney(sum, d.currency, exponent)} of ${fmtMoney(amountMinor, d.currency, exponent)} assigned · ${fmtMoney(diff < 0n ? -diff : diff, d.currency, exponent)} ${diff > 0n ? "left" : "too much"}`;
    }
  }

  let baseTotal: bigint | null = null;
  let rateDisplay: string | null = null;
  if (amountMinor !== null && conversion) {
    // Conversion preview only: the split doesn't affect the base total.
    const pre = computeEntry({
      type: d.type,
      originalAmount: amountMinor,
      originalExponent: exponent,
      baseExponent: ctx.baseExponent,
      conversion,
      payerMemberId: "preview",
      splitMode: "EQUAL",
      participants: ["preview"],
    });
    if (pre.ok) {
      baseTotal = pre.value.baseAmount;
      rateDisplay = pre.value.rateString;
    }
  }

  let computed: ComputedEntry | null = null;
  if (amountMinor !== null && conversion && people.length > 0 && d.payer && (d.splitMode === "EQUAL" || (shares && !errors.split))) {
    const res = computeEntry({
      type: d.type,
      originalAmount: amountMinor,
      originalExponent: exponent,
      baseExponent: ctx.baseExponent,
      conversion,
      payerMemberId: d.payer,
      splitMode: d.splitMode,
      participants: d.splitMode === "EQUAL" ? people : shares!,
    });
    if (res.ok) computed = res.value;
    else if (res.error === "BASE_ROUNDS_TO_ZERO" || res.error === "BASE_NOT_POSITIVE")
      errors[d.convMode === "ACTUAL" ? "baseAmount" : "rate"] = `That converts to less than the smallest ${ctx.baseCurrency} unit. Check the rate.`;
    else if (res.error === "TOO_LARGE") errors.originalAmount = "That amount is too large";
    else if (res.error === "EXACT_SUM_MISMATCH") errors.split ??= "The shares don't add up to the amount";
    else errors._form = "These values can't be saved. Check the amount and split.";
  }

  const ok = Object.keys(errors).length === 0 && desc.success && amountMinor !== null && conversionReq !== null;
  const body: EntryInput | null = ok
    ? {
        type: d.type,
        description: desc.data!,
        occurredAt: d.date,
        originalAmount: amountMinor!.toString(),
        originalCurrency: d.currency,
        conversion: conversionReq!,
        payerMemberId: d.payer,
        splitMode: d.splitMode,
        participants: people.map((m) => (d.splitMode === "EXACT" ? { memberId: m, amount: (shares![m] ?? 0n).toString() } : { memberId: m })),
        note: note.success && note.data ? note.data : null,
        attachmentIds: d.attachmentIds,
      }
    : null;

  return { errors, amountMinor, exponent, foreign, computed, baseTotal, rateDisplay, exactAssigned, body };
}

/** Map a server field path onto the form's field keys. */
export function formFieldFor(serverField: string, participants: string[]): string {
  if (serverField.startsWith("attachmentIds")) return "photos";
  const m = serverField.match(/^participants\.(\d+)\.amount$/);
  if (m) return `exact.${participants[Number(m[1])] ?? ""}`;
  if (serverField.startsWith("conversion.rate")) return "rate";
  if (serverField.startsWith("conversion.baseAmount")) return "baseAmount";
  if (serverField.startsWith("participants")) return "participants";
  return serverField;
}
