import type { EntryDTO, InstructionDTO, MemberDTO, ProjectViewDTO, RoundViewDTO } from "@shared/api";

export type Tone = "accent" | "blue" | "green" | "amber" | "red";
const TONES: Tone[] = ["accent", "blue", "green", "amber", "red"];

/** Stable avatar colour by join order, so the owner (first) gets the accent like in the design. */
export function toneFor(view: Pick<ProjectViewDTO, "members">, memberId: string): Tone {
  const sorted = [...view.members].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.id.localeCompare(b.id));
  const i = sorted.findIndex((m) => m.id === memberId);
  return TONES[(i < 0 ? 0 : i) % TONES.length]!;
}

export function member(view: Pick<ProjectViewDTO, "members">, id: string | null | undefined): MemberDTO | undefined {
  return id ? view.members.find((m) => m.id === id) : undefined;
}

/** "Maya", or "Maya (you)" with `you`. Removed members keep their name. */
export function nameOf(view: Pick<ProjectViewDTO, "members" | "me">, id: string | null | undefined, opts: { you?: boolean; short?: boolean } = {}): string {
  if (!id) return "Someone";
  const m = member(view, id);
  const n = m?.displayName ?? "Former member";
  if (id === view.me.memberId) {
    if (opts.short) return "You";
    if (opts.you) return `${n} (you)`;
  }
  return n;
}

export function initial(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toLocaleUpperCase();
}

/** Members shown in pickers and readiness lists. */
export function activeMembers(view: ProjectViewDTO): MemberDTO[] {
  return view.members
    .filter((m) => m.status === "ACTIVE")
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.id.localeCompare(b.id));
}

export function readinessOf(round: RoundViewDTO, memberId: string): boolean {
  return round.readiness.find((r) => r.memberId === memberId)?.ready ?? false;
}

/**
 * Members who hadn't marked "done adding" when the round froze. Readiness rows of a frozen
 * round are the ones recorded at freeze; people who joined later never count.
 */
export function notReadyAtFreeze(view: Pick<ProjectViewDTO, "members">, round: RoundViewDTO): MemberDTO[] {
  const frozenAt = round.round.frozenAt;
  if (round.round.status === "COLLECTING" || !frozenAt) return [];
  return round.readiness
    .filter((r) => !r.ready)
    .map((r) => member(view, r.memberId))
    .filter((m): m is MemberDTO => !!m && m.joinedAt <= frozenAt);
}

export function balanceOf(round: RoundViewDTO, memberId: string) {
  return round.balances.find((b) => b.memberId === memberId);
}

export function canEditEntry(view: ProjectViewDTO, e: EntryDTO): boolean {
  if (view.current.round.status !== "COLLECTING" || e.roundId !== view.current.round.id) return false;
  if (e.type === "ADJUSTMENT") return view.me.isOwner;
  return view.me.isOwner || e.creatorMemberId === view.me.memberId;
}

export function entrySign(e: EntryDTO): 1n | -1n {
  return e.type === "REFUND" ? -1n : 1n;
}

/** Instructions that need my action right now, most urgent first. */
export function myTasks(view: ProjectViewDTO): { instruction: InstructionDTO; role: "send" | "resend" | "confirm" }[] {
  const me = view.me.memberId;
  const out: { instruction: InstructionDTO; role: "send" | "resend" | "confirm" }[] = [];
  for (const i of view.current.instructions) {
    if (i.toMemberId === me && i.state === "SENT") out.push({ instruction: i, role: "confirm" });
    else if (i.fromMemberId === me && i.state === "DISPUTED") out.push({ instruction: i, role: "resend" });
    else if (i.fromMemberId === me && i.state === "PROPOSED") out.push({ instruction: i, role: "send" });
  }
  const order = { confirm: 0, resend: 1, send: 2 } as const;
  return out.sort((a, b) => order[a.role] - order[b.role]);
}

export function confirmedCount(round: RoundViewDTO): number {
  return round.instructions.filter((i) => i.state === "CONFIRMED").length;
}

/** Finish-line progress: [collecting, settling, settled] fill 0..1. */
export function trackProgress(round: RoundViewDTO | null): [number, number, number] {
  if (!round) return [0, 0, 0];
  const s = round.round.status;
  if (s === "COLLECTING") return [1, 0, 0];
  if (s === "SETTLED") return [1, 1, 1];
  const n = round.instructions.length;
  return [1, n ? confirmedCount(round) / n : 0, 0];
}

export function roundLabel(seq: number): string {
  return `Round ${seq}`;
}

/** Base-currency effect of one entry on one member's balance. */
export function effectFor(e: EntryDTO, memberId: string): { paid: bigint; share: bigint; net: bigint } {
  const c = BigInt(e.contributions.find((x) => x.memberId === memberId)?.baseAmount ?? "0");
  const a = BigInt(e.allocations.find((x) => x.memberId === memberId)?.baseAmount ?? "0");
  if (e.type === "ADJUSTMENT") {
    const x = BigInt(e.adjustmentEffects?.find((y) => y.memberId === memberId)?.baseAmount ?? "0");
    return { paid: 0n, share: 0n, net: x };
  }
  if (e.type === "REFUND") return { paid: -c, share: -a, net: a - c };
  return { paid: c, share: a, net: c - a };
}
