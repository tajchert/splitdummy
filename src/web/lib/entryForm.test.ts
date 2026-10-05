import { describe, expect, it } from "vitest";
import { evaluateEntry, formFieldFor, showCurrencySelector, withDraftDefaults, type EntryDraft, type FormContext } from "./entryForm";

const ctx = (over: Partial<FormContext> = {}): FormContext => ({
  baseCurrency: "EUR",
  baseExponent: 2,
  multiCurrencyEnabled: false,
  rates: [],
  decimalSeparator: ".",
  ...over,
});

const draft = (over: Partial<EntryDraft> = {}): EntryDraft => ({
  type: "EXPENSE",
  description: "Dinner",
  date: "2026-09-15",
  amount: "100.00",
  currency: "EUR",
  payer: "m_a",
  participants: ["m_a", "m_b", "m_c"],
  splitMode: "EQUAL",
  exact: {},
  convMode: "RATE",
  rate: "",
  baseAmount: "",
  rateEdited: false,
  note: "",
  attachmentIds: [],
  ...over,
});

describe("currency selector visibility", () => {
  it("is hidden for single-currency groups", () => {
    expect(showCurrencySelector(ctx())).toBe(false);
  });
  it("is shown when other currencies are allowed", () => {
    expect(showCurrencySelector(ctx({ multiCurrencyEnabled: true }))).toBe(true);
  });
  it("stays visible when editing an existing foreign entry after the mode was turned off", () => {
    expect(showCurrencySelector(ctx(), { originalCurrency: "USD" })).toBe(true);
    expect(showCurrencySelector(ctx(), { originalCurrency: "EUR" })).toBe(false);
  });
});

describe("evaluateEntry", () => {
  it("builds an IDENTITY equal-split body with deterministic shares", () => {
    const ev = evaluateEntry(draft(), ctx());
    expect(ev.errors).toEqual({});
    expect(ev.body).toMatchObject({
      originalAmount: "10000",
      originalCurrency: "EUR",
      conversion: { method: "IDENTITY" },
      splitMode: "EQUAL",
      participants: [{ memberId: "m_a" }, { memberId: "m_b" }, { memberId: "m_c" }],
    });
    expect(ev.computed?.originalAllocations).toEqual({ m_a: 3334n, m_b: 3333n, m_c: 3333n });
  });

  it("reports field errors and keeps no body", () => {
    const ev = evaluateEntry(draft({ description: "  ", amount: "", participants: [] }), ctx());
    expect(ev.body).toBeNull();
    expect(ev.errors.description).toBe("Enter a description");
    expect(ev.errors.originalAmount).toBe("Enter an amount");
    expect(ev.errors.participants).toBe("Pick at least one person");
  });

  it("respects the currency's decimal places and the locale separator", () => {
    expect(evaluateEntry(draft({ amount: "1.505" }), ctx()).errors.originalAmount).toBe("EUR has at most 2 decimal places");
    const jpy = evaluateEntry(draft({ amount: "1.5", currency: "JPY" }), ctx({ baseCurrency: "JPY", baseExponent: 0 }));
    expect(jpy.errors.originalAmount).toBe("JPY has no decimals");
    const ambiguous = evaluateEntry(draft({ amount: "1,23" }), ctx());
    expect(ambiguous.errors.originalAmount).toMatch(/Not sure if that's a decimal/);
    const comma = evaluateEntry(draft({ amount: "12,50" }), ctx({ decimalSeparator: "," }));
    expect(comma.body?.originalAmount).toBe("1250");
  });

  it("requires a rate for a foreign expense and previews the conversion", () => {
    const c = ctx({ multiCurrencyEnabled: true, baseCurrency: "PLN" });
    const missing = evaluateEntry(draft({ currency: "EUR" }), c);
    expect(missing.errors.rate).toBe("Enter the exchange rate");
    const ev = evaluateEntry(draft({ currency: "EUR", rate: "4.30", rateEdited: true, participants: ["m_a", "m_b"] }), c);
    expect(ev.errors).toEqual({});
    expect(ev.baseTotal).toBe(43000n);
    expect(ev.body?.conversion).toEqual({ method: "MANUAL_RATE", rate: "4.3" });
    expect(ev.computed?.baseAllocations).toEqual({ m_a: 21500n, m_b: 21500n });
  });

  it("prefills the owner's saved rate until the user types their own", () => {
    const c = ctx({
      multiCurrencyEnabled: true,
      rates: [{ currency: "USD", rate: "0.92", setByMemberId: "m_a", setAt: "2026-09-01T00:00:00Z", revision: 1 }],
    });
    const ev = evaluateEntry(draft({ currency: "USD", amount: "120.00" }), c);
    expect(ev.body?.conversion).toEqual({ method: "MANUAL_RATE", rate: "0.92" });
    expect(ev.baseTotal).toBe(11040n);
  });

  it("accepts the actual amount charged instead of a rate", () => {
    const c = ctx({ multiCurrencyEnabled: true, baseCurrency: "PLN" });
    const ev = evaluateEntry(draft({ currency: "EUR", convMode: "ACTUAL", baseAmount: "432.00" }), c);
    expect(ev.body?.conversion).toEqual({ method: "ACTUAL_BASE_AMOUNT", baseAmount: "43200" });
    expect(ev.baseTotal).toBe(43200n);
  });

  it("rejects foreign currencies when the group doesn't allow them", () => {
    const ev = evaluateEntry(draft({ currency: "USD", rate: "1", rateEdited: true }), ctx());
    expect(ev.errors.originalCurrency).toMatch(/only takes EUR/);
    expect(ev.body).toBeNull();
  });

  it("explains exact splits that don't add up, and still previews the conversion", () => {
    const c = ctx({ multiCurrencyEnabled: true });
    const ev = evaluateEntry(
      draft({ currency: "USD", amount: "120.00", rate: "0.92", rateEdited: true, splitMode: "EXACT", participants: ["m_a", "m_b"], exact: { m_a: "40", m_b: "60.00" } }),
      c,
    );
    expect(ev.errors.split).toBe("100.00 USD of 120.00 USD assigned · 20.00 USD left");
    expect(ev.body).toBeNull();
    expect(ev.baseTotal).toBe(11040n);
  });

  it("sends exact amounts in original minor units, zeros allowed", () => {
    const ev = evaluateEntry(draft({ splitMode: "EXACT", exact: { m_a: "100", m_b: "", m_c: "0" } }), ctx());
    expect(ev.errors).toEqual({});
    expect(ev.body?.participants).toEqual([
      { memberId: "m_a", amount: "10000" },
      { memberId: "m_b", amount: "0" },
      { memberId: "m_c", amount: "0" },
    ]);
  });

  it("maps server field paths onto form fields", () => {
    expect(formFieldFor("participants.1.amount", ["m_a", "m_b"])).toBe("exact.m_b");
    expect(formFieldFor("conversion.rate", [])).toBe("rate");
    expect(formFieldFor("description", [])).toBe("description");
  });
});

describe("note and photos in drafts", () => {
  it("sends the trimmed note and photo ids; an empty note becomes null", () => {
    const d = draft({ note: "  Tip incl.  ", attachmentIds: ["att_1", "att_2"] });
    expect(evaluateEntry(d, ctx()).body).toMatchObject({ note: "Tip incl.", attachmentIds: ["att_1", "att_2"] });
    expect(evaluateEntry({ ...d, note: "   " }, ctx()).body).toMatchObject({ note: null });
  });

  it("flags a note over 1000 characters", () => {
    const ev = evaluateEntry(draft({ note: "x".repeat(1001) }), ctx());
    expect(ev.errors.note).toBe("Keep the note under 1000 characters");
    expect(ev.body).toBeNull();
  });

  it("fills defaults for drafts saved before notes existed", () => {
    const { note: _n, attachmentIds: _a, ...old } = draft();
    expect(withDraftDefaults(old)).toMatchObject({ note: "", attachmentIds: [] });
  });

  it("maps server photo errors onto the photos field", () => {
    expect(formFieldFor("attachmentIds.2", [])).toBe("photos");
    expect(formFieldFor("note", [])).toBe("note");
  });
});
