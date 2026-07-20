import * as WorkShellPostTurns from "./work-shell-engine-post-turns.js";
import * as WorkShellTurns from "./work-shell-engine-turns.js";
import { runRustCommandSync } from "./rust-command.js";
import { createWorkShellAuthStatePatch } from "./work-shell-engine-state.js";
import type {
  WorkShellChatEntry,
  WorkShellEngineState,
  WorkShellPanel,
} from "./work-shell-engine.js";
import type { WorkShellReasoningConfig } from "./reasoning.js";
import type { ContextPacketReceipt } from "@unclecode/contracts";
import type {
  MemoryLineageAdapter,
  PromoteScopedMemoryInput,
} from "@unclecode/context-broker";

type WorkShellMemoryLineageRuntime = {
  readonly turnId?: string | undefined;
  readonly contextReceipt?: ContextPacketReceipt | undefined;
  readonly memoryLineage?: MemoryLineageAdapter | undefined;
  readonly promoteScopedMemory?: (input: PromoteScopedMemoryInput) => Promise<{ memoryId: string }>;
};

export async function runPromptTurnSuccessSequence<Attachment>(input: {
  prompt: string;
  transcriptText: string;
  attachments?: readonly Attachment[];
  turnStartedAt: number;
  autoContinueOnPermissionStall?: boolean | undefined;
  runAgentTurn: (prompt: string, attachments?: readonly Attachment[]) => Promise<{ text: string }>;
  cwd: string;
  sessionId: string;
  currentBridgeLines: readonly string[];
  currentMemoryLines?: readonly string[] | undefined;
  isTurnActive?: (() => boolean) | undefined;
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
    lineage?: MemoryLineageAdapter;
  }) => Promise<readonly string[]>;
} & WorkShellMemoryLineageRuntime): Promise<{
  readonly assistantText: string;
  readonly lastTurnDurationMs: number;
  readonly postTurnEffects: Awaited<ReturnType<typeof WorkShellPostTurns.runWorkShellPostTurnSuccessEffects>>;
}> {
  const result = await input.runAgentTurn(input.prompt, input.attachments ?? []);
  if (input.isTurnActive?.() === false) {
    throw new Error("Turn is no longer active.");
  }
  const lastTurnDurationMs = Date.now() - input.turnStartedAt;
  const assistantText = await WorkShellTurns.finalizeWorkShellAssistantReply({
    prompt: input.prompt,
    assistantText: result.text ?? "",
    autoContinueOnPermissionStall: input.autoContinueOnPermissionStall,
    // Carry the original attachments into the permission-stall continuation
    // turn so vision context (clipboard-pasted images, file references) is
    // not silently dropped on the auto-continue. Memo §4 step 4 / Q5. The
    // continuation only fires when detectPermissionSeekingStall matches an
    // assistant outro that asked permission, so the extra image bytes are a
    // rare-event cost — never paid on the happy path.
    runTurn: (prompt) => input.runAgentTurn(prompt, input.attachments ?? []),
  });
  if (input.isTurnActive?.() === false) {
    throw new Error("Turn is no longer active.");
  }
  const postTurnEffects = await WorkShellPostTurns.runWorkShellPostTurnSuccessEffects({
    cwd: input.cwd,
    transcriptText: input.transcriptText,
    assistantText,
    sessionId: input.sessionId,
    currentBridgeLines: input.currentBridgeLines,
    currentMemoryLines: input.currentMemoryLines,
    ...(input.isTurnActive !== undefined
      ? { isTurnActive: input.isTurnActive }
      : {}),
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    ...(input.contextReceipt !== undefined ? { contextReceipt: input.contextReceipt } : {}),
    ...(input.memoryLineage !== undefined ? { memoryLineage: input.memoryLineage } : {}),
    ...(input.promoteScopedMemory !== undefined
      ? { promoteScopedMemory: input.promoteScopedMemory }
      : {}),
    publishContextBridge: input.publishContextBridge,
    writeScopedMemory: input.writeScopedMemory,
    listScopedMemoryLines: input.listScopedMemoryLines,
  });

  return {
    assistantText,
    lastTurnDurationMs,
    postTurnEffects,
  };
}

export async function resolvePromptTurnFailureResult(input: {
  error: unknown;
  currentAuthLabel: string;
  turnStartedAt: number;
  refreshAuthState?: (() => Promise<{ authLabel: string; authIssueLines?: readonly string[] }>) | undefined;
  applyAuthIssueLines?: ((authIssueLines?: readonly string[]) => void) | undefined;
  formatWorkShellError: (message: string) => string;
}): Promise<{
  readonly formattedMessage: string;
  readonly nextAuthLabel: string;
  readonly isAuthFailure: boolean;
  readonly lastTurnDurationMs: number;
}> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const isAuthFailure = WorkShellPostTurns.isWorkShellAuthFailure(message);
  const nextAuthLabel = await WorkShellPostTurns.resolveWorkShellFailureAuthLabel({
    message,
    currentAuthLabel: input.currentAuthLabel,
    refreshAuthState: input.refreshAuthState,
    applyAuthIssueLines: input.applyAuthIssueLines,
  });

  return {
    formattedMessage: input.formatWorkShellError(message),
    nextAuthLabel,
    isAuthFailure,
    lastTurnDurationMs: Date.now() - input.turnStartedAt,
  };
}

export function createPromptTurnStartPatch<Reasoning extends WorkShellReasoningConfig>(input: {
  state: WorkShellEngineState<Reasoning>;
  turnStartedAt: number;
}): Partial<WorkShellEngineState<Reasoning>> {
  void input.state;
  return resolvePromptTurnStartPatch<Reasoning>(input.turnStartedAt);
}

export function createPromptTurnSuccessPatch<Reasoning extends WorkShellReasoningConfig>(input: {
  state: WorkShellEngineState<Reasoning>;
  bridgeLines: readonly string[];
  memoryLines: readonly string[];
  lastTurnDurationMs: number;
}): Partial<WorkShellEngineState<Reasoning>> {
  return resolvePromptTurnSuccessPayload<Reasoning>({
    assistantText: "",
    bridgeLines: input.bridgeLines,
    memoryLines: input.memoryLines,
    lastTurnDurationMs: input.lastTurnDurationMs,
  }).patch;
}

export function createPromptTurnFailurePatch<Reasoning extends WorkShellReasoningConfig>(input: {
  state: WorkShellEngineState<Reasoning>;
  nextAuthLabel: string;
  lastTurnDurationMs: number;
  isAuthFailure: boolean;
  statusPanel?: WorkShellPanel | undefined;
}): Partial<WorkShellEngineState<Reasoning>> {
  return {
    ...createWorkShellAuthStatePatch({
      state: input.state,
      authLabel: input.nextAuthLabel,
    }),
    currentTurnStartedAt: undefined,
    lastTurnDurationMs: input.lastTurnDurationMs,
    ...(input.isAuthFailure && input.statusPanel
      ? { panel: input.statusPanel }
      : {}),
  };
}

function isWorkShellChatEntry(value: unknown): value is WorkShellChatEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    ((value as { role?: unknown }).role === "system" ||
      (value as { role?: unknown }).role === "user" ||
      (value as { role?: unknown }).role === "assistant" ||
      (value as { role?: unknown }).role === "tool") &&
    typeof (value as { text?: unknown }).text === "string"
  );
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

function isPromptSuccessPatch(value: unknown): value is {
  bridgeLines: readonly string[];
  memoryLines: readonly string[];
  lastTurnDurationMs: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { bridgeLines?: unknown }).bridgeLines) &&
    (value as { bridgeLines: unknown[] }).bridgeLines.every((line) => typeof line === "string") &&
    Array.isArray((value as { memoryLines?: unknown }).memoryLines) &&
    (value as { memoryLines: unknown[] }).memoryLines.every((line) => typeof line === "string") &&
    typeof (value as { lastTurnDurationMs?: unknown }).lastTurnDurationMs === "number"
  );
}

function isPromptStartPatch(value: unknown): value is {
  isBusy: true;
  busyStatus: string;
  currentTurnStartedAt: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { isBusy?: unknown }).isBusy === true &&
    typeof (value as { busyStatus?: unknown }).busyStatus === "string" &&
    typeof (value as { currentTurnStartedAt?: unknown }).currentTurnStartedAt === "number"
  );
}

function isPromptFinalizePatch(value: unknown): value is {
  isBusy: false;
  clearBusyStatus: true;
  clearCurrentTurnStartedAt: true;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { isBusy?: unknown }).isBusy === false &&
    (value as { clearBusyStatus?: unknown }).clearBusyStatus === true &&
    (value as { clearCurrentTurnStartedAt?: unknown }).clearCurrentTurnStartedAt === true
  );
}

export function resolvePromptTurnStartPatch<Reasoning extends WorkShellReasoningConfig>(
  turnStartedAt: number,
): Partial<WorkShellEngineState<Reasoning>> {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "prompt-start-result"],
      process.cwd(),
      JSON.stringify({ turnStartedAt }),
    ),
  ) as unknown;
  const patch = (parsed as { patch?: unknown })?.patch;
  if (!isPromptStartPatch(patch)) {
    throw new Error("Rust prompt start returned an invalid payload.");
  }
  return patch;
}

export function resolvePromptTurnSuccessPayload<Reasoning extends WorkShellReasoningConfig>(input: {
  assistantText: string;
  bridgeLines: readonly string[];
  memoryLines: readonly string[];
  lastTurnDurationMs: number;
}): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly patch: Partial<WorkShellEngineState<Reasoning>>;
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "prompt-success-result"],
      process.cwd(),
      JSON.stringify(input),
    ),
  ) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Rust prompt success returned an invalid payload.");
  }
  const candidate = parsed as { entries?: unknown; patch?: unknown };
  if (
    !Array.isArray(candidate.entries) ||
    !candidate.entries.every(isWorkShellChatEntry) ||
    !isPromptSuccessPatch(candidate.patch)
  ) {
    throw new Error("Rust prompt success returned an invalid payload.");
  }
  return {
    entries: candidate.entries,
    patch: candidate.patch,
  };
}

export function resolvePromptTurnFailurePayload<Reasoning extends WorkShellReasoningConfig>(input: {
  state: WorkShellEngineState<Reasoning>;
  formattedMessage: string;
  nextAuthLabel: string;
  lastTurnDurationMs: number;
  isAuthFailure: boolean;
  statusInput?: Record<string, unknown> | undefined;
}): {
  readonly entries: readonly WorkShellChatEntry[];
  readonly patch: Partial<WorkShellEngineState<Reasoning>>;
} {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "prompt-failure-result"],
      process.cwd(),
      JSON.stringify({
        ...(input.statusInput ?? {}),
        formattedMessage: input.formattedMessage,
        nextAuthLabel: input.nextAuthLabel,
        lastTurnDurationMs: input.lastTurnDurationMs,
        isAuthFailure: input.isAuthFailure,
      }),
    ),
  ) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Rust prompt failure returned an invalid payload.");
  }
  const candidate = parsed as { entries?: unknown; patch?: unknown };
  const patch = candidate.patch as {
    authLabel?: unknown;
    lastTurnDurationMs?: unknown;
    clearCurrentTurnStartedAt?: unknown;
    panel?: unknown;
  } | undefined;
  if (
    !Array.isArray(candidate.entries) ||
    !candidate.entries.every(isWorkShellChatEntry) ||
    typeof patch !== "object" ||
    patch === null ||
    typeof patch.authLabel !== "string" ||
    typeof patch.lastTurnDurationMs !== "number"
  ) {
    throw new Error("Rust prompt failure returned an invalid payload.");
  }
  return {
    entries: candidate.entries,
    patch: {
      ...createWorkShellAuthStatePatch({
        state: input.state,
        authLabel: patch.authLabel,
      }),
      currentTurnStartedAt: patch.clearCurrentTurnStartedAt === true ? undefined : input.state.currentTurnStartedAt,
      lastTurnDurationMs: patch.lastTurnDurationMs,
      ...(isWorkShellPanel(patch.panel) ? { panel: patch.panel } : {}),
    },
  };
}

export function createPromptTurnFinalizePatch<Reasoning extends WorkShellReasoningConfig>(
  state: WorkShellEngineState<Reasoning>,
): Partial<WorkShellEngineState<Reasoning>> {
  void state;
  return resolvePromptTurnFinalizePatch<Reasoning>();
}

export function resolvePromptTurnFinalizePatch<Reasoning extends WorkShellReasoningConfig>(): Partial<WorkShellEngineState<Reasoning>> {
  const parsed = JSON.parse(
    runRustCommandSync(["rust", "ux", "prompt-finalize-result"], process.cwd(), "{}"),
  ) as unknown;
  const patch = (parsed as { patch?: unknown })?.patch;
  if (!isPromptFinalizePatch(patch)) {
    throw new Error("Rust prompt finalize returned an invalid payload.");
  }
  return {
    isBusy: false,
    busyStatus: undefined,
    currentTurnStartedAt: undefined,
    streamingAssistantText: undefined,
  };
}

type WorkShellPromptTurnExecutionResult = {
  readonly completed: boolean;
  readonly replyPersisted: boolean;
};

function resolveApiBlockedAuthMessage(authLabel: string): string | undefined {
  if (!authLabel.endsWith("-api-blocked")) {
    return undefined;
  }
  return "OpenAI auth is not ready for model reasoning or tool calls. Use /auth key, then resend the request.";
}

export async function executeWorkShellPromptTurn<
  Attachment,
  Reasoning extends WorkShellReasoningConfig,
>(input: {
  promptTurn: {
    transcriptText: string;
    prompt: string;
    sessionSummary: string;
    failureSummary: string;
    attachments?: readonly Attachment[];
  };
  state: WorkShellEngineState<Reasoning>;
  cwd: string;
  sessionId: string;
  autoContinueOnPermissionStall?: boolean | undefined;
  isTurnActive?: (() => boolean) | undefined;
  runAgentTurn: (prompt: string, attachments?: readonly Attachment[]) => Promise<{ text: string }>;
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
    lineage?: MemoryLineageAdapter;
  }) => Promise<readonly string[]>;
  refreshAuthState?: (() => Promise<{ authLabel: string; authIssueLines?: readonly string[] }>) | undefined;
  applyAuthIssueLines?: ((authIssueLines?: readonly string[]) => void) | undefined;
  formatWorkShellError: (message: string) => string;
  formatAgentTraceLine: (event: {
    readonly type: "bridge.published" | "memory.written";
    readonly [key: string]: unknown;
  }) => string;
  buildAuthFailureStatusPanel: (authLabel: string) => WorkShellPanel;
  buildAuthFailureStatusInput?: ((authLabel: string) => Record<string, unknown>) | undefined;
  appendEntries: (...entries: readonly WorkShellChatEntry[]) => void;
  setState: (patch: Partial<WorkShellEngineState<Reasoning>>) => void;
  pushTraceLine: (line: string) => void;
  persistSessionSnapshot: (
    state: "running" | "idle" | "requires_action",
    summary: string,
  ) => Promise<void>;
  /** Optional agentops recorder callback. Called after every turn (success or failure). Non-blocking. */
  recordTurn?: ((turn: { prompt: string; status: string; summary?: string; turnId?: string; contextReceiptId?: string; packetId?: string }) => void) | undefined;
} & WorkShellMemoryLineageRuntime): Promise<WorkShellPromptTurnExecutionResult> {
  input.appendEntries({ role: "user", text: input.promptTurn.transcriptText });
  const authGuard = resolveApiBlockedAuthMessage(input.state.authLabel);
  if (authGuard) {
    input.appendEntries({ role: "assistant", text: authGuard });
    input.setState({ lastTurnDurationMs: 0 });
    await input.persistSessionSnapshot("idle", input.promptTurn.sessionSummary).catch(() => undefined);
    return { completed: false, replyPersisted: false };
  }
  const turnStartedAt = Date.now();
  input.setState(createPromptTurnStartPatch({
    state: input.state,
    turnStartedAt,
  }));

  try {
    await input.persistSessionSnapshot("running", input.promptTurn.sessionSummary).catch(() => undefined);

    const { assistantText, lastTurnDurationMs, postTurnEffects } = await runPromptTurnSuccessSequence({
      prompt: input.promptTurn.prompt,
      transcriptText: input.promptTurn.transcriptText,
      ...(input.promptTurn.attachments ? { attachments: input.promptTurn.attachments } : {}),
      turnStartedAt,
      autoContinueOnPermissionStall: input.autoContinueOnPermissionStall,
      runAgentTurn: input.runAgentTurn,
      ...(input.isTurnActive !== undefined
        ? { isTurnActive: input.isTurnActive }
        : {}),
      cwd: input.cwd,
      sessionId: input.sessionId,
      currentBridgeLines: input.state.bridgeLines,
      currentMemoryLines: input.state.memoryLines,
      publishContextBridge: input.publishContextBridge,
      writeScopedMemory: input.writeScopedMemory,
      listScopedMemoryLines: input.listScopedMemoryLines,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(input.contextReceipt !== undefined ? { contextReceipt: input.contextReceipt } : {}),
      ...(input.memoryLineage !== undefined ? { memoryLineage: input.memoryLineage } : {}),
      ...(input.promoteScopedMemory !== undefined
        ? { promoteScopedMemory: input.promoteScopedMemory }
        : {}),
    });
    const successPayload = resolvePromptTurnSuccessPayload<Reasoning>({
      assistantText,
      bridgeLines: postTurnEffects.bridgeLines,
      memoryLines: postTurnEffects.memoryLines,
      lastTurnDurationMs,
    });
    input.appendEntries(...successPayload.entries);
    input.setState({
      ...successPayload.patch,
      streamingAssistantText: undefined,
      ...(input.contextReceipt !== undefined ? { contextSubmittedReceipt: input.contextReceipt } : {}),
    });
    if (!postTurnEffects.skipped) {
      input.pushTraceLine(input.formatAgentTraceLine(postTurnEffects.bridgeTraceEvent));
      if (postTurnEffects.memoryTraceEvent !== undefined) {
        input.pushTraceLine(input.formatAgentTraceLine(postTurnEffects.memoryTraceEvent));
      }
    }
    const replyPersisted = await input
      .persistSessionSnapshot("idle", input.promptTurn.sessionSummary)
      .then(
        () => true,
        () => false,
      );
    try {
      input.recordTurn?.({
        prompt: input.promptTurn.prompt,
        status: "completed",
        summary: input.promptTurn.sessionSummary,
        ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
        ...(input.contextReceipt !== undefined
          ? {
              contextReceiptId: input.contextReceipt.id,
              packetId: input.contextReceipt.packetId,
            }
          : {}),
      });
    } catch {
      /* non-blocking */
    }
    return { completed: true, replyPersisted };
  } catch (error) {
    const failure = await resolvePromptTurnFailureResult({
      error,
      currentAuthLabel: input.state.authLabel,
      turnStartedAt,
      refreshAuthState: input.refreshAuthState,
      applyAuthIssueLines: input.applyAuthIssueLines,
      formatWorkShellError: input.formatWorkShellError,
    });
    const failurePayload = resolvePromptTurnFailurePayload({
      state: input.state,
      formattedMessage: failure.formattedMessage,
      nextAuthLabel: failure.nextAuthLabel,
      lastTurnDurationMs: failure.lastTurnDurationMs,
      isAuthFailure: failure.isAuthFailure,
      ...(failure.isAuthFailure && input.buildAuthFailureStatusInput
        ? { statusInput: input.buildAuthFailureStatusInput(failure.nextAuthLabel) }
        : {}),
    });
    input.appendEntries(...failurePayload.entries);
    input.setState({
      ...failurePayload.patch,
      streamingAssistantText: undefined,
      ...(input.contextReceipt !== undefined ? { contextSubmittedReceipt: input.contextReceipt } : {}),
    });
    await input.persistSessionSnapshot("requires_action", input.promptTurn.failureSummary).catch(() => undefined);
    try {
      input.recordTurn?.({
        prompt: input.promptTurn.prompt,
        status: "failed",
        summary: input.promptTurn.failureSummary,
        ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
        ...(input.contextReceipt !== undefined
          ? {
              contextReceiptId: input.contextReceipt.id,
              packetId: input.contextReceipt.packetId,
            }
          : {}),
      });
    } catch {
      /* non-blocking */
    }
    return { completed: false, replyPersisted: false };
  } finally {
    input.setState(createPromptTurnFinalizePatch(input.state));
  }
}
