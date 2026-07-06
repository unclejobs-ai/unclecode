import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { CONTEXT_SOURCE_DEFAULT_SALIENCE, type UpsertContextSourceInput } from "@unclecode/contracts";

import { redactAgentOpsSecrets } from "./redaction.js";
import { sqlRow } from "./sql-row.js";
import {
  contextSourceRowToRecord,
  mapContextSourceRow,
  mapEventRow,
  mapTaskRow,
  mapVerificationRow,
} from "./store-mappers.js";
import type {
  AddAgentOpsEventInput,
  AddAgentOpsTaskInput,
  AddAgentOpsVerificationInput,
} from "./store-types.js";
import type {
  AgentOpsContextSourceRow,
  AgentOpsEventRecord,
  AgentOpsTaskRecord,
  AgentOpsVerificationRecord,
} from "./types.js";

export function addAgentOpsTask(
  db: DatabaseSync,
  input: AddAgentOpsTaskInput,
): AgentOpsTaskRecord {
  if (!projectExists(db, input.projectId)) throw new Error(`Unknown project: ${input.projectId}`);
  const timestamp = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (
       id, project_id, title, description, source_type, source_url, status, priority, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id,
       title = excluded.title,
       description = excluded.description,
       source_type = excluded.source_type,
       source_url = excluded.source_url,
       status = excluded.status,
       priority = excluded.priority,
       updated_at = excluded.updated_at`,
  ).run(
    input.id,
    input.projectId,
    redactAgentOpsSecrets(input.title),
    redactedOrNull(input.description),
    redactedOrNull(input.sourceType),
    redactedOrNull(input.sourceUrl),
    input.status ?? "active",
    input.priority ?? null,
    timestamp,
    timestamp,
  );
  return getTaskOrThrow(db, input.id);
}

export function addAgentOpsEvent(db: DatabaseSync, input: AddAgentOpsEventInput): AgentOpsEventRecord {
  const id = input.id ?? `event_${randomUUID()}`;
  db.prepare(
    `INSERT INTO events (id, project_id, task_id, run_id, lane_id, event_type, message, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId ?? null,
    input.taskId ?? null,
    input.runId ?? null,
    input.laneId ?? null,
    redactAgentOpsSecrets(input.eventType),
    redactAgentOpsSecrets(input.message),
    redactedOrNull(input.metadataJson),
    new Date().toISOString(),
  );
  return getEventOrThrow(db, id);
}

export function addAgentOpsVerification(
  db: DatabaseSync,
  input: AddAgentOpsVerificationInput,
): AgentOpsVerificationRecord {
  const id = input.id ?? `verification_${randomUUID()}`;
  db.prepare(
    `INSERT INTO verifications (id, run_id, command, kind, status, output_path, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       run_id = excluded.run_id,
       command = excluded.command,
       kind = excluded.kind,
       status = excluded.status,
       output_path = excluded.output_path,
       started_at = excluded.started_at,
       finished_at = excluded.finished_at`,
  ).run(
    id,
    input.runId,
    redactAgentOpsSecrets(input.command),
    input.kind,
    input.status,
    redactedOrNull(input.outputPath),
    input.startedAt ?? null,
    input.finishedAt ?? null,
  );
  return getVerificationOrThrow(db, id);
}

function projectExists(db: DatabaseSync, projectId: string): boolean {
  return db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId) !== undefined;
}

function getTaskOrThrow(db: DatabaseSync, id: string): AgentOpsTaskRecord {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  if (row === undefined) throw new Error(`Task not found: ${id}`);
  return mapTaskRow(sqlRow(row, `task ${id}`));
}

function getEventOrThrow(db: DatabaseSync, id: string): AgentOpsEventRecord {
  const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
  if (row === undefined) throw new Error(`Event not found: ${id}`);
  return mapEventRow(sqlRow(row, `event ${id}`));
}

function getVerificationOrThrow(db: DatabaseSync, id: string): AgentOpsVerificationRecord {
  const row = db.prepare("SELECT * FROM verifications WHERE id = ?").get(id);
  if (row === undefined) throw new Error(`Verification not found: ${id}`);
  return mapVerificationRow(sqlRow(row, `verification ${id}`));
}

function redactedOrNull(value: string | undefined): string | null {
  return value === undefined ? null : redactAgentOpsSecrets(value);
}

// ── Context Runbook Protocol (CRP) store functions ───────────────────
// See docs/design/crp-context-runbook-protocol.md.

export function upsertContextSource(
  db: DatabaseSync,
  input: UpsertContextSourceInput,
): AgentOpsContextSourceRow {
  if (!projectExists(db, input.projectId)) {
    throw new Error(`Unknown project: ${input.projectId}`);
  }
  const timestamp = new Date().toISOString();
  const salience = input.salience ?? CONTEXT_SOURCE_DEFAULT_SALIENCE;
  const tokenEstimate = input.tokenEstimate ?? 0;
  const includedInModel = input.includedInModel === false ? 0 : 1;
  const content = input.content === undefined ? null : input.content;
  const sha256 = input.sha256 === undefined ? null : input.sha256;
  const expiresAt = input.expiresAt === undefined ? null : input.expiresAt;

  db.prepare(
    `INSERT INTO context_sources (
       id, project_id, category, label, content, reason, sha256,
       salience, token_estimate, included_in_model, turn_last_seen,
       created_at, updated_at, expires_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id,
       category = excluded.category,
       label = excluded.label,
       content = excluded.content,
       reason = excluded.reason,
       sha256 = excluded.sha256,
       salience = excluded.salience,
       token_estimate = excluded.token_estimate,
       included_in_model = excluded.included_in_model,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
  ).run(
    input.id,
    input.projectId,
    input.category,
    input.label,
    content,
    input.reason,
    sha256,
    salience,
    tokenEstimate,
    includedInModel,
    timestamp,
    timestamp,
    expiresAt,
  );
  return getContextSourceOrThrow(db, input.id);
}

export function markContextSourceTurnSeen(
  db: DatabaseSync,
  ids: readonly string[],
  turnIndex: number,
): void {
  if (ids.length === 0) return;
  const stmt = db.prepare(
    "UPDATE context_sources SET turn_last_seen = ?, updated_at = ? WHERE id = ?",
  );
  const timestamp = new Date().toISOString();
  for (const id of ids) {
    stmt.run(turnIndex, timestamp, id);
  }
}

export function pruneExpiredContextSources(db: DatabaseSync, now = new Date()): number {
  const nowIso = now.toISOString();
  const result = db.prepare(
    "DELETE FROM context_sources WHERE expires_at IS NOT NULL AND expires_at <= ?",
  ).run(nowIso);
  return typeof result.changes === "number" ? result.changes : 0;
}

// Pin a source — set salience to maximum so the selector always includes it.
export function pinContextSource(db: DatabaseSync, id: string): void {
  db.prepare(
    "UPDATE context_sources SET salience = 1.0, updated_at = ? WHERE id = ?",
  ).run(new Date().toISOString(), id);
}

// Unpin — restore a reasonable default salience (provider can re-rank later).
export function unpinContextSource(db: DatabaseSync, id: string): void {
  db.prepare(
    "UPDATE context_sources SET salience = 0.5, updated_at = ? WHERE id = ?",
  ).run(new Date().toISOString(), id);
}

// Forget — hold a source back locally (included_in_model = 0).
export function forgetContextSource(db: DatabaseSync, id: string): void {
  db.prepare(
    "UPDATE context_sources SET included_in_model = 0, updated_at = ? WHERE id = ?",
  ).run(new Date().toISOString(), id);
}

// Include — restore a held-back source to model inclusion.
export function includeContextSource(db: DatabaseSync, id: string): void {
  db.prepare(
    "UPDATE context_sources SET included_in_model = 1, updated_at = ? WHERE id = ?",
  ).run(new Date().toISOString(), id);
}

function getContextSourceOrThrow(db: DatabaseSync, id: string): AgentOpsContextSourceRow {
  const row = db.prepare("SELECT * FROM context_sources WHERE id = ?").get(id);
  if (row === undefined) throw new Error(`Context source not found: ${id}`);
  return mapContextSourceRow(sqlRow(row, `context source ${id}`));
}

// Re-export the mapper so callers don't need a separate import path.
export { contextSourceRowToRecord };
