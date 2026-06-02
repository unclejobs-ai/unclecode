import { runRustCommandSync } from "./rust-command.js";
import { createWorkShellBusyStatePatch } from "./work-shell-engine-state.js";
import type { WorkShellChatEntry, WorkShellEngineState } from "./work-shell-engine.js";
import type { WorkShellReasoningConfig } from "./reasoning.js";

type WorkShellTraceEventDecision = {
  readonly busyStatusAction: "set" | "clear" | "none";
  readonly busyStatus?: string;
  readonly currentTurnStartedAt?: number;
  readonly traceEntryRole: WorkShellChatEntry["role"];
  readonly traceEntry?: WorkShellChatEntry;
};

function resolveWorkShellTraceEventDecision(input: {
  readonly event: { readonly type: string; readonly status?: string; readonly startedAt?: unknown };
  readonly line: string;
  readonly traceMode?: "minimal" | "verbose";
}): WorkShellTraceEventDecision {
  const raw = runRustCommandSync(
    ["rust", "ux", "trace-event"],
    process.cwd(),
    JSON.stringify({
      event: input.event,
      line: input.line,
      traceMode: input.traceMode ?? "minimal",
    }),
  );
  return JSON.parse(raw) as WorkShellTraceEventDecision;
}

export function resolveBusyStatusFromTraceEvent(
  event: { readonly type: string; readonly status?: string },
  line: string,
): string | null | undefined {
  const decision = resolveWorkShellTraceEventDecision({ event, line });
  if (decision.busyStatusAction === "clear") {
    return undefined;
  }
  if (decision.busyStatusAction === "set") {
    return decision.busyStatus ?? "thinking";
  }

  return null;
}

export function resolveTraceEntryRole(event: { readonly type: string }): WorkShellChatEntry["role"] {
  return resolveWorkShellTraceEventDecision({ event, line: "" }).traceEntryRole;
}

export function extractCurrentTurnStartedAt(event: { readonly type: string; readonly startedAt?: unknown }): number | undefined {
  return resolveWorkShellTraceEventDecision({ event, line: "" }).currentTurnStartedAt;
}

export function createTraceEventBusyPatch<Reasoning extends WorkShellReasoningConfig>(input: {
  state: WorkShellEngineState<Reasoning>;
  event: { readonly type: string; readonly status?: string; readonly startedAt?: unknown };
  line: string;
}): Partial<WorkShellEngineState<Reasoning>> | undefined {
  const decision = resolveWorkShellTraceEventDecision({ event: input.event, line: input.line });
  if (decision.busyStatusAction === "none") {
    return undefined;
  }

  return createWorkShellBusyStatePatch({
    state: input.state,
    isBusy: input.state.isBusy,
    ...(decision.busyStatusAction === "set" ? { busyStatus: decision.busyStatus ?? "thinking" } : {}),
    ...(decision.currentTurnStartedAt !== undefined ? { currentTurnStartedAt: decision.currentTurnStartedAt } : {}),
    ...(decision.busyStatusAction === "clear"
      ? { clearCurrentTurnStartedAt: true }
      : {}),
  });
}

export function resolveVerboseTraceEntry(input: {
  traceMode: "minimal" | "verbose";
  event: { readonly type: string };
  line: string;
}): WorkShellChatEntry | undefined {
  return resolveWorkShellTraceEventDecision(input).traceEntry;
}

export function applyWorkShellTraceEvent<
  Reasoning extends WorkShellReasoningConfig,
  TraceEvent extends { readonly type: string },
>(input: {
  state: WorkShellEngineState<Reasoning>;
  event: TraceEvent;
  formatAgentTraceLine: (event: TraceEvent) => string;
  setState: (patch: Partial<WorkShellEngineState<Reasoning>>) => void;
  appendEntries: (...entries: readonly WorkShellChatEntry[]) => void;
  pushTraceLine: (line: string) => void;
}): void {
  const line = input.formatAgentTraceLine(input.event);
  const busyPatch = createTraceEventBusyPatch({
    state: input.state,
    event: input.event,
    line,
  });
  if (busyPatch) {
    input.setState(busyPatch);
  }

  const traceEntry = resolveVerboseTraceEntry({
    traceMode: input.state.traceMode,
    event: input.event,
    line,
  });
  if (!traceEntry) {
    return;
  }

  input.appendEntries(traceEntry);
  input.pushTraceLine(line);
}
