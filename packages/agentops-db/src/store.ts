import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { applyAgentOpsMigrations } from "./migrations.js";
import { defaultAgentOpsPaths, type AgentOpsPaths } from "./paths.js";
import { redactAgentOpsSecrets } from "./redaction.js";
import { sqlRow, sqlRows } from "./sql-row.js";
import { createAgentOpsContextStoreMethods } from "./store-context-methods.js";
import { createAgentOpsContextReceiptStoreMethods } from "./store-context-receipts.js";
import { createAgentOpsContextSuggestionStoreMethods } from "./store-context-suggestions.js";
import { mapArtifactRow, mapLaneRow, mapProjectRow, mapRunRow } from "./store-mappers.js";
import type {
  AddAgentOpsArtifactInput,
  AddAgentOpsEventInput,
  AddAgentOpsLaneInput,
  AddAgentOpsProjectInput,
  AddAgentOpsTaskInput,
  AddAgentOpsVerificationInput,
  AgentOpsStore,
  CreateAgentOpsStoreOptions,
  FinishAgentOpsRunInput,
  RecordAgentOpsRunInput,
  StartAgentOpsRunInput,
} from "./store-types.js";
import { addAgentOpsEvent, addAgentOpsTask, addAgentOpsVerification } from "./store-writes.js";
import type {
  AgentOpsArtifactRecord,
  AgentOpsEventRecord,
  AgentOpsLaneRecord,
  AgentOpsProjectRecord,
  AgentOpsRunRecord,
  AgentOpsTaskRecord,
  AgentOpsVerificationRecord,
} from "./types.js";

export type {
  AddAgentOpsArtifactInput,
  AddAgentOpsEventInput,
  AddAgentOpsLaneInput,
  AddAgentOpsProjectInput,
  AddAgentOpsTaskInput,
  AddAgentOpsVerificationInput,
  AgentOpsStore,
  CreateAgentOpsStoreOptions,
  FinishAgentOpsRunInput,
  RecordAgentOpsRunInput,
  SelectedContextSources,
  StartAgentOpsRunInput,
} from "./store-types.js";

export function createAgentOpsStore(options: CreateAgentOpsStoreOptions = {}): AgentOpsStore {
  const basePaths = options.home === undefined ? defaultAgentOpsPaths() : defaultAgentOpsPaths(options.home);
  const paths = { ...basePaths, dbPath: options.dbPath ?? basePaths.dbPath };
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(dirname(paths.dbPath), { recursive: true });
  mkdirSync(paths.artifactsDir, { recursive: true });
  const db = new DatabaseSync(paths.dbPath);
  applyAgentOpsMigrations(db);
  return Object.assign(
    new SqliteAgentOpsStore(db, paths),
    createAgentOpsContextStoreMethods(db),
    createAgentOpsContextReceiptStoreMethods(db),
    createAgentOpsContextSuggestionStoreMethods(db),
  );
}

class SqliteAgentOpsStore {
  constructor(
    private readonly db: DatabaseSync,
    readonly paths: AgentOpsPaths,
  ) {}

  addProject(input: AddAgentOpsProjectInput): AgentOpsProjectRecord {
    const timestamp = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, repo_path, config_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           repo_path = excluded.repo_path,
           config_path = excluded.config_path,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        redactAgentOpsSecrets(input.name),
        redactAgentOpsSecrets(input.repoPath),
        redactedOrNull(input.configPath),
        timestamp,
        timestamp,
      );
    const project = this.getProject(input.id);
    if (project === undefined) throw new Error(`Project not found after upsert: ${input.id}`);
    return project;
  }

  addTask(input: AddAgentOpsTaskInput): AgentOpsTaskRecord {
    return addAgentOpsTask(this.db, input);
  }

  getProject(id: string): AgentOpsProjectRecord | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row === undefined ? undefined : mapProjectRow(sqlRow(row, `project ${id}`));
  }

  listProjects(): readonly AgentOpsProjectRecord[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY lower(name), id").all();
    return sqlRows(rows, "projects").map(mapProjectRow);
  }

  startRun(input: StartAgentOpsRunInput): AgentOpsRunRecord {
    if (this.getProject(input.projectId) === undefined) throw new Error(`Unknown project: ${input.projectId}`);
    const timestamp = new Date().toISOString();
    return this.recordRun({
      ...input,
      id: `run_${randomUUID()}`,
      runKey: input.runKey ?? timestamp,
      status: "running",
      startedAt: timestamp,
    });
  }

  recordRun(input: RecordAgentOpsRunInput): AgentOpsRunRecord {
    if (this.getProject(input.projectId) === undefined) throw new Error(`Unknown project: ${input.projectId}`);
    const timestamp = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO runs (
          id, task_id, project_id, run_key, worker_kind, command, cwd, worktree_path,
          status, exit_code, started_at, finished_at, summary, next_action
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          task_id = excluded.task_id, project_id = excluded.project_id, run_key = excluded.run_key,
          worker_kind = excluded.worker_kind, command = excluded.command, cwd = excluded.cwd,
          worktree_path = excluded.worktree_path, status = excluded.status, exit_code = excluded.exit_code,
          started_at = excluded.started_at, finished_at = excluded.finished_at, summary = excluded.summary,
          next_action = excluded.next_action`,
      )
      .run(
        input.id,
        input.taskId ?? null,
        input.projectId,
        input.runKey ?? input.id,
        redactAgentOpsSecrets(input.workerKind),
        redactAgentOpsSecrets(input.command),
        redactedOrNull(input.cwd),
        redactedOrNull(input.worktreePath),
        input.status,
        input.exitCode ?? null,
        input.startedAt ?? timestamp,
        input.finishedAt ?? null,
        redactedOrNull(input.summary),
        redactedOrNull(input.nextAction),
      );
    return this.getRunOrThrow(input.id);
  }

  finishRun(input: FinishAgentOpsRunInput): AgentOpsRunRecord {
    this.db
      .prepare("UPDATE runs SET status = ?, exit_code = ?, finished_at = ?, summary = ?, next_action = ? WHERE id = ?")
      .run(
        input.status,
        input.exitCode,
        new Date().toISOString(),
        redactedOrNull(input.summary),
        redactedOrNull(input.nextAction),
        input.id,
      );
    return this.getRunOrThrow(input.id);
  }

  addLane(input: AddAgentOpsLaneInput): AgentOpsLaneRecord {
    const id = input.id ?? `lane_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO lanes (
           id, run_id, name, worker_kind, model, status, output_path, exit_code, started_at, finished_at, summary
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           run_id = excluded.run_id, name = excluded.name, worker_kind = excluded.worker_kind,
           model = excluded.model, status = excluded.status, output_path = excluded.output_path,
           exit_code = excluded.exit_code, started_at = excluded.started_at, finished_at = excluded.finished_at,
           summary = excluded.summary`,
      )
      .run(
        id,
        input.runId,
        redactAgentOpsSecrets(input.name),
        redactAgentOpsSecrets(input.workerKind),
        redactedOrNull(input.model),
        input.status,
        redactedOrNull(input.outputPath),
        input.exitCode ?? null,
        input.startedAt ?? null,
        input.finishedAt ?? null,
        redactedOrNull(input.summary),
      );
    return this.getLaneOrThrow(id);
  }

  addArtifact(input: AddAgentOpsArtifactInput): AgentOpsArtifactRecord {
    const id = input.id ?? `artifact_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO artifacts (
           id, project_id, task_id, run_id, lane_id, artifact_type, title, path_or_url, sha256, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id, task_id = excluded.task_id, run_id = excluded.run_id,
           lane_id = excluded.lane_id, artifact_type = excluded.artifact_type, title = excluded.title,
           path_or_url = excluded.path_or_url, sha256 = excluded.sha256`,
      )
      .run(
        id,
        input.projectId,
        input.taskId ?? null,
        input.runId ?? null,
        input.laneId ?? null,
        input.artifactType,
        redactAgentOpsSecrets(input.title),
        redactAgentOpsSecrets(input.pathOrUrl),
        input.sha256 ?? null,
        new Date().toISOString(),
      );
    return this.getArtifactOrThrow(id);
  }

  addEvent(input: AddAgentOpsEventInput): AgentOpsEventRecord {
    return addAgentOpsEvent(this.db, input);
  }

  addVerification(input: AddAgentOpsVerificationInput): AgentOpsVerificationRecord {
    return addAgentOpsVerification(this.db, input);
  }

  close(): void {
    this.db.close();
  }

  private getRunOrThrow(id: string): AgentOpsRunRecord {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    if (row === undefined) throw new Error(`Run not found: ${id}`);
    return mapRunRow(sqlRow(row, `run ${id}`));
  }

  private getLaneOrThrow(id: string): AgentOpsLaneRecord {
    const row = this.db.prepare("SELECT * FROM lanes WHERE id = ?").get(id);
    if (row === undefined) throw new Error(`Lane not found: ${id}`);
    return mapLaneRow(sqlRow(row, `lane ${id}`));
  }

  private getArtifactOrThrow(id: string): AgentOpsArtifactRecord {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id);
    if (row === undefined) throw new Error(`Artifact not found: ${id}`);
    return mapArtifactRow(sqlRow(row, `artifact ${id}`));
  }
}

function redactedOrNull(value: string | undefined): string | null {
  return value === undefined ? null : redactAgentOpsSecrets(value);
}
