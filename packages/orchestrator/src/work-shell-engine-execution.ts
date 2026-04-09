import * as WorkShellPostTurns from "./work-shell-engine-post-turns.js";
import * as WorkShellTurns from "./work-shell-engine-turns.js";
import { createWorkShellAuthStatePatch, createWorkShellBusyStatePatch } from "./work-shell-engine-state.js";
import type {
  WorkShellChatEntry,
  WorkShellEngineState,
  WorkShellPanel,
} from "./work-shell-engine.js";
import type { WorkShellReasoningConfig } from "./reasoning.js";

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
}): Promise<{
  readonly assistantText: string;
  readonly lastTurnDurationMs: number;
  readonly postTurnEffects: Awaited<ReturnType<typeof WorkShellPostTurns.runWorkShellPostTurnSuccessEffects>>;
}> {
  const result = await input.runAgentTurn(input.prompt, input.attachments ?? []);
  const lastTurnDurationMs = Date.now() - input.turnStartedAt;
  const assistantText = await WorkShellTurns.finalizeWorkShellAssistantReply({
    prompt: input.prompt,
    assistantText: result.text || "(empty response)",
    autoContinueOnPermissionStall: input.autoContinueOnPermissionStall,
    runTurn: (prompt) => input.runAgentTurn(prompt, []),
  });
  const postTurnEffects = await WorkShellPostTurns.runWorkShellPostTurnSuccessEffects({
    cwd: input.cwd,
    transcriptText: input.transcriptText,
    assistantText,
    sessionId: input.sessionId,
    currentBridgeLines: input.currentBridgeLines,
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
  return createWorkShellBusyStatePatch({
    state: input.state,
    isBusy: true,
    busyStatus: "thinking",
    currentTurnStartedAt: input.turnStartedAt,
  });
}

export function createPromptTurnSuccessPatch<Reasoning extends WorkShellReasoningConfig>(input: {
  state: WorkShellEngineState<Reasoning>;
  bridgeLines: readonly string[];
  memoryLines: readonly string[];
  lastTurnDurationMs: number;
}): Partial<WorkShellEngineState<Reasoning>> {
  return {
    bridgeLines: input.bridgeLines,
    memoryLines: input.memoryLines,
    lastTurnDurationMs: input.lastTurnDurationMs,
  };
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

export function createPromptTurnFinalizePatch<Reasoning extends WorkShellReasoningConfig>(input: {
  state: WorkShellEngineState<Reasoning>;
}): Partial<WorkShellEngineState<Reasoning>> {
  return createWorkShellBusyStatePatch({
    state: input.state,
    isBusy: false,
    clearCurrentTurnStartedAt: true,
  });
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
  }) => Promise<readonly string[]>;
  refreshAuthState?: (() => Promise<{ authLabel: string; authIssueLines?: readonly string[] }>) | undefined;
  applyAuthIssueLines?: ((authIssueLines?: readonly string[]) => void) | undefined;
  formatWorkShellError: (message: string) => string;
  formatAgentTraceLine: (event: {
    readonly type: "bridge.published" | "memory.written";
    readonly [key: string]: unknown;
  }) => string;
  buildAuthFailureStatusPanel: (authLabel: string) => WorkShellPanel;
  appendEntries: (...entries: readonly WorkShellChatEntry[]) => void;
  setState: (patch: Partial<WorkShellEngineState<Reasoning>>) => void;
  pushTraceLine: (line: string) => void;
  persistSessionSnapshot: (
    state: "running" | "idle" | "requires_action",
    summary: string,
  ) => Promise<void>;
}): Promise<void> {
  input.appendEntries({ role: "user", text: input.promptTurn.transcriptText });
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
      cwd: input.cwd,
      sessionId: input.sessionId,
      currentBridgeLines: input.state.bridgeLines,
      publishContextBridge: input.publishContextBridge,
      writeScopedMemory: input.writeScopedMemory,
      listScopedMemoryLines: input.listScopedMemoryLines,
    });
    input.appendEntries({ role: "assistant", text: assistantText });
    input.setState(createPromptTurnSuccessPatch({
      state: input.state,
      bridgeLines: postTurnEffects.bridgeLines,
      memoryLines: postTurnEffects.memoryLines,
      lastTurnDurationMs,
    }));
    input.pushTraceLine(input.formatAgentTraceLine(postTurnEffects.bridgeTraceEvent));
    input.pushTraceLine(input.formatAgentTraceLine(postTurnEffects.memoryTraceEvent));
    await input.persistSessionSnapshot("idle", input.promptTurn.sessionSummary).catch(() => undefined);
  } catch (error) {
    const failure = await resolvePromptTurnFailureResult({
      error,
      currentAuthLabel: input.state.authLabel,
      turnStartedAt,
      refreshAuthState: input.refreshAuthState,
      applyAuthIssueLines: input.applyAuthIssueLines,
      formatWorkShellError: input.formatWorkShellError,
    });
    input.appendEntries({ role: "system", text: failure.formattedMessage });
    input.setState(createPromptTurnFailurePatch({
      state: input.state,
      nextAuthLabel: failure.nextAuthLabel,
      lastTurnDurationMs: failure.lastTurnDurationMs,
      isAuthFailure: failure.isAuthFailure,
      ...(failure.isAuthFailure
        ? {
            statusPanel: input.buildAuthFailureStatusPanel(failure.nextAuthLabel),
          }
        : {}),
    }));
    await input.persistSessionSnapshot("requires_action", input.promptTurn.failureSummary).catch(() => undefined);
  } finally {
    input.setState(createPromptTurnFinalizePatch({
      state: input.state,
    }));
  }
}
