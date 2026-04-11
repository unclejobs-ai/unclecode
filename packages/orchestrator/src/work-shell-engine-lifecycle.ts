import { loadInitialWorkShellContextState } from "./work-shell-engine-context.js";
import {
  createCollapsedContextPanel,
  createRecentSessionsLoadingPanel,
  createSensitiveInputCancelResult,
  loadRecentSessionsPanel,
} from "./work-shell-engine-panels.js";
import type {
  WorkShellChatEntry,
  WorkShellComposerMode,
  WorkShellEngineOptions,
  WorkShellPanel,
} from "./work-shell-engine.js";
import type { WorkShellReasoningConfig } from "./reasoning.js";

type BuildContextPanel = (
  contextSummaryLines: readonly string[],
  bridgeLines: readonly string[],
  memoryLines: readonly string[],
  traceLines: readonly string[],
  expanded?: boolean,
) => WorkShellPanel;

export async function loadInitialWorkShellLifecycleState(input: {
  cwd: string;
  sessionId: string;
  currentContextSummaryLines: readonly string[];
  listProjectBridgeLines: (cwd: string) => Promise<readonly string[]>;
  listScopedMemoryLines: (input: {
    scope: "session" | "project" | "user" | "agent";
    cwd: string;
    sessionId?: string;
    agentId?: string;
  }) => Promise<readonly string[]>;
  buildContextPanel: BuildContextPanel;
}): Promise<{
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
  readonly panel: WorkShellPanel;
}> {
  return loadInitialWorkShellContextState(input).catch(() => ({
    bridgeLines: [],
    memoryLines: [],
    panel: createCollapsedContextPanel({
      contextSummaryLines: input.currentContextSummaryLines,
      bridgeLines: [],
      memoryLines: [],
      traceLines: [],
      buildContextPanel: input.buildContextPanel,
    }),
  }));
}

export async function loadOpenSessionsPanelState(input: {
  cwd: string;
  listSessionLines: (cwd: string) => Promise<readonly string[]>;
}): Promise<{
  readonly loadingPanel: WorkShellPanel;
  readonly loadedPanel: WorkShellPanel;
}> {
  return {
    loadingPanel: createRecentSessionsLoadingPanel(),
    loadedPanel: await loadRecentSessionsPanel(input),
  };
}

export function resolveSensitiveInputCancelState<Reasoning extends WorkShellReasoningConfig>(input: {
  composerMode: WorkShellComposerMode;
  options: WorkShellEngineOptions<Reasoning>;
  stateModel: string;
  reasoning: Reasoning;
  authLabel: string;
  buildStatusPanel: (
    options: WorkShellEngineOptions<Reasoning>,
    reasoning: Reasoning,
    authLabel: string,
  ) => WorkShellPanel;
}): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly composerMode: "default";
  readonly panel: WorkShellPanel;
} | undefined {
  if (input.composerMode === "default") {
    return undefined;
  }

  return createSensitiveInputCancelResult({
    options: input.options,
    stateModel: input.stateModel,
    reasoning: input.reasoning,
    authLabel: input.authLabel,
    buildStatusPanel: input.buildStatusPanel,
  });
}

export function resolveCloseOverlayState(input: {
  panel: WorkShellPanel;
  currentContextSummaryLines: readonly string[];
  bridgeLines: readonly string[];
  memoryLines: readonly string[];
  traceLines: readonly string[];
  buildContextPanel: BuildContextPanel;
}): WorkShellPanel | undefined {
  if (input.panel.title !== "Context expanded") {
    return undefined;
  }

  return createCollapsedContextPanel({
    contextSummaryLines: input.currentContextSummaryLines,
    bridgeLines: input.bridgeLines,
    memoryLines: input.memoryLines,
    traceLines: input.traceLines,
    buildContextPanel: input.buildContextPanel,
  });
}
