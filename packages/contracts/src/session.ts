import type { SessionPendingAction, SessionState } from "./engine.js";
import type { JsonValue } from "./json.js";

export const SESSION_METADATA_FIELDS = [
  "permissionMode",
  "isUltraworkMode",
  "traceMode",
  "model",
  "pendingAction",
  "postTurnSummary",
  "taskSummary",
] as const;

export type SessionMetadataField = (typeof SESSION_METADATA_FIELDS)[number];

export type SessionMetadata = {
  readonly permissionMode?: string | null;
  readonly isUltraworkMode?: boolean | null;
  readonly traceMode?: "minimal" | "verbose" | null;
  readonly model?: string | null;
  readonly pendingAction?: SessionPendingAction | null;
  readonly postTurnSummary?: JsonValue | null;
  readonly taskSummary?: string | null;
};

export type PersistedWorktreeSession = {
  readonly originalCwd: string;
  readonly worktreePath: string;
  readonly worktreeName: string;
  readonly worktreeBranch?: string;
  readonly originalBranch?: string;
  readonly originalHeadCommit?: string;
  readonly sessionId: string;
  readonly tmuxSessionName?: string;
  readonly hookBased?: boolean;
};

export const SESSION_CHECKPOINT_TYPES = [
  "state",
  "metadata",
  "task_summary",
  "mode",
  "worktree",
  "approval",
] as const;

export type SessionCheckpointType = (typeof SESSION_CHECKPOINT_TYPES)[number];

export type SessionStateCheckpoint = {
  readonly type: "state";
  readonly state: SessionState;
};

export type SessionMetadataCheckpoint = {
  readonly type: "metadata";
  readonly metadata: SessionMetadata;
};

export type SessionTaskSummaryCheckpoint = {
  readonly type: "task_summary";
  readonly summary: string;
  readonly timestamp: string;
};

export type SessionModeCheckpoint = {
  readonly type: "mode";
  readonly mode: "coordinator" | "normal";
};

export type SessionWorktreeCheckpoint = {
  readonly type: "worktree";
  readonly worktree: PersistedWorktreeSession | null;
};

export type SessionApprovalCheckpoint = {
  readonly type: "approval";
  readonly pendingAction: SessionPendingAction;
};

export type SessionCheckpoint =
  | SessionStateCheckpoint
  | SessionMetadataCheckpoint
  | SessionTaskSummaryCheckpoint
  | SessionModeCheckpoint
  | SessionWorktreeCheckpoint
  | SessionApprovalCheckpoint;
