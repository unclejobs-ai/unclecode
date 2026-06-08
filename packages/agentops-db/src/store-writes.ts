import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { redactAgentOpsSecrets } from "./redaction.js";
import { sqlRow } from "./sql-row.js";
import { mapEventRow, mapTaskRow, mapVerificationRow } from "./store-mappers.js";
import type {
  AddAgentOpsEventInput,
  AddAgentOpsTaskInput,
  AddAgentOpsVerificationInput,
} from "./store-types.js";
import type { AgentOpsEventRecord, AgentOpsTaskRecord, AgentOpsVerificationRecord } from "./types.js";

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
