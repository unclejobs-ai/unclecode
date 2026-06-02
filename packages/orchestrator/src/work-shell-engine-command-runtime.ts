import {
  createAuthLoginPendingPanel,
  redactSensitiveInlineCommandLine,
  resolveVisibleInlineCommand,
} from "./work-shell-engine-commands.js";
import {
  createMemoriesLocalCommandResult,
  createRememberLocalCommandResult,
  createRememberUsageErrorResult,
} from "./work-shell-engine-builtins.js";
import * as WorkShellOperations from "./work-shell-engine-operations.js";
import type {
  WorkShellChatEntry,
  WorkShellEngineOptions,
  WorkShellEngineState,
  WorkShellPanel,
  WorkShellStatusContext,
} from "./work-shell-engine.js";
import { describeReasoning, type WorkShellReasoningConfig } from "./reasoning.js";
import type { WorkShellSubmitRoute } from "./work-shell-engine-submit.js";

export async function executeSecureApiKeyEntrySubmit<Reasoning extends WorkShellReasoningConfig>(input: {
  line: string;
  state: WorkShellEngineState<Reasoning>;
  options: WorkShellEngineOptions<Reasoning>;
  buildStatusPanel: (
    options: WorkShellEngineOptions<Reasoning>,
    reasoning: Reasoning,
    authLabel: string,
    statusContext?: WorkShellStatusContext,
  ) => WorkShellPanel;
  buildInlineCommandPanel: (args: readonly string[], lines: readonly string[]) => WorkShellPanel;
  formatInlineCommandResultSummary: (args: readonly string[], lines: readonly string[]) => string;
  saveApiKeyAuth?: ((raw: string) => Promise<readonly string[]>) | undefined;
  refreshAuthState?: (() => Promise<{ authLabel: string; authIssueLines?: readonly string[] }>) | undefined;
  extractAuthLabel?: ((lines: readonly string[]) => string | undefined) | undefined;
  applyAuthIssueLines: (authIssueLines?: readonly string[]) => void;
  formatWorkShellError: (message: string) => string;
  appendEntries: (...entries: readonly WorkShellChatEntry[]) => void;
  setState: (patch: Partial<WorkShellEngineState<Reasoning>>) => void;
  pushTraceLine: (line: string, preservePanel?: boolean) => void;
}): Promise<void> {
  input.setState({ isBusy: true });
  try {
    const result = await WorkShellOperations.resolveSecureApiKeyEntrySubmission({
      line: input.line,
      currentAuthLabel: input.state.authLabel,
      saveApiKeyAuth: input.saveApiKeyAuth,
      refreshAuthState: input.refreshAuthState,
      extractAuthLabel: input.extractAuthLabel,
      applyAuthIssueLines: input.applyAuthIssueLines,
      formatWorkShellError: input.formatWorkShellError,
    });
    if (result.kind === "unavailable") {
      const payload = WorkShellOperations.resolveSecureApiKeyEntryResultPayload({
        kind: "unavailable",
        provider: input.options.provider,
        model: input.state.model,
        mode: input.options.mode,
        cwd: input.options.cwd,
        reasoningLabel: describeReasoning(input.state.reasoning),
        authLabel: input.state.authLabel,
        contextSummaryLines: input.options.contextSummaryLines,
        bridgeLines: input.state.bridgeLines,
        memoryLines: input.state.memoryLines,
        traceLines: input.state.traceLines,
      });
      input.appendEntries(...payload.entries);
      input.setState(payload.patch);
      return;
    }
    if (result.kind === "error") {
      const payload = WorkShellOperations.resolveSecureApiKeyEntryResultPayload({
        kind: "error",
        message: result.message,
      });
      input.appendEntries(...payload.entries);
      input.setState(payload.patch);
      return;
    }
    const payload = WorkShellOperations.resolveSecureApiKeyEntryResultPayload({
      kind: "success",
      resultLines: result.resultLines,
      nextAuthLabel: result.nextAuthLabel,
    });
    input.appendEntries(...payload.entries);
    input.setState(payload.patch);
    for (const traceLine of payload.traceLines) {
      input.pushTraceLine(traceLine, true);
    }
  } finally {
    input.setState({ isBusy: false });
  }
}

export async function executeInlineCommandSubmit<Reasoning extends WorkShellReasoningConfig>(input: {
  line: string;
  slashCommand: readonly string[];
  state: WorkShellEngineState<Reasoning>;
  onModeChanged?: ((mode: string) => void | Promise<void>) | undefined;
  resolveWorkShellInlineCommand: (
    args: readonly string[],
    runInlineCommand: (
      args: readonly string[],
      onProgress?: ((line: string) => void) | undefined,
    ) => Promise<readonly string[]>,
    onProgress?: ((line: string) => void) | undefined,
  ) => Promise<{ readonly lines: readonly string[]; readonly failed: boolean }>;
  runInlineCommand?: ((args: readonly string[]) => Promise<readonly string[]>) | undefined;
  refineInlineCommandResultLines?: ((input: {
    args: readonly string[];
    lines: readonly string[];
    failed: boolean;
    authLabel: string;
  }) => readonly string[]) | undefined;
  refreshAuthState?: (() => Promise<{ authLabel: string; authIssueLines?: readonly string[] }>) | undefined;
  extractAuthLabel?: ((lines: readonly string[]) => string | undefined) | undefined;
  applyAuthIssueLines: (authIssueLines?: readonly string[]) => void;
  buildInlineCommandPanel: (args: readonly string[], lines: readonly string[]) => WorkShellPanel;
  formatInlineCommandResultSummary: (args: readonly string[], lines: readonly string[]) => string;
  appendEntries: (...entries: readonly WorkShellChatEntry[]) => void;
  setState: (patch: Partial<WorkShellEngineState<Reasoning>>) => void;
  pushTraceLine: (line: string, preservePanel?: boolean) => void;
}): Promise<void> {
  const runInlineCommand = input.runInlineCommand;
  if (!runInlineCommand) {
    return;
  }

  const { isAuthLogin } = resolveVisibleInlineCommand({
    line: input.line,
    slashCommand: input.slashCommand,
  });
  input.appendEntries({ role: "user", text: redactSensitiveInlineCommandLine(input.line) });
  input.setState({
    isBusy: true,
    ...(isAuthLogin ? { panel: createAuthLoginPendingPanel() } : {}),
  });

  try {
    const result = await WorkShellOperations.resolveInlineOperationalCommandResult({
      line: input.line,
      slashCommand: input.slashCommand,
      currentAuthLabel: input.state.authLabel,
      resolveWorkShellInlineCommand: input.resolveWorkShellInlineCommand,
      runInlineCommand,
      refineInlineCommandResultLines: input.refineInlineCommandResultLines,
      refreshAuthState: input.refreshAuthState,
      extractAuthLabel: input.extractAuthLabel,
      applyAuthIssueLines: input.applyAuthIssueLines,
      onAuthProgressPatch: (patch) => input.setState(patch),
    });
    input.appendEntries(...result.entries);
    input.setState(result.patch);
    if (input.slashCommand[0] === "mode" && input.slashCommand[1] === "set" && input.slashCommand[2]) {
      await input.onModeChanged?.(input.slashCommand[2]);
    }
    for (const traceLine of result.traceLines) {
      input.pushTraceLine(traceLine, true);
    }
  } finally {
    input.setState({ isBusy: false });
  }
}

export async function executeLocalCommandSubmit<Reasoning extends WorkShellReasoningConfig>(input: {
  line: string;
  localCommand: Extract<WorkShellSubmitRoute, { readonly kind: "local-command" }>["localCommand"];
  cwd: string;
  sessionId: string;
  listScopedMemoryLines: (input: {
    scope: "session" | "project" | "user" | "agent";
    cwd: string;
    sessionId?: string;
    agentId?: string;
  }) => Promise<readonly string[]>;
  writeScopedMemory: (input: {
    scope: "session" | "project" | "user" | "agent";
    cwd: string;
    summary: string;
    sessionId?: string;
    agentId?: string;
  }) => Promise<{ memoryId: string }>;
  formatAgentTraceLine: (event: {
    readonly type: "memory.written";
    readonly level: "high-signal";
    readonly memoryId: string;
    readonly scope: "session" | "project" | "user" | "agent";
    readonly summary: string;
  }) => string;
  appendEntries: (...entries: readonly WorkShellChatEntry[]) => void;
  setState: (patch: Partial<WorkShellEngineState<Reasoning>>) => void;
  pushTraceLine: (line: string, preservePanel?: boolean) => void;
}): Promise<void> {
  if (input.localCommand.kind === "memories") {
    // Listing memories is a read-only display operation — no trace push.
    // Only write operations (the "remember" branch below) emit a trace line.
    const { sessionMemory, projectMemory } = await WorkShellOperations.loadWorkShellMemoriesPanel({
      cwd: input.cwd,
      sessionId: input.sessionId,
      listScopedMemoryLines: input.listScopedMemoryLines,
    });
    const result = createMemoriesLocalCommandResult<Reasoning>({
      line: input.line,
      sessionMemory,
      projectMemory,
    });
    input.appendEntries(...result.entries);
    input.setState(result.patch);
    return;
  }

  if ("usageError" in input.localCommand) {
    input.appendEntries(
      ...createRememberUsageErrorResult(input.line, input.localCommand.usageError).entries,
    );
    return;
  }

  const result = await WorkShellOperations.writeWorkShellRememberCommand({
    command: input.localCommand,
    cwd: input.cwd,
    sessionId: input.sessionId,
    writeScopedMemory: input.writeScopedMemory,
    listScopedMemoryLines: input.listScopedMemoryLines,
    formatAgentTraceLine: input.formatAgentTraceLine,
  });
  const commandResult = createRememberLocalCommandResult<Reasoning>({
    line: input.line,
    scope: input.localCommand.scope,
    memoryTrace: result.memoryTrace,
    nextMemoryLines: result.nextMemoryLines,
  });
  if (commandResult.patch) {
    input.setState(commandResult.patch);
  }
  input.appendEntries(...commandResult.entries);
  input.pushTraceLine(commandResult.traceLine);
}
