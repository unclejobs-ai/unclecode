export type TuiShellSession = {
  readonly sessionId: string;
  readonly state: string;
  readonly updatedAt: string;
  readonly model: string | null;
  readonly taskSummary: string | null;
};

export type TuiShellHomeState = {
  readonly modeLabel: string;
  readonly authLabel: string;
  readonly sessionCount: number;
  readonly mcpServerCount: number;
  readonly mcpServers: readonly {
    name: string;
    transport: string;
    scope: string;
    trustTier: string;
    originLabel: string;
  }[];
  readonly latestResearchSessionId: string | null;
  readonly latestResearchSummary: string | null;
  readonly latestResearchTimestamp: string | null;
  readonly researchRunCount: number;
  readonly sessions: readonly TuiShellSession[];
  readonly bridgeLines?: readonly string[];
  readonly memoryLines?: readonly string[];
};

export type TuiActivityEntry = {
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly timestamp: string;
  readonly lines: readonly string[];
  readonly tone: "info" | "success" | "warning";
};

export type TuiStepTraceEntry = {
  readonly id: string;
  readonly kind: "thinking" | "tool" | "approval" | "result";
  readonly level: "low-signal" | "default" | "high-signal";
  readonly message: string;
  readonly timestamp: string;
};

export type TuiShellFocusState = {
  readonly column: "sessions" | "actions";
  readonly sessionIndex: number;
  readonly actionIndex: number;
  readonly detailOpen: boolean;
  readonly shouldExit: boolean;
  readonly selectedCommand: string | undefined;
};

export type TuiWorkerStatus = {
  readonly id: string;
  readonly label: string;
  readonly status: "running" | "idle" | "completed";
  readonly detail: string;
};

export type TuiApprovalRequest = {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly severity: "info" | "warning";
};

export type TuiShellState = {
  readonly homeState: TuiShellHomeState;
  readonly view: "work" | "sessions" | "mcp" | "research";
  readonly focus: TuiShellFocusState;
  readonly outputLines: readonly string[];
  readonly activityEntries: readonly TuiActivityEntry[];
  readonly traceEntries: readonly TuiStepTraceEntry[];
  readonly workers: readonly TuiWorkerStatus[];
  readonly approvals: readonly TuiApprovalRequest[];
  readonly isRunning: boolean;
  readonly runningActionId: string | undefined;
};

export type TuiShellEvent =
  | { readonly type: "action.started"; readonly actionId: string }
  | {
      readonly type: "action.completed";
      readonly entry: TuiActivityEntry;
      readonly outputLines: readonly string[];
      readonly homeState: TuiShellHomeState;
    }
  | {
      readonly type: "action.failed";
      readonly entry: TuiActivityEntry;
      readonly outputLines: readonly string[];
    }
  | {
      readonly type: "home.updated";
      readonly homeState: Partial<TuiShellHomeState>;
    }
  | { readonly type: "worker.progressed"; readonly worker: TuiWorkerStatus }
  | { readonly type: "approval.requested"; readonly approval: TuiApprovalRequest }
  | { readonly type: "approval.resolved"; readonly approvalId: string }
  | { readonly type: "view.changed"; readonly view: TuiShellState["view"] }
  | { readonly type: "focus.changed"; readonly focus: TuiShellFocusState };

function appendTraceEntry(entries: readonly TuiStepTraceEntry[], nextEntry: TuiStepTraceEntry): readonly TuiStepTraceEntry[] {
  return [nextEntry, ...entries].slice(0, 24);
}

export function createInitialShellState(
  homeState: TuiShellHomeState,
  options?: {
    readonly selectedSessionId?: string | undefined;
    readonly initialView?: TuiShellState["view"] | undefined;
  },
): TuiShellState {
  const selectedSessionIndex = options?.selectedSessionId
    ? Math.max(0, homeState.sessions.findIndex((session) => session.sessionId === options.selectedSessionId))
    : 0;

  const initialView = options?.initialView ?? "work";
  const initialColumn = initialView === "sessions" || options?.selectedSessionId ? "sessions" : "actions";

  return {
    homeState,
    view: initialView,
    focus: {
      column: initialColumn,
      sessionIndex: selectedSessionIndex,
      actionIndex: 0,
      detailOpen: false,
      shouldExit: false,
      selectedCommand: undefined,
    },
    outputLines: [],
    activityEntries: [],
    traceEntries: [],
    workers: [],
    approvals: [],
    isRunning: false,
    runningActionId: undefined,
  };
}

export function coalesceShellEvents(events: readonly TuiShellEvent[]): readonly TuiShellEvent[] {
  const passthrough: TuiShellEvent[] = [];
  const latestWorkerEvents = new Map<string, Extract<TuiShellEvent, { readonly type: "worker.progressed" }>>();

  for (const event of events) {
    if (event.type === "worker.progressed") {
      latestWorkerEvents.set(event.worker.id, event);
      continue;
    }

    passthrough.push(event);
  }

  return [...passthrough, ...latestWorkerEvents.values()];
}

export function applyShellEvents(state: TuiShellState, events: readonly TuiShellEvent[]): TuiShellState {
  return coalesceShellEvents(events).reduce(reduceShellEvent, state);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function areHomeStateValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => areHomeStateValuesEqual(entry, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => areHomeStateValuesEqual(left[key], right[key]));
  }
  return false;
}

export function reduceShellEvent(state: TuiShellState, event: TuiShellEvent): TuiShellState {
  switch (event.type) {
    case "action.started": {
      if (state.isRunning && state.runningActionId === event.actionId) {
        return state;
      }
      const timestamp = new Date().toISOString();
      return {
        ...state,
        view: "work",
        activityEntries: [
          {
            id: `start-${event.actionId}`,
            source: event.actionId,
            title: `Running ${event.actionId}`,
            timestamp,
            lines: ["Action started"],
            tone: "info" as const,
          },
          ...state.activityEntries,
        ].slice(0, 20),
        traceEntries: appendTraceEntry(state.traceEntries, {
          id: `trace-start-${event.actionId}`,
          kind: "thinking",
          level: "low-signal",
          message: `Running ${event.actionId}`,
          timestamp,
        }),
        isRunning: true,
        runningActionId: event.actionId,
      };
    }
    case "action.completed": {
      const timestamp = new Date().toISOString();
      return {
        ...state,
        homeState: event.homeState,
        view: event.entry.source === "new-research" ? "research" : "work",
        outputLines: event.outputLines,
        activityEntries: [event.entry, ...state.activityEntries].slice(0, 20),
        traceEntries: appendTraceEntry(state.traceEntries, {
          id: `trace-complete-${event.entry.id}`,
          kind: "result",
          level: "high-signal",
          message: `${event.entry.title} completed`,
          timestamp,
        }),
        workers: state.workers.map((worker) =>
          worker.id === state.runningActionId
            ? { ...worker, status: "completed", detail: "completed" }
            : worker,
        ),
        isRunning: false,
        runningActionId: undefined,
      };
    }
    case "action.failed": {
      const timestamp = new Date().toISOString();
      return {
        ...state,
        view: "work",
        outputLines: event.outputLines,
        activityEntries: [event.entry, ...state.activityEntries].slice(0, 20),
        traceEntries: appendTraceEntry(state.traceEntries, {
          id: `trace-failed-${event.entry.id}`,
          kind: "result",
          level: "high-signal",
          message: `${event.entry.title} failed`,
          timestamp,
        }),
        workers: state.workers.map((worker) =>
          worker.id === state.runningActionId
            ? { ...worker, status: "idle", detail: "failed" }
            : worker,
        ),
        isRunning: false,
        runningActionId: undefined,
      };
    }
    case "home.updated": {
      const hasChanges = Object.entries(event.homeState).some(([key, value]) => {
        const current = state.homeState[key as keyof TuiShellHomeState];
        return !areHomeStateValuesEqual(current, value);
      });
      if (!hasChanges) {
        return state;
      }
      return {
        ...state,
        homeState: {
          ...state.homeState,
          ...event.homeState,
        },
      };
    }
    case "worker.progressed": {
      const existing = state.workers.find((worker) => worker.id === event.worker.id);
      return {
        ...state,
        traceEntries: appendTraceEntry(state.traceEntries, {
          id: `trace-worker-${event.worker.id}-${event.worker.detail}`,
          kind: "tool",
          level: "default",
          message: `${event.worker.label}: ${event.worker.detail}`,
          timestamp: new Date().toISOString(),
        }),
        workers: existing
          ? state.workers.map((worker) => (worker.id === event.worker.id ? event.worker : worker))
          : [event.worker, ...state.workers].slice(0, 4),
      };
    }
    case "approval.requested": {
      if (state.approvals.some((approval) => approval.id === event.approval.id)) {
        return state;
      }
      const timestamp = new Date().toISOString();
      return {
        ...state,
        activityEntries: [
          {
            id: `approval-${event.approval.id}`,
            source: "approval",
            title: event.approval.title,
            timestamp,
            lines: [event.approval.detail],
            tone: event.approval.severity === "warning" ? "warning" as const : "info" as const,
          },
          ...state.activityEntries,
        ].slice(0, 20),
        traceEntries: appendTraceEntry(state.traceEntries, {
          id: `trace-approval-${event.approval.id}`,
          kind: "approval",
          level: "high-signal",
          message: `${event.approval.title}`,
          timestamp,
        }),
        approvals: [event.approval],
      };
    }
    case "approval.resolved": {
      if (!state.approvals.some((approval) => approval.id === event.approvalId)) {
        return state;
      }
      return {
        ...state,
        approvals: state.approvals.filter((approval) => approval.id !== event.approvalId),
      };
    }
    case "view.changed":
      return {
        ...state,
        view: event.view,
      };
    case "focus.changed":
      return {
        ...state,
        focus: event.focus,
      };
    default:
      return state;
  }
}
