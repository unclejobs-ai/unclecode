import { runRustCommandSync } from "./rust-command.js";
import { createCollapsedContextPanel } from "./work-shell-engine-panels.js";
import type {
  WorkShellChatEntry,
  WorkShellEngineOptions,
  WorkShellEngineState,
  WorkShellPanel,
  WorkShellTraceMode,
} from "./work-shell-engine.js";
import type { WorkShellReasoningConfig } from "./reasoning.js";
import { createAgentConsoleSnapshot } from "@unclecode/contracts";
import { createAgentConsoleViewState } from "./work-shell-agent-console-state.js";
import {
  detectWorkShellUserLocale,
  resolveWorkShellTerminalUiLocale,
} from "./work-shell-locale.js";
import type { WorkShellPauseSnapshot } from "./work-shell-pause-controller.js";

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
  const resumedLocale = [...(input.options.initialEntries ?? [])]
    .reverse()
    .find((entry) => entry.role === "user")?.text;
  const detectedResumedLocale = detectWorkShellUserLocale(resumedLocale ?? "");
  const decision = resolveWorkShellInitialStateDecision<Reasoning>({
    model: input.options.model,
    mode: input.options.mode,
    reasoning: input.options.reasoning,
    authLabel: input.options.authLabel,
    ...(input.options.initialTraceMode !== undefined ? { initialTraceMode: input.options.initialTraceMode } : {}),
  });
  return {
    entries: identifyWorkShellEntries(
      input.options.initialEntries ? input.options.initialEntries : decision.entries,
      new Set(),
    ),
    streamingAssistantText: undefined,
    streamingReasoningText: undefined,
    model: decision.model,
    mode: decision.mode,
    reasoning: decision.reasoning,
    authLabel: decision.authLabel,
    authLauncherLines: [...decision.authLauncherLines],
    bridgeLines: [...decision.bridgeLines],
    memoryLines: [...decision.memoryLines],
    panel: createCollapsedContextPanel({
      contextSummaryLines: input.contextSummaryLines,
      bridgeLines: decision.bridgeLines,
      memoryLines: decision.memoryLines,
      traceLines: decision.traceLines,
      buildContextPanel: input.buildContextPanel,
    }),
    traceLines: [...decision.traceLines],
    // Live dock-feed tail: engine-owned TS state, deliberately NOT part of the
    // Rust initial-state decision — it fills from trace events in every mode
    // and starts empty like traceLines does.
    liveTraceLines: [],
    traceMode: decision.traceMode,
    uiLocale: input.options.initialUiLocale
      ?? detectedResumedLocale
      ?? resolveWorkShellTerminalUiLocale(process.env, "en"),
    uiLocaleLocked: input.options.initialUiLocaleLocked
      ?? input.options.initialUiLocale !== undefined,
    composerMode: decision.composerMode,
    isBusy: decision.isBusy,
    turnLifecycle: { state: "idle" } satisfies WorkShellPauseSnapshot,
    busyStatus: undefined,
    currentTurnStartedAt: undefined,
    lastTurnDurationMs: undefined,
    contextActionReceipt: undefined,
    contextPreviewReceipt: undefined,
    contextSubmittedReceipt: undefined,
    contextPacketChange: undefined,
    contextSourceActionsEnabled: false,
    contextPolicySuggestions: [],
    contextAdviceUnavailable: undefined,
    contextAdviceActionsEnabled: false,
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
    // Context Desk (Pure Yazi): the desk starts closed, and `/context` is what
    // hands it the keyboard. Focus defaults to the sources pane over the
    // all-sources collection every time it opens.
    contextInspectorOpen: false,
    contextInspectorPane: "sources",
    contextInspectorCollection: "all",
    agentConsole: createAgentConsoleSnapshot({
      profileId: input.options.contextProfile ?? input.options.initialAgentConsole?.profileId ?? "build",
      ...(input.options.initialAgentConsole
        ? {
            ...(input.options.initialAgentConsole.manifest
              ? { manifest: input.options.initialAgentConsole.manifest }
              : {}),
            ...(input.options.initialAgentConsole.securityApprovals
              ? { securityApprovals: input.options.initialAgentConsole.securityApprovals }
              : {}),
            ...(input.options.initialAgentConsole.pendingDecision
              ? { pendingDecision: input.options.initialAgentConsole.pendingDecision }
              : {}),
            ...(input.options.initialAgentConsole.workGraph
              ? { workGraph: input.options.initialAgentConsole.workGraph }
              : {}),
            ...(input.options.initialAgentConsole.qualityReview
              ? { qualityReview: input.options.initialAgentConsole.qualityReview }
              : {}),
            ...(input.options.initialAgentConsole.mainUsage
              ? { mainUsage: input.options.initialAgentConsole.mainUsage }
              : {}),
            activity: input.options.initialAgentConsole.activity,
            // Resume carries the whole safe lifecycle projection: dropping the
            // agent and job records here would reopen the console with a
            // history the checkpoint already normalised.
            agents: input.options.initialAgentConsole.agents,
            jobs: input.options.initialAgentConsole.jobs,
          }
        : { activity: [], agents: [], jobs: [] }),
    }),
    agentConsoleView: createAgentConsoleViewState(),
  };
}

export function appendWorkShellEntries<Reasoning extends WorkShellReasoningConfig>(
  state: WorkShellEngineState<Reasoning>,
  ...entries: readonly WorkShellChatEntry[]
): Partial<WorkShellEngineState<Reasoning>> {
  const identifiedEntries = identifyWorkShellEntries(
    entries,
    new Set(state.entries.flatMap((entry) => entry.id ? [entry.id] : [])),
    state.entries.length,
  );
  const decision = resolveWorkShellAppendEntriesPatchDecision({
    entries: state.entries,
    nextEntries: identifiedEntries,
  });
  return { entries: [...decision.entries] };
}

function identifyWorkShellEntries(
  entries: readonly WorkShellChatEntry[],
  occupied: Set<string>,
  startIndex = 0,
): readonly WorkShellChatEntry[] {
  return entries.map((entry, offset) => {
    if (entry.id) {
      occupied.add(entry.id);
      return entry;
    }
    let suffix = startIndex + offset;
    let id = `entry-${suffix}`;
    while (occupied.has(id)) {
      suffix += 1;
      id = `entry-${suffix}`;
    }
    occupied.add(id);
    // Identity is deliberately enumerable: session/snapshot JSON must retain
    // it so a reattached hook anchors the same transcript entry after restart.
    return { ...entry, id };
  });
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
