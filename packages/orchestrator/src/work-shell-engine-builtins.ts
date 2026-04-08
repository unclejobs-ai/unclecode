import {
  createLoadedSkillPanel,
  createSecureApiKeyEntryPanel,
  createSkillsPanel,
} from "./work-shell-engine-commands.js";
import { createWorkShellTraceModePatch } from "./work-shell-engine-state.js";
import type {
  WorkShellChatEntry,
  WorkShellEngineOptions,
  WorkShellEngineState,
  WorkShellLoadedSkill,
  WorkShellPanel,
  WorkShellSkillListItem,
  WorkShellTraceMode,
} from "./work-shell-engine.js";
import type { WorkShellReasoningConfig } from "./reasoning.js";

export function createBuiltinTranscriptEntries(
  line: string,
  systemText: string,
): readonly WorkShellChatEntry[] {
  return [
    { role: "user", text: line },
    { role: "system", text: systemText },
  ];
}

export function createHelpBuiltinResult(line: string, buildHelpPanel: () => WorkShellPanel): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly panel: WorkShellPanel;
} {
  return {
    entries: createBuiltinTranscriptEntries(line, "Help shown."),
    panel: buildHelpPanel(),
  };
}

export function createContextBuiltinResult<Reasoning extends WorkShellReasoningConfig>(input: {
  line: string;
  contextSummaryLines: readonly string[];
  state: WorkShellEngineState<Reasoning>;
  buildContextPanel: (
    contextSummaryLines: readonly string[],
    bridgeLines: readonly string[],
    memoryLines: readonly string[],
    traceLines: readonly string[],
    expanded?: boolean,
  ) => WorkShellPanel;
}): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly panel: WorkShellPanel;
} {
  return {
    entries: createBuiltinTranscriptEntries(input.line, "Context shown."),
    panel: input.buildContextPanel(
      input.contextSummaryLines,
      input.state.bridgeLines,
      input.state.memoryLines,
      input.state.traceLines,
      true,
    ),
  };
}

export function createStatusBuiltinResult<Reasoning extends WorkShellReasoningConfig>(input: {
  line: string;
  reasoning: Reasoning;
  authLabel: string;
  buildStatusPanel: (reasoning: Reasoning, authLabel: string) => WorkShellPanel;
}): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly panel: WorkShellPanel;
} {
  return {
    entries: createBuiltinTranscriptEntries(input.line, "Status shown. Live steps return on the next action."),
    panel: input.buildStatusPanel(input.reasoning, input.authLabel),
  };
}

export function createTraceModeBuiltinResult<Reasoning extends WorkShellReasoningConfig>(input: {
  line: string;
  traceMode: WorkShellTraceMode;
  state: WorkShellEngineState<Reasoning>;
  contextSummaryLines: readonly string[];
  buildContextPanel: (
    contextSummaryLines: readonly string[],
    bridgeLines: readonly string[],
    memoryLines: readonly string[],
    traceLines: readonly string[],
    expanded?: boolean,
  ) => WorkShellPanel;
}): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly patch: Partial<WorkShellEngineState<Reasoning>>;
} {
  return {
    entries: createBuiltinTranscriptEntries(
      input.line,
      input.traceMode === "verbose" ? "Verbose trace mode enabled." : "Minimal trace mode enabled.",
    ),
    patch: createWorkShellTraceModePatch({
      state: input.state,
      traceMode: input.traceMode,
      contextSummaryLines: input.contextSummaryLines,
      buildContextPanel: input.buildContextPanel,
    }),
  };
}

export function resolveReasoningBuiltinResult<Reasoning extends WorkShellReasoningConfig>(input: {
  line: string;
  currentReasoning: Reasoning;
  modeDefaultReasoning: Reasoning;
  authLabel: string;
  resolveReasoningCommand: (
    input: string,
    reasoning: Reasoning,
    modeDefault: Reasoning,
  ) => { nextReasoning: Reasoning; message: string };
  buildStatusPanel: (reasoning: Reasoning, authLabel: string) => WorkShellPanel;
}): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly nextReasoning: Reasoning;
  readonly panel: WorkShellPanel;
} {
  const result = input.resolveReasoningCommand(
    input.line,
    input.currentReasoning,
    input.modeDefaultReasoning,
  );
  return {
    entries: createBuiltinTranscriptEntries(input.line, result.message),
    nextReasoning: result.nextReasoning,
    panel: input.buildStatusPanel(result.nextReasoning, input.authLabel),
  };
}

export function resolveModelBuiltinResult<Reasoning extends WorkShellReasoningConfig>(input: {
  line: string;
  currentModel: string;
  currentReasoning: Reasoning;
  modeDefaultReasoning: Reasoning;
  resolveModelCommand?: ((
    input: string,
    currentModel: string,
    currentReasoning: Reasoning,
    modeDefault: Reasoning,
  ) => {
    readonly nextModel: string;
    readonly nextReasoning: Reasoning;
    readonly message: string;
    readonly panel: WorkShellPanel;
  } | undefined) | undefined;
}): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly nextModel: string;
  readonly nextReasoning: Reasoning;
  readonly panel: WorkShellPanel;
  readonly shouldUpdateRuntime: boolean;
} | undefined {
  const result = input.resolveModelCommand?.(
    input.line,
    input.currentModel,
    input.currentReasoning,
    input.modeDefaultReasoning,
  );
  if (!result) {
    return undefined;
  }

  return {
    entries: createBuiltinTranscriptEntries(input.line, result.message),
    nextModel: result.nextModel,
    nextReasoning: result.nextReasoning,
    panel: result.panel,
    shouldUpdateRuntime:
      result.nextModel !== input.currentModel || result.nextReasoning !== input.currentReasoning,
  };
}

export function createToolsBuiltinResult(line: string, toolLines: readonly string[]): readonly WorkShellChatEntry[] {
  return createBuiltinTranscriptEntries(line, toolLines.join("\n"));
}

export function createAuthKeyBuiltinResult(line: string): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly composerMode: "api-key-entry";
  readonly panel: WorkShellPanel;
} {
  return {
    entries: [{ role: "user", text: line }],
    composerMode: "api-key-entry",
    panel: createSecureApiKeyEntryPanel(),
  };
}

export function createSkillsBuiltinResult(
  line: string,
  skills: readonly WorkShellSkillListItem[],
): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly panel: WorkShellPanel;
} {
  return {
    entries: createBuiltinTranscriptEntries(
      line,
      skills.length > 0 ? `Loaded ${skills.length} skills.` : "No skills found.",
    ),
    panel: createSkillsPanel(skills),
  };
}

export function createSkillUsageErrorEntries(line: string): readonly WorkShellChatEntry[] {
  return createBuiltinTranscriptEntries(line, "Usage: /skill <name>");
}

export function createLoadedSkillBuiltinResult(
  line: string,
  skill: WorkShellLoadedSkill,
): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly panel: WorkShellPanel;
} {
  return {
    entries: [
      { role: "user", text: line },
      ...skill.attempts.flatMap((attempt) => [
        { role: "tool" as const, text: `read ${attempt.path}` },
        ...(attempt.ok ? [] : [{ role: "system" as const, text: attempt.error ?? "Failed to read skill." }]),
      ]),
      { role: "system", text: `Loaded skill ${skill.name}.` },
    ],
    panel: createLoadedSkillPanel(skill),
  };
}

export function createSkillLoadErrorEntries(
  line: string,
  error: unknown,
): readonly WorkShellChatEntry[] {
  return createBuiltinTranscriptEntries(
    line,
    error instanceof Error ? error.message : String(error),
  );
}

export function createBuiltinStatusPanel<Reasoning extends WorkShellReasoningConfig>(input: {
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
  return input.buildStatusPanel(
    {
      ...input.options,
      model: input.stateModel,
    },
    input.reasoning,
    input.authLabel,
  );
}
