import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { AGENTOPS_SCHEMA_VERSION, applyAgentOpsMigrations } from "./migrations.js";
import { defaultAgentOpsPaths } from "./paths.js";
import { redactAgentOpsSecrets } from "./redaction.js";
import {
  entityStatusValue,
  numberValue,
  optionalNumber,
  optionalString,
  requiredString,
  sqlRows,
  type SqlRow,
} from "./sql-row.js";
import type { AgentOpsEntityStatus } from "./types.js";

export interface ReadAgentOpsHomeOptions {
  readonly home?: string;
  readonly dbPath?: string;
  readonly now?: Date | string;
}

export interface AgentOpsArtifactLink {
  readonly title: string;
  readonly pathOrUrl: string;
}

export interface AgentOpsRunCard {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly title: string;
  readonly status: AgentOpsEntityStatus;
  readonly workerKind: string;
  readonly command: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  readonly nextAction?: string;
  readonly artifactLinks: readonly AgentOpsArtifactLink[];
}

export interface AgentOpsProjectSummary {
  readonly projectId: string;
  readonly projectName: string;
  readonly needsAttentionCount: number;
  readonly activeRunCount: number;
  readonly completedTodayCount: number;
  readonly totalRunCount: number;
}

export interface AgentOpsHomeSummary {
  readonly schemaVersion: number;
  readonly generatedFor: string;
  readonly needsAttention: readonly AgentOpsRunCard[];
  readonly activeRuns: readonly AgentOpsRunCard[];
  readonly completedToday: readonly AgentOpsRunCard[];
  readonly projectSummaries: readonly AgentOpsProjectSummary[];
}

export function readAgentOpsHome(options: ReadAgentOpsHomeOptions = {}): AgentOpsHomeSummary {
  const basePaths = options.home === undefined ? defaultAgentOpsPaths() : defaultAgentOpsPaths(options.home);
  const dbPath = options.dbPath ?? basePaths.dbPath;
  mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(basePaths.artifactsDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    applyAgentOpsMigrations(db);
    const now = parseNow(options.now);
    const { start, end } = todayBounds(now);
    return {
      schemaVersion: AGENTOPS_SCHEMA_VERSION,
      generatedFor: isoDate(now),
      needsAttention: readRunCards(db, attentionRunsSql, []),
      activeRuns: readRunCards(db, activeRunsSql, []),
      completedToday: readRunCards(db, completedTodaySql, [start, end]),
      projectSummaries: readProjectSummaries(db, start, end),
    };
  } finally {
    db.close();
  }
}

const runCardColumnsSql = `
  SELECT
    r.id, r.project_id, p.name AS project_name, COALESCE(t.title, r.summary, r.command) AS title,
    r.status, r.worker_kind, r.command, r.started_at, r.finished_at, r.exit_code, r.next_action
  FROM runs r
  JOIN projects p ON p.id = r.project_id
  LEFT JOIN tasks t ON t.id = r.task_id
`;

const attentionRunsSql = `${runCardColumnsSql}
  WHERE r.status IN ('failed', 'blocked')
  ORDER BY
    CASE r.status WHEN 'failed' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END,
    COALESCE(r.finished_at, r.started_at) DESC,
    r.id
  LIMIT 20`;

const activeRunsSql = `${runCardColumnsSql}
  WHERE r.status IN ('queued', 'active', 'running')
  ORDER BY r.started_at DESC, r.id
  LIMIT 20`;

const completedTodaySql = `${runCardColumnsSql}
  WHERE r.status = 'completed' AND r.finished_at >= ? AND r.finished_at < ?
  ORDER BY r.finished_at DESC, r.id
  LIMIT 20`;

function readRunCards(db: DatabaseSync, sql: string, parameters: readonly string[]): readonly AgentOpsRunCard[] {
  return sqlRows(db.prepare(sql).all(...parameters), "run cards").map((row) =>
    runCardFromRow(row, readArtifactLinks(db, requiredString(row, "id"))),
  );
}

function readArtifactLinks(db: DatabaseSync, runId: string): readonly AgentOpsArtifactLink[] {
  return sqlRows(
    db.prepare("SELECT title, path_or_url FROM artifacts WHERE run_id = ? ORDER BY created_at, id").all(runId),
    "artifact links",
  ).map((row) => ({
    title: redactAgentOpsSecrets(requiredString(row, "title")),
    pathOrUrl: redactAgentOpsSecrets(requiredString(row, "path_or_url")),
  }));
}

function readProjectSummaries(db: DatabaseSync, start: string, end: string): readonly AgentOpsProjectSummary[] {
  return sqlRows(
    db
      .prepare(
        `SELECT
          p.id AS project_id, p.name AS project_name, COUNT(r.id) AS total_run_count,
          SUM(CASE WHEN r.status IN ('failed', 'blocked') THEN 1 ELSE 0 END) AS needs_attention_count,
          SUM(CASE WHEN r.status IN ('queued', 'active', 'running') THEN 1 ELSE 0 END) AS active_run_count,
          SUM(
            CASE
              WHEN r.status = 'completed' AND r.finished_at >= ? AND r.finished_at < ?
              THEN 1 ELSE 0
            END
          ) AS completed_today_count
        FROM projects p
        LEFT JOIN runs r ON r.project_id = p.id
        GROUP BY p.id, p.name
        ORDER BY lower(p.name), p.id`,
      )
      .all(start, end),
    "project summaries",
  ).map((row) => ({
    projectId: requiredString(row, "project_id"),
    projectName: requiredString(row, "project_name"),
    needsAttentionCount: numberValue(row, "needs_attention_count"),
    activeRunCount: numberValue(row, "active_run_count"),
    completedTodayCount: numberValue(row, "completed_today_count"),
    totalRunCount: numberValue(row, "total_run_count"),
  }));
}

function runCardFromRow(row: SqlRow, artifactLinks: readonly AgentOpsArtifactLink[]): AgentOpsRunCard {
  const finishedAt = optionalString(row, "finished_at");
  const exitCode = optionalNumber(row, "exit_code");
  const nextAction = optionalString(row, "next_action");
  return {
    id: requiredString(row, "id"),
    projectId: requiredString(row, "project_id"),
    projectName: requiredString(row, "project_name"),
    title: redactAgentOpsSecrets(requiredString(row, "title")),
    status: entityStatusValue(row, "status"),
    workerKind: requiredString(row, "worker_kind"),
    command: redactAgentOpsSecrets(requiredString(row, "command")),
    startedAt: requiredString(row, "started_at"),
    artifactLinks,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(nextAction === undefined ? {} : { nextAction: redactAgentOpsSecrets(nextAction) }),
  };
}

function parseNow(now: Date | string | undefined): Date {
  const date = now instanceof Date ? now : new Date(now ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid AgentOps report date: ${String(now)}`);
  return date;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function todayBounds(date: Date): { readonly start: string; readonly end: string } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
  return { start: start.toISOString(), end: end.toISOString() };
}
