import type {
  ResolvedWorkShellBuiltinCommand,
  ResolvedWorkShellLocalCommand,
} from "./work-shell-engine-commands.js";
import { resolvePromptSlashCommand } from "./work-shell-engine-commands.js";
import { runRustCommandSync } from "./rust-command.js";
import type { WorkShellComposerMode } from "./work-shell-engine.js";
import type { WorkShellPromptCommand } from "./work-shell-engine-turns.js";

export type WorkShellSubmitRoute =
  | { readonly kind: "secure-api-key-entry"; readonly line: string }
  | { readonly kind: "builtin"; readonly line: string; readonly command: ResolvedWorkShellBuiltinCommand }
  | { readonly kind: "prompt-command"; readonly line: string; readonly promptCommand: WorkShellPromptCommand }
  | { readonly kind: "inline-command"; readonly line: string; readonly slashCommand: readonly string[] }
  | { readonly kind: "local-command"; readonly line: string; readonly localCommand: ResolvedWorkShellLocalCommand }
  | { readonly kind: "chat"; readonly line: string };

function parseRustSubmitRoute(raw: string): WorkShellSubmitRoute | undefined {
  const parsed = JSON.parse(raw) as Partial<WorkShellSubmitRoute> | { readonly kind?: unknown };
  if (parsed.kind === "ignore") {
    return undefined;
  }
  if (typeof parsed.kind !== "string" || typeof (parsed as { line?: unknown }).line !== "string") {
    throw new Error("Rust submit route returned an invalid payload.");
  }
  const line = (parsed as { line: string }).line;
  switch (parsed.kind) {
    case "secure-api-key-entry":
      return { kind: "secure-api-key-entry", line };
    case "builtin":
      if (!isBuiltinCommand((parsed as { command?: unknown }).command)) {
        throw new Error("Rust submit route returned an invalid builtin command.");
      }
      return { kind: "builtin", line, command: (parsed as { command: ResolvedWorkShellBuiltinCommand }).command };
    case "prompt-command":
      if (!isPromptCommand((parsed as { promptCommand?: unknown }).promptCommand)) {
        throw new Error("Rust submit route returned an invalid prompt command.");
      }
      return { kind: "prompt-command", line, promptCommand: (parsed as { promptCommand: WorkShellPromptCommand }).promptCommand };
    case "inline-command":
      if (!Array.isArray((parsed as { slashCommand?: unknown }).slashCommand) || !(parsed as { slashCommand: unknown[] }).slashCommand.every((item) => typeof item === "string")) {
        throw new Error("Rust submit route returned an invalid inline command.");
      }
      return { kind: "inline-command", line, slashCommand: (parsed as { slashCommand: string[] }).slashCommand };
    case "local-command":
      if (!isLocalCommand((parsed as { localCommand?: unknown }).localCommand)) {
        throw new Error("Rust submit route returned an invalid local command.");
      }
      return { kind: "local-command", line, localCommand: (parsed as { localCommand: ResolvedWorkShellLocalCommand }).localCommand };
    case "chat":
      return { kind: "chat", line };
    default:
      throw new Error("Rust submit route returned an invalid kind.");
  }
}

function isBuiltinCommand(value: unknown): value is ResolvedWorkShellBuiltinCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as { kind?: unknown; traceMode?: unknown; line?: unknown; skillName?: unknown };
  if (typeof command.kind !== "string") return false;
  if (command.kind === "trace-mode") return command.traceMode === "verbose" || command.traceMode === "minimal";
  if (command.kind === "reasoning" || command.kind === "model") return typeof command.line === "string";
  if (command.kind === "skill") return typeof command.line === "string" && (command.skillName === undefined || typeof command.skillName === "string");
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
    "cancel",
    "harness",
    "auth-key",
  ].includes(command.kind);
}

function isPromptCommand(value: unknown): value is WorkShellPromptCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as { kind?: unknown; focus?: unknown };
  return (command.kind === "review" || command.kind === "commit") && (command.focus === undefined || typeof command.focus === "string");
}

function isLocalCommand(value: unknown): value is ResolvedWorkShellLocalCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as { kind?: unknown; scope?: unknown; summary?: unknown; usageError?: unknown };
  if (command.kind === "memories") return true;
  if (command.kind !== "remember") return false;
  if (typeof command.usageError === "string") return true;
  return ["session", "project", "user", "agent"].includes(String(command.scope)) && typeof command.summary === "string";
}

export function resolveWorkShellSubmitRoute(input: {
  value: string;
  isBusy: boolean;
  composerMode: WorkShellComposerMode;
  resolveWorkShellSlashCommand: (input: string) => readonly string[] | undefined;
  hasInlineCommandRunner: boolean;
}): WorkShellSubmitRoute | undefined {
  const route = parseRustSubmitRoute(runRustCommandSync(
    [
      "rust",
      "command",
      "submit-route",
      String(input.isBusy),
      input.composerMode,
      String(input.hasInlineCommandRunner),
    ],
    process.cwd(),
    input.value,
  ));
  if (!route?.line.startsWith("/") || route.kind !== "chat") {
    return route;
  }

  const slashCommand = input.resolveWorkShellSlashCommand(route.line);
  const promptCommand = resolvePromptSlashCommand(slashCommand);
  if (promptCommand) {
    return { kind: "prompt-command", line: route.line, promptCommand };
  }
  if (slashCommand && input.hasInlineCommandRunner) {
    return { kind: "inline-command", line: route.line, slashCommand };
  }

  return route;
}
