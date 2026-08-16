import { buildPromptCommandPrompt } from "./work-shell-engine-commands.js";
import { executeWorkShellPromptTurn } from "./work-shell-engine-execution.js";
import { createWorkShellStatusPanel } from "./work-shell-engine-panels.js";
import * as WorkShellTurns from "./work-shell-engine-turns.js";
import type { WorkShellPromptCommand } from "./work-shell-engine-turns.js";
import type { WorkAgentTurnResult } from "./work-agent.js";
import type { ContextPacketReceipt } from "@unclecode/contracts";
import type {
  MemoryLineageAdapter,
  PromoteScopedMemoryInput,
} from "@unclecode/context-broker";
import type {
  WorkShellChatEntry,
  WorkShellComposerResolution,
  WorkShellEngineOptions,
  WorkShellEngineState,
  WorkShellPanel,
  WorkShellStatusContext,
} from "./work-shell-engine.js";
import { describeReasoning, type WorkShellReasoningConfig } from "./reasoning.js";

type WorkShellPromptTurnExecutionResult = {
  readonly completed: boolean;
  readonly replyPersisted: boolean;
};

/**
 * Merge text-derived attachments (from resolveComposerInput) with attachments
 * produced outside the text-resolution path (e.g. clipboard paste). Dedupes
 * by `dataUrl` when the attachment has one — that key captures the source
 * bytes plus the mime header without forcing both producer paths to agree
 * on a stable id. Attachments without a dataUrl pass through unchanged so
 * non-image attachment kinds added later are not silently dropped.
 */
export function mergeWorkShellComposerAttachments<Attachment>(
  resolved: WorkShellComposerResolution<Attachment>,
  pending: readonly Attachment[] | undefined,
): WorkShellComposerResolution<Attachment> {
  if (!pending || pending.length === 0) {
    return resolved;
  }
  const seen = new Set<string>();
  const out: Attachment[] = [];
  for (const item of [...resolved.attachments, ...pending]) {
    const key = (item as { readonly dataUrl?: string }).dataUrl;
    if (typeof key === "string") {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
    }
    out.push(item);
  }
  return { ...resolved, attachments: out };
}

type PromptRuntimeInput<Attachment, Reasoning extends WorkShellReasoningConfig> = {
  state: WorkShellEngineState<Reasoning>;
  options: WorkShellEngineOptions<Reasoning>;
  sessionId: string;
  buildStatusPanel: (
    options: WorkShellEngineOptions<Reasoning>,
    reasoning: Reasoning,
    authLabel: string,
    statusContext?: WorkShellStatusContext,
  ) => WorkShellPanel;
  autoContinueOnPermissionStall?: boolean | undefined;
  runAgentTurn: (prompt: string, attachments?: readonly Attachment[]) => Promise<WorkAgentTurnResult>;
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
  memoryLineage?: MemoryLineageAdapter | undefined;
  promoteScopedMemory?: ((input: PromoteScopedMemoryInput) => Promise<{ memoryId: string }>) | undefined;
  listScopedMemoryLines: (input: {
    scope: "session" | "project" | "user" | "agent";
    cwd: string;
    sessionId?: string;
    agentId?: string;
    lineage?: MemoryLineageAdapter;
  }) => Promise<readonly string[]>;
  refreshAuthState?: (() => Promise<{ authLabel: string; authIssueLines?: readonly string[] }>) | undefined;
  applyAuthIssueLines: (authIssueLines?: readonly string[]) => void;
  formatWorkShellError: (message: string) => string;
  formatAgentTraceLine: (event: {
    readonly type: "bridge.published" | "memory.written";
    readonly [key: string]: unknown;
  }) => string;
  appendEntries: (...entries: readonly WorkShellChatEntry[]) => void;
  setState: (patch: Partial<WorkShellEngineState<Reasoning>>) => void;
  pushTraceLine: (traceLine: string) => void;
  persistSessionSnapshot: (
    sessionState: "running" | "idle" | "requires_action",
    summary: string,
  ) => Promise<void>;
  /** Optional agentops recorder callback. Non-blocking. */
  recordTurn?: ((turn: { prompt: string; status: string; summary?: string; turnId?: string; contextReceiptId?: string; packetId?: string }) => void) | undefined;
  readonly turnId?: string | undefined;
  readonly contextReceipt?: ContextPacketReceipt | undefined;
};

function createPromptRuntimeExecutionInput<Attachment, Reasoning extends WorkShellReasoningConfig>(input: {
  promptTurn: {
    transcriptText: string;
    prompt: string;
    sessionSummary: string;
    failureSummary: string;
    attachments?: readonly Attachment[];
  };
} & PromptRuntimeInput<Attachment, Reasoning>) {
  return {
    promptTurn: input.promptTurn,
    state: input.state,
    cwd: input.options.cwd,
    sessionId: input.sessionId,
    autoContinueOnPermissionStall: input.autoContinueOnPermissionStall,
    runAgentTurn: input.runAgentTurn,
    ...(input.isTurnActive !== undefined
      ? { isTurnActive: input.isTurnActive }
      : {}),
    publishContextBridge: input.publishContextBridge,
    writeScopedMemory: input.writeScopedMemory,
    listScopedMemoryLines: input.listScopedMemoryLines,
    ...(input.memoryLineage !== undefined ? { memoryLineage: input.memoryLineage } : {}),
    ...(input.promoteScopedMemory !== undefined
      ? { promoteScopedMemory: input.promoteScopedMemory }
      : {}),
    refreshAuthState: input.refreshAuthState,
    applyAuthIssueLines: input.applyAuthIssueLines,
    formatWorkShellError: input.formatWorkShellError,
    formatAgentTraceLine: input.formatAgentTraceLine,
    buildAuthFailureStatusPanel: (authLabel: string) =>
      createWorkShellStatusPanel({
        options: input.options,
        stateModel: input.state.model,
        reasoning: input.state.reasoning,
        authLabel,
        buildStatusPanel: input.buildStatusPanel,
      }),
    buildAuthFailureStatusInput: (authLabel: string) => ({
      provider: input.options.provider,
      model: input.state.model,
      mode: input.options.mode,
      cwd: input.options.cwd,
      reasoningLabel: describeReasoning(input.state.reasoning),
      authLabel,
      contextSummaryLines: input.options.contextSummaryLines,
      bridgeLines: input.state.bridgeLines,
      memoryLines: input.state.memoryLines,
      traceLines: input.state.traceLines,
    }),
    appendEntries: input.appendEntries,
    setState: input.setState,
    pushTraceLine: input.pushTraceLine,
    persistSessionSnapshot: input.persistSessionSnapshot,
    ...(input.recordTurn !== undefined ? { recordTurn: input.recordTurn } : {}),
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    ...(input.contextReceipt !== undefined ? { contextReceipt: input.contextReceipt } : {}),
  };
}

type WorkShellChatPreflight<Attachment> = {
  readonly promptTurn: ReturnType<typeof WorkShellTurns.createChatPromptTurnInput<Attachment>>;
  readonly readOnlyGuard: string | undefined;
};

export async function resolveWorkShellChatPreflight<Attachment>(input: {
  readonly line: string;
  readonly cwd: string;
  readonly mode: WorkShellEngineOptions<WorkShellReasoningConfig>["mode"];
  readonly resolveComposerInput: (value: string, cwd: string) => Promise<WorkShellComposerResolution<Attachment>>;
  readonly pendingAttachments?: readonly Attachment[] | undefined;
}): Promise<WorkShellChatPreflight<Attachment>> {
  const resolved = await input.resolveComposerInput(input.line, input.cwd);
  const composer = mergeWorkShellComposerAttachments(resolved, input.pendingAttachments);
  const promptTurn = WorkShellTurns.createChatPromptTurnInput({
    line: input.line,
    composer,
  });
  return {
    promptTurn,
    readOnlyGuard: WorkShellTurns.resolveReadOnlyModeGuard({
      mode: input.mode,
      prompt: promptTurn.prompt,
    }),
  };
}

export async function executeWorkShellChatSubmit<
  Attachment,
  Reasoning extends WorkShellReasoningConfig,
>(input: {
  line: string;
  resolveComposerInput: (value: string, cwd: string) => Promise<WorkShellComposerResolution<Attachment>>;
  // Attachments produced outside the text-resolution path (e.g. clipboard
  // paste in the TUI). Merged with text-derived attachments so the user's
  // pasted image actually reaches the provider, not just the preview badge.
  // Memo §4 step 2 follow-up after Hermes review of commit 40ab895 caught
  // that pendingClipboardAttachments lived only in TUI hook state and
  // never crossed the engine boundary.
  pendingAttachments?: readonly Attachment[];
  preflight?: WorkShellChatPreflight<Attachment>;
} & PromptRuntimeInput<Attachment, Reasoning>): Promise<WorkShellPromptTurnExecutionResult> {
  const preflight = input.preflight ?? await resolveWorkShellChatPreflight({
    line: input.line,
    cwd: input.options.cwd,
    mode: input.options.mode,
    resolveComposerInput: input.resolveComposerInput,
    ...(input.pendingAttachments ? { pendingAttachments: input.pendingAttachments } : {}),
  });
  const basePromptTurn = preflight.promptTurn;
  const promptTurn = input.turnId !== undefined && input.contextReceipt !== undefined
    ? WorkShellTurns.withPromptTurnContextProof(basePromptTurn, {
      turnId: input.turnId,
      contextReceipt: input.contextReceipt,
    })
    : basePromptTurn;
  const readOnlyGuard = preflight.readOnlyGuard;
  if (readOnlyGuard) {
    input.appendEntries(
      { role: "user", text: promptTurn.transcriptText },
      { role: "assistant", text: readOnlyGuard },
    );
    input.setState({ lastTurnDurationMs: 0 });
    await input.persistSessionSnapshot("idle", promptTurn.sessionSummary).catch(() => undefined);
    return { completed: false, replyPersisted: false };
  }
  return executeWorkShellPromptTurn(
    createPromptRuntimeExecutionInput({
      ...input,
      promptTurn,
    }),
  );
}

export async function executeWorkShellPromptCommandSubmit<
  Attachment,
  Reasoning extends WorkShellReasoningConfig,
>(input: {
  transcriptText: string;
  promptCommand: WorkShellPromptCommand;
} & PromptRuntimeInput<Attachment, Reasoning>): Promise<WorkShellPromptTurnExecutionResult> {
  return executeWorkShellPromptTurn(
    createPromptRuntimeExecutionInput({
      ...input,
      promptTurn: (
        input.turnId !== undefined && input.contextReceipt !== undefined
          ? WorkShellTurns.withPromptTurnContextProof(
            WorkShellTurns.createPromptCommandTurnInput({
              transcriptText: input.transcriptText,
              prompt: buildPromptCommandPrompt(input.promptCommand),
              promptCommand: input.promptCommand,
            }),
            {
              turnId: input.turnId,
              contextReceipt: input.contextReceipt,
            },
          )
          : WorkShellTurns.createPromptCommandTurnInput({
            transcriptText: input.transcriptText,
            prompt: buildPromptCommandPrompt(input.promptCommand),
            promptCommand: input.promptCommand,
          })
      ),
    }),
  );
}
