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

export type OrchestratorStepTraceEvent = {
  readonly type: "orchestrator.step";
  readonly level: "high-signal";
  readonly stepId: string;
  readonly role: "planner" | "researcher" | "reviewer" | "executor" | "coordinator";
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly summary: string;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly durationMs?: number;
};

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

export type ExecutionTraceEvent =
  | TurnStartedTraceEvent
  | ProviderCallingTraceEvent
  | TurnCompletedTraceEvent
  | ToolStartedTraceEvent
  | ToolCompletedTraceEvent
  | OrchestratorStepTraceEvent
  | BridgePublishedTraceEvent
  | MemoryWrittenTraceEvent;
