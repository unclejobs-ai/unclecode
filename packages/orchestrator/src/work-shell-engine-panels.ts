import { createBuiltinStatusPanel } from "./work-shell-engine-builtins.js";
import type {
  WorkShellChatEntry,
  WorkShellEngineOptions,
  WorkShellPanel,
} from "./work-shell-engine.js";
import type { WorkShellReasoningConfig } from "./reasoning.js";

export function createCollapsedContextPanel(input: {
  contextSummaryLines: readonly string[];
  bridgeLines: readonly string[];
  memoryLines: readonly string[];
  traceLines: readonly string[];
  buildContextPanel: (
    contextSummaryLines: readonly string[],
    bridgeLines: readonly string[],
    memoryLines: readonly string[],
    traceLines: readonly string[],
    expanded?: boolean,
  ) => WorkShellPanel;
}): WorkShellPanel {
  return input.buildContextPanel(
    input.contextSummaryLines,
    input.bridgeLines,
    input.memoryLines,
    input.traceLines,
  );
}

export function createRecentSessionsLoadingPanel(): WorkShellPanel {
  return {
    title: "Recent sessions",
    lines: ["Loading sessions…"],
  };
}

export function createRecentSessionsPanel(lines: readonly string[]): WorkShellPanel {
  return {
    title: "Recent sessions",
    lines,
  };
}

export function createWorkShellStatusPanel<Reasoning extends WorkShellReasoningConfig>(input: {
  options: WorkShellEngineOptions<Reasoning>;
  stateModel: string;
  reasoning: Reasoning;
  authLabel: string;
  buildStatusPanel: (
    options: WorkShellEngineOptions<Reasoning>,
    reasoning: Reasoning,
    authLabel: string,
  ) => WorkShellPanel;
}): WorkShellPanel {
  return createBuiltinStatusPanel({
    options: input.options,
    stateModel: input.stateModel,
    reasoning: input.reasoning,
    authLabel: input.authLabel,
    buildStatusPanel: input.buildStatusPanel,
  });
}

export function createSensitiveInputCancelResult<Reasoning extends WorkShellReasoningConfig>(input: {
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
} {
  return {
    entries: [{ role: "system", text: "API key entry canceled." }],
    composerMode: "default",
    panel: createWorkShellStatusPanel({
      options: input.options,
      stateModel: input.stateModel,
      reasoning: input.reasoning,
      authLabel: input.authLabel,
      buildStatusPanel: input.buildStatusPanel,
    }),
  };
}
