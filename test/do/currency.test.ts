import { describe, expect, it } from "vitest";
import type { EntryDTO, FreezeResultDTO, ProjectDTO, RateDefaultDTO, RoundViewDTO } from "@shared/api";
import { createGroup, errorCode, expense, freezeNow, type Group } from "./helpers";

const eur = (g: Group, amount: string, conversion: any, participants?: string[]) =>
  expense(g.owner.memberId, participants ?? [g.owner.memberId, g.members[0]!.memberId], amount, {
    originalCurrency: "EUR",
    conversion,
  });

async function settings(g: Group, patch: Record<string, unknown>) {
  const { project } = await g.owner.view();
  return g.owner.call("updateSettings", {}, { expectedVersion: project.version, ...patch });
}

describe("currency mode", () => {
  it("adds a base expense with no conversion input (criterion 1)", async () => {
    const g = await createGroup();
    const entry = await g.owner.ok<EntryDTO>("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId], "1999"));
    expect(entry.conversion).toMatchObject({ method: "IDENTITY", rate: "1", rateSource: "IDENTITY", rateSetByMemberId: null });
    expect(entry.baseAmount).toBe("1999");
    expect(entry.baseCurrency).toBe("PLN");
    // A conversion on a base expense is rejected rather than ignored.
    expect(
      await errorCode(
        g.owner.call("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId], "100", {
          conversion: { method: "MANUAL_RATE", rate: "2" },
        })),
      ),
    ).toMatchObject({ status: 422, field: "conversion.method" });
  });

  it("enables multi-currency at creation or later without changing saved totals (criterion 2)", async () => {
    const created = await createGroup({ multiCurrencyEnabled: true });
    expect((await created.owner.view()).project.multiCurrencyEnabled).toBe(true);

    const g = await createGroup();
    const bob = g.members[0]!;
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId, bob.memberId], "10000"));
    const before = await g.owner.view();
    const res = await settings(g, { multiCurrencyEnabled: true });
    expect(res.status).toBe(200);
    expect((res.body as ProjectDTO).multiCurrencyEnabled).toBe(true);
    const after = await g.owner.view();
    expect(after.current.entries).toEqual(before.current.entries);
    expect(after.current.totals).toEqual(before.current.totals);
    expect(after.current.balances).toEqual(before.current.balances);
  });

  it("forbids participants from changing currency settings and rejects stale forms (criterion 3)", async () => {
    const g = await createGroup({ multiCurrencyEnabled: true });
    const bob = g.members[0]!;
    const { project } = await bob.view();
    expect((await errorCode(bob.call("updateSettings", {}, { expectedVersion: project.version, multiCurrencyEnabled: false }))).status).toBe(403);
    expect((await errorCode(bob.call("putRate", { currency: "EUR" }, { rate: "4.3" }))).status).toBe(403);

    // Owner disables; a form opened while it was enabled still tries to save a EUR expense.
    expect((await settings(g, { multiCurrencyEnabled: false })).status).toBe(200);
    expect(await errorCode(bob.call("createEntry", { roundId: g.roundId }, eur(g, "10000", { method: "MANUAL_RATE", rate: "4.3" })))).toMatchObject({
      status: 409,
      code: "MULTI_CURRENCY_DISABLED",
    });
    // Stale settings writes are rejected too.
    expect(await errorCode(g.owner.call("updateSettings", {}, { expectedVersion: project.version, name: "New" }))).toMatchObject({
      status: 409,
      code: "STALE_VERSION",
    });
  });

  it("requires a rate or actual base amount for foreign expenses (criterion 4)", async () => {
    const g = await createGroup({ multiCurrencyEnabled: true });
    expect(await errorCode(g.owner.call("createEntry", { roundId: g.roundId }, eur(g, "10000", { method: "IDENTITY" })))).toMatchObject({
      status: 422,
      field: "conversion",
    });
    expect(
      await errorCode(g.owner.call("createEntry", { roundId: g.roundId }, eur(g, "10000", { method: "MANUAL_RATE", rate: "0" }))),
    ).toMatchObject({ status: 422, field: "conversion.rate" });
    expect(
      await errorCode(g.owner.call("createEntry", { roundId: g.roundId }, eur(g, "10000", { method: "MANUAL_RATE", rate: "4,3" }))),
    ).toMatchObject({ status: 422, field: "conversion.rate" });
    expect(
      await errorCode(
        g.owner.call("createEntry", { roundId: g.roundId }, { ...eur(g, "1", { method: "MANUAL_RATE", rate: "0.0001" }) }),
      ),
    ).toMatchObject({ status: 422, field: "conversion" });
  });

  it("saves 100 EUR at 4.30 as 430 PLN; a later default of 4.50 changes nothing (criterion 5)", async () => {
    const g = await createGroup({ multiCurrencyEnabled: true });
    const bob = g.members[0]!;
    const rate = await g.owner.ok<RateDefaultDTO>("putRate", { currency: "EUR" }, { rate: "4.30" });
    expect(rate).toMatchObject({ currency: "EUR", rate: "4.3", revision: 1, setByMemberId: g.owner.memberId });

    const entry = await g.owner.ok<EntryDTO>("createEntry", { roundId: g.roundId }, eur(g, "10000", { method: "MANUAL_RATE", rate: "4.3" }));
    expect(entry).toMatchObject({ originalAmount: "10000", originalCurrency: "EUR", baseAmount: "43000", baseCurrency: "PLN" });
    expect(entry.conversion).toMatchObject({ method: "MANUAL_RATE", rate: "4.3", rateSource: "OWNER_DEFAULT", rateSetByMemberId: g.owner.memberId });
    expect(entry.allocations.map((a) => a.baseAmount)).toEqual(["21500", "21500"]);

    const ready = await g.owner.ok("setReadiness", { roundId: g.roundId }, { ready: true });
    expect(ready.ready).toBe(true);
    const updated = await g.owner.ok<RateDefaultDTO>("putRate", { currency: "EUR" }, { rate: "4.50", expectedRevision: 1 });
    expect(updated.revision).toBe(2);
    expect(await errorCode(g.owner.call("putRate", { currency: "EUR" }, { rate: "4.6", expectedRevision: 1 }))).toMatchObject({
      code: "STALE_VERSION",
    });
    const view = await g.owner.view();
    // FX default changes clear nobody's readiness.
    expect(view.current.readiness.find((r) => r.memberId === g.owner.memberId)?.ready).toBe(true);
    expect(view.current.entries[0]).toEqual(entry);

    // An explicit 4.3 now differs from the saved default → provenance is an override.
    const override = await bob.ok<EntryDTO>("createEntry", { roundId: g.roundId }, eur(g, "100", { method: "MANUAL_RATE", rate: "4.3" }));
    expect(override.conversion).toMatchObject({ rateSource: "ENTRY_OVERRIDE", rateSetByMemberId: bob.memberId });
    await bob.ok("deleteEntry", { roundId: g.roundId, entryId: override.id }, { expectedRevision: 1 });

    const frozen = await freezeNow(g);
    expect(frozen.instructions).toHaveLength(1);
    expect(frozen.instructions[0]).toMatchObject({
      fromMemberId: bob.memberId,
      toMemberId: g.owner.memberId,
      amount: "21500",
      currency: "PLN",
      exponent: 2,
    });
  });

  it("settles from the actual base charge with its explanation (criterion 6)", async () => {
    const g = await createGroup({ multiCurrencyEnabled: true });
    const entry = await g.owner.ok<EntryDTO>(
      "createEntry",
      { roundId: g.roundId },
      eur(g, "10000", { method: "ACTUAL_BASE_AMOUNT", baseAmount: "43200", note: "Bank statement" }),
    );
    expect(entry).toMatchObject({ baseAmount: "43200" });
    expect(entry.conversion).toMatchObject({ method: "ACTUAL_BASE_AMOUNT", rate: "4.32", rateSource: "ACTUAL_CHARGE", note: "Bank statement" });
    const frozen = await freezeNow(g);
    expect(frozen.instructions[0]?.amount).toBe("21600");
  });

  it("handles zero- and three-decimal currencies", async () => {
    const g = await createGroup({ baseCurrency: "KWD", multiCurrencyEnabled: true });
    const view = await g.owner.view();
    expect(view.project.baseExponent).toBe(3);
    const jpy = await g.owner.ok<EntryDTO>(
      "createEntry",
      { roundId: g.roundId },
      expense(g.owner.memberId, [g.owner.memberId], "1000", {
        originalCurrency: "JPY",
        conversion: { method: "MANUAL_RATE", rate: "0.002" },
      }),
    );
    expect(jpy).toMatchObject({ originalExponent: 0, baseExponent: 3, baseAmount: "2000" });
  });
});

describe("disabling and history (criterion 10)", () => {
  it("blocks disabling with foreign entries; frozen history keeps its currencies", async () => {
    const g = await createGroup({ multiCurrencyEnabled: true });
    const entry = await g.owner.ok<EntryDTO>("createEntry", { roundId: g.roundId }, eur(g, "10000", { method: "MANUAL_RATE", rate: "4.3" }));
    expect(await errorCode(settings(g, { multiCurrencyEnabled: false }))).toMatchObject({
      status: 409,
      code: "FOREIGN_ENTRIES_EXIST",
      details: { currencies: ["EUR"] },
    });

    const frozen = await freezeNow(g);
    // Settling: currency mode is locked either way.
    expect((await errorCode(settings(g, { multiCurrencyEnabled: false }))).code).toBe("ROUND_NOT_COLLECTING");
    expect((await errorCode(g.owner.call("putRate", { currency: "EUR" }, { rate: "5" }))).code).toBe("ROUND_NOT_COLLECTING");

    const bob = g.members[0]!;
    const instruction = frozen.instructions[0]!;
    await bob.ok("markSent", { roundId: g.roundId, instructionId: instruction.id });
    await g.owner.ok("markReceived", { roundId: g.roundId, instructionId: instruction.id });
    const history = await g.owner.ok<RoundViewDTO>("getRound", { roundId: g.roundId }, null, null);

    // No active round: the owner can switch mode for the next round without touching history.
    expect((await settings(g, { multiCurrencyEnabled: false })).status).toBe(200);
    await g.owner.ok("startRound");
    expect(await g.owner.ok<RoundViewDTO>("getRound", { roundId: g.roundId }, null, null)).toEqual(history);
    expect(history.entries[0]).toEqual(entry);
    expect(history.currencySubtotals).toEqual([{ currency: "EUR", exponent: 2, expenses: "10000", refunds: "0", baseEquivalent: "43000" }]);
  });
});

describe("settlement currency lock (criterion 11)", () => {
  it("allows changing the base before the first entry only", async () => {
    const g = await createGroup({ members: 0 });
    const changed = await settings(g, { baseCurrency: "EUR" });
    expect((changed.body as ProjectDTO).baseCurrency).toBe("EUR");
    expect((await errorCode(settings(g, { baseCurrency: "ZZZ" }))).field).toBe("baseCurrency");

    const entry = await g.owner.ok<EntryDTO>(
      "createEntry",
      { roundId: g.roundId },
      expense(g.owner.memberId, [g.owner.memberId], "500", { originalCurrency: "EUR" }),
    );
    await g.owner.ok("deleteEntry", { roundId: g.roundId, entryId: entry.id }, { expectedRevision: 1 });
    // Deleting the only entry does not unlock it.
    expect(await errorCode(settings(g, { baseCurrency: "PLN" }))).toMatchObject({ status: 409, code: "CURRENCY_LOCKED" });
    expect((await g.owner.view()).project.baseCurrencyLocked).toBe(true);
  });

  it("freeze preserves rates, original amounts and base allocations", async () => {
    const g = await createGroup({ multiCurrencyEnabled: true, members: 2 });
    const [bob, carol] = g.members;
    const entry = await g.owner.ok<EntryDTO>(
      "createEntry",
      { roundId: g.roundId },
      expense(g.owner.memberId, [g.owner.memberId, bob!.memberId, carol!.memberId], "10000", {
        originalCurrency: "EUR",
        conversion: { method: "MANUAL_RATE", rate: "4.3333" },
      }),
    );
    const before = await g.owner.ok<RoundViewDTO>("getRound", { roundId: g.roundId }, null, null);
    const frozen = await freezeNow(g);
    expect(frozen.round.status).toBe("SETTLING");
    const after = await g.owner.ok<RoundViewDTO>("getRound", { roundId: g.roundId }, null, null);
    expect(after.entries).toEqual([entry]);
    expect(after.entries).toEqual(before.entries);
    const sum = entry.allocations.reduce((s, a) => s + BigInt(a.baseAmount), 0n);
    expect(sum.toString()).toBe(entry.baseAmount);
    expect(after.balances.map(({ confirmedProgress, remaining, ...b }) => b)).toEqual(
      before.balances.map(({ confirmedProgress, remaining, ...b }) => b),
    );
  });
});
