import {
  ENGINE_EVENT_TYPES,
  SESSION_CHECKPOINT_TYPES,
  SESSION_STATES,
  type EngineEvent,
  type JsonObject,
  type JsonValue,
  type PersistedWorktreeSession,
  type SessionCheckpoint,
  type SessionMetadata,
  type SessionPendingAction,
  type SessionState,
} from "@unclecode/contracts";

import { redactSecrets, stringifyWithRedaction } from "./redaction.js";
import type {
  SessionCheckpointSnapshot,
  SessionStoreRecord,
  SessionTaskSummarySnapshot,
} from "./types.js";

const SESSION_STATE_SET = new Set<string>(SESSION_STATES);
const ENGINE_EVENT_TYPE_SET = new Set<string>(ENGINE_EVENT_TYPES);
const SESSION_CHECKPOINT_TYPE_SET = new Set<string>(SESSION_CHECKPOINT_TYPES);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isSessionState(value: unknown): value is SessionState {
  return typeof value === "string" && SESSION_STATE_SET.has(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(item => isJsonValue(item));
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(item => isJsonValue(item));
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && !Array.isArray(value) && Object.values(value).every(item => isJsonValue(item));
}

function isEngineEvent(value: unknown): value is EngineEvent {
  return isRecord(value) && typeof value.type === "string" && ENGINE_EVENT_TYPE_SET.has(value.type);
}

export function sanitizeSessionMetadata(value: unknown): SessionMetadata {
  if (!isRecord(value)) {
    return {};
  }

  const pendingAction = isRecord(value.pendingAction)
    ? sanitizePendingAction(value.pendingAction)
    : undefined;
  const postTurnSummary =
    typeof value.postTurnSummary === "string"
      ? redactSecrets(value.postTurnSummary)
      : isJsonValue(value.postTurnSummary)
        ? value.postTurnSummary
        : undefined;

  return {
    ...(typeof value.permissionMode === "string" || value.permissionMode === null
      ? { permissionMode: value.permissionMode }
      : {}),
    ...(typeof value.isUltraworkMode === "boolean" || value.isUltraworkMode === null
      ? { isUltraworkMode: value.isUltraworkMode }
      : {}),
    ...(value.traceMode === "minimal" || value.traceMode === "verbose" || value.traceMode === null
      ? { traceMode: value.traceMode }
      : {}),
    ...(typeof value.model === "string" || value.model === null
      ? {
          model:
            typeof value.model === "string" ? redactSecrets(value.model) : value.model,
        }
      : {}),
    ...(pendingAction ? { pendingAction } : {}),
    ...(value.pendingAction === null ? { pendingAction: null } : {}),
    ...(postTurnSummary !== undefined ? { postTurnSummary } : {}),
    ...(typeof value.taskSummary === "string" || value.taskSummary === null
      ? {
          taskSummary:
            typeof value.taskSummary === "string"
              ? redactSecrets(value.taskSummary)
              : value.taskSummary,
        }
      : {}),
  };
}

export function sanitizePendingAction(value: unknown): SessionPendingAction | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const toolName = typeof value.toolName === "string" ? redactSecrets(value.toolName) : undefined;
  const actionDescription =
    typeof value.actionDescription === "string"
      ? redactSecrets(value.actionDescription)
      : undefined;
  const toolUseId = typeof value.toolUseId === "string" ? redactSecrets(value.toolUseId) : undefined;
  const requestId = typeof value.requestId === "string" ? redactSecrets(value.requestId) : undefined;

  if (!toolName || !actionDescription || !toolUseId || !requestId) {
    return undefined;
  }

  return {
    toolName,
    actionDescription,
    toolUseId,
    requestId,
    ...(isJsonObject(value.input) ? { input: value.input } : {}),
  };
}

export function sanitizeWorktree(value: unknown): PersistedWorktreeSession | null | undefined {
  if (value === null) {
    return null;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const originalCwd = typeof value.originalCwd === "string" ? redactSecrets(value.originalCwd) : undefined;
  const worktreePath = typeof value.worktreePath === "string" ? redactSecrets(value.worktreePath) : undefined;
  const worktreeName = typeof value.worktreeName === "string" ? redactSecrets(value.worktreeName) : undefined;
  const sessionId = typeof value.sessionId === "string" ? redactSecrets(value.sessionId) : undefined;

  if (!originalCwd || !worktreePath || !worktreeName || !sessionId) {
    return undefined;
  }

  return {
    originalCwd,
    worktreePath,
    worktreeName,
    sessionId,
    ...(typeof value.worktreeBranch === "string"
      ? { worktreeBranch: redactSecrets(value.worktreeBranch) }
      : {}),
    ...(typeof value.originalBranch === "string"
      ? { originalBranch: redactSecrets(value.originalBranch) }
      : {}),
    ...(typeof value.originalHeadCommit === "string"
      ? { originalHeadCommit: redactSecrets(value.originalHeadCommit) }
      : {}),
    ...(typeof value.tmuxSessionName === "string"
      ? { tmuxSessionName: redactSecrets(value.tmuxSessionName) }
      : {}),
    ...(typeof value.hookBased === "boolean" ? { hookBased: value.hookBased } : {}),
  };
}

export function sanitizeTaskSummary(value: unknown): SessionTaskSummarySnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (typeof value.summary !== "string" || typeof value.timestamp !== "string") {
    return undefined;
  }

  return {
    summary: redactSecrets(value.summary),
    timestamp: value.timestamp,
  };
}

export function parseCheckpoint(value: unknown): SessionCheckpoint | undefined {
  if (!isRecord(value) || typeof value.type !== "string" || !SESSION_CHECKPOINT_TYPE_SET.has(value.type)) {
    return undefined;
  }

  switch (value.type) {
    case "state":
      return isSessionState(value.state) ? { type: "state", state: value.state } : undefined;
    case "metadata":
      return { type: "metadata", metadata: sanitizeSessionMetadata(value.metadata) };
    case "task_summary": {
      const taskSummary = sanitizeTaskSummary(value);
      return taskSummary
        ? { type: "task_summary", summary: taskSummary.summary, timestamp: taskSummary.timestamp }
        : undefined;
    }
    case "mode":
      return value.mode === "coordinator" || value.mode === "normal"
        ? { type: "mode", mode: value.mode }
        : undefined;
    case "worktree": {
      const worktree = sanitizeWorktree(value.worktree);
      return worktree !== undefined ? { type: "worktree", worktree } : undefined;
    }
    case "approval": {
      const pendingAction = sanitizePendingAction(value.pendingAction);
      return pendingAction ? { type: "approval", pendingAction } : undefined;
    }
    default:
      return undefined;
  }
}

export function parseRecord(value: unknown): SessionStoreRecord | undefined {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.sessionId !== "string" || typeof value.timestamp !== "string") {
    return undefined;
  }

  if (value.kind === "engine_event") {
    const event = parseEvent(value.event);
    if (!event) {
      return undefined;
    }

    return {
      kind: "engine_event",
      sessionId: redactSecrets(value.sessionId),
      timestamp: value.timestamp,
      event,
    };
  }

  if (value.kind === "checkpoint") {
    const checkpoint = parseCheckpoint(value.checkpoint);
    if (!checkpoint) {
      return undefined;
    }

    return {
      kind: "checkpoint",
      sessionId: redactSecrets(value.sessionId),
      timestamp: value.timestamp,
      checkpoint,
    };
  }

  return undefined;
}

function parseEvent(value: unknown): EngineEvent | undefined {
  if (!isEngineEvent(value)) {
    return undefined;
  }

  if (value.type === "session.state_changed") {
    const pendingAction = sanitizePendingAction(value.details);
    return {
      type: "session.state_changed",
      state: value.state,
      ...(pendingAction ? { details: pendingAction } : {}),
    };
  }

  const serialized = stringifyWithRedaction(value);
  const parsed: unknown = JSON.parse(serialized);
  return isEngineEvent(parsed) ? parsed : undefined;
}

export function createBaseSnapshot(ref: { sessionId: string; projectPath: string }): SessionCheckpointSnapshot {
  return {
    sessionId: ref.sessionId,
    projectPath: ref.projectPath,
    eventCount: 0,
    updatedAt: new Date(0).toISOString(),
    state: SESSION_STATES[0],
    metadata: {},
  };
}

export function applyCheckpoint(
  snapshot: SessionCheckpointSnapshot,
  checkpoint: SessionCheckpoint,
  updatedAt: string,
): SessionCheckpointSnapshot {
  switch (checkpoint.type) {
    case "state":
      return {
        ...snapshot,
        updatedAt,
        state: checkpoint.state,
      };
    case "metadata":
      return {
        ...snapshot,
        updatedAt,
        metadata: {
          ...snapshot.metadata,
          ...sanitizeSessionMetadata(checkpoint.metadata),
        },
      };
    case "task_summary":
      return {
        ...snapshot,
        updatedAt,
        taskSummary: {
          summary: redactSecrets(checkpoint.summary),
          timestamp: checkpoint.timestamp,
        },
        metadata: {
          ...snapshot.metadata,
          taskSummary: redactSecrets(checkpoint.summary),
        },
      };
    case "mode":
      return {
        ...snapshot,
        updatedAt,
        mode: checkpoint.mode,
      };
    case "worktree":
      return {
        ...snapshot,
        updatedAt,
        ...(checkpoint.worktree === undefined ? {} : { worktree: checkpoint.worktree }),
      };
    case "approval":
      return {
        ...snapshot,
        updatedAt,
        pendingAction: checkpoint.pendingAction,
      };
  }
}

export function applyEvent(
  snapshot: SessionCheckpointSnapshot,
  event: EngineEvent,
): SessionCheckpointSnapshot {
  if (event.type !== "session.state_changed") {
    return snapshot;
  }

  const nextSnapshot: SessionCheckpointSnapshot = {
    ...snapshot,
    state: event.state,
  };

  if (!event.details) {
    const { pendingAction: _pendingAction, ...snapshotWithoutPendingAction } = nextSnapshot;
    return snapshotWithoutPendingAction;
  }

  return event.details
    ? {
        ...nextSnapshot,
        pendingAction: event.details,
      }
    : nextSnapshot;
}
