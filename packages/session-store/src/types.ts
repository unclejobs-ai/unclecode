import type {
  AgentConsoleSnapshot,
  EngineEvent,
  PersistedWorktreeSession,
  SessionCheckpoint,
  SessionMetadata,
  SessionPendingAction,
  SessionState,
} from "@unclecode/contracts";

export interface SessionStoreSessionRef {
  readonly projectPath: string;
  readonly sessionId: string;
}

export interface SessionStorePaths {
  readonly projectDir: string;
  readonly sessionDir: string;
  readonly eventLogPath: string;
  readonly checkpointPath: string;
  readonly projectMemoryDir: string;
  readonly projectMemoryDbPath: string;
  readonly researchArtifactsDir: string;
}

export interface SessionStoreRecord {
  readonly kind: "engine_event" | "checkpoint";
  readonly sessionId: string;
  readonly timestamp: string;
  readonly event?: EngineEvent;
  readonly checkpoint?: SessionCheckpoint;
}

export interface SessionTaskSummarySnapshot {
  readonly summary: string;
  readonly timestamp: string;
}

export interface SessionCheckpointSnapshot {
  readonly sessionId: string;
  readonly projectPath: string;
  readonly eventCount: number;
  readonly updatedAt: string;
  readonly state: SessionState;
  readonly metadata: SessionMetadata;
  readonly mode?: "coordinator" | "normal";
  readonly worktree?: PersistedWorktreeSession | null;
  readonly pendingAction?: SessionPendingAction;
  readonly taskSummary?: SessionTaskSummarySnapshot;
  readonly agentConsole?: AgentConsoleSnapshot;
  readonly forkedFromSessionId?: string;
}

export interface SessionResumeResult {
  readonly sessionId: string;
  readonly records: readonly SessionStoreRecord[];
  readonly checkpoint: SessionCheckpointSnapshot | null;
  readonly state: SessionState;
  readonly metadata: SessionMetadata;
  readonly mode?: "coordinator" | "normal";
  readonly worktree?: PersistedWorktreeSession | null;
  readonly pendingAction?: SessionPendingAction;
  readonly taskSummary?: SessionTaskSummarySnapshot;
  readonly forkedFromSessionId?: string;
  readonly agentConsole?: AgentConsoleSnapshot;
}

export interface ProjectMemoryEntry {
  readonly memoryId: string;
  readonly content: string;
}

export interface SessionStorePersistenceNotice {
  readonly kind: "engine_event" | "checkpoint";
  readonly sessionId: string;
  readonly projectPath: string;
  readonly revision: number;
}

export interface SessionStoreOptions {
  readonly rootDir: string;
  readonly onPersisted?: ((notice: SessionStorePersistenceNotice) => void | Promise<void>) | undefined;
}

export interface SessionForkOptions {
  readonly projectPath: string;
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
}

export interface SessionStore {
  appendEvent(ref: SessionStoreSessionRef, event: EngineEvent): Promise<void>;
  appendCheckpoint(
    ref: SessionStoreSessionRef,
    checkpoint: SessionCheckpoint,
  ): Promise<void>;
  resumeSession(ref: SessionStoreSessionRef): Promise<SessionResumeResult>;
  forkSession(options: SessionForkOptions): Promise<void>;
  writeProjectMemory(entry: {
    readonly projectPath: string;
    readonly memoryId: string;
    readonly content: string;
  }): Promise<void>;
  deleteProjectMemory(entry: {
    readonly projectPath: string;
    readonly memoryId: string;
  }): Promise<void>;
  listProjectMemories(projectPath: string): Promise<readonly ProjectMemoryEntry[]>;
  getSessionPaths(ref: SessionStoreSessionRef): SessionStorePaths;
}
