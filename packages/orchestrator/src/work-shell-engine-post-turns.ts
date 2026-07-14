import { createConversationTurnSummary } from "./work-shell-engine-turns.js";
import { runRustCommandSync } from "./rust-command.js";
import {
  formatScopedMemoryTransparencyLines,
  type MemoryLineageAdapter,
  type PromoteScopedMemoryInput,
} from "@unclecode/context-broker";
import type { ContextPacketReceipt, ContextPolicySuggestion } from "@unclecode/contracts";

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
  turnId?: string | undefined;
  contextReceipt?: ContextPacketReceipt | undefined;
  memoryLineage?: MemoryLineageAdapter | undefined;
  promoteScopedMemory?: (input: PromoteScopedMemoryInput) => Promise<{
    memoryId: string;
    rollback?: (() => Promise<void>) | undefined;
  }>;
  isTurnActive?: (() => boolean) | undefined;
  publishContextBridge: (input: {
    cwd: string;
    summary: string;
    source: string;
    target: string;
    kind: "summary" | "decision" | "fact" | "file-change" | "task-state" | "warning";
  }) => Promise<{
    bridgeId: string;
    line: string;
    rollback?: (() => Promise<void>) | undefined;
  }>;
  writeScopedMemory: (input: {
    scope: "session" | "project" | "user" | "agent";
    cwd: string;
    summary: string;
    sessionId?: string;
    agentId?: string;
  }) => Promise<{
    memoryId: string;
    rollback?: (() => Promise<void>) | undefined;
  }>;
  listScopedMemoryLines: (input: {
    scope: "session" | "project" | "user" | "agent";
    cwd: string;
    sessionId?: string;
    agentId?: string;
    lineage?: MemoryLineageAdapter;
  }) => Promise<readonly string[]>;
};

export type WorkShellPostTurnSuccessEffectsResult = {
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
  readonly bridgeSummary: string;
  readonly memorySummary: string;
  readonly bridgeTraceEvent: WorkShellSyntheticTraceEvent;
  readonly memoryTraceEvent?: WorkShellSyntheticTraceEvent | undefined;
  /** Set when assistant text sanitized to empty — no bridge/memory side effects. */
  readonly skipped?: boolean;
};
export type WorkShellContextAdviceEffectsResult = {
  readonly suggestions: readonly ContextPolicySuggestion[];
  readonly unavailable?: string | undefined;
};

export async function runWorkShellContextAdviceEffects(
  generate: () => Promise<readonly ContextPolicySuggestion[]>,
): Promise<WorkShellContextAdviceEffectsResult> {
  try {
    return { suggestions: await generate() };
  } catch {
    return {
      suggestions: [],
      unavailable: "Context optimizer unavailable; reply kept.",
    };
  }
}


export function createSkippedWorkShellPostTurnSuccessEffects(input: {
  currentBridgeLines: readonly string[];
  currentMemoryLines?: readonly string[] | undefined;
}): WorkShellPostTurnSuccessEffectsResult {
  return {
    bridgeLines: input.currentBridgeLines,
    memoryLines: input.currentMemoryLines ?? [],
    bridgeSummary: "",
    memorySummary: "",
    bridgeTraceEvent: { type: "bridge.published", summary: "" },
    memoryTraceEvent: { type: "memory.written", summary: "" },
    skipped: true,
  };
}

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

function resolveAssistantSummaryPredecessor(
  lines: readonly string[],
  lineage: MemoryLineageAdapter,
): string | undefined {
  for (const line of lines) {
    const memoryId = / · cite (memory:\S+) · /.exec(line)?.[1];
    if (memoryId === undefined) continue;
    const record = lineage.get(memoryId);
    if (record?.sourceId === "assistant-summary" && lineage.isActive(memoryId)) {
      return memoryId;
    }
  }
  return undefined;
}

function requireSubmittedMemoryProof(input: {
  readonly sessionId: string;
  readonly turnId?: string | undefined;
  readonly contextReceipt?: ContextPacketReceipt | undefined;
}): { readonly turnId: string; readonly packetReceiptId: string } {
  if (
    !input.turnId?.trim()
    || input.contextReceipt?.state !== "submitted"
    || input.contextReceipt.turnId !== input.turnId
    || input.contextReceipt.sessionId !== input.sessionId
  ) {
    throw new Error("Submitted packet receipt required for memory promotion.");
  }
  return {
    turnId: input.turnId,
    packetReceiptId: input.contextReceipt.id,
  };
}

async function rollbackDurableEffects(
  effects: readonly (((() => Promise<void>) | undefined))[],
): Promise<void> {
  const rollbacks = effects.filter(
    (effect): effect is () => Promise<void> => effect !== undefined,
  );
  const results = await Promise.allSettled(rollbacks.map((rollback) => rollback()));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Interrupted turn rollback failed.");
  }
}

export async function runWorkShellPostTurnSuccessEffects(
  input: WorkShellPostTurnSuccessEffectsInput,
): Promise<WorkShellPostTurnSuccessEffectsResult> {
  if (!input.assistantText.trim()) {
    return createSkippedWorkShellPostTurnSuccessEffects({
      currentBridgeLines: input.currentBridgeLines,
      currentMemoryLines: input.currentMemoryLines,
    });
  }

  const summary = createConversationTurnSummary({
    transcriptText: input.transcriptText,
    assistantText: input.assistantText,
  });
  let bridgeId: string | undefined;
  let bridgeLine: string | undefined;
  let bridgeSummary = summary;
  let bridgeTraceEvent: WorkShellSyntheticTraceEvent = { type: "bridge.published", summary };
  let bridgeRollback: (() => Promise<void>) | undefined;
  try {
    if (input.isTurnActive?.() === false) {
      throw new Error("Turn is no longer active.");
    }
    const bridge = await input.publishContextBridge({
      cwd: input.cwd,
      summary,
      source: "work-shell",
      target: "project-context",
      kind: "summary",
    });
    if (input.isTurnActive?.() === false) {
      await rollbackDurableEffects([bridge.rollback]);
      throw new Error("Turn is no longer active.");
    }
    bridgeId = bridge.bridgeId;
    bridgeLine = bridge.line;
    bridgeRollback = bridge.rollback;
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
  let memoryTraceEvent: WorkShellSyntheticTraceEvent | undefined = {
    type: "memory.written",
    summary,
  };
  let memoryRollback: (() => Promise<void>) | undefined;
  try {
    if (input.isTurnActive?.() === false) {
      throw new Error("Turn is no longer active.");
    }
    const lineageConfigured = input.contextReceipt !== undefined
      || input.turnId !== undefined
      || input.memoryLineage !== undefined
      || input.promoteScopedMemory !== undefined;
    if (
      lineageConfigured
      && (input.memoryLineage === undefined || input.promoteScopedMemory === undefined)
    ) {
      throw new Error("Memory lineage promotion is only partially configured.");
    }
    const supersedesMemoryId = input.memoryLineage === undefined
      ? undefined
      : resolveAssistantSummaryPredecessor(
          input.currentMemoryLines ?? [],
          input.memoryLineage,
        );
    const memory = input.memoryLineage !== undefined && input.promoteScopedMemory !== undefined
      ? await input.promoteScopedMemory({
          scope: "session",
          cwd: input.cwd,
          summary,
          sessionId: input.sessionId,
          agentId: "work-shell",
          sourceId: "assistant-summary",
          ...requireSubmittedMemoryProof(input),
          confidence: 0.9,
          ...(supersedesMemoryId === undefined ? {} : { supersedesMemoryId }),
          lineage: input.memoryLineage,
        })
      : await input.writeScopedMemory({
          scope: "session",
          cwd: input.cwd,
          summary,
          sessionId: input.sessionId,
          agentId: "work-shell",
        });
    memoryId = memory.memoryId;
    memoryRollback = memory.rollback;
    if (input.isTurnActive?.() === false) {
      throw new Error("Turn is no longer active.");
    }
    const lines = await input.listScopedMemoryLines({
      scope: "session",
      cwd: input.cwd,
      sessionId: input.sessionId,
      ...(input.memoryLineage === undefined ? {} : { lineage: input.memoryLineage }),
    });
    memoryLines = lines.some((line) => line.includes(" · cite memory:"))
      ? lines
      : formatScopedMemoryTransparencyLines(
          lines.map((summary, index) => ({
            scope: "session" as const,
            memoryId: `memory:session:1970-01-01T00:00:00.000Z:test${String(index + 1).padStart(4, "0")}`,
            summary,
            timestamp: "1970-01-01T00:00:00.000Z",
          })),
        );
    if (input.isTurnActive?.() === false) {
      throw new Error("Turn is no longer active.");
    }
  } catch (error) {
    if (input.isTurnActive?.() === false) {
      await rollbackDurableEffects([memoryRollback, bridgeRollback]);
      memoryId = undefined;
      bridgeId = undefined;
      bridgeLine = undefined;
      memoryRollback = undefined;
      bridgeRollback = undefined;
    }
    memorySummary = "Context memory unavailable; reply kept.";
    memoryTraceEvent = undefined;
  }

  if (input.isTurnActive?.() === false) {
    await rollbackDurableEffects([memoryRollback, bridgeRollback]);
    memoryId = undefined;
    bridgeId = undefined;
    bridgeLine = undefined;
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
