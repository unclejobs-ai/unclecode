/**
 * Team-mode run primitives — RUN_ID-bound persistence, hash-chained checkpoints,
 * disk-backed file ownership for cross-process worker coordination.
 * Layer A (Claude Code conductor) and Layer B (peer worker CLIs) bind via
 * UNCLECODE_TEAM_RUN_ID + UNCLECODE_TEAM_RUN_ROOT env vars.
 */

import type { PersonaId, MiniLoopMessage } from "./mini-loop.js";
import type {
  ExecutionPolicyCapability,
  PolicyDecisionEffect,
  PolicyDecisionSource,
} from "./policy.js";
import type { VersionedRef } from "./ssot.js";

export const TEAM_RUN_STATUSES = [
  "started",
  "running",
  "gated",
  "accepted",
  "corrective",
  "aborted",
  "killed",
  "errored",
] as const;

export type TeamRunStatus = (typeof TEAM_RUN_STATUSES)[number];

export const TEAM_GATE_LEVELS = ["strict", "warn", "off"] as const;

export type TeamGateLevel = (typeof TEAM_GATE_LEVELS)[number];

export const TEAM_RUNTIME_MODES = ["local", "docker", "e2b", "openshell"] as const;

export type TeamRuntimeMode = (typeof TEAM_RUNTIME_MODES)[number];

export const TEAM_ISOLATION_MODES = ["shared", "worktree"] as const;

export type TeamIsolationMode = (typeof TEAM_ISOLATION_MODES)[number];

/**
 * Per-lane runtime backend. Distinct from TeamRuntimeMode (sandbox container).
 * - SDK trio: openai/anthropic/gemini — in-process provider
 * - cursor:   @cursor/sdk Agent.prompt (in-process)
 * - codex:    spawn `codex exec --json`
 * - opencode: spawn `opencode run --model …`
 * - glm:      OpenAI-compatible HTTP (Z.ai / BigModel) via baseURL override
 * - hermes:   spawn `acpx <agent> exec` — remote-agent fan-out via ACP
 */
export const TEAM_LANE_RUNTIMES = [
  "openai",
  "anthropic",
  "gemini",
  "cursor",
  "codex",
  "opencode",
  "glm",
  "hermes",
] as const;

export type TeamLaneRuntime = (typeof TEAM_LANE_RUNTIMES)[number];

export function isTeamLaneRuntime(value: unknown): value is TeamLaneRuntime {
  return (
    typeof value === "string"
    && (TEAM_LANE_RUNTIMES as readonly string[]).includes(value)
  );
}

export const EVIDENCE_GATE_STATUSES = ["pass", "fail", "blocked"] as const;

export type EvidenceGateStatus = (typeof EVIDENCE_GATE_STATUSES)[number];

export type EvidenceArtifactRef = {
  readonly path: string;
  readonly kind: "cli-transcript" | "test-output" | "data-diff" | "screenshot" | "log" | "other";
  readonly description: string;
  readonly sha256?: string;
};

export type EvidenceGateReceipt = {
  readonly status: EvidenceGateStatus;
  readonly summary: string;
  readonly artifacts: ReadonlyArray<EvidenceArtifactRef>;
  readonly cleanupReceipt: string;
  readonly recordedAt: number;
  readonly citedRefs?: ReadonlyArray<VersionedRef>;
};

export function isEvidenceGateReceiptComplete(receipt: EvidenceGateReceipt): boolean {
  return receipt.summary.trim().length > 0
    && receipt.cleanupReceipt.trim().length > 0
    && receipt.artifacts.length > 0
    && receipt.artifacts.every((artifact) =>
      artifact.path.trim().length > 0
      && artifact.kind.trim().length > 0
      && artifact.description.trim().length > 0,
    );
}

export const AGENT_SEMANTIC_INTENTS = [
  "implementation",
  "verification",
  "review",
  "research",
  "coordination",
] as const;

export type AgentSemanticIntent = (typeof AGENT_SEMANTIC_INTENTS)[number];

export const AGENT_TOOL_POLICIES = ["none", "read_only", "sandboxed", "unrestricted"] as const;

export type AgentToolPolicy = (typeof AGENT_TOOL_POLICIES)[number];

export const AGENT_WRITE_POLICIES = ["none", "propose_only", "workspace"] as const;

export type AgentWritePolicy = (typeof AGENT_WRITE_POLICIES)[number];

export type AgentRoutingContract = {
  readonly intent: AgentSemanticIntent;
  readonly toolPolicy: AgentToolPolicy;
  readonly writePolicy: AgentWritePolicy;
  readonly rationale: string;
  readonly citedRefs?: ReadonlyArray<VersionedRef>;
};

/**
 * Canonical worker spec — single source of truth for both the orchestrator
 * dispatch layer and per-lane adapters. Heterogeneous lanes per run.
 */
export type WorkerSpec = {
  readonly workerId: string;
  readonly persona: PersonaId;
  readonly task: string;
  readonly runtime: TeamLaneRuntime;
  readonly model?: string;
  readonly extras?: Readonly<Record<string, string>>;
  readonly routingContract?: AgentRoutingContract;
};

export type TeamRunManifest = {
  readonly runId: string;
  readonly objective: string;
  readonly persona: PersonaId;
  readonly lanes: number;
  readonly gate: TeamGateLevel;
  readonly runtime: TeamRuntimeMode;
  readonly isolation?: TeamIsolationMode;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly workspaceRoot: string;
  readonly codeState?: {
    readonly headCommit?: string;
    readonly dirty: boolean;
  };
  readonly env?: Readonly<Record<string, string>>;
};

export type TeamRunCheckpoint = {
  readonly type: "team_run";
  readonly runId: string;
  readonly persona: PersonaId;
  readonly status: TeamRunStatus;
  readonly objective: string;
  readonly lanes: number;
  readonly timestamp: string;
  readonly prevTipHash: string;
  readonly lineHash?: string;
};

export type TeamStepCheckpoint = {
  readonly type: "team_step";
  readonly runId: string;
  readonly workerId: string;
  readonly stepIndex: number;
  readonly action?: {
    readonly tool: string;
    readonly argHash: string;
  };
  readonly policy?: {
    readonly capability: ExecutionPolicyCapability;
    readonly effect: PolicyDecisionEffect;
    readonly source: PolicyDecisionSource;
    readonly reason: string;
    readonly matchedRule: string;
    readonly runtimeMode: string;
    readonly toolName?: string;
  };
  readonly observationHash?: string;
  readonly costUsd?: number;
  readonly timestamp: string;
  readonly prevTipHash: string;
  readonly lineHash?: string;
};

export type TeamWorkerSnapshot = {
  readonly workerId: string;
  readonly persona: PersonaId;
  readonly status: "pending" | "running" | "completed" | "failed" | "killed";
  readonly stepIndex: number;
  readonly costUsd: number;
  readonly claimedPaths: ReadonlyArray<string>;
};

export type TeamContextPacket = {
  readonly runId: string;
  readonly persona: PersonaId;
  readonly objective: string;
  readonly messages: ReadonlyArray<MiniLoopMessage>;
  readonly artifacts: ReadonlyArray<{
    readonly path: string;
    readonly sha256: string;
  }>;
  readonly gateResults: ReadonlyArray<{
    readonly gateId: string;
    readonly status: "pass" | "warn" | "fail";
    readonly summary: string;
  }>;
  readonly handoffNotes?: string;
  readonly packetId: string;
};
