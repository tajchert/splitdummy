/** Typed row access over the DO's SQLite storage. Synchronous; safe inside transactionSync. */

export interface ProjectRow {
  id: string;
  name: string;
  owner_member_id: string;
  pending_owner_member_id: string | null;
  base_currency: string;
  base_exponent: number;
  multi_currency_enabled: number;
  base_currency_locked: number;
  active_round_id: string | null;
  version: number;
  created_at: string;
}

export type MemberStatus = "ACTIVE" | "LEFT" | "REMOVED";

export interface MemberRow {
  id: string;
  principal_id: string;
  display_name: string;
  is_guest: number;
  has_recoverable_account: number;
  joined_at: string;
  status: MemberStatus;
  status_changed_at: string | null;
}

export interface RoundRow {
  id: string;
  sequence: number;
  status: "COLLECTING" | "SETTLING" | "SETTLED";
  ledger_version: number;
  review_version: number;
  created_at: string;
  frozen_at: string | null;
  settled_at: string | null;
  early_freeze_reason: string | null;
  frozen_by_member_id: string | null;
}

export interface ReadinessRow {
  round_id: string;
  member_id: string;
  ready: number;
  marked_at: string | null;
}

export interface EntryRow {
  id: string;
  round_id: string;
  type: "EXPENSE" | "REFUND" | "ADJUSTMENT";
  creator_member_id: string;
  last_edited_by_member_id: string | null;
  occurred_at: string;
  description: string;
  original_amount: string;
  original_currency: string;
  original_exponent: number;
  base_amount: string;
  base_currency: string;
  base_exponent: number;
  conversion_method: "IDENTITY" | "MANUAL_RATE" | "ACTUAL_BASE_AMOUNT";
  rate: string;
  rate_source: "IDENTITY" | "OWNER_DEFAULT" | "ENTRY_OVERRIDE" | "ACTUAL_CHARGE";
  rate_set_by_member_id: string | null;
  rate_set_at: string | null;
  conversion_note: string | null;
  payer_member_id: string | null;
  split_mode: "EQUAL" | "EXACT" | null;
  corrected_entry_id: string | null;
  corrected_round_id: string | null;
  revision: number;
  deleted: number;
  deleted_at: string | null;
  deleted_by_member_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SplitRow {
  entry_id: string;
  member_id: string;
  original_amount: string;
  base_amount: string;
}

export interface EffectRow {
  entry_id: string;
  member_id: string;
  base_amount: string;
}

/** An entry with its child rows. */
export interface LoadedEntry {
  row: EntryRow;
  contributions: SplitRow[];
  allocations: SplitRow[];
  effects: EffectRow[];
}

export interface RateRow {
  currency: string;
  rate: string;
  set_by_member_id: string;
  set_at: string;
  revision: number;
}

export interface InvitationRow {
  id: string;
  secret_hash: string;
  created_by_member_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface InstructionRow {
  id: string;
  round_id: string;
  position: number;
  from_member_id: string;
  to_member_id: string;
  amount: string;
  currency: string;
  exponent: number;
  state: "PROPOSED" | "SENT" | "CONFIRMED" | "DISPUTED";
  sent_at: string | null;
  confirmed_at: string | null;
  disputed_at: string | null;
  dispute_note: string | null;
  revision: number;
}

export interface SnapshotRow {
  round_id: string;
  ledger_version: number;
  review_version: number;
  cutoff_at: string;
  algorithm_version: string;
  snapshot_json: string;
}

export interface AuditRow {
  seq: number;
  id: string;
  at: string;
  actor_member_id: string | null;
  action: string;
  round_id: string | null;
  entity_id: string | null;
  entity_revision: number | null;
  summary: string;
  details_json: string | null;
}

type Binding = string | number | null;

export class Store {
  constructor(readonly sql: SqlStorage) {}

  all<T>(query: string, ...bindings: Binding[]): T[] {
    return this.sql.exec(query, ...bindings).toArray() as T[];
  }

  first<T>(query: string, ...bindings: Binding[]): T | undefined {
    return this.all<T>(query, ...bindings)[0];
  }

  run(query: string, ...bindings: Binding[]): void {
    this.sql.exec(query, ...bindings);
  }

  count(query: string, ...bindings: Binding[]): number {
    const row = this.first<{ n: number }>(query, ...bindings);
    return row ? Number(row.n) : 0;
  }

  project(): ProjectRow | undefined {
    return this.first<ProjectRow>("SELECT * FROM project LIMIT 1");
  }

  members(): MemberRow[] {
    return this.all<MemberRow>("SELECT * FROM members ORDER BY joined_at, id");
  }

  member(id: string): MemberRow | undefined {
    return this.first<MemberRow>("SELECT * FROM members WHERE id = ?", id);
  }

  memberByPrincipal(principalId: string): MemberRow | undefined {
    return this.first<MemberRow>("SELECT * FROM members WHERE principal_id = ?", principalId);
  }

  rounds(): RoundRow[] {
    return this.all<RoundRow>("SELECT * FROM rounds ORDER BY sequence DESC");
  }

  round(id: string): RoundRow | undefined {
    return this.first<RoundRow>("SELECT * FROM rounds WHERE id = ?", id);
  }

  latestRound(): RoundRow | undefined {
    return this.first<RoundRow>("SELECT * FROM rounds ORDER BY sequence DESC LIMIT 1");
  }

  readiness(roundId: string): ReadinessRow[] {
    return this.all<ReadinessRow>("SELECT * FROM readiness WHERE round_id = ?", roundId);
  }

  entryRow(id: string): EntryRow | undefined {
    return this.first<EntryRow>("SELECT * FROM entries WHERE id = ?", id);
  }

  /** Non-deleted entries of a round with their contributions/allocations/effects, newest first. */
  roundEntries(roundId: string): LoadedEntry[] {
    const rows = this.all<EntryRow>(
      "SELECT * FROM entries WHERE round_id = ? AND deleted = 0 ORDER BY occurred_at DESC, created_at DESC, id DESC",
      roundId,
    );
    const byEntry = <R extends { entry_id: string }>(table: string): Map<string, R[]> => {
      const map = new Map<string, R[]>();
      const children = this.all<R>(
        `SELECT t.* FROM ${table} t JOIN entries e ON e.id = t.entry_id WHERE e.round_id = ? AND e.deleted = 0 ORDER BY t.member_id`,
        roundId,
      );
      for (const child of children) {
        const list = map.get(child.entry_id);
        if (list) list.push(child);
        else map.set(child.entry_id, [child]);
      }
      return map;
    };
    const contributions = byEntry<SplitRow>("contributions");
    const allocations = byEntry<SplitRow>("allocations");
    const effects = byEntry<EffectRow>("adjustment_effects");
    return rows.map((row) => ({
      row,
      contributions: contributions.get(row.id) ?? [],
      allocations: allocations.get(row.id) ?? [],
      effects: effects.get(row.id) ?? [],
    }));
  }

  loadEntry(id: string): LoadedEntry | undefined {
    const row = this.entryRow(id);
    if (!row) return undefined;
    return {
      row,
      contributions: this.all<SplitRow>("SELECT * FROM contributions WHERE entry_id = ? ORDER BY member_id", id),
      allocations: this.all<SplitRow>("SELECT * FROM allocations WHERE entry_id = ? ORDER BY member_id", id),
      effects: this.all<EffectRow>("SELECT * FROM adjustment_effects WHERE entry_id = ? ORDER BY member_id", id),
    };
  }

  rates(): RateRow[] {
    return this.all<RateRow>("SELECT * FROM rate_defaults ORDER BY currency");
  }

  rate(currency: string): RateRow | undefined {
    return this.first<RateRow>("SELECT * FROM rate_defaults WHERE currency = ?", currency);
  }

  instructions(roundId: string): InstructionRow[] {
    return this.all<InstructionRow>("SELECT * FROM instructions WHERE round_id = ? ORDER BY position", roundId);
  }

  instruction(id: string): InstructionRow | undefined {
    return this.first<InstructionRow>("SELECT * FROM instructions WHERE id = ?", id);
  }

  snapshot(roundId: string): SnapshotRow | undefined {
    return this.first<SnapshotRow>("SELECT * FROM settlement_snapshots WHERE round_id = ?", roundId);
  }

  /** True when any live ledger entry or any settlement instruction references the member. */
  isReferenced(memberId: string): boolean {
    return (
      this.count(
        `SELECT COUNT(*) AS n FROM entries e WHERE e.deleted = 0 AND (
           e.creator_member_id = ?1 OR e.payer_member_id = ?1
           OR EXISTS (SELECT 1 FROM contributions c WHERE c.entry_id = e.id AND c.member_id = ?1)
           OR EXISTS (SELECT 1 FROM allocations a WHERE a.entry_id = e.id AND a.member_id = ?1)
           OR EXISTS (SELECT 1 FROM adjustment_effects x WHERE x.entry_id = e.id AND x.member_id = ?1))`,
        memberId,
      ) > 0 ||
      this.count("SELECT COUNT(*) AS n FROM instructions WHERE from_member_id = ?1 OR to_member_id = ?1", memberId) > 0
    );
  }

  /** Member IDs referenced anywhere (for MemberDTO.referenced without N queries). */
  referencedMemberIds(): Set<string> {
    // DO SQLite caps compound SELECT terms, so gather each source separately.
    const queries = [
      "SELECT DISTINCT creator_member_id AS id FROM entries WHERE deleted = 0",
      "SELECT DISTINCT payer_member_id AS id FROM entries WHERE deleted = 0 AND payer_member_id IS NOT NULL",
      "SELECT DISTINCT c.member_id AS id FROM contributions c JOIN entries e ON e.id = c.entry_id WHERE e.deleted = 0",
      "SELECT DISTINCT a.member_id AS id FROM allocations a JOIN entries e ON e.id = a.entry_id WHERE e.deleted = 0",
      "SELECT DISTINCT x.member_id AS id FROM adjustment_effects x JOIN entries e ON e.id = x.entry_id WHERE e.deleted = 0",
      "SELECT DISTINCT from_member_id AS id FROM instructions",
      "SELECT DISTINCT to_member_id AS id FROM instructions",
    ];
    const ids = new Set<string>();
    for (const q of queries) for (const r of this.all<{ id: string }>(q)) ids.add(r.id);
    return ids;
  }
}
