import type { ProjectSummaryDTO, ProjectViewDTO } from "@shared/api";
import type { OutboxMessage } from "../do/types";

type DirectoryUpsert = Extract<OutboxMessage, { type: "DIRECTORY_UPSERT" }>;

export interface DirectoryRow {
  principalId: string;
  projectId: string;
  memberId: string;
  isOwner: boolean;
  status: "ACTIVE" | "LEFT" | "REMOVED";
  name: string;
  baseCurrency: string;
  roundStatus: ProjectSummaryDTO["roundStatus"];
  roundSequence: number | null;
  nextAction: string | null;
  projectVersion: number;
}

/**
 * Version-guarded upsert. `minVersionOp` is ">" for synchronous writes from the request path
 * (never overwrite a projection of the same version, which carries nextAction) and ">=" for
 * queue projections (same version = same state, so re-applying is idempotent). Older versions
 * never overwrite newer ones, so out-of-order delivery cannot regress a row.
 */
export function upsertStatement(db: D1Database, row: DirectoryRow, minVersionOp: ">" | ">="): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO project_directory
         (principal_id, project_id, member_id, is_owner, status, name, base_currency, round_status, round_sequence, next_action, project_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (principal_id, project_id) DO UPDATE SET
         member_id = excluded.member_id, is_owner = excluded.is_owner, status = excluded.status, name = excluded.name,
         base_currency = excluded.base_currency, round_status = excluded.round_status, round_sequence = excluded.round_sequence,
         next_action = excluded.next_action, project_version = excluded.project_version, updated_at = excluded.updated_at
       WHERE excluded.project_version ${minVersionOp} project_directory.project_version`,
    )
    .bind(
      row.principalId,
      row.projectId,
      row.memberId,
      row.isOwner ? 1 : 0,
      row.status,
      row.name,
      row.baseCurrency,
      row.roundStatus,
      row.roundSequence,
      row.nextAction,
      row.projectVersion,
      new Date().toISOString(),
    );
}

export function rowsFromOutbox(msg: DirectoryUpsert): DirectoryRow[] {
  const p = msg.payload;
  return p.members.map((m) => ({
    principalId: m.principalId,
    projectId: msg.projectId,
    memberId: m.memberId,
    isOwner: m.isOwner,
    status: m.status,
    name: p.name,
    baseCurrency: p.baseCurrency,
    roundStatus: p.roundStatus,
    roundSequence: p.roundSequence,
    nextAction: m.nextAction,
    projectVersion: msg.projectVersion,
  }));
}

/** Builds the caller's own row from a ProjectViewDTO (create/join responses). Null if the shape is off. */
export function rowFromProjectView(principalId: string, view: unknown): DirectoryRow | null {
  const v = view as Partial<ProjectViewDTO> | null;
  const project = v?.project;
  const me = v?.me;
  if (!project || !me || typeof project.id !== "string" || typeof me.memberId !== "string") return null;
  if (typeof project.version !== "number") return null;
  const round = v.current?.round;
  return {
    principalId,
    projectId: project.id,
    memberId: me.memberId,
    isOwner: me.isOwner === true,
    status: "ACTIVE",
    name: project.name,
    baseCurrency: project.baseCurrency,
    roundStatus: round?.status ?? null,
    roundSequence: round?.sequence ?? null,
    nextAction: null,
    projectVersion: project.version,
  };
}

interface DirectoryDbRow {
  project_id: string;
  name: string;
  base_currency: string;
  round_status: ProjectSummaryDTO["roundStatus"];
  round_sequence: number | null;
  is_owner: number;
  next_action: ProjectSummaryDTO["nextAction"];
  updated_at: string;
}

export async function listProjects(db: D1Database, principalId: string): Promise<ProjectSummaryDTO[]> {
  const { results } = await db
    .prepare(
      `SELECT project_id, name, base_currency, round_status, round_sequence, is_owner, next_action, updated_at
       FROM project_directory WHERE principal_id = ? AND status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 500`,
    )
    .bind(principalId)
    .all<DirectoryDbRow>();
  return results.map((r) => ({
    id: r.project_id,
    name: r.name,
    baseCurrency: r.base_currency,
    roundStatus: r.round_status,
    roundSequence: r.round_sequence,
    isOwner: r.is_owner === 1,
    nextAction: r.next_action,
    updatedAt: r.updated_at,
  }));
}

export async function projectIdsForPrincipal(db: D1Database, principalId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT project_id FROM project_directory WHERE principal_id = ?")
    .bind(principalId)
    .all<{ project_id: string }>();
  return results.map((r) => r.project_id);
}
