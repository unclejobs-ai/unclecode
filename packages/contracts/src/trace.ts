import type { ProviderId } from "./providers.js";

export const EXECUTION_TRACE_EVENT_TYPES = [
  "turn.started",
  "provider.calling",
  "turn.completed",
  "tool.started",
  "tool.completed",
  "orchestrator.step",
  "bridge.published",
  "memory.written",
  "reasoning.delta",
  "attachment.attached",
  "attachment.dropped",
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
};

export type ToolCompletedTraceEvent = {
  readonly type: "tool.completed";
  readonly level: "default";
  readonly provider: ProviderId | "unknown";
  readonly toolName: string;
  readonly toolCallId: string;
  readonly isError: boolean;
  readonly output: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
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

export type ExecutionTraceEvent =
  | TurnStartedTraceEvent
  | ProviderCallingTraceEvent
  | TurnCompletedTraceEvent
  | ToolStartedTraceEvent
  | ToolCompletedTraceEvent
  | OrchestratorStepTraceEvent
  | BridgePublishedTraceEvent
  | MemoryWrittenTraceEvent
  | ReasoningDeltaTraceEvent
  | AttachmentAttachedTraceEvent
  | AttachmentDroppedTraceEvent;
