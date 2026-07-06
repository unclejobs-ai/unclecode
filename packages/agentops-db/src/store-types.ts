import type {
  ContextSourceRecord,
  SelectContextSourcesInput,
  UpsertContextSourceInput,
} from "@unclecode/contracts";

import type {
  AgentOpsArtifactRecord,
  AgentOpsEventRecord,
  AgentOpsLaneRecord,
  AgentOpsProjectRecord,
  AgentOpsRunRecord,
  AgentOpsTaskRecord,
  AgentOpsVerificationRecord,
} from "./types.js";
import type { AgentOpsPaths } from "./paths.js";

export interface CreateAgentOpsStoreOptions {
  readonly home?: string;
  readonly dbPath?: string;
}

export interface AddAgentOpsProjectInput {
  readonly id: string;
  readonly name: string;
  readonly repoPath: string;
  readonly configPath?: string;
}

export interface AddAgentOpsTaskInput {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description?: string;
  readonly sourceType?: string;
  readonly sourceUrl?: string;
  readonly status?: AgentOpsTaskRecord["status"];
  readonly priority?: number;
}

export interface StartAgentOpsRunInput {
  readonly projectId: string;
  readonly taskId?: string;
  readonly runKey?: string;
  readonly workerKind: string;
  readonly command: string;
  readonly cwd?: string;
  readonly worktreePath?: string;
}

export interface RecordAgentOpsRunInput extends StartAgentOpsRunInput {
  readonly id: string;
  readonly status: AgentOpsRunRecord["status"];
  readonly exitCode?: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly summary?: string;
  readonly nextAction?: string;
}

export interface FinishAgentOpsRunInput {
  readonly id: string;
  readonly status: "completed" | "failed" | "blocked" | "cancelled";
  readonly exitCode: number;
  readonly summary?: string;
  readonly nextAction?: string;
}

export interface AddAgentOpsLaneInput {
  readonly id?: string;
  readonly runId: string;
  readonly name: string;
  readonly workerKind: string;
  readonly model?: string;
  readonly status: AgentOpsLaneRecord["status"];
  readonly outputPath?: string;
  readonly exitCode?: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly summary?: string;
}

export interface AddAgentOpsArtifactInput {
  readonly id?: string;
  readonly projectId: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly laneId?: string;
  readonly artifactType: AgentOpsArtifactRecord["artifactType"];
  readonly title: string;
  readonly pathOrUrl: string;
  readonly sha256?: string;
}

export interface AddAgentOpsEventInput {
  readonly id?: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly laneId?: string;
  readonly eventType: string;
  readonly message: string;
  readonly metadataJson?: string;
}

export interface AddAgentOpsVerificationInput {
  readonly id?: string;
  readonly runId: string;
  readonly command: string;
  readonly kind: AgentOpsVerificationRecord["kind"];
  readonly status: AgentOpsVerificationRecord["status"];
  readonly outputPath?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export type SelectedContextSources = {
  readonly selected: readonly ContextSourceRecord[];
  readonly heldBack: readonly ContextSourceRecord[];
  readonly totalTokens: number;
  readonly budget: number;
};

export interface AgentOpsStore {
  readonly paths: AgentOpsPaths;
  addProject(input: AddAgentOpsProjectInput): AgentOpsProjectRecord;
  addTask(input: AddAgentOpsTaskInput): AgentOpsTaskRecord;
  getProject(id: string): AgentOpsProjectRecord | undefined;
  listProjects(): readonly AgentOpsProjectRecord[];
  startRun(input: StartAgentOpsRunInput): AgentOpsRunRecord;
  recordRun(input: RecordAgentOpsRunInput): AgentOpsRunRecord;
  finishRun(input: FinishAgentOpsRunInput): AgentOpsRunRecord;
  addLane(input: AddAgentOpsLaneInput): AgentOpsLaneRecord;
  addArtifact(input: AddAgentOpsArtifactInput): AgentOpsArtifactRecord;
  addEvent(input: AddAgentOpsEventInput): AgentOpsEventRecord;
  addVerification(input: AddAgentOpsVerificationInput): AgentOpsVerificationRecord;
  // Context Runbook Protocol (CRP) — typed context source store.
  upsertContextSource(input: UpsertContextSourceInput): ContextSourceRecord;
  selectContextSources(input: SelectContextSourcesInput): SelectedContextSources;
  countContextSourcesByCategory(projectId: string): ReadonlyMap<string, number>;
  markContextSourceTurnSeen(ids: readonly string[], turnIndex: number): void;
  pruneExpiredContextSources(now?: Date): number;
  pinContextSource(id: string): void;
  unpinContextSource(id: string): void;
  forgetContextSource(id: string): void;
  includeContextSource(id: string): void;
  close(): void;
}
