import { type EngineEvent, type SessionCheckpoint } from "@unclecode/contracts";
import { dirname } from "node:path";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

import { listProjectMemoryRecords, writeProjectMemoryRecord } from "./project-memory-db.js";
import { getProjectMemoryPath, getSessionPaths } from "./paths.js";
import { redactSecrets, stringifyWithRedaction } from "./redaction.js";
import {
  applyCheckpoint,
  applyEvent,
  createBaseSnapshot,
  isRecord,
  isSessionState,
  parseRecord,
  sanitizePendingAction,
  sanitizeSessionMetadata,
  sanitizeTaskSummary,
  sanitizeWorktree,
} from "./validators.js";
import type {
  ProjectMemoryEntry,
  SessionCheckpointSnapshot,
  SessionForkOptions,
  SessionResumeResult,
  SessionStore,
  SessionStoreOptions,
  SessionStoreRecord,
  SessionStoreSessionRef,
} from "./types.js";

class FileNotFoundError extends Error {
  readonly code = "ENOENT" as const;
  constructor(cause: unknown) {
    super("File not found", { cause });
  }
}

class FileParseError extends Error {
  constructor(path: string, cause: unknown) {
    super(`Failed to parse file: ${path}`, { cause });
  }
}

async function readJsonFile(path: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new FileNotFoundError(error);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new FileParseError(path, error);
  }
}

async function readRecords(path: string): Promise<SessionStoreRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new FileNotFoundError(error);
  }

  const records: SessionStoreRecord[] = [];

  for (const line of raw.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedLine) as unknown;
    } catch {
      break;
    }

    const record = parseRecord(parsed);
    if (!record) {
      break;
    }

    records.push(record);
  }

  return records;
}

async function ensureSessionDirs(options: SessionStoreOptions, ref: SessionStoreSessionRef): Promise<void> {
  const paths = getSessionPaths(options, ref);
  await mkdir(paths.sessionDir, { recursive: true });
  await mkdir(paths.projectMemoryDir, { recursive: true });
  await mkdir(paths.researchArtifactsDir, { recursive: true });
}

async function appendRecord(
  options: SessionStoreOptions,
  ref: SessionStoreSessionRef,
  record: SessionStoreRecord,
): Promise<void> {
  await ensureSessionDirs(options, ref);
  const paths = getSessionPaths(options, ref);
  await appendFile(paths.eventLogPath, `${stringifyWithRedaction(record)}\n`, "utf8");
}

async function readCheckpointSnapshot(path: string): Promise<SessionCheckpointSnapshot | null> {
  const parsed = await readJsonFile(path);
  if (!isRecord(parsed)) {
    return null;
  }

  const sessionId = typeof parsed.sessionId === "string" ? redactSecrets(parsed.sessionId) : undefined;
  const projectPath = typeof parsed.projectPath === "string" ? redactSecrets(parsed.projectPath) : undefined;
  const eventCount = typeof parsed.eventCount === "number" ? parsed.eventCount : undefined;
  const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;
  const state = isSessionState(parsed.state) ? parsed.state : undefined;

  if (!sessionId || !projectPath || eventCount === undefined || !updatedAt || !state) {
    return null;
  }

  const worktree = sanitizeWorktree(parsed.worktree);
  const pendingAction = sanitizePendingAction(parsed.pendingAction);
  const taskSummary = sanitizeTaskSummary(parsed.taskSummary);

  return {
    sessionId,
    projectPath,
    eventCount,
    updatedAt,
    state,
    metadata: sanitizeSessionMetadata(parsed.metadata),
    ...(parsed.mode === "coordinator" || parsed.mode === "normal"
      ? { mode: parsed.mode }
      : {}),
    ...(worktree !== undefined ? { worktree } : {}),
    ...(pendingAction ? { pendingAction } : {}),
    ...(taskSummary ? { taskSummary } : {}),
    ...(typeof parsed.forkedFromSessionId === "string"
      ? { forkedFromSessionId: redactSecrets(parsed.forkedFromSessionId) }
      : {}),
  };
}

async function writeCheckpointSnapshot(
  path: string,
  snapshot: SessionCheckpointSnapshot,
): Promise<void> {
  await writeFile(path, stringifyWithRedaction(snapshot), "utf8");
}

async function countRecords(path: string): Promise<number> {
  const records = await readRecords(path);
  return records.length;
}

function toRecord(
  sessionId: string,
  timestamp: string,
  payload: EngineEvent | SessionCheckpoint,
): SessionStoreRecord {
  if ("state" in payload && payload.type === "session.state_changed") {
    return {
      kind: "engine_event",
      sessionId,
      timestamp,
      event: payload,
    };
  }

  if (parseRecord({ kind: "engine_event", sessionId, timestamp, event: payload })) {
    return {
      kind: "engine_event",
      sessionId,
      timestamp,
      event: payload as EngineEvent,
    };
  }

  return {
    kind: "checkpoint",
    sessionId,
    timestamp,
    checkpoint: payload as SessionCheckpoint,
  };
}

async function createForkSnapshot(
  options: SessionStoreOptions,
  sourceRef: SessionStoreSessionRef,
  targetRef: SessionStoreSessionRef,
  sourceRecords: readonly SessionStoreRecord[],
): Promise<SessionCheckpointSnapshot> {
  const sourcePaths = getSessionPaths(options, sourceRef);
  const sourceCheckpoint = await readCheckpointSnapshot(sourcePaths.checkpointPath);

  if (sourceCheckpoint) {
    return {
      ...sourceCheckpoint,
      sessionId: targetRef.sessionId,
      projectPath: targetRef.projectPath,
      forkedFromSessionId: sourceRef.sessionId,
      updatedAt: new Date().toISOString(),
    };
  }

  let snapshot = createBaseSnapshot(targetRef);
  for (const record of sourceRecords) {
    if (record.kind === "checkpoint" && record.checkpoint) {
      snapshot = applyCheckpoint(snapshot, record.checkpoint, record.timestamp);
    }
    if (record.kind === "engine_event" && record.event) {
      snapshot = applyEvent(snapshot, record.event);
    }
  }

  return {
    ...snapshot,
    eventCount: sourceRecords.length,
    updatedAt: new Date().toISOString(),
    forkedFromSessionId: sourceRef.sessionId,
  };
}

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  return {
    async appendEvent(ref, event): Promise<void> {
      const timestamp = new Date().toISOString();
      await appendRecord(options, ref, toRecord(ref.sessionId, timestamp, event));
    },

    async appendCheckpoint(ref, checkpoint): Promise<void> {
      const timestamp = new Date().toISOString();
      await appendRecord(options, ref, toRecord(ref.sessionId, timestamp, checkpoint));

      const paths = getSessionPaths(options, ref);
      const existingSnapshot = (await readCheckpointSnapshot(paths.checkpointPath)) ?? createBaseSnapshot(ref);
      const nextSnapshot = {
        ...applyCheckpoint(existingSnapshot, checkpoint, timestamp),
        eventCount: await countRecords(paths.eventLogPath),
      };
      await writeCheckpointSnapshot(paths.checkpointPath, nextSnapshot);
    },

    async resumeSession(ref): Promise<SessionResumeResult> {
      const paths = getSessionPaths(options, ref);
      const checkpoint = await readCheckpointSnapshot(paths.checkpointPath);
      const records = await readRecords(paths.eventLogPath);

      let snapshot = checkpoint ?? createBaseSnapshot(ref);
      let replayStartIndex = 0;

      if (checkpoint && checkpoint.eventCount <= records.length) {
        replayStartIndex = checkpoint.eventCount;
      }

      if (!checkpoint) {
        snapshot = createBaseSnapshot(ref);
      }

      for (const record of records.slice(replayStartIndex)) {
        if (record.kind === "checkpoint" && record.checkpoint) {
          snapshot = applyCheckpoint(snapshot, record.checkpoint, record.timestamp);
        }

        if (record.kind === "engine_event" && record.event) {
          snapshot = applyEvent(snapshot, record.event);
        }
      }

      return {
        sessionId: ref.sessionId,
        records,
        checkpoint,
        state: snapshot.state,
        metadata: snapshot.metadata,
        ...(snapshot.mode ? { mode: snapshot.mode } : {}),
        ...(snapshot.worktree !== undefined ? { worktree: snapshot.worktree } : {}),
        ...(snapshot.pendingAction ? { pendingAction: snapshot.pendingAction } : {}),
        ...(snapshot.taskSummary ? { taskSummary: snapshot.taskSummary } : {}),
        ...(snapshot.agentConsole ? { agentConsole: snapshot.agentConsole } : {}),
        ...(snapshot.forkedFromSessionId
          ? { forkedFromSessionId: snapshot.forkedFromSessionId }
          : {}),
      };
    },

    async forkSession({ projectPath, sourceSessionId, targetSessionId }: SessionForkOptions): Promise<void> {
      const sourceRef = { projectPath, sessionId: sourceSessionId } satisfies SessionStoreSessionRef;
      const targetRef = { projectPath, sessionId: targetSessionId } satisfies SessionStoreSessionRef;
      const sourcePaths = getSessionPaths(options, sourceRef);
      const targetPaths = getSessionPaths(options, targetRef);
      const sourceRecords = await readRecords(sourcePaths.eventLogPath);

      await ensureSessionDirs(options, targetRef);

      const rewrittenRecords = sourceRecords.map(record => ({
        ...record,
        sessionId: targetSessionId,
      }));

      const logBody = rewrittenRecords.map(record => stringifyWithRedaction(record)).join("\n");
      await writeFile(targetPaths.eventLogPath, logBody.length > 0 ? `${logBody}\n` : "", "utf8");

      const forkSnapshot = await createForkSnapshot(options, sourceRef, targetRef, sourceRecords);
      await writeCheckpointSnapshot(targetPaths.checkpointPath, forkSnapshot);
    },

    async writeProjectMemory({ projectPath, memoryId, content }): Promise<void> {
      const paths = getSessionPaths(options, { projectPath, sessionId: "memory-probe" });

      await mkdir(paths.projectMemoryDir, { recursive: true });
      writeProjectMemoryRecord(getProjectMemoryPath(options, projectPath), memoryId, content);
    },

    async listProjectMemories(projectPath: string): Promise<readonly ProjectMemoryEntry[]> {
      const dbPath = getProjectMemoryPath(options, projectPath);
      await mkdir(dirname(dbPath), { recursive: true });
      return listProjectMemoryRecords(dbPath);
    },

    getSessionPaths(ref: SessionStoreSessionRef) {
      return getSessionPaths(options, ref);
    },
  };
}
