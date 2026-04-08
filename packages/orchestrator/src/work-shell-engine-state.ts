import type {
  WorkShellChatEntry,
  WorkShellEngineOptions,
  WorkShellEngineState,
  WorkShellPanel,
  WorkShellTraceMode,
} from "./work-shell-engine.js";
import type { WorkShellReasoningConfig } from "./reasoning.js";

type BuildContextPanel<Reasoning extends WorkShellReasoningConfig> = (
  contextSummaryLines: readonly string[],
  bridgeLines: readonly string[],
  memoryLines: readonly string[],
  traceLines: readonly string[],
  expanded?: boolean,
) => WorkShellPanel;

export function createInitialWorkShellEngineState<Reasoning extends WorkShellReasoningConfig>(input: {
  options: WorkShellEngineOptions<Reasoning>;
  contextSummaryLines: readonly string[];
  buildContextPanel: BuildContextPanel<Reasoning>;
}): WorkShellEngineState<Reasoning> {
  return {
    entries: [],
    model: input.options.model,
    reasoning: input.options.reasoning,
    authLabel: input.options.authLabel,
    authLauncherLines: [],
    bridgeLines: [],
    memoryLines: [],
    panel: input.buildContextPanel(input.contextSummaryLines, [], [], []),
    traceLines: [],
    traceMode:
      input.options.initialTraceMode
      ?? (input.options.mode === "ultrawork" ? "verbose" : "minimal"),
    composerMode: "default",
    isBusy: false,
    busyStatus: undefined,
    currentTurnStartedAt: undefined,
    lastTurnDurationMs: undefined,
  };
}

export function appendWorkShellEntries<Reasoning extends WorkShellReasoningConfig>(
  state: WorkShellEngineState<Reasoning>,
  ...entries: readonly WorkShellChatEntry[]
): Partial<WorkShellEngineState<Reasoning>> {
  return { entries: [...state.entries, ...entries] };
}

export function createWorkShellBusyStatePatch<Reasoning extends WorkShellReasoningConfig>(input: {
  state: WorkShellEngineState<Reasoning>;
  isBusy: boolean;
  busyStatus?: string | undefined;
  currentTurnStartedAt?: number | undefined;
  clearCurrentTurnStartedAt?: boolean | undefined;
}): Partial<WorkShellEngineState<Reasoning>> {
  return {
    isBusy: input.isBusy,
    busyStatus: input.busyStatus,
    ...(input.currentTurnStartedAt !== undefined
      ? { currentTurnStartedAt: input.currentTurnStartedAt }
      : input.clearCurrentTurnStartedAt
        ? { currentTurnStartedAt: undefined }
        : {}),
  };
}

export function createWorkShellAuthStatePatch<Reasoning extends WorkShellReasoningConfig>(input: {
  state: WorkShellEngineState<Reasoning>;
  authLabel: string;
  authLauncherLines?: readonly string[] | undefined;
}): Partial<WorkShellEngineState<Reasoning>> {
  return {
    authLabel: input.authLabel,
    ...(input.authLauncherLines ? { authLauncherLines: input.authLauncherLines } : {}),
  };
}

export function createWorkShellTraceModePatch<Reasoning extends WorkShellReasoningConfig>(input: {
  state: WorkShellEngineState<Reasoning>;
  traceMode: WorkShellTraceMode;
  contextSummaryLines: readonly string[];
  buildContextPanel: BuildContextPanel<Reasoning>;
}): Partial<WorkShellEngineState<Reasoning>> {
  if (input.traceMode === "verbose") {
    return { traceMode: "verbose" };
  }

  return {
    traceMode: "minimal",
    traceLines: [],
    panel: input.buildContextPanel(
      input.contextSummaryLines,
      input.state.bridgeLines,
      input.state.memoryLines,
      [],
    ),
  };
}

export function createWorkShellTraceLinePatch<Reasoning extends WorkShellReasoningConfig>(input: {
  state: WorkShellEngineState<Reasoning>;
  line: string;
  contextSummaryLines: readonly string[];
  buildContextPanel: BuildContextPanel<Reasoning>;
  preservePanel?: boolean | undefined;
}): Partial<WorkShellEngineState<Reasoning>> {
  const traceLines = [input.line, ...input.state.traceLines].slice(0, 8);
  const shouldKeepPanel = Boolean(input.preservePanel) || isPinnedPanelTitle(input.state.panel.title);
  return {
    traceLines,
    ...(shouldKeepPanel
      ? {}
      : {
          panel: input.buildContextPanel(
            input.contextSummaryLines,
            input.state.bridgeLines,
            input.state.memoryLines,
            traceLines,
          ),
        }),
  };
}

export function isPinnedPanelTitle(title: string): boolean {
  return title === "Recent sessions"
    || title === "Session status"
    || title === "Status"
    || title === "Help"
    || title === "Memories"
    || title === "Skills"
    || title.startsWith("Skill · ");
}
