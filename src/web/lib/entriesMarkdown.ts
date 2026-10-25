import type { EntryDTO, ProjectViewDTO, RoundViewDTO } from "@shared/api";
import { pow10 } from "@shared/money";
import { effectFor, nameOf, roundLabel } from "./project";

/** "-1234.50": plain dot decimal, no grouping, so pasted tables stay machine-readable. */
function plain(minor: bigint, exponent: number): string {
  const abs = minor < 0n ? -minor : minor;
  const scale = pow10(exponent);
  const frac = exponent > 0 ? "." + (abs % scale).toString().padStart(exponent, "0") : "";
  return (minor < 0n ? "-" : "") + (abs / scale).toString() + frac;
}

function cell(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

const TYPE_LABEL: Record<EntryDTO["type"], string> = { EXPENSE: "Expense", REFUND: "Refund", ADJUSTMENT: "Correction" };

/** Per-member column value: share of an expense/refund (refunds negative), balance effect of a correction. */
function memberValue(e: EntryDTO, memberId: string): bigint {
  const fx = effectFor(e, memberId);
  return e.type === "ADJUSTMENT" ? fx.net : fx.share;
}

/** The round's entries as a GitHub-flavoured markdown table, one column per member's share in the base currency. */
export function entriesMarkdown(view: Pick<ProjectViewDTO, "project" | "members" | "me">, round: RoundViewDTO, entries: EntryDTO[]): string {
  const { baseCurrency: code, baseExponent: exp } = view.project;
  const involved = new Set(entries.flatMap((e) => [...e.contributions, ...e.allocations, ...(e.adjustmentEffects ?? [])].map((x) => x.memberId)));
  const members = view.members.filter((m) => involved.has(m.id));
  const names = members.map((m) => cell(nameOf(view, m.id)));

  const header = ["Date", "Description", "Type", "Paid by", "Amount", ...names.map((n) => `${n} share (${code})`)];
  const align = ["---", "---", "---", "---", "---:", ...names.map(() => "---:")];
  const rows = entries.map((e) => {
    const sign = e.type === "REFUND" ? -1n : 1n;
    const payer = e.type === "ADJUSTMENT" ? e.creatorMemberId : (e.payerMemberId ?? e.creatorMemberId);
    let amount = "";
    if (e.type !== "ADJUSTMENT") {
      amount = `${plain(BigInt(e.originalAmount) * sign, e.originalExponent)} ${e.originalCurrency}`;
      if (e.originalCurrency !== e.baseCurrency) amount += ` (${plain(BigInt(e.baseAmount) * sign, e.baseExponent)} ${e.baseCurrency} @ ${e.conversion.rate})`;
    }
    return [e.occurredAt, cell(e.description), TYPE_LABEL[e.type], cell(nameOf(view, payer)), amount, ...members.map((m) => plain(memberValue(e, m.id), exp))];
  });
  const net = BigInt(round.totals.expenses) - BigInt(round.totals.refunds);
  const total = ["", "**Total**", "", "", `**${plain(net, exp)} ${code}**`, ...members.map((m) => `**${plain(entries.reduce((s, e) => s + memberValue(e, m.id), 0n), exp)}**`)];

  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    `**${cell(view.project.name)} · ${roundLabel(round.round.sequence)}** · amounts in ${code}`,
    "",
    line(header),
    line(align),
    ...rows.map(line),
    line(total),
    "",
  ].join("\n");
}
