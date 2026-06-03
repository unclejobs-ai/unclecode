import type {
  WorkShellLoadedSkill,
  WorkShellMemoryScope,
  WorkShellPanel,
  WorkShellSkillListItem,
} from "./work-shell-engine.js";
import { runRustCommandSync } from "./rust-command.js";

export type ResolvedWorkShellBuiltinCommand =
  | { readonly kind: "exit" }
  | { readonly kind: "clear" }
  | { readonly kind: "help" }
  | { readonly kind: "context" }
  | { readonly kind: "reload" }
  | { readonly kind: "status" }
  | { readonly kind: "sessions" }
  | { readonly kind: "tools" }
  | { readonly kind: "skills" }
  | { readonly kind: "queue" }
  | { readonly kind: "queue-clear" }
  | { readonly kind: "cancel" }
  | { readonly kind: "harness" }
  | { readonly kind: "auth-key" }
  | { readonly kind: "trace-mode"; readonly traceMode: "verbose" | "minimal" }
  | { readonly kind: "reasoning"; readonly line: string }
  | { readonly kind: "model"; readonly line: string }
  | { readonly kind: "skill"; readonly line: string; readonly skillName?: string };

export function resolveWorkShellBuiltinCommand(
  line: string,
): ResolvedWorkShellBuiltinCommand | undefined {
  const parsed = JSON.parse(
    runRustCommandSync(["rust", "command", "builtin-command"], process.cwd(), line),
  ) as unknown;
  if (parsed === null) {
    return undefined;
  }
  if (!isBuiltinCommand(parsed)) {
    throw new Error("Rust builtin command returned an invalid payload.");
  }
  return parsed;
}

function isBuiltinCommand(value: unknown): value is ResolvedWorkShellBuiltinCommand {
  if (!value || typeof value !== "object") {
    return false;
  }
  const command = value as { kind?: unknown; traceMode?: unknown; line?: unknown; skillName?: unknown };
  if (typeof command.kind !== "string") {
    return false;
  }
  if (command.kind === "trace-mode") {
    return command.traceMode === "verbose" || command.traceMode === "minimal";
  }
  if (command.kind === "reasoning" || command.kind === "model") {
    return typeof command.line === "string";
  }
  if (command.kind === "skill") {
    return typeof command.line === "string" && (command.skillName === undefined || typeof command.skillName === "string");
  }
  return [
    "exit",
    "clear",
    "help",
    "context",
    "reload",
    "status",
    "sessions",
    "tools",
    "skills",
    "queue",
    "queue-clear",
    "cancel",
    "harness",
    "auth-key",
  ].includes(command.kind);
}

export function createSecureApiKeyEntryPanel(message = "Paste key. Optional: --org <id> --project <id>."): WorkShellPanel {
  return buildRustUxPanel("auth-secure-entry", { message });
}

export function createSkillsPanel(skills: readonly WorkShellSkillListItem[]): WorkShellPanel {
  return buildRustUxPanel("skills", { skills });
}

export function createQueuePanel(input: {
  readonly isBusy: boolean;
  readonly busyStatus?: string;
  readonly mode?: string;
  readonly workerBudget?: number;
  readonly queuedCount?: number;
  readonly queuedItems?: readonly { readonly id: number; readonly line: string }[];
}): WorkShellPanel {
  return buildRustUxPanel("queue", input);
}

export function createHarnessPanel(input: {
  readonly mode: string;
  readonly workerBudget: number;
  readonly autoContinue: boolean;
}): WorkShellPanel {
  return buildRustUxPanel("harness", input);
}

export function createLoadedSkillPanel(skill: WorkShellLoadedSkill): WorkShellPanel {
  return buildRustUxPanel("skill", skill);
}

function buildRustUxPanel(
  kind: "queue" | "harness" | "skills" | "skill" | "memories" | "auth-secure-entry" | "auth-progress",
  input: unknown,
): WorkShellPanel {
  const parsed = JSON.parse(
    runRustCommandSync(["rust", "ux", "panel", kind], process.cwd(), JSON.stringify(input)),
  ) as unknown;
  if (!isWorkShellPanel(parsed)) {
    throw new Error("Rust UX panel command returned an invalid payload.");
  }
  return parsed;
}

function isWorkShellPanel(value: unknown): value is WorkShellPanel {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { title?: unknown; lines?: unknown };
  return (
    typeof candidate.title === "string" &&
    Array.isArray(candidate.lines) &&
    candidate.lines.every((line) => typeof line === "string")
  );
}

export type ResolvedWorkShellLocalCommand =
  | { readonly kind: "memories" }
  | { readonly kind: "remember"; readonly scope: WorkShellMemoryScope; readonly summary: string }
  | { readonly kind: "remember"; readonly usageError: string };

export function resolveWorkShellLocalCommand(line: string): ResolvedWorkShellLocalCommand | undefined {
  const parsed = JSON.parse(
    runRustCommandSync(["rust", "command", "local-command"], process.cwd(), line),
  ) as unknown;
  if (parsed === null) {
    return undefined;
  }
  if (!isLocalCommand(parsed)) {
    throw new Error("Rust local command returned an invalid payload.");
  }
  return parsed;
}

function isLocalCommand(value: unknown): value is ResolvedWorkShellLocalCommand {
  if (!value || typeof value !== "object") {
    return false;
  }
  const command = value as { kind?: unknown; scope?: unknown; summary?: unknown; usageError?: unknown };
  if (command.kind === "memories") {
    return true;
  }
  if (command.kind !== "remember") {
    return false;
  }
  if (typeof command.usageError === "string") {
    return true;
  }
  return (
    (command.scope === "session" || command.scope === "project" || command.scope === "user" || command.scope === "agent") &&
    typeof command.summary === "string"
  );
}

export function createMemoriesPanel(
  sessionMemory: readonly string[],
  projectMemory: readonly string[],
): WorkShellPanel {
  return buildRustUxPanel("memories", { sessionMemory, projectMemory });
}

export function redactSensitiveInlineCommandArgs(args: readonly string[]): readonly string[] {
  return resolveInlineCommandVisibility({
    line: `/${args.join(" ")}`,
    slashCommand: args,
  }).visibleArgs;
}

export function redactSensitiveInlineCommandLine(line: string): string {
  return resolveInlineCommandVisibility({
    line,
    slashCommand: line.trim().replace(/^\//, "").split(/\s+/).filter(Boolean),
  }).visibleLine;
}

export function resolveVisibleInlineCommand(input: {
  line: string;
  slashCommand: readonly string[];
}): {
  readonly visibleLine: string;
  readonly visibleArgs: readonly string[];
  readonly isAuthCommand: boolean;
  readonly isAuthLogin: boolean;
} {
  return resolveInlineCommandVisibility(input);
}

function resolveInlineCommandVisibility(input: {
  readonly line: string;
  readonly slashCommand: readonly string[];
}): {
  readonly visibleLine: string;
  readonly visibleArgs: readonly string[];
  readonly isAuthCommand: boolean;
  readonly isAuthLogin: boolean;
} {
  const parsed = JSON.parse(
    runRustCommandSync(["rust", "ux", "inline-command-visibility"], process.cwd(), JSON.stringify(input)),
  ) as unknown;
  if (!isInlineCommandVisibility(parsed)) {
    throw new Error("Rust inline command visibility returned an invalid payload.");
  }
  return parsed;
}

function isInlineCommandVisibility(value: unknown): value is {
  readonly visibleLine: string;
  readonly visibleArgs: readonly string[];
  readonly isAuthCommand: boolean;
  readonly isAuthLogin: boolean;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    visibleLine?: unknown;
    visibleArgs?: unknown;
    isAuthCommand?: unknown;
    isAuthLogin?: unknown;
  };
  return (
    typeof candidate.visibleLine === "string" &&
    Array.isArray(candidate.visibleArgs) &&
    candidate.visibleArgs.every((arg) => typeof arg === "string") &&
    typeof candidate.isAuthCommand === "boolean" &&
    typeof candidate.isAuthLogin === "boolean"
  );
}

export function createAuthLoginPendingPanel(): WorkShellPanel {
  return buildRustUxPanel("auth-progress", { progressLines: [] });
}

export function buildAuthProgressPanelLines(progressLines: readonly string[]): readonly string[] {
  return buildRustUxPanel("auth-progress", { progressLines }).lines;
}

export function resolvePromptSlashCommand(
  slashCommand: readonly string[] | undefined,
): { readonly kind: "review" | "commit"; readonly focus?: string } | undefined {
  if (!slashCommand) {
    return undefined;
  }
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "command", "prompt-slash-command"],
      process.cwd(),
      JSON.stringify({ slashCommand }),
    ),
  ) as unknown;
  if (parsed === null) {
    return undefined;
  }
  if (!isPromptSlashCommand(parsed)) {
    throw new Error("Rust prompt slash command returned an invalid payload.");
  }
  return parsed;
}

function isPromptSlashCommand(value: unknown): value is { readonly kind: "review" | "commit"; readonly focus?: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { kind?: unknown; focus?: unknown };
  return (
    (candidate.kind === "review" || candidate.kind === "commit") &&
    (candidate.focus === undefined || typeof candidate.focus === "string")
  );
}

export function buildPromptCommandPrompt(input: {
  readonly kind: "review" | "commit";
  readonly focus?: string;
}): string {
  return runRustCommandSync(
    ["rust", "command", "prompt-command"],
    process.cwd(),
    JSON.stringify(input),
  ).trimEnd();
}
