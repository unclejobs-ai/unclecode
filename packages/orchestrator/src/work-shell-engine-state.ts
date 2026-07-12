import { runRustCommandSync } from "./rust-command.js";
import type {
  WorkShellChatEntry,
  WorkShellEngineOptions,
  WorkShellEngineState,
  WorkShellPanel,
  WorkShellTraceMode,
} from "./work-shell-engine.js";
import type { WorkShellReasoningConfig } from "./reasoning.js";
import { createAgentConsoleSnapshot } from "@unclecode/contracts";

type BuildContextPanel<Reasoning extends WorkShellReasoningConfig> = (
  contextSummaryLines: readonly string[],
  bridgeLines: readonly string[],
  memoryLines: readonly string[],
  traceLines: readonly string[],
  expanded?: boolean,
) => WorkShellPanel;

type WorkShellTraceLinePatchDecision = {
  readonly traceLines: readonly string[];
  readonly preservePanel: boolean;
  readonly shouldRebuildContextPanel: boolean;
};

type WorkShellTraceModePatchDecision = {
  readonly traceMode: WorkShellTraceMode;
  readonly clearTraceLines: boolean;
  readonly shouldRebuildContextPanel: boolean;
};

type WorkShellBusyStatePatchDecision = {
  readonly isBusy: boolean;
  readonly busyStatusAction: "set" | "clear";
  readonly busyStatus?: string;
  readonly currentTurnStartedAtAction: "set" | "clear" | "keep";
  readonly currentTurnStartedAt?: number;
};

type WorkShellAuthStatePatchDecision = {
  readonly authLabel: string;
  readonly authLauncherLinesAction: "set" | "keep";
  readonly authLauncherLines?: readonly string[];
};

type WorkShellInitialStateDecision<Reasoning extends WorkShellReasoningConfig> = {
  readonly entries: readonly WorkShellChatEntry[];
  readonly model: string;
  readonly mode: WorkShellEngineOptions<Reasoning>["mode"];
  readonly reasoning: Reasoning;
  readonly authLabel: string;
  readonly authLauncherLines: readonly string[];
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
  readonly traceLines: readonly string[];
  readonly traceMode: WorkShellTraceMode;
  readonly composerMode: WorkShellEngineState<Reasoning>["composerMode"];
  readonly isBusy: boolean;
};

type WorkShellAppendEntriesPatchDecision = {
  readonly entries: readonly WorkShellChatEntry[];
};

export function createInitialWorkShellEngineState<Reasoning extends WorkShellReasoningConfig>(input: {
  options: WorkShellEngineOptions<Reasoning>;
  contextSummaryLines: readonly string[];
  buildContextPanel: BuildContextPanel<Reasoning>;
}): WorkShellEngineState<Reasoning> {
  const decision = resolveWorkShellInitialStateDecision<Reasoning>({
    model: input.options.model,
    mode: input.options.mode,
    reasoning: input.options.reasoning,
    authLabel: input.options.authLabel,
    ...(input.options.initialTraceMode !== undefined ? { initialTraceMode: input.options.initialTraceMode } : {}),
  });
  return {
    entries: input.options.initialEntries ? [...input.options.initialEntries] : [...decision.entries],
    streamingAssistantText: undefined,
    model: decision.model,
    mode: decision.mode,
    reasoning: decision.reasoning,
    authLabel: decision.authLabel,
    authLauncherLines: [...decision.authLauncherLines],
    bridgeLines: [...decision.bridgeLines],
    memoryLines: [...decision.memoryLines],
    panel: input.buildContextPanel(input.contextSummaryLines, decision.bridgeLines, decision.memoryLines, decision.traceLines),
    traceLines: [...decision.traceLines],
    traceMode: decision.traceMode,
    composerMode: decision.composerMode,
    isBusy: decision.isBusy,
    busyStatus: undefined,
    currentTurnStartedAt: undefined,
    lastTurnDurationMs: undefined,
    contextActionReceipt: undefined,
    contextSourceActionsEnabled: false,
    queuedCount: 0,
    queuePaused: false,
    terminalColumns: 100,
    modelWindow: input.options.modelWindow ?? 200000,
    // Context Inspector (Sprint 2): cursor + expanded-source state for the
    // /context overlay. Cursor indexes into the navigable source list shown
    // in the overlay; -1 means "no selection". Only one source expands at a
    // time. See docs/design/context-inspector-redesign.md §C/§E.
    contextInspectorCursor: -1,
    contextInspectorExpanded: null,
    contextInspectorDetailContent: undefined,
    contextInspectorDetailOffset: 0,
    agentConsole: createAgentConsoleSnapshot({
      profileId: input.options.contextProfile ?? input.options.initialAgentConsole?.profileId ?? "build",
      ...(input.options.initialAgentConsole
        ? {
            ...(input.options.initialAgentConsole.manifest
              ? { manifest: input.options.initialAgentConsole.manifest }
              : {}),
            ...(input.options.initialAgentConsole.pendingDecision
              ? { pendingDecision: input.options.initialAgentConsole.pendingDecision }
              : {}),
            ...(input.options.initialAgentConsole.workGraph
              ? { workGraph: input.options.initialAgentConsole.workGraph }
              : {}),
            activity: input.options.initialAgentConsole.activity,
          }
        : { activity: [] }),
    }),
  };
}

export function appendWorkShellEntries<Reasoning extends WorkShellReasoningConfig>(
  state: WorkShellEngineState<Reasoning>,
  ...entries: readonly WorkShellChatEntry[]
): Partial<WorkShellEngineState<Reasoning>> {
  const decision = resolveWorkShellAppendEntriesPatchDecision({
    entries: state.entries,
    nextEntries: entries,
  });
  return { entries: [...decision.entries] };
}

export function createWorkShellBusyStatePatch<Reasoning extends WorkShellReasoningConfig>(input: {
  state: WorkShellEngineState<Reasoning>;
  isBusy: boolean;
  busyStatus?: string | undefined;
  currentTurnStartedAt?: number | undefined;
  clearCurrentTurnStartedAt?: boolean | undefined;
}): Partial<WorkShellEngineState<Reasoning>> {
  const decision = resolveWorkShellBusyStatePatchDecision({
    isBusy: input.isBusy,
    ...(input.busyStatus !== undefined ? { busyStatus: input.busyStatus } : {}),
    ...(input.currentTurnStartedAt !== undefined ? { currentTurnStartedAt: input.currentTurnStartedAt } : {}),
    ...(input.clearCurrentTurnStartedAt !== undefined ? { clearCurrentTurnStartedAt: input.clearCurrentTurnStartedAt } : {}),
  });
  return {
    isBusy: decision.isBusy,
    busyStatus: decision.busyStatusAction === "set" ? decision.busyStatus : undefined,
    ...(decision.currentTurnStartedAtAction === "set" && decision.currentTurnStartedAt !== undefined
      ? { currentTurnStartedAt: decision.currentTurnStartedAt }
      : decision.currentTurnStartedAtAction === "clear"
        ? { currentTurnStartedAt: undefined }
        : {}),
  };
}

export function createWorkShellAuthStatePatch<Reasoning extends WorkShellReasoningConfig>(input: {
  state: WorkShellEngineState<Reasoning>;
  authLabel: string;
  authLauncherLines?: readonly string[] | undefined;
}): Partial<WorkShellEngineState<Reasoning>> {
  const decision = resolveWorkShellAuthStatePatchDecision({
    authLabel: input.authLabel,
    ...(input.authLauncherLines !== undefined ? { authLauncherLines: input.authLauncherLines } : {}),
  });
  return {
    authLabel: decision.authLabel,
    ...(decision.authLauncherLinesAction === "set" ? { authLauncherLines: decision.authLauncherLines ?? [] } : {}),
  };
}

export function createWorkShellTraceModePatch<Reasoning extends WorkShellReasoningConfig>(input: {
  state: WorkShellEngineState<Reasoning>;
  traceMode: WorkShellTraceMode;
  contextSummaryLines: readonly string[];
  buildContextPanel: BuildContextPanel<Reasoning>;
}): Partial<WorkShellEngineState<Reasoning>> {
  const decision = resolveWorkShellTraceModePatchDecision(input.traceMode);

  return {
    traceMode: decision.traceMode,
    ...(decision.clearTraceLines ? { traceLines: [] } : {}),
    ...(decision.shouldRebuildContextPanel
      ? {
          panel: input.buildContextPanel(
            input.contextSummaryLines,
            input.state.bridgeLines,
            input.state.memoryLines,
            [],
            input.state.panel.title === "Context expanded",
          ),
        }
      : {}),
  };
}

export function createWorkShellTraceLinePatch<Reasoning extends WorkShellReasoningConfig>(input: {
  state: WorkShellEngineState<Reasoning>;
  line: string;
  contextSummaryLines: readonly string[];
  buildContextPanel: BuildContextPanel<Reasoning>;
  preservePanel?: boolean | undefined;
}): Partial<WorkShellEngineState<Reasoning>> {
  const decision = resolveWorkShellTraceLinePatchDecision({
    line: input.line,
    traceLines: input.state.traceLines,
    panelTitle: input.state.panel.title,
    preservePanel: Boolean(input.preservePanel),
  });
  return {
    traceLines: decision.traceLines,
    ...(!decision.shouldRebuildContextPanel
      ? {}
      : {
          panel: input.buildContextPanel(
            input.contextSummaryLines,
            input.state.bridgeLines,
            input.state.memoryLines,
            decision.traceLines,
            input.state.panel.title === "Context expanded",
          ),
        }),
  };
}

export function resolveModeDefaultReasoning<Reasoning extends WorkShellReasoningConfig>(
  reasoning: Reasoning,
): Reasoning {
  return resolveWorkShellModeDefaultReasoningDecision(reasoning);
}

export function isPinnedPanelTitle(title: string): boolean {
  return resolveWorkShellTraceLinePatchDecision({
    line: "",
    traceLines: [],
    panelTitle: title,
    preservePanel: false,
  }).preservePanel;
}

function resolveWorkShellTraceLinePatchDecision(input: {
  readonly line: string;
  readonly traceLines: readonly string[];
  readonly panelTitle: string;
  readonly preservePanel: boolean;
}): WorkShellTraceLinePatchDecision {
  const raw = runRustCommandSync(
    ["rust", "ux", "trace-line-patch"],
    process.cwd(),
    JSON.stringify(input),
  );
  return JSON.parse(raw) as WorkShellTraceLinePatchDecision;
}

function resolveWorkShellTraceModePatchDecision(traceMode: WorkShellTraceMode): WorkShellTraceModePatchDecision {
  const raw = runRustCommandSync(
    ["rust", "ux", "trace-mode-patch"],
    process.cwd(),
    JSON.stringify({ traceMode }),
  );
  return JSON.parse(raw) as WorkShellTraceModePatchDecision;
}

function resolveWorkShellBusyStatePatchDecision(input: {
  readonly isBusy: boolean;
  readonly busyStatus?: string;
  readonly currentTurnStartedAt?: number;
  readonly clearCurrentTurnStartedAt?: boolean;
}): WorkShellBusyStatePatchDecision {
  const raw = runRustCommandSync(
    ["rust", "ux", "busy-state-patch"],
    process.cwd(),
    JSON.stringify(input),
  );
  return JSON.parse(raw) as WorkShellBusyStatePatchDecision;
}

function resolveWorkShellAuthStatePatchDecision(input: {
  readonly authLabel: string;
  readonly authLauncherLines?: readonly string[];
}): WorkShellAuthStatePatchDecision {
  const raw = runRustCommandSync(
    ["rust", "ux", "auth-state-patch"],
    process.cwd(),
    JSON.stringify(input),
  );
  return JSON.parse(raw) as WorkShellAuthStatePatchDecision;
}

function resolveWorkShellInitialStateDecision<Reasoning extends WorkShellReasoningConfig>(input: {
  readonly model: string;
  readonly mode: WorkShellEngineOptions<Reasoning>["mode"];
  readonly reasoning: Reasoning;
  readonly authLabel: string;
  readonly initialTraceMode?: WorkShellTraceMode;
}): WorkShellInitialStateDecision<Reasoning> {
  const raw = runRustCommandSync(
    ["rust", "ux", "initial-state"],
    process.cwd(),
    JSON.stringify(input),
  );
  return JSON.parse(raw) as WorkShellInitialStateDecision<Reasoning>;
}

function resolveWorkShellAppendEntriesPatchDecision(input: {
  readonly entries: readonly WorkShellChatEntry[];
  readonly nextEntries: readonly WorkShellChatEntry[];
}): WorkShellAppendEntriesPatchDecision {
  const raw = runRustCommandSync(
    ["rust", "ux", "append-entries-patch"],
    process.cwd(),
    JSON.stringify(input),
  );
  return JSON.parse(raw) as WorkShellAppendEntriesPatchDecision;
}

function resolveWorkShellModeDefaultReasoningDecision<Reasoning extends WorkShellReasoningConfig>(
  reasoning: Reasoning,
): Reasoning {
  const raw = runRustCommandSync(
    ["rust", "ux", "mode-default-reasoning"],
    process.cwd(),
    JSON.stringify(reasoning),
  );
  return JSON.parse(raw) as Reasoning;
}
