import {
  createAuthLoginPendingPanel,
  createMemoriesPanel,
  createSecureApiKeyEntryPanel,
  redactSensitiveInlineCommandLine,
  resolveVisibleInlineCommand,
} from "./work-shell-engine-commands.js";
import * as WorkShellOperations from "./work-shell-engine-operations.js";
import { createWorkShellStatusPanel } from "./work-shell-engine-panels.js";
import { createWorkShellAuthStatePatch } from "./work-shell-engine-state.js";
import type {
  WorkShellChatEntry,
  WorkShellEngineOptions,
  WorkShellEngineState,
  WorkShellPanel,
} from "./work-shell-engine.js";
import type { WorkShellReasoningConfig } from "./reasoning.js";
import type { WorkShellSubmitRoute } from "./work-shell-engine-submit.js";

export async function executeSecureApiKeyEntrySubmit<Reasoning extends WorkShellReasoningConfig>(input: {
  line: string;
  state: WorkShellEngineState<Reasoning>;
  options: WorkShellEngineOptions<Reasoning>;
  buildStatusPanel: (
    options: WorkShellEngineOptions<Reasoning>,
    reasoning: Reasoning,
    authLabel: string,
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
      input.appendEntries({ role: "system", text: "Secure API key entry is unavailable." });
      input.setState({
        composerMode: "default",
        panel: createWorkShellStatusPanel({
          options: input.options,
          stateModel: input.state.model,
          reasoning: input.state.reasoning,
          authLabel: input.state.authLabel,
          buildStatusPanel: input.buildStatusPanel,
        }),
      });
      return;
    }
    if (result.kind === "error") {
      input.appendEntries({ role: "system", text: result.message });
      input.setState({ panel: createSecureApiKeyEntryPanel(result.message) });
      return;
    }
    input.appendEntries(
      { role: "tool", text: "✓ auth key" },
      {
        role: "system",
        text: input.formatInlineCommandResultSummary(["auth", "key"], result.resultLines),
      },
    );
    input.setState({
      composerMode: "default",
      ...createWorkShellAuthStatePatch({
        state: input.state,
        authLabel: result.nextAuthLabel,
        authLauncherLines: result.resultLines,
      }),
      panel: input.buildInlineCommandPanel(["auth", "key"], result.resultLines),
    });
    input.pushTraceLine("→ auth key", true);
    input.pushTraceLine("✓ auth key", true);
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
      onAuthProgressLines: (lines) => {
        input.setState({
          panel: {
            title: "Auth",
            lines,
          },
        });
      },
    });
    input.appendEntries(
      { role: "tool", text: result.completionLine },
      {
        role: "system",
        text: input.formatInlineCommandResultSummary(result.visibleArgs, result.resultLines),
      },
    );
    input.setState({
      authLabel: result.nextAuthLabel,
      ...(result.isAuthCommand ? { authLauncherLines: result.resultLines } : {}),
      panel: input.buildInlineCommandPanel(result.visibleArgs, result.resultLines),
    });
    if (input.slashCommand[0] === "mode" && input.slashCommand[1] === "set" && input.slashCommand[2]) {
      await input.onModeChanged?.(input.slashCommand[2]);
    }
    input.pushTraceLine(`→ ${result.visibleArgs.join(" ")}`, true);
    input.pushTraceLine(result.completionLine, true);
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
    input.appendEntries(
      { role: "user", text: input.line },
      { role: "system", text: "Memories shown." },
    );
    input.setState({
      memoryLines: sessionMemory,
      panel: createMemoriesPanel(sessionMemory, projectMemory),
    });
    return;
  }

  if ("usageError" in input.localCommand) {
    input.appendEntries(
      { role: "user", text: input.line },
      { role: "system", text: input.localCommand.usageError },
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
  if (input.localCommand.scope === "session") {
    input.setState({ memoryLines: result.nextMemoryLines });
  }
  input.appendEntries(
    { role: "user", text: input.line },
    { role: "tool", text: result.memoryTrace },
  );
  input.pushTraceLine(result.memoryTrace);
}
