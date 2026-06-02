import { runRustCommandSync } from "./rust-command.js";
import type {
  WorkShellChatEntry,
  WorkShellEngineOptions,
  WorkShellEngineState,
  WorkShellLoadedSkill,
  WorkShellPanel,
  WorkShellStatusContext,
  WorkShellSkillListItem,
  WorkShellTraceMode,
} from "./work-shell-engine.js";
import { describeReasoning, type WorkShellReasoningConfig } from "./reasoning.js";

export function createBuiltinTranscriptEntries(
  line: string,
  systemText: string,
): readonly WorkShellChatEntry[] {
  return [
    { role: "user", text: line },
    { role: "system", text: systemText },
  ];
}

export function createClearBuiltinResult(line: string): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly patch: { readonly entries: readonly WorkShellChatEntry[] };
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "clear-command"],
      process.cwd(),
      JSON.stringify({ line }),
    ),
  ) as unknown;
  if (!isClearBuiltinResult(parsed)) {
    throw new Error("Rust clear command returned an invalid payload.");
  }
  return {
    entries: parsed.entries,
    patch: parsed.patch,
  };
}

function isClearBuiltinResult(value: unknown): value is {
  entries: readonly WorkShellChatEntry[];
  patch: { entries: readonly WorkShellChatEntry[] };
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { entries?: unknown; patch?: unknown };
  const patch = candidate.patch as { entries?: unknown } | undefined;
  return (
    Array.isArray(candidate.entries) &&
    candidate.entries.every(isWorkShellChatEntry) &&
    typeof patch === "object" &&
    patch !== null &&
    Array.isArray(patch.entries) &&
    patch.entries.every(isWorkShellChatEntry)
  );
}

export function createHelpBuiltinResult(line: string, buildHelpPanel: () => WorkShellPanel): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly panel: WorkShellPanel;
} {
  void buildHelpPanel;
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "help-command"],
      process.cwd(),
      JSON.stringify({ line }),
    ),
  ) as unknown;
  if (!isPanelBuiltinResult(parsed)) {
    throw new Error("Rust help command returned an invalid payload.");
  }
  return {
    entries: parsed.entries,
    panel: parsed.panel,
  };
}

export function createHarnessBuiltinResult(input: {
  line: string;
  mode: string;
  workerBudget: number;
  autoContinue: boolean;
}): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly panel: WorkShellPanel;
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "harness-command"],
      process.cwd(),
      JSON.stringify(input),
    ),
  ) as unknown;
  if (!isPanelBuiltinResult(parsed)) {
    throw new Error("Rust harness command returned an invalid payload.");
  }
  return {
    entries: parsed.entries,
    panel: parsed.panel,
  };
}

export function createSessionsBuiltinResult(line: string): {
  readonly entries: readonly WorkShellChatEntry[];
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "sessions-command"],
      process.cwd(),
      JSON.stringify({ line }),
    ),
  ) as unknown;
  if (!isEntriesOnlyResult(parsed)) {
    throw new Error("Rust sessions command returned an invalid payload.");
  }
  return parsed;
}

export function createReloadBuiltinResult(line: string): {
  readonly startEntries: readonly WorkShellChatEntry[];
  readonly completeEntry: WorkShellChatEntry;
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "reload-command"],
      process.cwd(),
      JSON.stringify({ line }),
    ),
  ) as unknown;
  if (!isReloadBuiltinResult(parsed)) {
    throw new Error("Rust reload command returned an invalid payload.");
  }
  return parsed;
}

function isReloadBuiltinResult(value: unknown): value is {
  startEntries: readonly WorkShellChatEntry[];
  completeEntry: WorkShellChatEntry;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { startEntries?: unknown; completeEntry?: unknown };
  return (
    Array.isArray(candidate.startEntries) &&
    candidate.startEntries.every(isWorkShellChatEntry) &&
    isWorkShellChatEntry(candidate.completeEntry)
  );
}

export function createMemoriesLocalCommandResult<Reasoning extends WorkShellReasoningConfig>(input: {
  readonly line: string;
  readonly sessionMemory: readonly string[];
  readonly projectMemory: readonly string[];
}): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly patch: Partial<WorkShellEngineState<Reasoning>>;
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "memories-command"],
      process.cwd(),
      JSON.stringify(input),
    ),
  ) as unknown;
  if (!isMemoryCommandResult(parsed)) {
    throw new Error("Rust memories command returned an invalid payload.");
  }
  return {
    entries: parsed.entries,
    patch: parsed.patch as Partial<WorkShellEngineState<Reasoning>>,
  };
}

export function createRememberUsageErrorResult(line: string, usageError: string): {
  readonly entries: readonly WorkShellChatEntry[];
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "remember-command"],
      process.cwd(),
      JSON.stringify({ line, usageError }),
    ),
  ) as unknown;
  if (!isEntriesOnlyResult(parsed)) {
    throw new Error("Rust remember command returned an invalid usage payload.");
  }
  return parsed;
}

export function createRememberLocalCommandResult<Reasoning extends WorkShellReasoningConfig>(input: {
  readonly line: string;
  readonly scope: "session" | "project" | "user" | "agent";
  readonly memoryTrace: string;
  readonly nextMemoryLines: readonly string[];
}): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly patch?: Partial<WorkShellEngineState<Reasoning>>;
  readonly traceLine: string;
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "remember-command"],
      process.cwd(),
      JSON.stringify(input),
    ),
  ) as unknown;
  if (!isRememberCommandResult(parsed)) {
    throw new Error("Rust remember command returned an invalid payload.");
  }
  return {
    entries: parsed.entries,
    ...(parsed.patch ? { patch: parsed.patch as Partial<WorkShellEngineState<Reasoning>> } : {}),
    traceLine: parsed.traceLine,
  };
}

function isMemoryCommandResult(value: unknown): value is {
  entries: readonly WorkShellChatEntry[];
  patch: { memoryLines: readonly string[]; panel: WorkShellPanel };
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { entries?: unknown; patch?: unknown };
  const patch = candidate.patch as { memoryLines?: unknown; panel?: unknown } | undefined;
  return (
    Array.isArray(candidate.entries) &&
    candidate.entries.every(isWorkShellChatEntry) &&
    typeof patch === "object" &&
    patch !== null &&
    isStringArray(patch.memoryLines) &&
    isWorkShellPanel(patch.panel)
  );
}

function isRememberCommandResult(value: unknown): value is {
  entries: readonly WorkShellChatEntry[];
  patch?: { memoryLines: readonly string[] };
  traceLine: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { entries?: unknown; patch?: unknown; traceLine?: unknown };
  if (!Array.isArray(candidate.entries) || !candidate.entries.every(isWorkShellChatEntry)) {
    return false;
  }
  if (typeof candidate.traceLine !== "string") {
    return false;
  }
  if (candidate.patch === undefined) {
    return true;
  }
  const patch = candidate.patch as { memoryLines?: unknown };
  return typeof candidate.patch === "object" && candidate.patch !== null && isStringArray(patch.memoryLines);
}

function isPanelBuiltinResult(value: unknown): value is {
  entries: readonly WorkShellChatEntry[];
  panel: WorkShellPanel;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { entries?: unknown; panel?: unknown };
  return (
    Array.isArray(candidate.entries) &&
    candidate.entries.every(isWorkShellChatEntry) &&
    isWorkShellPanel(candidate.panel)
  );
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
  void input.buildContextPanel;
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "context-command"],
      process.cwd(),
      JSON.stringify({
        line: input.line,
        contextSummaryLines: input.contextSummaryLines,
        bridgeLines: input.state.bridgeLines,
        memoryLines: input.state.memoryLines,
        traceLines: input.state.traceLines,
      }),
    ),
  ) as unknown;
  if (!isPanelBuiltinResult(parsed)) {
    throw new Error("Rust context command returned an invalid payload.");
  }
  return {
    entries: parsed.entries,
    panel: parsed.panel,
  };
}

export function createStatusBuiltinResult<Reasoning extends WorkShellReasoningConfig>(input: {
  line: string;
  options: WorkShellEngineOptions<Reasoning>;
  stateModel: string;
  reasoning: Reasoning;
  authLabel: string;
  statusContext: WorkShellStatusContext;
  isBusy?: boolean;
  busyStatus?: string | undefined;
  currentTurnStartedAt?: number | undefined;
  lastTurnDurationMs?: number | undefined;
  nowMs?: number | undefined;
  buildStatusPanel: (
    reasoning: Reasoning,
    authLabel: string,
    statusContext: WorkShellStatusContext,
  ) => WorkShellPanel;
}): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly panel: WorkShellPanel;
} {
  void input.buildStatusPanel;
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "status-command"],
      process.cwd(),
      JSON.stringify({
        line: input.line,
        provider: input.options.provider,
        model: input.stateModel,
        mode: input.options.mode,
        cwd: input.options.cwd,
        reasoningLabel: describeReasoning(input.reasoning),
        authLabel: input.authLabel,
        contextSummaryLines: input.statusContext.contextSummaryLines,
        bridgeLines: input.statusContext.bridgeLines,
        memoryLines: input.statusContext.memoryLines,
        traceLines: input.statusContext.traceLines,
        ...(input.isBusy !== undefined ? { isBusy: input.isBusy } : {}),
        ...(input.busyStatus ? { busyStatus: input.busyStatus } : {}),
        ...(input.currentTurnStartedAt !== undefined
          ? { currentTurnStartedAt: input.currentTurnStartedAt }
          : {}),
        ...(input.lastTurnDurationMs !== undefined
          ? { lastTurnDurationMs: input.lastTurnDurationMs }
          : {}),
        ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
      }),
    ),
  ) as unknown;
  if (!isPanelBuiltinResult(parsed)) {
    throw new Error("Rust status command returned an invalid payload.");
  }
  return {
    entries: parsed.entries,
    panel: parsed.panel,
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
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "trace-mode-command"],
      process.cwd(),
      JSON.stringify({
        line: input.line,
        traceMode: input.traceMode,
        contextSummaryLines: input.contextSummaryLines,
        bridgeLines: input.state.bridgeLines,
        memoryLines: input.state.memoryLines,
        traceLines: input.state.traceLines,
      }),
    ),
  ) as unknown;
  if (!isTraceModeBuiltinResult(parsed)) {
    throw new Error("Rust trace mode command returned an invalid payload.");
  }
  return {
    entries: parsed.entries,
    patch: parsed.patch as Partial<WorkShellEngineState<Reasoning>>,
  };
}

function isTraceModeBuiltinResult(value: unknown): value is {
  entries: readonly WorkShellChatEntry[];
  patch: {
    traceMode?: WorkShellTraceMode;
    traceLines?: readonly string[];
    panel?: WorkShellPanel;
  };
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { entries?: unknown; patch?: unknown };
  return (
    Array.isArray(candidate.entries) &&
    candidate.entries.every(isWorkShellChatEntry) &&
    typeof candidate.patch === "object" &&
    candidate.patch !== null &&
    isTraceModePatch(candidate.patch)
  );
}

function isWorkShellChatEntry(value: unknown): value is WorkShellChatEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { role?: unknown; text?: unknown };
  return (
    (candidate.role === "user" || candidate.role === "assistant" || candidate.role === "system" || candidate.role === "tool") &&
    typeof candidate.text === "string"
  );
}

function isTraceModePatch(value: object): boolean {
  const candidate = value as { traceMode?: unknown; traceLines?: unknown; panel?: unknown };
  if (candidate.traceMode !== "verbose" && candidate.traceMode !== "minimal") return false;
  if (candidate.traceLines !== undefined && !isStringArray(candidate.traceLines)) return false;
  return candidate.panel === undefined || isWorkShellPanel(candidate.panel);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isWorkShellPanel(value: unknown): value is WorkShellPanel {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { title?: unknown; lines?: unknown };
  return typeof candidate.title === "string" && isStringArray(candidate.lines);
}

export function resolveReasoningBuiltinResult<Reasoning extends WorkShellReasoningConfig>(input: {
  line: string;
  options: WorkShellEngineOptions<Reasoning>;
  stateModel: string;
  currentReasoning: Reasoning;
  modeDefaultReasoning: Reasoning;
  authLabel: string;
  statusContext?: WorkShellStatusContext;
  buildStatusPanel: (
    reasoning: Reasoning,
    authLabel: string,
    statusContext?: WorkShellStatusContext,
  ) => WorkShellPanel;
}): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly nextReasoning: Reasoning;
  readonly panel: WorkShellPanel;
} {
  void input.buildStatusPanel;
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "reasoning-builtin-command"],
      process.cwd(),
      JSON.stringify({
        line: input.line,
        provider: input.options.provider,
        model: input.stateModel,
        mode: input.options.mode,
        cwd: input.options.cwd,
        authLabel: input.authLabel,
        currentReasoning: input.currentReasoning,
        modeDefaultReasoning: input.modeDefaultReasoning,
        contextSummaryLines: input.statusContext?.contextSummaryLines ?? [],
        bridgeLines: input.statusContext?.bridgeLines ?? [],
        memoryLines: input.statusContext?.memoryLines ?? [],
        traceLines: input.statusContext?.traceLines ?? [],
      }),
    ),
  ) as unknown;
  if (!isReasoningBuiltinResult(parsed)) {
    throw new Error("Rust reasoning builtin command returned an invalid payload.");
  }
  return {
    entries: parsed.entries,
    nextReasoning: parsed.nextReasoning as Reasoning,
    panel: parsed.panel,
  };
}

function isReasoningBuiltinResult(value: unknown): value is {
  entries: readonly WorkShellChatEntry[];
  nextReasoning: WorkShellReasoningConfig;
  panel: WorkShellPanel;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { entries?: unknown; nextReasoning?: unknown; panel?: unknown };
  return (
    Array.isArray(candidate.entries) &&
    candidate.entries.every(isWorkShellChatEntry) &&
    isReasoningConfig(candidate.nextReasoning) &&
    isWorkShellPanel(candidate.panel)
  );
}

function isReasoningConfig(value: unknown): value is WorkShellReasoningConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { effort?: unknown; source?: unknown; support?: unknown };
  return (
    typeof candidate.effort === "string" &&
    typeof candidate.source === "string" &&
    typeof candidate.support === "object" &&
    candidate.support !== null
  );
}

export function resolveModelBuiltinResult<Reasoning extends WorkShellReasoningConfig>(input: {
  line: string;
  provider: string;
  currentModel: string;
  currentReasoning: Reasoning;
  modeDefaultReasoning: Reasoning;
}): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly nextModel: string;
  readonly nextReasoning: Reasoning;
  readonly panel: WorkShellPanel;
  readonly shouldUpdateRuntime: boolean;
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "model-builtin-command"],
      process.cwd(),
      JSON.stringify({
        line: input.line,
        provider: input.provider,
        currentModel: input.currentModel,
        currentReasoning: input.currentReasoning,
        modeDefaultReasoning: input.modeDefaultReasoning,
      }),
    ),
  ) as unknown;
  if (!isModelBuiltinResult(parsed)) {
    throw new Error("Rust model builtin command returned an invalid payload.");
  }
  return {
    entries: parsed.entries,
    nextModel: parsed.nextModel,
    nextReasoning: parsed.nextReasoning as Reasoning,
    panel: parsed.panel,
    shouldUpdateRuntime:
      parsed.nextModel !== input.currentModel ||
      JSON.stringify(parsed.nextReasoning) !== JSON.stringify(input.currentReasoning),
  };
}

function isModelBuiltinResult(value: unknown): value is {
  entries: readonly WorkShellChatEntry[];
  nextModel: string;
  nextReasoning: WorkShellReasoningConfig;
  panel: WorkShellPanel;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    entries?: unknown;
    nextModel?: unknown;
    nextReasoning?: unknown;
    panel?: unknown;
  };
  return (
    Array.isArray(candidate.entries) &&
    candidate.entries.every(isWorkShellChatEntry) &&
    typeof candidate.nextModel === "string" &&
    isReasoningConfig(candidate.nextReasoning) &&
    isWorkShellPanel(candidate.panel)
  );
}

export function createToolsBuiltinResult(line: string, toolLines: readonly string[]): readonly WorkShellChatEntry[] {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "tools-command"],
      process.cwd(),
      JSON.stringify({ line, toolLines }),
    ),
  ) as unknown;
  if (!isEntriesOnlyResult(parsed)) {
    throw new Error("Rust tools command returned an invalid payload.");
  }
  return parsed.entries;
}

function isEntriesOnlyResult(value: unknown): value is { entries: readonly WorkShellChatEntry[] } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { entries?: unknown };
  return Array.isArray(candidate.entries) && candidate.entries.every(isWorkShellChatEntry);
}

export function createAuthKeyBuiltinResult(line: string): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly composerMode: "api-key-entry";
  readonly panel: WorkShellPanel;
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "auth-key-command"],
      process.cwd(),
      JSON.stringify({ line }),
    ),
  ) as unknown;
  if (!isAuthKeyBuiltinResult(parsed)) {
    throw new Error("Rust auth key command returned an invalid payload.");
  }
  return {
    entries: parsed.entries,
    composerMode: parsed.composerMode,
    panel: parsed.panel,
  };
}

function isAuthKeyBuiltinResult(value: unknown): value is {
  entries: readonly WorkShellChatEntry[];
  composerMode: "api-key-entry";
  panel: WorkShellPanel;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { entries?: unknown; composerMode?: unknown; panel?: unknown };
  return (
    Array.isArray(candidate.entries) &&
    candidate.entries.every(isWorkShellChatEntry) &&
    candidate.composerMode === "api-key-entry" &&
    isWorkShellPanel(candidate.panel)
  );
}

export function createSkillsBuiltinResult(
  line: string,
  skills: readonly WorkShellSkillListItem[],
): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly panel: WorkShellPanel;
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "skills-command"],
      process.cwd(),
      JSON.stringify({ line, skills }),
    ),
  ) as unknown;
  if (!isSkillsBuiltinResult(parsed)) {
    throw new Error("Rust skills command returned an invalid payload.");
  }
  return {
    entries: parsed.entries,
    panel: parsed.panel,
  };
}

function isSkillsBuiltinResult(value: unknown): value is {
  entries: readonly WorkShellChatEntry[];
  panel: WorkShellPanel;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { entries?: unknown; panel?: unknown };
  return (
    Array.isArray(candidate.entries) &&
    candidate.entries.every(isWorkShellChatEntry) &&
    isWorkShellPanel(candidate.panel)
  );
}

export function createQueueBuiltinResult(input: {
  readonly line: string;
  readonly isBusy: boolean;
  readonly busyStatus?: string;
  readonly mode?: string;
  readonly workerBudget?: number;
  readonly queuedCount?: number;
  readonly queuedItems?: readonly { readonly id: number; readonly line: string }[];
  readonly transcriptText?: string;
}): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly panel: WorkShellPanel;
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "queue-command"],
      process.cwd(),
      JSON.stringify(input),
    ),
  ) as unknown;
  if (!isPanelBuiltinResult(parsed)) {
    throw new Error("Rust queue command returned an invalid payload.");
  }
  return {
    entries: parsed.entries,
    panel: parsed.panel,
  };
}

export function createSkillUsageErrorEntries(line: string): readonly WorkShellChatEntry[] {
  return parseSkillCommandResult({ line }).entries;
}

export function createLoadedSkillBuiltinResult(
  line: string,
  skill: WorkShellLoadedSkill,
): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly panel: WorkShellPanel;
} {
  const result = parseSkillCommandResult({ line, skill });
  if (!result.panel) {
    throw new Error("Rust skill command returned an invalid payload.");
  }
  return { entries: result.entries, panel: result.panel };
}

export function createSkillLoadErrorEntries(
  line: string,
  error: unknown,
): readonly WorkShellChatEntry[] {
  return parseSkillCommandResult({
    line,
    error: error instanceof Error ? error.message : String(error),
  }).entries;
}

function parseSkillCommandResult(input: {
  readonly line: string;
  readonly skill?: WorkShellLoadedSkill;
  readonly error?: string;
}): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly panel?: WorkShellPanel;
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "skill-command"],
      process.cwd(),
      JSON.stringify(input),
    ),
  ) as unknown;
  if (!isSkillCommandResult(parsed)) {
    throw new Error("Rust skill command returned an invalid payload.");
  }
  return parsed;
}

function isSkillCommandResult(value: unknown): value is {
  entries: readonly WorkShellChatEntry[];
  panel?: WorkShellPanel;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { entries?: unknown; panel?: unknown };
  return (
    Array.isArray(candidate.entries) &&
    candidate.entries.every(isWorkShellChatEntry) &&
    (candidate.panel === undefined || isWorkShellPanel(candidate.panel))
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
    statusContext?: WorkShellStatusContext,
  ) => WorkShellPanel;
  statusContext?: WorkShellStatusContext;
}): WorkShellPanel {
  return input.buildStatusPanel(
    {
      ...input.options,
      model: input.stateModel,
    },
    input.reasoning,
    input.authLabel,
    input.statusContext,
  );
}
