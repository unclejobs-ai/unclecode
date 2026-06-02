import { createConversationTurnSummary } from "./work-shell-engine-turns.js";
import { runRustCommandSync } from "./rust-command.js";

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
  const bridge = await input.publishContextBridge({
    cwd: input.cwd,
    summary,
    source: "work-shell",
    target: "project-context",
    kind: "summary",
  });
  const memory = await input.writeScopedMemory({
    scope: "session",
    cwd: input.cwd,
    summary,
    sessionId: input.sessionId,
    agentId: "work-shell",
  });
  const memoryLines = await input.listScopedMemoryLines({
    scope: "session",
    cwd: input.cwd,
    sessionId: input.sessionId,
  });

  return resolveWorkShellPostTurnSuccessEffectsPayload({
    summary,
    bridgeId: bridge.bridgeId,
    bridgeLine: bridge.line,
    currentBridgeLines: input.currentBridgeLines,
    memoryId: memory.memoryId,
    memoryLines,
  });
}
