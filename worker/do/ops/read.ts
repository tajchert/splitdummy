/** Read-only ops. Membership is still checked; nothing is written. */
import type { HistoryDTO } from "@shared/api";
import { buildCsv } from "../csv";
import { forbidden, notCollecting, notFound } from "../errors";
import { SCHEMA_VERSION } from "../schema";
import type { AuditRow, RoundRow } from "../store";
import type { Tx } from "../tx";
import type { DoRequest, DoResponse } from "../types";
import { auditDto, projectView, reviewView, roundDto, roundView } from "../views";
import { ok } from "./project";

const HISTORY_EVENT_LIMIT = 5000;

function roundParam(tx: Tx, req: DoRequest): RoundRow {
  const round = tx.store.round(req.params.roundId ?? "");
  if (!round) throw notFound("This round isn't available.");
  return round;
}

export function getProject(tx: Tx): DoResponse {
  return ok(projectView(tx.store, tx.member()));
}

export function getRound(tx: Tx, req: DoRequest): DoResponse {
  tx.member();
  return ok(roundView(tx.store, roundParam(tx, req)));
}

export function getReview(tx: Tx, req: DoRequest): DoResponse {
  tx.member();
  const round = roundParam(tx, req);
  if (round.status !== "COLLECTING") throw notCollecting();
  return ok(reviewView(tx.store, round));
}

export function getHistory(tx: Tx): DoResponse {
  tx.member();
  const events = tx.store.all<AuditRow>("SELECT * FROM audit_events ORDER BY seq DESC LIMIT ?", HISTORY_EVENT_LIMIT);
  const body: HistoryDTO = { rounds: tx.store.rounds().map(roundDto), events: events.map(auditDto) };
  return ok(body);
}

export function exportCsv(tx: Tx): DoResponse {
  tx.member();
  const project = tx.project;
  const views = tx.store.rounds().map((r) => roundView(tx.store, r));
  const names = new Map(tx.store.members().map((m) => [m.id, m.display_name]));
  const safeName = project.name.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().replace(/\s+/g, "-") || "splitdummy";
  return {
    status: 200,
    body: buildCsv(views, names),
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${encodeURIComponent(safeName)}.csv"`,
      "cache-control": "private, no-store",
    },
  };
}

const BACKUP_TABLES = [
  "project",
  "members",
  "rounds",
  "readiness",
  "entries",
  "contributions",
  "allocations",
  "adjustment_effects",
  "rate_defaults",
  "invitations",
  "settlement_snapshots",
  "instructions",
  "confirmed_transfers",
  "audit_events",
  "outbox",
] as const;

/** Internal (edge cron) full dump for R2. Idempotency responses are omitted: they are derivable and large. */
export function backupSnapshot(tx: Tx): DoResponse {
  if (tx.principal) throw forbidden("Backups are internal.");
  const project = tx.store.project();
  if (!project) throw notFound();
  const tables: Record<string, unknown[]> = {};
  for (const t of BACKUP_TABLES) tables[t] = tx.store.all(`SELECT * FROM ${t}`);
  return {
    status: 200,
    body: {
      format: "splitdummy-project-backup",
      schemaVersion: SCHEMA_VERSION,
      projectId: project.id,
      projectVersion: project.version,
      exportedAt: tx.now,
      tables,
    },
  };
}
