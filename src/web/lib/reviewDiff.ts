import type { ProjectViewDTO, RoundViewDTO } from "@shared/api";
import { nameOf } from "./project";

/** One human sentence describing what changed between two snapshots of a round. */
export function describeChange(prev: RoundViewDTO, next: RoundViewDTO, view: Pick<ProjectViewDTO, "members" | "me">): string {
  const parts: string[] = [];
  const before = new Map(prev.entries.map((e) => [e.id, e]));
  const after = new Map(next.entries.map((e) => [e.id, e]));
  for (const e of next.entries) {
    const old = before.get(e.id);
    if (!old) parts.push(`${nameOf(view, e.creatorMemberId)} added “${e.description}”`);
    else if (old.revision !== e.revision) parts.push(`${nameOf(view, e.lastEditedByMemberId ?? e.creatorMemberId)} edited “${e.description}”`);
  }
  for (const e of prev.entries) if (!after.has(e.id)) parts.push(`“${e.description}” was deleted`);
  for (const r of next.readiness) {
    const old = prev.readiness.find((x) => x.memberId === r.memberId);
    if ((old?.ready ?? false) !== r.ready) parts.push(`${nameOf(view, r.memberId)} ${r.ready ? "finished adding" : "is adding again"}`);
  }
  if (parts.length === 0) return "Something changed.";
  if (parts.length > 2) return `${parts.slice(0, 2).join(". ")} and ${parts.length - 2} more change${parts.length - 2 === 1 ? "" : "s"}.`;
  return `${parts.join(". ")}.`;
}
