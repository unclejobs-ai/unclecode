import { runRustCommandSync } from "./rust-command.js";
import {
  formatScopedMemoryTransparencyLines,
} from "@unclecode/context-broker";

export async function resolveSecureApiKeyEntrySubmission(input: {
  line: string;
  currentAuthLabel: string;
  saveApiKeyAuth?: ((raw: string) => Promise<readonly string[]>) | undefined;
  refreshAuthState?: (() => Promise<{ authLabel: string; authIssueLines?: readonly string[] }>) | undefined;
  extractAuthLabel?: ((lines: readonly string[]) => string | undefined) | undefined;
  applyAuthIssueLines: (authIssueLines?: readonly string[]) => void;
  formatWorkShellError: (message: string) => string;
}): Promise<
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "success";
      readonly resultLines: readonly string[];
      readonly nextAuthLabel: string;
    }
  | { readonly kind: "error"; readonly message: string }
> {
  if (!input.saveApiKeyAuth) {
    return { kind: "unavailable" };
  }

  try {
    const resultLines = await input.saveApiKeyAuth(input.line);
    let nextAuthLabel = input.extractAuthLabel?.(resultLines) ?? input.currentAuthLabel;
    if (input.refreshAuthState) {
      try {
        const refreshed = await input.refreshAuthState();
        nextAuthLabel = refreshed.authLabel;
        input.applyAuthIssueLines(refreshed.authIssueLines);
      } catch {
        nextAuthLabel = input.extractAuthLabel?.(resultLines) ?? input.currentAuthLabel;
      }
    }

    return {
      kind: "success",
      resultLines,
      nextAuthLabel,
    };
  } catch (error) {
    return {
      kind: "error",
      message: input.formatWorkShellError(error instanceof Error ? error.message : String(error)),
    };
  }
}

export function resolveSecureApiKeyEntryResultPayload(input: {
  readonly kind: "unavailable" | "success" | "error";
  readonly resultLines?: readonly string[];
  readonly nextAuthLabel?: string;
  readonly message?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly mode?: string;
  readonly cwd?: string;
  readonly reasoningLabel?: string;
  readonly authLabel?: string;
  readonly contextSummaryLines?: readonly string[];
  readonly bridgeLines?: readonly string[];
  readonly memoryLines?: readonly string[];
  readonly traceLines?: readonly string[];
}): {
  readonly entries: readonly { readonly role: "user" | "assistant" | "system" | "tool"; readonly text: string }[];
  readonly patch: {
    readonly composerMode?: "default";
    readonly authLabel?: string;
    readonly authLauncherLines?: readonly string[];
    readonly panel: { readonly title: string; readonly lines: readonly string[] };
  };
  readonly traceLines: readonly string[];
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "auth-key-submit-result"],
      process.cwd(),
      JSON.stringify(input),
    ),
  ) as unknown;
  if (!isSecureApiKeyEntryResultPayload(parsed)) {
    throw new Error("Rust auth key submit result returned an invalid payload.");
  }
  return parsed;
}

function isSecureApiKeyEntryResultPayload(value: unknown): value is ReturnType<typeof resolveSecureApiKeyEntryResultPayload> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { entries?: unknown; patch?: unknown; traceLines?: unknown };
  const patch = candidate.patch as {
    composerMode?: unknown;
    authLabel?: unknown;
    authLauncherLines?: unknown;
    panel?: unknown;
  } | undefined;
  return (
    Array.isArray(candidate.entries) &&
    candidate.entries.every(isChatEntry) &&
    typeof patch === "object" &&
    patch !== null &&
    (patch.composerMode === undefined || patch.composerMode === "default") &&
    (patch.authLabel === undefined || typeof patch.authLabel === "string") &&
    (patch.authLauncherLines === undefined || isStringArray(patch.authLauncherLines)) &&
    isPanel(patch.panel) &&
    isStringArray(candidate.traceLines)
  );
}

export async function loadWorkShellMemoriesPanel(input: {
  cwd: string;
  sessionId: string;
  listScopedMemoryLines: (input: {
    scope: "session" | "project" | "user" | "agent";
    cwd: string;
    sessionId?: string;
    agentId?: string;
  }) => Promise<readonly string[]>;
}): Promise<{
  readonly sessionMemory: readonly string[];
  readonly projectMemory: readonly string[];
}> {
  const [sessionMemory, projectMemory] = await Promise.all([
    input.listScopedMemoryLines({ scope: "session", cwd: input.cwd, sessionId: input.sessionId }),
    input.listScopedMemoryLines({ scope: "project", cwd: input.cwd }),
  ]);
  return {
    sessionMemory,
    projectMemory,
  };
}

export async function writeWorkShellRememberCommand(input: {
  command: { readonly scope: "session" | "project" | "user" | "agent"; readonly summary: string };
  cwd: string;
  sessionId: string;
  writeScopedMemory: (input: {
    scope: "session" | "project" | "user" | "agent";
    cwd: string;
    summary: string;
    sessionId?: string;
    agentId?: string;
  }) => Promise<{ memoryId: string }>;
  listScopedMemoryLines: (input: {
    scope: "session" | "project" | "user" | "agent";
    cwd: string;
    sessionId?: string;
    agentId?: string;
  }) => Promise<readonly string[]>;
  formatAgentTraceLine: (event: {
    readonly type: "memory.written";
    readonly level: "high-signal";
    readonly memoryId: string;
    readonly scope: "session" | "project" | "user" | "agent";
    readonly summary: string;
  }) => string;
}): Promise<{
  readonly nextMemoryLines: readonly string[];
  readonly memoryTrace: string;
}> {
  const result = await input.writeScopedMemory({
    scope: input.command.scope,
    cwd: input.cwd,
    summary: input.command.summary,
    sessionId: input.sessionId,
    agentId: "work-shell",
  });
  const memoryScope = input.command.scope === "project" ? "project" : input.command.scope;
  const lines = await input.listScopedMemoryLines({
    scope: memoryScope,
    cwd: input.cwd,
    sessionId: input.sessionId,
    agentId: "work-shell",
  });
  const nextMemoryLines = lines.some((line) => line.includes(" · cite memory:"))
    ? lines
    : formatScopedMemoryTransparencyLines(
        lines.map((summary, index) => ({
          scope: memoryScope,
          memoryId: `memory:${memoryScope}:1970-01-01T00:00:00.000Z:test${String(index + 1).padStart(4, "0")}`,
          summary,
          timestamp: "1970-01-01T00:00:00.000Z",
        })),
      );
  const memoryTrace = input.formatAgentTraceLine({
    type: "memory.written",
    level: "high-signal",
    memoryId: result.memoryId,
    scope: input.command.scope,
    summary: input.command.summary,
  });

  return {
    nextMemoryLines,
    memoryTrace,
  };
}

export async function resolveInlineOperationalCommandResult(input: {
  line: string;
  slashCommand: readonly string[];
  currentAuthLabel: string;
  resolveWorkShellInlineCommand: (
    args: readonly string[],
    runInlineCommand: (
      args: readonly string[],
      onProgress?: ((line: string) => void) | undefined,
    ) => Promise<readonly string[]>,
    onProgress?: ((line: string) => void) | undefined,
  ) => Promise<{ readonly lines: readonly string[]; readonly failed: boolean }>;
  runInlineCommand: (args: readonly string[]) => Promise<readonly string[]>;
  refineInlineCommandResultLines?: ((input: {
    args: readonly string[];
    lines: readonly string[];
    failed: boolean;
    authLabel: string;
  }) => readonly string[]) | undefined;
  refreshAuthState?: (() => Promise<{ authLabel: string; authIssueLines?: readonly string[] }>) | undefined;
  extractAuthLabel?: ((lines: readonly string[]) => string | undefined) | undefined;
  applyAuthIssueLines: (authIssueLines?: readonly string[]) => void;
  onAuthProgressLines?: ((lines: readonly string[]) => void) | undefined;
  onAuthProgressPatch?: ((patch: { readonly panel: { readonly title: string; readonly lines: readonly string[] } }) => void) | undefined;
}): Promise<{
  readonly visibleLine: string;
  readonly visibleArgs: readonly string[];
  readonly resultLines: readonly string[];
  readonly completionLine: string;
  readonly nextAuthLabel: string;
  readonly isAuthCommand: boolean;
  readonly entries: readonly { readonly role: "user" | "assistant" | "system" | "tool"; readonly text: string }[];
  readonly patch: {
    readonly authLabel: string;
    readonly authLauncherLines?: readonly string[];
    readonly panel: { readonly title: string; readonly lines: readonly string[] };
  };
  readonly traceLines: readonly string[];
}> {
  const isAuthLogin = input.slashCommand[0] === "auth" && input.slashCommand[1] === "login";

  const authProgressLines: string[] = [];
  const commandResult = await input.resolveWorkShellInlineCommand(
    input.slashCommand,
    input.runInlineCommand,
    isAuthLogin
      ? (line) => {
          authProgressLines.push(line);
          const patch = resolveAuthProgressPatch(authProgressLines);
          input.onAuthProgressLines?.(patch.panel.lines);
          input.onAuthProgressPatch?.(patch);
        }
      : undefined,
  );
  const isAuthCommand = input.slashCommand[0] === "auth";
  const resultLines = input.refineInlineCommandResultLines
    ? input.refineInlineCommandResultLines({
        args: input.slashCommand,
        lines: commandResult.lines,
        failed: commandResult.failed,
        authLabel: input.currentAuthLabel,
      })
    : commandResult.lines;

  let nextAuthLabel = input.extractAuthLabel?.(resultLines) ?? input.currentAuthLabel;
  if (isAuthCommand && input.refreshAuthState) {
    try {
      const refreshed = await input.refreshAuthState();
      nextAuthLabel = refreshed.authLabel;
      input.applyAuthIssueLines(refreshed.authIssueLines);
    } catch {
      nextAuthLabel = input.extractAuthLabel?.(resultLines) ?? input.currentAuthLabel;
    }
  }

  return resolveInlineCommandResultPayload({
    line: input.line,
    slashCommand: input.slashCommand,
    resultLines,
    failed: commandResult.failed,
    nextAuthLabel,
  });
}

function resolveAuthProgressPatch(progressLines: readonly string[]): {
  readonly panel: { readonly title: string; readonly lines: readonly string[] };
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "auth-progress-result"],
      process.cwd(),
      JSON.stringify({ progressLines }),
    ),
  ) as unknown;
  if (!isPanelPatch(parsed)) {
    throw new Error("Rust auth progress result returned an invalid payload.");
  }
  return parsed.patch;
}

function resolveInlineCommandResultPayload(input: {
  readonly line: string;
  readonly slashCommand: readonly string[];
  readonly resultLines: readonly string[];
  readonly failed: boolean;
  readonly nextAuthLabel: string;
}): {
  readonly visibleLine: string;
  readonly visibleArgs: readonly string[];
  readonly resultLines: readonly string[];
  readonly completionLine: string;
  readonly nextAuthLabel: string;
  readonly isAuthCommand: boolean;
  readonly entries: readonly { readonly role: "user" | "assistant" | "system" | "tool"; readonly text: string }[];
  readonly patch: {
    readonly authLabel: string;
    readonly authLauncherLines?: readonly string[];
    readonly panel: { readonly title: string; readonly lines: readonly string[] };
  };
  readonly traceLines: readonly string[];
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "inline-command-result"],
      process.cwd(),
      JSON.stringify(input),
    ),
  ) as unknown;
  if (!isInlineCommandResultPayload(parsed)) {
    throw new Error("Rust inline command result returned an invalid payload.");
  }
  return parsed;
}

function isInlineCommandResultPayload(value: unknown): value is ReturnType<typeof resolveInlineCommandResultPayload> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    visibleLine?: unknown;
    visibleArgs?: unknown;
    resultLines?: unknown;
    completionLine?: unknown;
    nextAuthLabel?: unknown;
    isAuthCommand?: unknown;
    entries?: unknown;
    patch?: unknown;
    traceLines?: unknown;
  };
  const patch = candidate.patch as { authLabel?: unknown; authLauncherLines?: unknown; panel?: unknown } | undefined;
  return (
    typeof candidate.visibleLine === "string" &&
    isStringArray(candidate.visibleArgs) &&
    isStringArray(candidate.resultLines) &&
    typeof candidate.completionLine === "string" &&
    typeof candidate.nextAuthLabel === "string" &&
    typeof candidate.isAuthCommand === "boolean" &&
    Array.isArray(candidate.entries) &&
    candidate.entries.every(isChatEntry) &&
    typeof patch === "object" &&
    patch !== null &&
    typeof patch.authLabel === "string" &&
    (patch.authLauncherLines === undefined || isStringArray(patch.authLauncherLines)) &&
    isPanel(patch.panel) &&
    isStringArray(candidate.traceLines)
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isChatEntry(value: unknown): value is { role: "user" | "assistant" | "system" | "tool"; text: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { role?: unknown; text?: unknown };
  return (
    (candidate.role === "user" || candidate.role === "assistant" || candidate.role === "system" || candidate.role === "tool") &&
    typeof candidate.text === "string"
  );
}

function isPanel(value: unknown): value is { title: string; lines: readonly string[] } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { title?: unknown; lines?: unknown };
  return typeof candidate.title === "string" && isStringArray(candidate.lines);
}

function isPanelPatch(value: unknown): value is { patch: { panel: { title: string; lines: readonly string[] } } } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { patch?: unknown };
  const patch = candidate.patch as { panel?: unknown } | undefined;
  return typeof patch === "object" && patch !== null && isPanel(patch.panel);
}
