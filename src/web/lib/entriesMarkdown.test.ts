import { describe, expect, it } from "vitest";
import type { EntryDTO, ProjectViewDTO, RoundViewDTO } from "@shared/api";
import { entriesMarkdown } from "./entriesMarkdown";

const view = {
  project: { name: "Trip | Team", baseCurrency: "USD", baseExponent: 2 },
  me: { memberId: "m_b" },
  members: [
    { id: "m_a", displayName: "Ann" },
    { id: "m_b", displayName: "Bob" },
    { id: "m_c", displayName: "Cat" },
  ],
} as unknown as ProjectViewDTO;

const entry = (over: Partial<EntryDTO>): EntryDTO =>
  ({
    type: "EXPENSE",
    occurredAt: "2026-10-17",
    description: "Dinner",
    originalAmount: "745",
    originalCurrency: "USD",
    originalExponent: 2,
    baseAmount: "745",
    baseCurrency: "USD",
    baseExponent: 2,
    conversion: { rate: "1" },
    payerMemberId: "m_a",
    creatorMemberId: "m_a",
    contributions: [{ memberId: "m_a", originalAmount: "745", baseAmount: "745" }],
    allocations: [
      { memberId: "m_a", originalAmount: "249", baseAmount: "249" },
      { memberId: "m_b", originalAmount: "248", baseAmount: "248" },
      { memberId: "m_c", originalAmount: "248", baseAmount: "248" },
    ],
    adjustmentEffects: null,
    ...over,
  }) as EntryDTO;

const round = (expenses: string, refunds = "0") => ({ round: { sequence: 1 }, totals: { expenses, refunds, adjustments: "0" } }) as unknown as RoundViewDTO;

describe("entriesMarkdown", () => {
  it("renders one share column per member and a totals row", () => {
    const md = entriesMarkdown(view, round("745"), [entry({ description: "Parking\nlot | A" })]);
    expect(md).toBe(
      [
        "**Trip \\| Team · Round 1** · amounts in USD",
        "",
        "| Date | Description | Type | Paid by | Amount | Ann share (USD) | Bob share (USD) | Cat share (USD) |",
        "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |",
        "| 2026-10-17 | Parking lot \\| A | Expense | Ann | 7.45 USD | 2.49 | 2.48 | 2.48 |",
        "|  | **Total** |  |  | **7.45 USD** | **2.49** | **2.48** | **2.48** |",
        "",
      ].join("\n"),
    );
  });

  it("signs refunds negative, shows conversions and correction effects, and skips uninvolved members", () => {
    const refund = entry({
      type: "REFUND",
      originalAmount: "1000",
      originalCurrency: "EUR",
      baseAmount: "1100",
      conversion: { rate: "1.1" } as EntryDTO["conversion"],
      payerMemberId: "m_b",
      contributions: [{ memberId: "m_b", originalAmount: "1000", baseAmount: "1100" }],
      allocations: [
        { memberId: "m_a", originalAmount: "500", baseAmount: "550" },
        { memberId: "m_b", originalAmount: "500", baseAmount: "550" },
      ],
    });
    const fix = entry({
      type: "ADJUSTMENT",
      creatorMemberId: "m_a",
      contributions: [],
      allocations: [],
      adjustmentEffects: [
        { memberId: "m_a", originalAmount: "5", baseAmount: "5" },
        { memberId: "m_b", originalAmount: "-5", baseAmount: "-5" },
      ],
    });
    const lines = entriesMarkdown(view, round("0", "1100"), [refund, fix]).split("\n");
    expect(lines[2]).not.toContain("Cat");
    expect(lines[4]).toBe("| 2026-10-17 | Dinner | Refund | Bob | -10.00 EUR (-11.00 USD @ 1.1) | -5.50 | -5.50 |");
    expect(lines[5]).toBe("| 2026-10-17 | Dinner | Correction | Ann |  | 0.05 | -0.05 |");
    expect(lines[6]).toBe("|  | **Total** |  |  | **-11.00 USD** | **-5.45** | **-5.55** |");
  });
});
