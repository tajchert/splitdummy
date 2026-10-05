import { describe, expect, it } from "vitest";
import { EntryInputSchema, NoteSchema, UpdateEntrySchema } from "./api";

const base = {
  type: "EXPENSE",
  description: "Dinner",
  occurredAt: "2026-10-01",
  originalAmount: "1000",
  originalCurrency: "PLN",
  conversion: { method: "IDENTITY" },
  payerMemberId: "m_a",
  splitMode: "EQUAL",
  participants: [{ memberId: "m_a" }],
};

describe("NoteSchema", () => {
  it("trims and caps at 1000 characters", () => {
    expect(NoteSchema.parse("  hi  ")).toBe("hi");
    expect(NoteSchema.safeParse("x".repeat(1000)).success).toBe(true);
    expect(NoteSchema.safeParse("x".repeat(1001)).success).toBe(false);
    expect(NoteSchema.safeParse(`${"x".repeat(1000)}   `).success).toBe(true);
  });
});

describe("EntryInputSchema note and photos", () => {
  it("keeps both fields optional so old clients are unaffected", () => {
    const parsed = EntryInputSchema.parse(base);
    expect(parsed.note).toBeUndefined();
    expect(parsed.attachmentIds).toBeUndefined();
  });

  it("accepts null and empty values to clear", () => {
    expect(EntryInputSchema.parse({ ...base, note: null, attachmentIds: [] })).toMatchObject({ note: null, attachmentIds: [] });
  });

  it("rejects more than five photos and duplicates", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `att_${i}`);
    expect(EntryInputSchema.safeParse({ ...base, attachmentIds: ids(5) }).success).toBe(true);
    const six = EntryInputSchema.safeParse({ ...base, attachmentIds: ids(6) });
    expect(six.success).toBe(false);
    expect(six.error?.issues[0]?.path).toEqual(["attachmentIds"]);
    const dup = EntryInputSchema.safeParse({ ...base, attachmentIds: ["att_1", "att_1"] });
    expect(dup.success).toBe(false);
  });

  it("carries the fields into updates", () => {
    expect(UpdateEntrySchema.parse({ ...base, expectedRevision: 2, note: "Tip included" }).note).toBe("Tip included");
  });
});
