export type AgentOpsEntityStatus =
  | "queued"
  | "active"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "skipped"
  | "done"
  | "archived";

export type AgentOpsArtifactType =
  | "output"
  | "diff"
  | "report"
  | "screenshot"
  | "pr"
  | "commit"
  | "worktree"
  | "transcript";

export type AgentOpsVerificationKind = "lint" | "typecheck" | "test" | "build" | "e2e" | "custom";

export type AgentOpsVerificationStatus = "passed" | "failed" | "skipped" | "unknown";

export interface AgentOpsProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly repoPath: string;
  readonly configPath?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentOpsTaskRecord {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description?: string;
  readonly sourceType?: string;
  readonly sourceUrl?: string;
  readonly status: AgentOpsEntityStatus;
  readonly priority?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentOpsRunRecord {
  readonly id: string;
  readonly taskId?: string;
  readonly projectId: string;
  readonly runKey: string;
  readonly workerKind: string;
  readonly command: string;
  readonly cwd?: string;
  readonly worktreePath?: string;
  readonly status: AgentOpsEntityStatus;
  readonly exitCode?: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly summary?: string;
  readonly nextAction?: string;
}

export interface AgentOpsLaneRecord {
  readonly id: string;
  readonly runId: string;
  readonly name: string;
  readonly workerKind: string;
  readonly model?: string;
  readonly status: AgentOpsEntityStatus;
  readonly outputPath?: string;
  readonly exitCode?: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly summary?: string;
}

export interface AgentOpsArtifactRecord {
  readonly id: string;
  readonly projectId: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly laneId?: string;
  readonly artifactType: AgentOpsArtifactType;
  readonly title: string;
  readonly pathOrUrl: string;
  readonly sha256?: string;
  readonly createdAt: string;
}

export interface AgentOpsEventRecord {
  readonly id: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly laneId?: string;
  readonly eventType: string;
  readonly message: string;
  readonly metadataJson?: string;
  readonly createdAt: string;
}

export interface AgentOpsVerificationRecord {
  readonly id: string;
  readonly runId: string;
  readonly command: string;
  readonly kind: AgentOpsVerificationKind;
  readonly status: AgentOpsVerificationStatus;
  readonly outputPath?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface AgentOpsContextSourceRow {
  readonly id: string;
  readonly projectId: string;
  readonly category: string;
  readonly label: string;
  readonly content: string | null;
  readonly reason: string;
  readonly sha256: string | null;
  readonly salience: number;
  readonly tokenEstimate: number;
  readonly includedInModel: number;
  readonly turnLastSeen: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
}
