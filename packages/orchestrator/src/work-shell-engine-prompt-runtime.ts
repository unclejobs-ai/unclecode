import { buildPromptCommandPrompt } from "./work-shell-engine-commands.js";
import { executeWorkShellPromptTurn } from "./work-shell-engine-execution.js";
import { createWorkShellStatusPanel } from "./work-shell-engine-panels.js";
import * as WorkShellTurns from "./work-shell-engine-turns.js";
import type { WorkShellPromptCommand } from "./work-shell-engine-turns.js";
import type {
  WorkShellChatEntry,
  WorkShellComposerResolution,
  WorkShellEngineOptions,
  WorkShellEngineState,
  WorkShellPanel,
} from "./work-shell-engine.js";
import type { WorkShellReasoningConfig } from "./reasoning.js";

type PromptRuntimeInput<Attachment, Reasoning extends WorkShellReasoningConfig> = {
  state: WorkShellEngineState<Reasoning>;
  options: WorkShellEngineOptions<Reasoning>;
  sessionId: string;
  buildStatusPanel: (
    options: WorkShellEngineOptions<Reasoning>,
    reasoning: Reasoning,
    authLabel: string,
  ) => WorkShellPanel;
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
    publishContextBridge: input.publishContextBridge,
    writeScopedMemory: input.writeScopedMemory,
    listScopedMemoryLines: input.listScopedMemoryLines,
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
    appendEntries: input.appendEntries,
    setState: input.setState,
    pushTraceLine: input.pushTraceLine,
    persistSessionSnapshot: input.persistSessionSnapshot,
  };
}

export async function executeWorkShellChatSubmit<
  Attachment,
  Reasoning extends WorkShellReasoningConfig,
>(input: {
  line: string;
  resolveComposerInput: (value: string, cwd: string) => Promise<WorkShellComposerResolution<Attachment>>;
} & PromptRuntimeInput<Attachment, Reasoning>): Promise<void> {
  const composer = await input.resolveComposerInput(input.line, input.options.cwd);
  const promptTurn = WorkShellTurns.createChatPromptTurnInput({
    line: input.line,
    composer,
  });
  const readOnlyGuard = WorkShellTurns.resolveReadOnlyModeGuard({
    mode: input.options.mode,
    prompt: promptTurn.prompt,
  });
  if (readOnlyGuard) {
    input.appendEntries(
      { role: "user", text: promptTurn.transcriptText },
      { role: "assistant", text: readOnlyGuard },
    );
    input.setState({ lastTurnDurationMs: 0 });
    await input.persistSessionSnapshot("idle", promptTurn.sessionSummary).catch(() => undefined);
    return;
  }
  await executeWorkShellPromptTurn(
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
} & PromptRuntimeInput<Attachment, Reasoning>): Promise<void> {
  await executeWorkShellPromptTurn(
    createPromptRuntimeExecutionInput({
      ...input,
      promptTurn: WorkShellTurns.createPromptCommandTurnInput({
        transcriptText: input.transcriptText,
        prompt: buildPromptCommandPrompt(input.promptCommand),
        promptCommand: input.promptCommand,
      }),
    }),
  );
}
