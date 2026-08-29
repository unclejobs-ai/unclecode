import type {
  ResolvedWorkShellBuiltinCommand,
  ResolvedWorkShellLocalCommand,
} from "./work-shell-engine-commands.js";
import { isAgentConsoleTab, resolvePromptSlashCommand } from "./work-shell-engine-commands.js";
import { runRustCommandSync } from "./rust-command.js";
import type { WorkShellComposerMode } from "./work-shell-engine.js";
import type { WorkShellPromptCommand } from "./work-shell-engine-turns.js";
import { listWorkShellSlashSuggestionEntries } from "./work-shell-slash.js";

export type WorkShellSubmitRoute =
  | { readonly kind: "secure-api-key-entry"; readonly line: string }
  | { readonly kind: "builtin"; readonly line: string; readonly command: ResolvedWorkShellBuiltinCommand }
  | { readonly kind: "prompt-command"; readonly line: string; readonly promptCommand: WorkShellPromptCommand }
  | { readonly kind: "inline-command"; readonly line: string; readonly slashCommand: readonly string[] }
  | { readonly kind: "local-command"; readonly line: string; readonly localCommand: ResolvedWorkShellLocalCommand }
  /**
   * `consoleInvalid` is Rust's verdict that the line is a console-like form
   * that can never run (`/tod`, `/agents extra`). It only ever reaches the
   * unknown-slash leaf below, where it turns the outcome into a silent no-op.
   */
  | { readonly kind: "chat"; readonly line: string; readonly consoleInvalid?: boolean };

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
    case "chat": {
      const consoleInvalid: unknown = "consoleInvalid" in parsed ? parsed.consoleInvalid : undefined;
      if (consoleInvalid !== undefined && typeof consoleInvalid !== "boolean") {
        throw new Error("Rust submit route returned an invalid console marker.");
      }
      return { kind: "chat", line, ...(consoleInvalid === true ? { consoleInvalid: true } : {}) };
    }
    default:
      throw new Error("Rust submit route returned an invalid kind.");
  }
}

function isBuiltinCommand(value: unknown): value is ResolvedWorkShellBuiltinCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as { kind?: unknown; tab?: unknown; traceMode?: unknown; line?: unknown; skillName?: unknown; suggestion?: unknown; consoleInvalid?: unknown; id?: unknown; direction?: unknown };
  if (typeof command.kind !== "string") return false;
  if (command.kind === "agent-console") return isAgentConsoleTab(command.tab);
  if (command.kind === "queue-remove") {
    return typeof command.id === "number" && Number.isSafeInteger(command.id) && command.id > 0;
  }
  if (command.kind === "queue-move") {
    return typeof command.id === "number" && Number.isSafeInteger(command.id) && command.id > 0
      && (command.direction === "up" || command.direction === "down");
  }
  if (command.kind === "trace-mode") return command.traceMode === "verbose" || command.traceMode === "minimal";
  if (command.kind === "reasoning" || command.kind === "model") return typeof command.line === "string";
  if (command.kind === "unknown-slash") return typeof command.line === "string" && (command.suggestion === undefined || typeof command.suggestion === "string") && (command.consoleInvalid === undefined || typeof command.consoleInvalid === "boolean");
  if (command.kind === "skill") return typeof command.line === "string" && (command.skillName === undefined || typeof command.skillName === "string");
  return [
    "exit",
    "clear",
    "help",
    "context",
    "cache",
    "reload",
    "status",
    "sessions",
    "tools",
    "policy",
    "skills",
    "queue",
    "queue-clear",
    "queue-resume",
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

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = leftIndex + 1;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const saved = previous[rightIndex + 1] ?? 0;
      const cost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      const insertion = previous[rightIndex] ?? 0;
      previous[rightIndex + 1] = Math.min(
        (previous[rightIndex + 1] ?? 0) + 1,
        insertion + 1,
        diagonal + cost,
      );
      diagonal = saved;
    }
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function listKnownSlashCommandNames(): readonly string[] {
  const names = new Set<string>();
  for (const entry of listWorkShellSlashSuggestionEntries()) {
    const command = entry.command.trim().toLowerCase();
    if (!command.startsWith("/")) {
      continue;
    }
    names.add(command);
    const rootCommand = command.split(/\s+/, 1)[0];
    if (rootCommand) {
      names.add(rootCommand);
    }
  }
  return [...names].sort();
}

function suggestKnownSlashCommand(line: string): string | undefined {
  const token = line.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (!token || !token.startsWith("/")) {
    return undefined;
  }
  const ranked = listKnownSlashCommandNames()
    .map((command) => ({
      command,
      distance: levenshteinDistance(token, command),
    }))
    .sort((left, right) =>
      left.distance - right.distance ||
      right.command.length - left.command.length ||
      left.command.localeCompare(right.command)
    );
  const best = ranked[0];
  if (!best) {
    return undefined;
  }
  const threshold = token.length <= 5 ? 2 : 3;
  return best.distance <= threshold ? best.command : undefined;
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

  // Rust already decided this line is a console-like form that can never run.
  // Nothing resolved it above, so it ends here as a silent no-op rather than
  // as unknown-command guidance the operator did not ask for.
  if (route.consoleInvalid) {
    return {
      kind: "builtin",
      line: route.line,
      command: { kind: "unknown-slash", line: route.line, consoleInvalid: true },
    };
  }

  const suggestion = suggestKnownSlashCommand(route.line);
  return {
    kind: "builtin",
    line: route.line,
    command: {
      kind: "unknown-slash",
      line: route.line,
      ...(suggestion ? { suggestion } : {}),
    },
  };
}
