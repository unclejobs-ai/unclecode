import {
  type ContextSourceCategory,
  type ContextSourceRecord,
} from "@unclecode/contracts";

import {
  entityStatusValue,
  numberValue,
  optionalNumber,
  optionalString,
  requiredString,
  type SqlRow,
} from "./sql-row.js";
import type {
  AgentOpsArtifactRecord,
  AgentOpsArtifactType,
  AgentOpsContextSourceRow,
  AgentOpsEventRecord,
  AgentOpsLaneRecord,
  AgentOpsProjectRecord,
  AgentOpsRunRecord,
  AgentOpsTaskRecord,
  AgentOpsVerificationKind,
  AgentOpsVerificationRecord,
  AgentOpsVerificationStatus,
} from "./types.js";

const ARTIFACT_TYPE_VALUES = [
  "output",
  "diff",
  "report",
  "screenshot",
  "pr",
  "commit",
  "worktree",
  "transcript",
] as const satisfies readonly AgentOpsArtifactType[];

const ARTIFACT_TYPE_SET: ReadonlySet<string> = new Set(ARTIFACT_TYPE_VALUES);

const VERIFICATION_KIND_VALUES = [
  "lint",
  "typecheck",
  "test",
  "build",
  "e2e",
  "custom",
] as const satisfies readonly AgentOpsVerificationKind[];
const VERIFICATION_KIND_SET: ReadonlySet<string> = new Set(VERIFICATION_KIND_VALUES);

const VERIFICATION_STATUS_VALUES = [
  "passed",
  "failed",
  "skipped",
  "unknown",
] as const satisfies readonly AgentOpsVerificationStatus[];
const VERIFICATION_STATUS_SET: ReadonlySet<string> = new Set(VERIFICATION_STATUS_VALUES);

export function mapProjectRow(row: SqlRow): AgentOpsProjectRecord {
  const configPath = optionalString(row, "config_path");
  return {
    id: requiredString(row, "id"),
    name: requiredString(row, "name"),
    repoPath: requiredString(row, "repo_path"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    ...(configPath === undefined ? {} : { configPath }),
  };
}

export function mapTaskRow(row: SqlRow): AgentOpsTaskRecord {
  const description = optionalString(row, "description");
  const sourceType = optionalString(row, "source_type");
  const sourceUrl = optionalString(row, "source_url");
  const priority = optionalNumber(row, "priority");
  return {
    id: requiredString(row, "id"),
    projectId: requiredString(row, "project_id"),
    title: requiredString(row, "title"),
    status: entityStatusValue(row, "status"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    ...(description === undefined ? {} : { description }),
    ...(sourceType === undefined ? {} : { sourceType }),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    ...(priority === undefined ? {} : { priority }),
  };
}

export function mapRunRow(row: SqlRow): AgentOpsRunRecord {
  const taskId = optionalString(row, "task_id");
  const cwd = optionalString(row, "cwd");
  const worktreePath = optionalString(row, "worktree_path");
  const exitCode = optionalNumber(row, "exit_code");
  const finishedAt = optionalString(row, "finished_at");
  const summary = optionalString(row, "summary");
  const nextAction = optionalString(row, "next_action");
  return {
    id: requiredString(row, "id"),
    projectId: requiredString(row, "project_id"),
    runKey: requiredString(row, "run_key"),
    workerKind: requiredString(row, "worker_kind"),
    command: requiredString(row, "command"),
    status: entityStatusValue(row, "status"),
    startedAt: requiredString(row, "started_at"),
    ...(taskId === undefined ? {} : { taskId }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(worktreePath === undefined ? {} : { worktreePath }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(summary === undefined ? {} : { summary }),
    ...(nextAction === undefined ? {} : { nextAction }),
  };
}

export function mapLaneRow(row: SqlRow): AgentOpsLaneRecord {
  const model = optionalString(row, "model");
  const outputPath = optionalString(row, "output_path");
  const exitCode = optionalNumber(row, "exit_code");
  const startedAt = optionalString(row, "started_at");
  const finishedAt = optionalString(row, "finished_at");
  const summary = optionalString(row, "summary");
  return {
    id: requiredString(row, "id"),
    runId: requiredString(row, "run_id"),
    name: requiredString(row, "name"),
    workerKind: requiredString(row, "worker_kind"),
    status: entityStatusValue(row, "status"),
    ...(model === undefined ? {} : { model }),
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(summary === undefined ? {} : { summary }),
  };
}

export function mapArtifactRow(row: SqlRow): AgentOpsArtifactRecord {
  const taskId = optionalString(row, "task_id");
  const runId = optionalString(row, "run_id");
  const laneId = optionalString(row, "lane_id");
  const sha256 = optionalString(row, "sha256");
  return {
    id: requiredString(row, "id"),
    projectId: requiredString(row, "project_id"),
    artifactType: artifactTypeValue(row),
    title: requiredString(row, "title"),
    pathOrUrl: requiredString(row, "path_or_url"),
    createdAt: requiredString(row, "created_at"),
    ...(taskId === undefined ? {} : { taskId }),
    ...(runId === undefined ? {} : { runId }),
    ...(laneId === undefined ? {} : { laneId }),
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

export function mapEventRow(row: SqlRow): AgentOpsEventRecord {
  const projectId = optionalString(row, "project_id");
  const taskId = optionalString(row, "task_id");
  const runId = optionalString(row, "run_id");
  const laneId = optionalString(row, "lane_id");
  const metadataJson = optionalString(row, "metadata_json");
  return {
    id: requiredString(row, "id"),
    eventType: requiredString(row, "event_type"),
    message: requiredString(row, "message"),
    createdAt: requiredString(row, "created_at"),
    ...(projectId === undefined ? {} : { projectId }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(runId === undefined ? {} : { runId }),
    ...(laneId === undefined ? {} : { laneId }),
    ...(metadataJson === undefined ? {} : { metadataJson }),
  };
}

export function mapVerificationRow(row: SqlRow): AgentOpsVerificationRecord {
  const outputPath = optionalString(row, "output_path");
  const startedAt = optionalString(row, "started_at");
  const finishedAt = optionalString(row, "finished_at");
  return {
    id: requiredString(row, "id"),
    runId: requiredString(row, "run_id"),
    command: requiredString(row, "command"),
    kind: verificationKindValue(row),
    status: verificationStatusValue(row),
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  };
}

function artifactTypeValue(row: SqlRow): AgentOpsArtifactType {
  const value = requiredString(row, "artifact_type");
  if (!isArtifactType(value)) {
    throw new TypeError(`Unknown artifact type: ${value}`);
  }
  return value;
}

function isArtifactType(value: string): value is AgentOpsArtifactType {
  return ARTIFACT_TYPE_SET.has(value);
}

function verificationKindValue(row: SqlRow): AgentOpsVerificationKind {
  const value = requiredString(row, "kind");
  if (!isVerificationKind(value)) {
    throw new TypeError(`Unknown verification kind: ${value}`);
  }
  return value;
}

function verificationStatusValue(row: SqlRow): AgentOpsVerificationStatus {
  const value = requiredString(row, "status");
  if (!isVerificationStatus(value)) {
    throw new TypeError(`Unknown verification status: ${value}`);
  }
  return value;
}

function isVerificationKind(value: string): value is AgentOpsVerificationKind {
  return VERIFICATION_KIND_SET.has(value);
}

function isVerificationStatus(value: string): value is AgentOpsVerificationStatus {
  return VERIFICATION_STATUS_SET.has(value);
}

const CONTEXT_SOURCE_CATEGORY_VALUES = [
  "workspace",
  "workspace-guidance",
  "bridge",
  "loop-trail",
  "condensed-history",
  "memory",
  "runtime",
  "attachment",
  "system",
] as const satisfies readonly ContextSourceCategory[];

const CONTEXT_SOURCE_CATEGORY_SET: ReadonlySet<string> = new Set(CONTEXT_SOURCE_CATEGORY_VALUES);

// Raw DB row — column names match the SQLite schema (snake_case).
export function mapContextSourceRow(row: SqlRow): AgentOpsContextSourceRow {
  const content = optionalString(row, "content");
  const sha256 = optionalString(row, "sha256");
  const turnLastSeen = optionalNumber(row, "turn_last_seen");
  const expiresAt = optionalString(row, "expires_at");
  const badgesJson = optionalString(row, "badges_json");
  const metadataJson = optionalString(row, "metadata_json");
  return {
    id: requiredString(row, "id"),
    projectId: requiredString(row, "project_id"),
    category: requiredString(row, "category"),
    label: requiredString(row, "label"),
    reason: requiredString(row, "reason"),
    salience: numberValue(row, "salience"),
    tokenEstimate: numberValue(row, "token_estimate"),
    includedInModel: numberValue(row, "included_in_model"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    content: content === undefined ? null : content,
    sha256: sha256 === undefined ? null : sha256,
    turnLastSeen: turnLastSeen === undefined ? null : turnLastSeen,
    expiresAt: expiresAt === undefined ? null : expiresAt,
    badgesJson: badgesJson === undefined ? null : badgesJson,
    metadataJson: metadataJson === undefined ? null : metadataJson,
  };
}

// DB row → contracts record (camelCase, typed category).
export function contextSourceRowToRecord(row: AgentOpsContextSourceRow): ContextSourceRecord {
  const category = contextSourceCategoryValue(row.category);
  return {
    id: row.id,
    projectId: row.projectId,
    category,
    label: row.label,
    content: row.content,
    reason: row.reason,
    sha256: row.sha256,
    salience: row.salience,
    tokenEstimate: row.tokenEstimate,
    includedInModel: row.includedInModel !== 0,
    turnLastSeen: row.turnLastSeen,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}

function contextSourceCategoryValue(value: string): ContextSourceCategory {
  if (!CONTEXT_SOURCE_CATEGORY_SET.has(value)) {
    throw new TypeError(`Unknown context source category: ${value}`);
  }
  return value as ContextSourceCategory;
}
