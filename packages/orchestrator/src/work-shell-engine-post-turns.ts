import { createConversationTurnSummary } from "./work-shell-engine-turns.js";
import { runRustCommandSync } from "./rust-command.js";
import {
  formatScopedMemoryTransparencyLines,
  type ScopedMemoryEntry,
} from "@unclecode/context-broker";

export type WorkShellSyntheticTraceEvent = {
  readonly type: "bridge.published" | "memory.written";
  readonly [key: string]: unknown;
};

export type WorkShellPostTurnSuccessEffectsInput = {
  cwd: string;
  transcriptText: string;
  assistantText: string;
  sessionId: string;
  currentBridgeLines: readonly string[];
  currentMemoryLines?: readonly string[] | undefined;
  publishContextBridge: (input: {
    cwd: string;
    summary: string;
    source: string;
    target: string;
    kind: "summary" | "decision" | "fact" | "file-change" | "task-state" | "warning";
  }) => Promise<{ bridgeId: string; line: string }>;
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
  listScopedMemoryEntries?: (input: {
    scope: "session" | "project" | "user" | "agent";
    cwd: string;
    sessionId?: string;
    agentId?: string;
    limit?: number;
  }) => Promise<readonly ScopedMemoryEntry[]>;
};

export type WorkShellPostTurnSuccessEffectsResult = {
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
  readonly bridgeSummary: string;
  readonly memorySummary: string;
  readonly bridgeTraceEvent: WorkShellSyntheticTraceEvent;
  readonly memoryTraceEvent: WorkShellSyntheticTraceEvent;
};

export function isWorkShellAuthFailure(message: string): boolean {
  return /request failed with status 401/i.test(message);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((line) => typeof line === "string");
}

function isSyntheticTraceEvent(value: unknown): value is WorkShellSyntheticTraceEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    (((value as { type?: unknown }).type === "bridge.published") ||
      ((value as { type?: unknown }).type === "memory.written"))
  );
}

export function resolveWorkShellPostTurnSuccessEffectsPayload(input: {
  summary: string;
  bridgeId: string;
  bridgeLine: string;
  currentBridgeLines: readonly string[];
  memoryId: string;
  memoryLines: readonly string[];
}): WorkShellPostTurnSuccessEffectsResult {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "post-turn-success-result"],
      process.cwd(),
      JSON.stringify(input),
    ),
  ) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Rust post-turn success returned an invalid payload.");
  }
  const candidate = parsed as {
    bridgeLines?: unknown;
    memoryLines?: unknown;
    bridgeSummary?: unknown;
    memorySummary?: unknown;
    bridgeTraceEvent?: unknown;
    memoryTraceEvent?: unknown;
  };
  if (
    !isStringArray(candidate.bridgeLines) ||
    !isStringArray(candidate.memoryLines) ||
    typeof candidate.bridgeSummary !== "string" ||
    typeof candidate.memorySummary !== "string" ||
    !isSyntheticTraceEvent(candidate.bridgeTraceEvent) ||
    !isSyntheticTraceEvent(candidate.memoryTraceEvent)
  ) {
    throw new Error("Rust post-turn success returned an invalid payload.");
  }
  return {
    bridgeLines: candidate.bridgeLines,
    memoryLines: candidate.memoryLines,
    bridgeSummary: candidate.bridgeSummary,
    memorySummary: candidate.memorySummary,
    bridgeTraceEvent: candidate.bridgeTraceEvent,
    memoryTraceEvent: candidate.memoryTraceEvent,
  };
}

function classifyWorkShellPostTurnStorageError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /better_sqlite3\.node/i.test(message) ||
    /NODE_MODULE_VERSION/i.test(message) ||
    /compiled against a different Node\.js version/i.test(message)
  ) {
    return "native-module-version-mismatch";
  }
  return "context-storage-unavailable";
}

function createDegradedPostTurnTraceEvent(
  type: WorkShellSyntheticTraceEvent["type"],
  summary: string,
  error: unknown,
): WorkShellSyntheticTraceEvent {
  return {
    type,
    summary,
    degraded: true,
    errorClass: classifyWorkShellPostTurnStorageError(error),
  };
}

export async function resolveWorkShellFailureAuthLabel(input: {
  message: string;
  currentAuthLabel: string;
  refreshAuthState?: (() => Promise<{ authLabel: string; authIssueLines?: readonly string[] }>) | undefined;
  applyAuthIssueLines?: ((authIssueLines?: readonly string[]) => void) | undefined;
}): Promise<string> {
  if (!isWorkShellAuthFailure(input.message) || !input.refreshAuthState) {
    return input.currentAuthLabel;
  }

  try {
    const refreshed = await input.refreshAuthState();
    input.applyAuthIssueLines?.(refreshed.authIssueLines);
    return refreshed.authLabel;
  } catch {
    return input.currentAuthLabel;
  }
}

export async function runWorkShellPostTurnSuccessEffects(
  input: WorkShellPostTurnSuccessEffectsInput,
): Promise<WorkShellPostTurnSuccessEffectsResult> {
  const summary = createConversationTurnSummary({
    transcriptText: input.transcriptText,
    assistantText: input.assistantText,
  });
  let bridgeId: string | undefined;
  let bridgeLine: string | undefined;
  let bridgeSummary = summary;
  let bridgeTraceEvent: WorkShellSyntheticTraceEvent = { type: "bridge.published", summary };
  try {
    const bridge = await input.publishContextBridge({
      cwd: input.cwd,
      summary,
      source: "work-shell",
      target: "project-context",
      kind: "summary",
    });
    bridgeId = bridge.bridgeId;
    bridgeLine = bridge.line;
  } catch (error) {
    bridgeSummary = "Context bridge unavailable; reply kept.";
    bridgeTraceEvent = createDegradedPostTurnTraceEvent(
      "bridge.published",
      bridgeSummary,
      error,
    );
  }

  let memoryId: string | undefined;
  let memoryLines = input.currentMemoryLines ?? [];
  let memorySummary = summary;
  let memoryTraceEvent: WorkShellSyntheticTraceEvent = { type: "memory.written", summary };
  try {
    const memory = await input.writeScopedMemory({
      scope: "session",
      cwd: input.cwd,
      summary,
      sessionId: input.sessionId,
      agentId: "work-shell",
    });
    memoryId = memory.memoryId;
    const entries = input.listScopedMemoryEntries
      ? await input.listScopedMemoryEntries({
          scope: "session",
          cwd: input.cwd,
          sessionId: input.sessionId,
          agentId: "work-shell",
        })
      : (await input.listScopedMemoryLines({
          scope: "session",
          cwd: input.cwd,
          sessionId: input.sessionId,
        })).map((summary, index) => ({
          scope: "session" as const,
          memoryId: `memory:session:1970-01-01T00:00:00.000Z:test${String(index + 1).padStart(4, "0")}`,
          summary,
          timestamp: "1970-01-01T00:00:00.000Z",
        }));
    memoryLines = formatScopedMemoryTransparencyLines(entries);
  } catch (error) {
    memorySummary = "Context memory unavailable; reply kept.";
    memoryTraceEvent = createDegradedPostTurnTraceEvent(
      "memory.written",
      memorySummary,
      error,
    );
  }

  if (bridgeId && bridgeLine && memoryId) {
    return resolveWorkShellPostTurnSuccessEffectsPayload({
      summary,
      bridgeId,
      bridgeLine,
      currentBridgeLines: input.currentBridgeLines,
      memoryId,
      memoryLines,
    });
  }

  return {
    bridgeLines: (bridgeLine ? [bridgeLine, ...input.currentBridgeLines] : input.currentBridgeLines).slice(0, 6),
    memoryLines,
    bridgeSummary,
    memorySummary,
    bridgeTraceEvent,
    memoryTraceEvent,
  };
}
