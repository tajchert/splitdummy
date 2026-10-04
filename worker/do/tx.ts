/**
 * Mutation context. One Tx lives inside one `transactionSync` call: it carries the resolved
 * principal/member, records audit + outbox rows, and bumps versions when the op finishes.
 * Anything thrown aborts the whole transaction (state, audit and outbox together).
 */
import type { ProjectSummaryDTO } from "@shared/api";
import { conflict, forbidden, notCollecting, notFound, unauthenticated } from "./errors";
import type { MemberRow, ProjectRow, RoundRow, Store } from "./store";
import type { OutboxMessage, Principal } from "./types";

type NotifyKind = Extract<OutboxMessage, { type: "NOTIFY" }>["payload"]["kind"];

export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

export class Tx {
  readonly now = new Date().toISOString();
  /** Something durable changed: bump project.version, broadcast, maybe publish directory. */
  changed = false;
  private ledgerChanged = false;
  private reviewChanged = false;
  private notifications: { kind: NotifyKind; memberIds: string[]; summary: string }[] = [];
  /** Members whose live sockets should be closed after commit (removed members). */
  readonly disconnect: string[] = [];
  private cachedMember: MemberRow | undefined;
  /** Audit actor; defaults to the resolved member. */
  private actorId: string | null = null;

  constructor(
    readonly store: Store,
    readonly principal: Principal | null,
  ) {}

  /** 404 when this object holds no project (never created implicitly). */
  requireProject(): void {
    if (!this.store.project()) throw notFound();
  }

  get project(): ProjectRow {
    const p = this.store.project();
    if (!p) throw notFound();
    return p;
  }

  /** Current member for the principal; ACTIVE or LEFT (LEFT members keep their obligations). */
  member(): MemberRow {
    if (this.cachedMember) return this.cachedMember;
    if (!this.principal) throw unauthenticated();
    this.requireProject();
    const m = this.store.memberByPrincipal(this.principal.principalId);
    if (!m || m.status === "REMOVED") throw notFound();
    this.cachedMember = m;
    return m;
  }

  owner(message = "Only the group owner can do this."): MemberRow {
    const m = this.member();
    if (this.project.owner_member_id !== m.id) throw forbidden(message);
    return m;
  }

  /** For ops that create the acting member (createProject, join). */
  setActor(member: MemberRow): void {
    this.cachedMember = member;
    this.actorId = member.id;
  }

  activeRound(): RoundRow | undefined {
    const id = this.project.active_round_id;
    return id ? this.store.round(id) : undefined;
  }

  /** The round named in the path, which must exist (404) and be the active collecting round (409). */
  collectingRound(roundId: string | undefined): RoundRow {
    const round = roundId ? this.store.round(roundId) : undefined;
    if (!round) throw notFound("This round isn't available.");
    if (round.status !== "COLLECTING" || this.project.active_round_id !== round.id) throw notCollecting();
    return round;
  }

  /** Membership/currency settings may change only while collecting or between rounds. */
  requireNotSettling(): void {
    if (this.activeRound()?.status === "SETTLING") {
      throw conflict("ROUND_NOT_COLLECTING", "Settlement is in progress; this can't change until everyone is settled.");
    }
  }

  financial(): void {
    this.changed = true;
    this.ledgerChanged = true;
    this.reviewChanged = true;
  }

  reviewTouched(): void {
    this.changed = true;
    this.reviewChanged = true;
  }

  touch(): void {
    this.changed = true;
  }

  /** Clear readiness in the active collecting round, for some members or everyone. */
  clearReadiness(memberIds: string[] | "ALL"): void {
    const round = this.activeRound();
    if (!round || round.status !== "COLLECTING") return;
    if (memberIds === "ALL") {
      this.store.run("UPDATE readiness SET ready = 0, marked_at = ? WHERE round_id = ? AND ready = 1", this.now, round.id);
    } else {
      for (const id of new Set(memberIds)) {
        this.store.run(
          "UPDATE readiness SET ready = 0, marked_at = ? WHERE round_id = ? AND member_id = ? AND ready = 1",
          this.now,
          round.id,
          id,
        );
      }
    }
    this.reviewTouched();
  }

  audit(
    action: string,
    summary: string,
    opts: { roundId?: string | null; entityId?: string | null; revision?: number | null; details?: unknown } = {},
  ): void {
    this.store.run(
      `INSERT INTO audit_events (id, at, actor_member_id, action, round_id, entity_id, entity_revision, summary, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId("a"),
      this.now,
      this.actorId ?? this.cachedMember?.id ?? null,
      action,
      opts.roundId ?? null,
      opts.entityId ?? null,
      opts.revision ?? null,
      summary,
      opts.details === undefined ? null : JSON.stringify(opts.details),
    );
    this.changed = true;
  }

  notify(kind: NotifyKind, memberIds: string[], summary: string): void {
    this.notifications.push({ kind, memberIds, summary });
  }

  /**
   * Finalize: bump versions, write outbox rows. Returns the new project version and whether
   * any outbox row was written (so the caller can arm the alarm after commit).
   */
  finish(): { projectVersion: number; outbox: boolean } {
    const project = this.store.project();
    if (!project || !this.changed) return { projectVersion: project?.version ?? 0, outbox: false };
    const version = project.version + 1;
    this.store.run("UPDATE project SET version = ? WHERE id = ?", version, project.id);
    if (project.active_round_id && (this.ledgerChanged || this.reviewChanged)) {
      this.store.run(
        `UPDATE rounds SET ledger_version = ledger_version + ?, review_version = review_version + 1
         WHERE id = ? AND status = 'COLLECTING'`,
        this.ledgerChanged ? 1 : 0,
        project.active_round_id,
      );
    }

    let outbox = false;
    const principals = new Map(this.store.members().map((m) => [m.id, m.principal_id]));
    for (const n of this.notifications) {
      const principalIds = [...new Set(n.memberIds.map((id) => principals.get(id)).filter((p): p is string => !!p))];
      if (principalIds.length === 0) continue;
      this.writeOutbox({
        id: newId("o"),
        type: "NOTIFY",
        projectId: project.id,
        projectVersion: version,
        payload: { kind: n.kind, principalIds, summary: n.summary },
      });
      outbox = true;
    }

    // Directory projection: publish only when what the directory shows actually changed.
    const directory = directoryPayload(this.store);
    const serialized = JSON.stringify(directory);
    const last = this.store.first<{ value: string }>("SELECT value FROM meta WHERE key = 'directory_payload'");
    if (last?.value !== serialized) {
      this.store.run(
        "INSERT INTO meta (key, value) VALUES ('directory_payload', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        serialized,
      );
      this.writeOutbox({ id: newId("o"), type: "DIRECTORY_UPSERT", projectId: project.id, projectVersion: version, payload: directory });
      outbox = true;
    }
    return { projectVersion: version, outbox };
  }

  private writeOutbox(message: OutboxMessage): void {
    this.store.run(
      "INSERT INTO outbox (id, project_version, type, message_json, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?)",
      message.id,
      message.projectVersion,
      message.type,
      JSON.stringify(message),
      this.now,
      Date.now(),
    );
  }
}

type DirectoryPayload = Extract<OutboxMessage, { type: "DIRECTORY_UPSERT" }>["payload"];
type NextAction = NonNullable<ProjectSummaryDTO["nextAction"]>;

export function directoryPayload(store: Store): DirectoryPayload {
  const project = store.project()!;
  const latest = store.latestRound();
  const round = (project.active_round_id && store.round(project.active_round_id)) || latest;
  const ready = new Set(
    round && round.status === "COLLECTING"
      ? store.readiness(round.id).filter((r) => r.ready === 1).map((r) => r.member_id)
      : [],
  );
  const instructions = round && round.status === "SETTLING" ? store.instructions(round.id) : [];
  const members = store.members();

  const nextAction = (m: MemberRow): NextAction | null => {
    if (m.status === "REMOVED" || !round) return null;
    const isOwner = project.owner_member_id === m.id;
    switch (round.status) {
      case "COLLECTING":
        if (m.status !== "ACTIVE") return "WAITING";
        if (!ready.has(m.id)) return "MARK_READY";
        return isOwner ? "REVIEW_FREEZE" : "WAITING";
      case "SETTLING":
        if (instructions.some((i) => i.from_member_id === m.id && (i.state === "PROPOSED" || i.state === "DISPUTED"))) {
          return "SEND_MONEY";
        }
        if (instructions.some((i) => i.to_member_id === m.id && i.state === "SENT")) return "CONFIRM_RECEIPT";
        return "WAITING";
      case "SETTLED":
        return "DONE";
    }
  };

  return {
    name: project.name,
    baseCurrency: project.base_currency,
    roundStatus: round?.status ?? null,
    roundSequence: round?.sequence ?? null,
    members: members.map((m) => ({
      principalId: m.principal_id,
      memberId: m.id,
      isOwner: project.owner_member_id === m.id,
      status: m.status,
      nextAction: nextAction(m),
    })),
  };
}
