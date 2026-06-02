import { createBuiltinStatusPanel } from "./work-shell-engine-builtins.js";
import { runRustCommandSync } from "./rust-command.js";
import type {
  WorkShellChatEntry,
  WorkShellEngineOptions,
  WorkShellPanel,
  WorkShellStatusContext,
} from "./work-shell-engine.js";
import { describeReasoning, type WorkShellReasoningConfig } from "./reasoning.js";

function parseRustPanel(raw: string, expectedTitle: string): WorkShellPanel {
  const parsed = JSON.parse(raw) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { title?: unknown }).title !== expectedTitle ||
    !Array.isArray((parsed as { lines?: unknown }).lines)
  ) {
    throw new Error("Rust panel returned an invalid payload.");
  }
  return {
    title: expectedTitle,
    lines: (parsed as { lines: unknown[] }).lines.filter((line): line is string => typeof line === "string"),
  };
}

function isWorkShellChatRole(role: unknown): role is WorkShellChatEntry["role"] {
  return role === "system" || role === "user" || role === "assistant" || role === "tool";
}

function parseRustChatEntry(value: unknown): WorkShellChatEntry {
  if (
    !value ||
    typeof value !== "object" ||
    !isWorkShellChatRole((value as { role?: unknown }).role) ||
    typeof (value as { text?: unknown }).text !== "string"
  ) {
    throw new Error("Rust transition returned an invalid chat entry.");
  }
  return {
    role: (value as { role: WorkShellChatEntry["role"] }).role,
    text: (value as { text: string }).text,
  };
}

function parseRustChatEntries(raw: string): readonly WorkShellChatEntry[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Rust transition returned an invalid chat entry list.");
  }
  return parsed.map(parseRustChatEntry);
}

function parseRustSingleChatEntry(raw: string): WorkShellChatEntry {
  return parseRustChatEntry(JSON.parse(raw) as unknown);
}

function isWorkShellPanel(value: unknown): value is WorkShellPanel {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { title?: unknown }).title === "string" &&
    Array.isArray((value as { lines?: unknown }).lines) &&
    (value as { lines: unknown[] }).lines.every((line) => typeof line === "string")
  );
}

function parseSensitiveInputCancelResult(raw: string): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly composerMode: "default";
  readonly panel: WorkShellPanel;
} {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Rust sensitive input cancel returned an invalid payload.");
  }
  const candidate = parsed as { entries?: unknown; composerMode?: unknown; panel?: unknown };
  if (
    !Array.isArray(candidate.entries) ||
    !candidate.entries.every((entry) => {
      try {
        parseRustChatEntry(entry);
        return true;
      } catch {
        return false;
      }
    }) ||
    candidate.composerMode !== "default" ||
    !isWorkShellPanel(candidate.panel)
  ) {
    throw new Error("Rust sensitive input cancel returned an invalid payload.");
  }
  return {
    entries: candidate.entries.map(parseRustChatEntry),
    composerMode: "default",
    panel: candidate.panel,
  };
}

function runRustTransition(input: Record<string, unknown>): string {
  return runRustCommandSync(["rust", "ux", "text", "work-shell-transition"], process.cwd(), JSON.stringify(input));
}

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
  expanded?: boolean | undefined;
}): WorkShellPanel {
  return input.buildContextPanel(
    input.contextSummaryLines,
    input.bridgeLines,
    input.memoryLines,
    input.traceLines,
    input.expanded,
  );
}

export function createRecentSessionsLoadingPanel(): WorkShellPanel {
  return parseRustPanel(
    runRustCommandSync(["rust", "ux", "panel", "sessions"], process.cwd(), JSON.stringify({ loading: true })),
    "Recent sessions",
  );
}

export function createRecentSessionsPanel(lines: readonly string[]): WorkShellPanel {
  return parseRustPanel(
    runRustCommandSync(["rust", "ux", "panel", "sessions"], process.cwd(), JSON.stringify({ lines })),
    "Recent sessions",
  );
}

export async function loadRecentSessionsPanel(input: {
  cwd: string;
  listSessionLines: (cwd: string) => Promise<readonly string[]>;
}): Promise<WorkShellPanel> {
  return createRecentSessionsPanel(await input.listSessionLines(input.cwd));
}

export function createWorkspaceReloadEntries(line: string): readonly WorkShellChatEntry[] {
  return parseRustChatEntries(runRustTransition({ kind: "workspace-reload-start", line }));
}

export function createWorkspaceReloadCompleteEntry(): WorkShellChatEntry {
  return parseRustSingleChatEntry(runRustTransition({ kind: "workspace-reload-complete" }));
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
    statusContext?: WorkShellStatusContext,
  ) => WorkShellPanel;
  statusContext?: WorkShellStatusContext;
}): WorkShellPanel {
  return createBuiltinStatusPanel({
    options: input.options,
    stateModel: input.stateModel,
    reasoning: input.reasoning,
    authLabel: input.authLabel,
    ...(input.statusContext ? { statusContext: input.statusContext } : {}),
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
    statusContext?: WorkShellStatusContext,
  ) => WorkShellPanel;
  statusContext?: WorkShellStatusContext;
}): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly composerMode: "default";
  readonly panel: WorkShellPanel;
} {
  void input.buildStatusPanel;
  return parseSensitiveInputCancelResult(
    runRustCommandSync(
      ["rust", "ux", "sensitive-input-cancel-result"],
      process.cwd(),
      JSON.stringify({
        provider: input.options.provider,
        model: input.stateModel,
        mode: input.options.mode,
        cwd: input.options.cwd,
        reasoningLabel: describeReasoning(input.reasoning),
        authLabel: input.authLabel,
        contextSummaryLines: input.statusContext?.contextSummaryLines ?? input.options.contextSummaryLines,
        bridgeLines: input.statusContext?.bridgeLines ?? [],
        memoryLines: input.statusContext?.memoryLines ?? [],
        traceLines: input.statusContext?.traceLines ?? [],
      }),
    ),
  );
}
