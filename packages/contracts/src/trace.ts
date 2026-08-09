import type {
  AskUserQuestionResult,
  TerminalAgentRunStatus,
  TerminalAsyncJobStatus,
  WorkGraph,
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
  readonly jobId?: string;
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
  readonly jobId?: string;
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
  readonly agentRunId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly costUsd?: number;
  readonly startedAt: number;
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
  | UsageRecordedTraceEvent;
