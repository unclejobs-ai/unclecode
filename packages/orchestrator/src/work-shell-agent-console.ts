import {
  createAgentConsoleSnapshot,
  isCoalescibleToolActivity,
  parseAgentConsoleSnapshot,
  type AgentConsoleSnapshot,
  type ToolActivity,
  type WorkNodeStatus,
  type ToolActivityKind,
} from "@unclecode/contracts";

const MAX_TOOL_ACTIVITY = 80;

type TraceRecord = Record<string, unknown>;

/**
 * Projects provider tool lifecycle events into bounded, resume-safe console
 * evidence. Tool output is intentionally never read or retained here.
 */
export function applyTraceEventToAgentConsole(
  snapshot: AgentConsoleSnapshot,
  event: { readonly type: string },
): AgentConsoleSnapshot {
  const workSnapshot = applyWorkLifecycleEvent(snapshot, event);
  if (workSnapshot !== snapshot) {
    return workSnapshot;
  }

  if (event.type !== "tool.started" && event.type !== "tool.completed") {
    return snapshot;
  }

  const trace = asRecord(event);
  if (!trace) {
    return snapshot;
  }
  const toolCallId = readNonEmptyString(trace, "toolCallId");
  const toolName = readNonEmptyString(trace, "toolName");
  if (!toolCallId || !toolName) {
    return snapshot;
  }

  const existingIndex = snapshot.activity.findIndex((activity) => activity.toolCallId === toolCallId);
  const current = existingIndex === -1 ? undefined : snapshot.activity[existingIndex];
  const startedAt = readTimestamp(trace, "startedAt") ?? current?.startedAt ?? Date.now();
  const input = asRecord(trace.input);
  const nextActivity = event.type === "tool.started"
    ? createStartedActivity({ toolCallId, toolName, startedAt, input, current })
    : createCompletedActivity({ toolCallId, toolName, startedAt, input, trace, current });

  const activity = existingIndex === -1
    ? [...snapshot.activity, nextActivity]
    : snapshot.activity.map((entry, index) => index === existingIndex ? nextActivity : entry);

  return createAgentConsoleSnapshot({
    ...snapshot,
    activity: capToolActivity(activity),
  });
}

function applyWorkLifecycleEvent(
  snapshot: AgentConsoleSnapshot,
  event: { readonly type: string },
): AgentConsoleSnapshot {
  const trace = asRecord(event);
  if (!trace) {
    return snapshot;
  }

  if (event.type === "work.proposed") {
    const parsed = parseAgentConsoleSnapshot({
      ...snapshot,
      workGraph: trace.graph,
    });
    if (
      !parsed?.workGraph
      || parsed.workGraph.id !== readNonEmptyString(trace, "graphId")
    ) {
      return snapshot;
    }
    return parsed;
  }

  const graph = snapshot.workGraph;
  if (!graph || readNonEmptyString(trace, "graphId") !== graph.id) {
    return snapshot;
  }

  if (event.type === "work.approved") {
    return createAgentConsoleSnapshot({
      ...snapshot,
      workGraph: { ...graph, approval: "approved" },
    });
  }

  if (event.type !== "work.status") {
    return snapshot;
  }
  const nodeId = readNonEmptyString(trace, "nodeId");
  const status = readWorkNodeStatus(trace.status);
  if (!nodeId || !status || !graph.nodes.some((node) => node.id === nodeId)) {
    return snapshot;
  }
  return createAgentConsoleSnapshot({
    ...snapshot,
    workGraph: {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === nodeId ? { ...node, status } : node),
    },
  });
}

function readWorkNodeStatus(value: unknown): WorkNodeStatus | undefined {
  return typeof value === "string" && [
    "proposed",
    "approved",
    "ready",
    "running",
    "blocked",
    "requires_action",
    "completed",
    "failed",
    "cancelled",
  ].includes(value)
    ? value as WorkNodeStatus
    : undefined;
}

function createStartedActivity(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startedAt: number;
  readonly input: TraceRecord | undefined;
  readonly current: ToolActivity | undefined;
}): ToolActivity {
  const target = input.current?.target ?? deriveToolTarget(input.input);
  return {
    id: input.current?.id ?? `tool:${input.toolCallId}`,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    kind: input.current?.kind ?? classifyToolActivityKind(input.toolName),
    intent: input.current?.intent ?? deriveToolIntent(input.toolName, input.input),
    status: "running",
    ...(target ? { target } : {}),
    startedAt: input.startedAt,
  };
}

function createCompletedActivity(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startedAt: number;
  readonly input: TraceRecord | undefined;
  readonly trace: TraceRecord;
  readonly current: ToolActivity | undefined;
}): ToolActivity {
  const completedAt = readTimestamp(input.trace, "completedAt") ?? Date.now();
  const durationMs = readTimestamp(input.trace, "durationMs") ?? Math.max(0, completedAt - input.startedAt);
  const failed = input.trace.isError === true;

  const target = input.current?.target ?? deriveToolTarget(input.input);
  return {
    id: input.current?.id ?? `tool:${input.toolCallId}`,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    kind: input.current?.kind ?? classifyToolActivityKind(input.toolName),
    intent: input.current?.intent ?? deriveToolIntent(input.toolName, input.input),
    status: failed ? "failed" : "completed",
    ...(target ? { target } : {}),
    summary: `${failed ? "failed" : "completed"} · ${durationMs}ms`,
    startedAt: input.startedAt,
    completedAt,
  };
}

function capToolActivity(activity: readonly ToolActivity[]): readonly ToolActivity[] {
  const retained = [...activity];
  while (retained.length > MAX_TOOL_ACTIVITY) {
    const coalescibleIndex = retained.findIndex(isCoalescibleToolActivity);
    retained.splice(coalescibleIndex === -1 ? 0 : coalescibleIndex, 1);
  }
  return retained;
}

function classifyToolActivityKind(toolName: string): ToolActivityKind {
  const normalized = toolName.toLowerCase();
  if (normalized === "ask_user") {
    return "interaction";
  }
  if (normalized.includes("delete") || normalized.includes("remove")) {
    return "delete";
  }
  if (normalized.includes("write") || normalized.includes("edit") || normalized.includes("patch")) {
    return "write";
  }
  if (normalized.includes("read") || normalized.includes("search") || normalized.includes("find")
    || normalized.includes("glob") || normalized.includes("list") || normalized.includes("inspect")) {
    return normalized.includes("search") || normalized.includes("find") || normalized.includes("glob")
      ? "search"
      : "read";
  }
  if (normalized.includes("shell") || normalized.includes("command") || normalized.includes("execute")
    || normalized.includes("run") || normalized.includes("build") || normalized.includes("test")) {
    return "execute";
  }
  return "other";
}

function deriveToolIntent(toolName: string, input: TraceRecord | undefined): string {
  const declaredIntent = readNonEmptyString(input, "i") ?? readNonEmptyString(input, "intent");
  if (declaredIntent) {
    return declaredIntent;
  }
  const target = deriveToolTarget(input);
  return target ? `${toolName}: ${target}` : toolName;
}

function deriveToolTarget(input: TraceRecord | undefined): string | undefined {
  return readNonEmptyString(input, "path")
    ?? readNonEmptyString(input, "file")
    ?? readNonEmptyString(input, "url");
}

function asRecord(value: unknown): TraceRecord | undefined {
  return typeof value === "object" && value !== null
    ? value as TraceRecord
    : undefined;
}

function readNonEmptyString(record: TraceRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readTimestamp(record: TraceRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
