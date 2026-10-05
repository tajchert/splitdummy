/** CSV export of every round's entries and transfers. UTF-8, fully quoted, formula-safe. */
import type { AmountSplitDTO, EntryDTO, InstructionDTO, RoundViewDTO } from "@shared/api";
import { minorToDecimal } from "./format";

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Quote a cell and neutralize spreadsheet formulas: anything starting with = + - @ TAB or CR
 * gets a leading apostrophe. Plain numbers (including negative amounts) are left as numbers.
 */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}

const HEADER = [
  "record_type",
  "round_id",
  "round_sequence",
  "round_status",
  "id",
  "occurred_at",
  "description",
  "payer_or_sender",
  "recipient",
  "created_by",
  "original_amount",
  "original_currency",
  "base_amount",
  "base_currency",
  "conversion_method",
  "rate",
  "rate_source",
  "rate_set_by",
  "rate_set_at",
  "conversion_note",
  "split_mode",
  "contributions",
  "allocations",
  "adjustment_effects",
  "corrected_entry_id",
  "corrected_round_id",
  "transfer_state",
  "created_at",
  "updated_at",
  "sent_at",
  "confirmed_at",
  "note",
  "photo_count",
];

export function buildCsv(views: RoundViewDTO[], names: Map<string, string>): string {
  const label = (id: string | null) => (id ? `${names.get(id) ?? "Former member"} [${id}]` : "");
  const lines: string[] = [HEADER.map(csvCell).join(",")];

  const splits = (list: AmountSplitDTO[] | null, e: EntryDTO) =>
    (list ?? [])
      .map((s) => {
        const base = `${minorToDecimal(s.baseAmount, e.baseExponent)} ${e.baseCurrency}`;
        const original =
          e.originalCurrency !== e.baseCurrency ? ` (${minorToDecimal(s.originalAmount, e.originalExponent)} ${e.originalCurrency})` : "";
        return `${label(s.memberId)}: ${base}${original}`;
      })
      .join("; ");

  for (const view of [...views].sort((a, b) => a.round.sequence - b.round.sequence)) {
    const r = view.round;
    const entries = [...view.entries].sort((a, b) =>
      a.occurredAt === b.occurredAt ? (a.createdAt < b.createdAt ? -1 : 1) : a.occurredAt < b.occurredAt ? -1 : 1,
    );
    for (const e of entries) {
      lines.push(
        [
          e.type,
          r.id,
          r.sequence,
          r.status,
          e.id,
          e.occurredAt,
          e.description,
          label(e.payerMemberId),
          "",
          label(e.creatorMemberId),
          minorToDecimal(e.originalAmount, e.originalExponent),
          e.originalCurrency,
          minorToDecimal(e.baseAmount, e.baseExponent),
          e.baseCurrency,
          e.conversion.method,
          e.conversion.rate,
          e.conversion.rateSource,
          label(e.conversion.rateSetByMemberId),
          e.conversion.rateSetAt,
          e.conversion.note,
          e.splitMode,
          splits(e.contributions, e),
          splits(e.allocations, e),
          splits(e.adjustmentEffects, e),
          e.correctedEntryId,
          e.correctedRoundId,
          "",
          e.createdAt,
          e.updatedAt,
          "",
          "",
          e.note,
          e.attachments.length,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    for (const i of view.instructions) lines.push(transferRow(r, i, label));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

function transferRow(r: RoundViewDTO["round"], i: InstructionDTO, label: (id: string | null) => string): string {
  const amount = minorToDecimal(i.amount, i.exponent);
  return [
    "TRANSFER",
    r.id,
    r.sequence,
    r.status,
    i.id,
    "",
    "Settlement transfer",
    label(i.fromMemberId),
    label(i.toMemberId),
    "",
    amount,
    i.currency,
    amount,
    i.currency,
    "",
    "",
    "",
    "",
    "",
    i.disputeNote,
    "",
    "",
    "",
    "",
    "",
    "",
    i.state,
    r.frozenAt,
    "",
    i.sentAt,
    i.confirmedAt,
    "",
    "",
  ]
    .map(csvCell)
    .join(",");
}
