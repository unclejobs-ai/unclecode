import type {
  AskUserQuestionResult,
  EvolutionProposalProjection,
  PluginDiagnosticProjection,
  TerminalAgentRunStatus,
  TerminalAsyncJobStatus,
  WorkGraph,
  QualityGateStatus,
  QualityHarnessStage,
  QualityProfile,
  WorkNodeStatus,
} from "./agent-console.js";
import type {
  ExecutionPolicyCapability,
  PolicyDecisionEffect,
  PolicyDecisionSource,
} from "./policy.js";
import type { ProviderId } from "./providers.js";

export const EXECUTION_TRACE_EVENT_TYPES = [
  "turn.started",
  "provider.route",
  "provider.calling",
  "turn.completed",
  "tool.started",
  "tool.completed",
  "decision.opened",
  "decision.resolved",
  "work.proposed",
  "work.approved",
  "work.status",
  "orchestrator.step",
  "bridge.published",
  "memory.written",
  "reasoning.delta",
  "assistant.delta",
  "attachment.attached",
  "attachment.dropped",
  "policy.denied",
  "job.queued",
  "job.settled",
  "agent.run.started",
  "agent.run.settled",
  "usage.recorded",
  "quality.stage_started",
  "quality.gate_evaluated",
  "quality.refine_requested",
  "quality.pivot_requested",
  "quality.completed",
  "evolution.proposed",
  "plugin.diagnostic",
] as const;

export type ExecutionTraceEventType = (typeof EXECUTION_TRACE_EVENT_TYPES)[number];

export const EXECUTION_TRACE_LEVELS = ["low-signal", "default", "high-signal"] as const;

export type ExecutionTraceLevel = (typeof EXECUTION_TRACE_LEVELS)[number];

export type TurnStartedTraceEvent = {
  readonly type: "turn.started";
  readonly level: "low-signal";
  readonly provider: ProviderId | "unknown";
  readonly model: string;
  readonly prompt: string;
  readonly startedAt: number;
};

export type ProviderCallingTraceEvent = {
  readonly type: "provider.calling";
  readonly level: "default";
  readonly provider: ProviderId | "unknown";
  readonly model: string;
  readonly startedAt: number;
};

export type ProviderRouteTraceEvent = {
  readonly type: "provider.route";
  readonly level: "default";
  readonly provider: ProviderId | "unknown";
  readonly model: string;
  readonly label?: string;
  readonly transport?: string;
  readonly runtimeSupported?: boolean;
  readonly endpointUrl?: string;
  readonly proxyPolicy?: {
    readonly proxyUrl: string | null;
    readonly source: string;
    readonly bypassed: boolean;
    readonly targetHost: string;
    readonly noProxy: readonly string[];
  };
  readonly error?: string;
  readonly startedAt: number;
};

export type TurnCompletedTraceEvent = {
  readonly type: "turn.completed";
  readonly level: "low-signal";
  readonly provider: ProviderId | "unknown";
  readonly model: string;
  readonly text: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
};

export type ToolStartedTraceEvent = {
  readonly type: "tool.started";
  readonly level: "default";
  readonly provider: ProviderId | "unknown";
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: Record<string, unknown>;
  readonly startedAt: number;
  /** Absent for main-agent tool calls; set when a subagent owns the call. */
  readonly agentRunId?: string;
  readonly asyncJobId?: string;
};

export type ToolCompletedTraceEvent = {
  readonly type: "tool.completed";
  readonly level: "default";
  readonly provider: ProviderId | "unknown";
  readonly toolName: string;
  readonly toolCallId: string;
  /** Display-safe tool arguments retained only for concise activity rendering. */
  readonly input?: Record<string, unknown>;
  readonly isError: boolean;
  readonly output: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  /** Absent for main-agent tool calls; set when a subagent owns the call. */
  readonly agentRunId?: string;
  readonly asyncJobId?: string;
};

export type DecisionOpenedTraceEvent = {
  readonly type: "decision.opened";
  readonly level: "high-signal";
  readonly requestId: string;
  readonly title?: string;
  readonly questionCount: number;
  readonly startedAt: number;
};

export type DecisionResolvedTraceEvent = {
  readonly type: "decision.resolved";
  readonly level: "high-signal";
  readonly requestId: string;
  readonly status: AskUserQuestionResult["status"];
  readonly selectedOptions?: readonly string[];
  readonly startedAt: number;
};

export type WorkProposedTraceEvent = {
  readonly type: "work.proposed";
  readonly level: "high-signal";
  readonly graphId: string;
  readonly nodeCount: number;
  readonly startedAt: number;
  readonly graph?: WorkGraph;
};

export type WorkApprovedTraceEvent = {
  readonly type: "work.approved";
  readonly level: "high-signal";
  readonly graphId: string;
  readonly startedAt: number;
};

export type WorkStatusTraceEvent = {
  readonly type: "work.status";
  readonly level: "high-signal";
  readonly graphId: string;
  readonly nodeId: string;
  readonly status: WorkNodeStatus;
  readonly summary: string;
  readonly startedAt: number;
};

/**
 * Roles whose events MUST correspond to a real model dispatch. Emitting these
 * events around synchronous in-memory work is forbidden by the spec.
 */
export type OrchestratorStepAgentRole =
  | "planner"
  | "researcher"
  | "reviewer"
  | "executor";

/**
 * Roles that are structural spans used purely for UI grouping. They do NOT
 * correspond to any LLM call. "coordinator" is the legacy alias retained so
 * historical logs keep parsing; new producers should emit "turn".
 */
export type OrchestratorStepSpanRole = "turn" | "coordinator";

type OrchestratorStepTraceEventBase = {
  readonly type: "orchestrator.step";
  readonly level: "high-signal";
  readonly stepId: string;
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly summary: string;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly durationMs?: number;
};

/**
 * Trace event for one orchestrator step. The role/kind pairing is enforced as
 * a discriminated union so producers cannot emit invalid combinations such as
 * `role: "turn", kind: "agent-step"` — they will fail the typecheck. `kind`
 * stays optional so historical logs that pre-date the field continue to
 * parse; new code should always set it.
 */
export type OrchestratorStepTraceEvent = OrchestratorStepTraceEventBase &
  (
    | {
        readonly role: OrchestratorStepAgentRole;
        readonly kind?: "agent-step";
      }
    | {
        readonly role: OrchestratorStepSpanRole;
        readonly kind?: "span";
      }
  );

export type BridgePublishedTraceEvent = {
  readonly type: "bridge.published";
  readonly level: "high-signal";
  readonly bridgeId: string;
  readonly scope: "session" | "project" | "user";
  readonly kind: "summary" | "decision" | "fact" | "file-change" | "task-state" | "warning";
  readonly summary: string;
  readonly source: string;
  readonly target: string;
};

export type MemoryWrittenTraceEvent = {
  readonly type: "memory.written";
  readonly level: "high-signal";
  readonly memoryId: string;
  readonly scope: "session" | "project" | "user" | "agent";
  readonly summary: string;
};

export type ReasoningDeltaTraceEvent = {
  readonly type: "reasoning.delta";
  readonly level: "default";
  readonly provider: ProviderId | "unknown";
  readonly model: string;
  readonly kind: "summary" | "text";
  readonly itemId: string;
  readonly delta: string;
};

export type AssistantDeltaTraceEvent = {
  readonly type: "assistant.delta";
  readonly level: "default";
  readonly provider: ProviderId | "unknown";
  readonly model: string;
  readonly itemId: string;
  readonly delta: string;
};

/**
 * Source identifier for attachment lifecycle events. v1 only emits the
 * "clipboard" producer; future producers (drag-drop, file picker, MCP
 * supplier) get their own values rather than a free-form string so each
 * source can be log-filtered without parsing.
 */
export type AttachmentTraceSource = "clipboard";

/**
 * Reason an attachment was dropped from the pending list. v1 distinguishes
 * cap rejection from explicit user clear; submit-time clear is intentionally
 * NOT traced to avoid N attached + N dropped noise on every successful
 * turn (Hermes design review of #26).
 */
export type AttachmentDropReason = "cap-exceeded" | "capture-too-large" | "user-cleared";

export type AttachmentAttachedTraceEvent = {
  readonly type: "attachment.attached";
  readonly level: "default";
  readonly source: AttachmentTraceSource;
  readonly mimeType: string;
  readonly byteEstimate: number;
  readonly startedAt: number;
};

export type AttachmentDroppedTraceEvent = {
  readonly type: "attachment.dropped";
  readonly level: "default";
  readonly source: AttachmentTraceSource;
  readonly reason: AttachmentDropReason;
  // Optional because capture-side rejection happens before the dataUrl
  // exists, so we only have the raw byte count from the read syscall —
  // the cap-exceeded path carries the estimated bytes from the dataUrl.
  readonly byteEstimate?: number;
  readonly mimeType?: string;
  readonly startedAt: number;
};

export type PolicyDeniedTraceEvent = {
  readonly type: "policy.denied";
  readonly level: "high-signal";
  readonly capability: ExecutionPolicyCapability;
  readonly effect: PolicyDecisionEffect;
  readonly source: PolicyDecisionSource;
  readonly reason: string;
  readonly matchedRule: string;
  readonly runtimeMode: string;
  readonly toolName?: string;
  readonly requestId?: string;
  readonly startedAt: number;
};

export type JobQueuedTraceEvent = {
  readonly type: "job.queued";
  readonly level: "default";
  readonly eventId: string;
  readonly jobId: string;
  readonly jobType: string;
  readonly label: string;
  readonly agentRunId?: string;
  readonly queuedAt: number;
};

export type JobSettledTraceEvent = {
  readonly type: "job.settled";
  readonly level: "default";
  readonly eventId: string;
  readonly jobId: string;
  readonly agentRunId?: string;
  readonly status: TerminalAsyncJobStatus;
  readonly startedAt?: number;
  readonly completedAt: number;
  /** Bounded via `boundLifecycleSummary` before it reaches a snapshot. */
  readonly summary?: string;
  readonly errorSummary?: string;
};

export type AgentRunStartedTraceEvent = {
  readonly type: "agent.run.started";
  readonly level: "high-signal";
  readonly eventId: string;
  readonly runId: string;
  /** Required: every agent run is owned by exactly one job. */
  readonly jobId: string;
  readonly displayName: string;
  readonly agentType: string;
  readonly parentRunId?: string;
  readonly continuationOf?: string;
  readonly startedAt: number;
};

export type AgentRunSettledTraceEvent = {
  readonly type: "agent.run.settled";
  readonly level: "high-signal";
  readonly eventId: string;
  readonly runId: string;
  readonly jobId: string;
  readonly status: TerminalAgentRunStatus;
  readonly startedAt?: number;
  readonly completedAt: number;
  /** Bounded via `boundLifecycleSummary` before it reaches a snapshot. */
  readonly summary?: string;
  readonly errorSummary?: string;
};

/**
 * One usage measurement. `eventId` is the dedupe key: replaying the same
 * event must not double-count, and a measurement lands on either the main
 * session ledger or exactly one agent run — never both. Counters are optional
 * because providers report partial usage.
 */
export type UsageRecordedTraceEvent = {
  readonly type: "usage.recorded";
  readonly level: "low-signal";
  readonly eventId: string;
  readonly provider: string;
  readonly model: string;
  readonly agentRunId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheSavingsUsd?: number;
  readonly costUsd?: number;
  readonly startedAt: number;
};

export type QualityRouteKind = "direct" | "frontier" | "commodity" | "fallback";

type QualityTraceRoute = {
  /** Present only after a real model dispatch selected this route. */
  readonly provider?: ProviderId | "unknown";
  /** Present only after a real model dispatch selected this model. */
  readonly model?: string;
  /** Present only after a real model dispatch used this routing lane. */
  readonly route?: QualityRouteKind;
  readonly agentRunId?: string;
};

type QualityTraceBase = QualityTraceRoute & {
  readonly level: "high-signal";
  readonly runId: string;
  readonly graphId: string;
  readonly profile: QualityProfile;
  readonly stage: QualityHarnessStage;
  readonly iteration: number;
  /** Present when the transition belongs to one WorkGraph node. */
  readonly nodeId?: string;
  readonly nodeAttempt?: number;
  readonly artifactRefs?: readonly string[];
  readonly startedAt: number;
};

export type QualityStageStartedTraceEvent = QualityTraceBase & {
  readonly type: "quality.stage_started";
};

export type QualityGateEvaluatedTraceEvent = QualityTraceBase & {
  readonly type: "quality.gate_evaluated";
  readonly decision: QualityGateStatus;
  readonly refineCount: number;
  readonly pivotCount: number;
  readonly evidenceRefs: readonly string[];
  readonly failures: readonly string[];
  readonly reason: string;
  readonly artifactHash?: string;
  readonly reviewedArtifactHash?: string;
  readonly currentArtifactHash?: string;
  readonly reviewerRunId?: string;
  /** Explicit invalidation result; consumers must never infer this from prose. */
  readonly stale?: boolean;
  readonly independentVerification: boolean;
};

export type QualityRefineRequestedTraceEvent = QualityTraceBase & {
  readonly type: "quality.refine_requested";
  readonly decision: "refine";
  readonly count: number;
  readonly limit: number;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
  readonly failures: readonly string[];
  readonly nodeId?: string;
};

export type QualityPivotRequestedTraceEvent = QualityTraceBase & {
  readonly type: "quality.pivot_requested";
  readonly decision: "pivot";
  readonly count: number;
  readonly limit: number;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
  readonly failures: readonly string[];
};

export type QualityCompletedTraceEvent = QualityTraceBase & {
  readonly type: "quality.completed";
  readonly decision: QualityGateStatus;
  readonly completedStages: readonly QualityHarnessStage[];
  readonly evidenceRefs: readonly string[];
  readonly failures: readonly string[];
  /** Hash bound by the quality gate; not a digest for every artifactRefs item. */
  readonly artifactHash?: string;
  readonly reviewedArtifactHash?: string;
  readonly currentArtifactHash?: string;
  readonly reviewerRunId?: string;
  /** Freshness of the terminal review/artifact binding. */
  readonly stale?: boolean;
  readonly independentVerification: boolean;
  readonly completedAt: number;
};

export type EvolutionProposedTraceEvent = {
  readonly type: "evolution.proposed";
  readonly level: "high-signal";
  readonly runId: string;
  /** Only durable proposals may enter the session/control-room projection. */
  readonly recorded: true;
  readonly proposal: EvolutionProposalProjection;
  readonly startedAt: number;
};

/**
 * Bounded, redacted projection of one external plugin invocation failure.
 * The in-process Quality Engine is builtin and never emits this event.
 */
export type PluginDiagnosticTraceEvent = PluginDiagnosticProjection & {
  readonly type: "plugin.diagnostic";
  readonly level: "high-signal";
};

export type ExecutionTraceEvent =
  | TurnStartedTraceEvent
  | ProviderRouteTraceEvent
  | ProviderCallingTraceEvent
  | TurnCompletedTraceEvent
  | ToolStartedTraceEvent
  | ToolCompletedTraceEvent
  | DecisionOpenedTraceEvent
  | DecisionResolvedTraceEvent
  | WorkProposedTraceEvent
  | WorkApprovedTraceEvent
  | WorkStatusTraceEvent
  | OrchestratorStepTraceEvent
  | BridgePublishedTraceEvent
  | MemoryWrittenTraceEvent
  | ReasoningDeltaTraceEvent
  | AssistantDeltaTraceEvent
  | AttachmentAttachedTraceEvent
  | AttachmentDroppedTraceEvent
  | PolicyDeniedTraceEvent
  | JobQueuedTraceEvent
  | JobSettledTraceEvent
  | AgentRunStartedTraceEvent
  | AgentRunSettledTraceEvent
  | UsageRecordedTraceEvent
  | QualityStageStartedTraceEvent
  | QualityGateEvaluatedTraceEvent
  | QualityRefineRequestedTraceEvent
  | QualityPivotRequestedTraceEvent
  | QualityCompletedTraceEvent
  | EvolutionProposedTraceEvent
  | PluginDiagnosticTraceEvent;
