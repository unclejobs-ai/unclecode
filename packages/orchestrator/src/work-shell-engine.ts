import { randomUUID } from "node:crypto";

import {
  createAuthKeyBuiltinResult,
  createBuiltinStatusPanel,
  createContextBuiltinResult,
  createHelpBuiltinResult,
  createLoadedSkillBuiltinResult,
  createSkillLoadErrorEntries,
  createSkillsBuiltinResult,
  createSkillUsageErrorEntries,
  createStatusBuiltinResult,
  createToolsBuiltinResult,
  createTraceModeBuiltinResult,
  resolveModelBuiltinResult,
  resolveReasoningBuiltinResult,
} from "./work-shell-engine-builtins.js";
import {
  buildPromptCommandPrompt,
  createAuthLoginPendingPanel,
  createMemoriesPanel,
  createSecureApiKeyEntryPanel,
  redactSensitiveInlineCommandLine,
  resolvePromptSlashCommand,
  resolveVisibleInlineCommand,
  resolveWorkShellBuiltinCommand,
  resolveWorkShellLocalCommand,
} from "./work-shell-engine-commands.js";
import * as WorkShellOperations from "./work-shell-engine-operations.js";
import * as WorkShellPostTurns from "./work-shell-engine-post-turns.js";
import * as WorkShellTurns from "./work-shell-engine-turns.js";
import {
  createWorkShellSessionSnapshotInput,
  loadWorkShellContextState,
} from "./work-shell-engine-persistence.js";
import {
  appendWorkShellEntries,
  createInitialWorkShellEngineState,
  createWorkShellAuthStatePatch,
  createWorkShellBusyStatePatch,
  createWorkShellTraceLinePatch,
  createWorkShellTraceModePatch,
} from "./work-shell-engine-state.js";
import {
  extractCurrentTurnStartedAt,
  resolveBusyStatusFromTraceEvent,
  resolveTraceEntryRole,
} from "./work-shell-engine-trace.js";
import type { WorkShellReasoningConfig } from "./reasoning.js";

export type WorkShellChatEntry = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly text: string;
};

export type WorkShellPanel = {
  readonly title: string;
  readonly lines: readonly string[];
};

export type WorkShellComposerResolution<Attachment> = {
  readonly prompt: string;
  readonly attachments: readonly Attachment[];
  readonly transcriptText: string;
};

export type WorkShellLoadedSkill = {
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly attempts: readonly {
    readonly path: string;
    readonly ok: boolean;
    readonly error?: string | undefined;
  }[];
};

export type WorkShellSkillListItem = {
  readonly name: string;
  readonly path: string;
  readonly scope: "project" | "user";
  readonly summary?: string | undefined;
};

export type WorkShellMemoryScope = "session" | "project" | "user" | "agent";

export type WorkShellEngineOptions<Reasoning extends WorkShellReasoningConfig> = {
  readonly provider: string;
  readonly model: string;
  readonly mode: string;
  readonly authLabel: string;
  readonly reasoning: Reasoning;
  readonly cwd: string;
  readonly contextSummaryLines: readonly string[];
  readonly initialTraceMode?: WorkShellTraceMode | undefined;
  readonly autoContinueOnPermissionStall?: boolean | undefined;
};

export type WorkShellTraceMode = "minimal" | "verbose";

export type WorkShellComposerMode = "default" | "api-key-entry";

export type WorkShellEngineState<Reasoning extends WorkShellReasoningConfig> = {
  readonly entries: readonly WorkShellChatEntry[];
  readonly model: string;
  readonly reasoning: Reasoning;
  readonly authLabel: string;
  readonly authLauncherLines: readonly string[];
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
  readonly panel: WorkShellPanel;
  readonly traceLines: readonly string[];
  readonly traceMode: WorkShellTraceMode;
  readonly composerMode: WorkShellComposerMode;
  readonly isBusy: boolean;
  readonly busyStatus?: string | undefined;
  readonly currentTurnStartedAt?: number | undefined;
  readonly lastTurnDurationMs?: number | undefined;
};

export interface WorkShellAgent<Attachment, TraceEvent, Reasoning extends WorkShellReasoningConfig> {
  clear(): void;
  runTurn(prompt: string, attachments?: readonly Attachment[]): Promise<{ text: string }>;
  updateRuntimeSettings(settings: { reasoning?: Reasoning | undefined; model?: string | undefined }): void;
  setTraceListener(listener?: ((event: TraceEvent) => void) | undefined): void;
}

export type WorkShellEngineInput<
  Attachment,
  Reasoning extends WorkShellReasoningConfig,
  TraceEvent extends { readonly type: string },
> = {
  agent: WorkShellAgent<Attachment, TraceEvent, Reasoning>;
  options: WorkShellEngineOptions<Reasoning>;
  buildContextPanel: (
    contextSummaryLines: readonly string[],
    bridgeLines: readonly string[],
    memoryLines: readonly string[],
    traceLines: readonly string[],
    expanded?: boolean,
  ) => WorkShellPanel;
  buildHelpPanel: () => WorkShellPanel;
  buildStatusPanel: (
    options: WorkShellEngineOptions<Reasoning>,
    reasoning: Reasoning,
    authLabel: string,
  ) => WorkShellPanel;
  buildInlineCommandPanel: (args: readonly string[], lines: readonly string[]) => WorkShellPanel;
  formatInlineCommandResultSummary: (args: readonly string[], lines: readonly string[]) => string;
  formatAgentTraceLine: (event: TraceEvent | { readonly type: "bridge.published" | "memory.written"; readonly [key: string]: unknown }) => string;
  formatWorkShellError: (message: string) => string;
  listProjectBridgeLines: (cwd: string) => Promise<readonly string[]>;
  listScopedMemoryLines: (input: {
    scope: WorkShellMemoryScope;
    cwd: string;
    sessionId?: string;
    agentId?: string;
  }) => Promise<readonly string[]>;
  listSessionLines: (cwd: string) => Promise<readonly string[]>;
  persistWorkShellSessionSnapshot: (input: {
    cwd: string;
    sessionId: string;
    model: string;
    mode: string;
    state: "running" | "idle" | "requires_action";
    summary: string;
    traceMode?: WorkShellTraceMode | undefined;
  }) => Promise<void>;
  resolveReasoningCommand: (
    input: string,
    reasoning: Reasoning,
    modeDefault: Reasoning,
  ) => { nextReasoning: Reasoning; message: string };
  resolveModelCommand?: ((
    input: string,
    currentModel: string,
    currentReasoning: Reasoning,
    modeDefault: Reasoning,
  ) => {
    readonly nextModel: string;
    readonly nextReasoning: Reasoning;
    readonly message: string;
    readonly panel: WorkShellPanel;
  } | undefined) | undefined;
  resolveWorkShellSlashCommand: (input: string) => readonly string[] | undefined;
  resolveWorkShellInlineCommand: (
    args: readonly string[],
    runInlineCommand: (
      args: readonly string[],
      onProgress?: ((line: string) => void) | undefined,
    ) => Promise<readonly string[]>,
    onProgress?: ((line: string) => void) | undefined,
  ) => Promise<{ readonly lines: readonly string[]; readonly failed: boolean }>;
  refineInlineCommandResultLines?: (input: {
    args: readonly string[];
    lines: readonly string[];
    failed: boolean;
    authLabel: string;
  }) => readonly string[];
  refreshAuthState?: (() => Promise<{ authLabel: string; authIssueLines?: readonly string[] }>) | undefined;
  runInlineCommand?: ((args: readonly string[]) => Promise<readonly string[]>) | undefined;
  saveApiKeyAuth?: ((raw: string) => Promise<readonly string[]>) | undefined;
  resolveComposerInput: (value: string, cwd: string) => Promise<WorkShellComposerResolution<Attachment>>;
  publishContextBridge: (input: {
    cwd: string;
    summary: string;
    source: string;
    target: string;
    kind: "summary" | "decision" | "fact" | "file-change" | "task-state" | "warning";
  }) => Promise<{ bridgeId: string; line: string }>;
  writeScopedMemory: (input: {
    scope: WorkShellMemoryScope;
    cwd: string;
    summary: string;
    sessionId?: string;
    agentId?: string;
  }) => Promise<{ memoryId: string }>;
  listAvailableSkills?: (cwd: string) => Promise<readonly WorkShellSkillListItem[]>;
  loadNamedSkill?: (name: string, cwd: string) => Promise<WorkShellLoadedSkill>;
  reloadWorkspaceContext?: (cwd: string) => Promise<readonly string[]>;
  toolLines?: readonly string[];
  extractAuthLabel?: (lines: readonly string[]) => string | undefined;
  onExit: () => void;
  sessionId?: string;
};

export class WorkShellEngine<
  Attachment,
  Reasoning extends WorkShellReasoningConfig,
  TraceEvent extends { readonly type: string },
> {
  private readonly agent: WorkShellAgent<Attachment, TraceEvent, Reasoning>;
  private readonly options: WorkShellEngineOptions<Reasoning>;
  private readonly buildContextPanel: (
    contextSummaryLines: readonly string[],
    bridgeLines: readonly string[],
    memoryLines: readonly string[],
    traceLines: readonly string[],
    expanded?: boolean,
  ) => WorkShellPanel;
  private readonly buildHelpPanel: () => WorkShellPanel;
  private readonly buildStatusPanel: (
    options: WorkShellEngineOptions<Reasoning>,
    reasoning: Reasoning,
    authLabel: string,
  ) => WorkShellPanel;
  private readonly buildInlineCommandPanel: (args: readonly string[], lines: readonly string[]) => WorkShellPanel;
  private readonly formatInlineCommandResultSummary: (args: readonly string[], lines: readonly string[]) => string;
  private readonly formatAgentTraceLine: (event: TraceEvent | { readonly type: "bridge.published" | "memory.written"; readonly [key: string]: unknown }) => string;
  private readonly formatWorkShellError: (message: string) => string;
  private readonly listProjectBridgeLines: (cwd: string) => Promise<readonly string[]>;
  private readonly listScopedMemoryLines: (input: {
    scope: WorkShellMemoryScope;
    cwd: string;
    sessionId?: string;
    agentId?: string;
  }) => Promise<readonly string[]>;
  private readonly listSessionLines: (cwd: string) => Promise<readonly string[]>;
  private readonly persistWorkShellSessionSnapshot: (input: {
    cwd: string;
    sessionId: string;
    model: string;
    mode: string;
    state: "running" | "idle" | "requires_action";
    summary: string;
    traceMode?: WorkShellTraceMode | undefined;
  }) => Promise<void>;
  private readonly resolveReasoningCommand: (
    input: string,
    reasoning: Reasoning,
    modeDefault: Reasoning,
  ) => { nextReasoning: Reasoning; message: string };
  private readonly resolveModelCommand?: ((
    input: string,
    currentModel: string,
    currentReasoning: Reasoning,
    modeDefault: Reasoning,
  ) => {
    readonly nextModel: string;
    readonly nextReasoning: Reasoning;
    readonly message: string;
    readonly panel: WorkShellPanel;
  } | undefined) | undefined;
  private readonly resolveWorkShellSlashCommand: (input: string) => readonly string[] | undefined;
  private readonly resolveWorkShellInlineCommand: (
    args: readonly string[],
    runInlineCommand: (
      args: readonly string[],
      onProgress?: ((line: string) => void) | undefined,
    ) => Promise<readonly string[]>,
    onProgress?: ((line: string) => void) | undefined,
  ) => Promise<{ readonly lines: readonly string[]; readonly failed: boolean }>;
  private readonly refineInlineCommandResultLines?: ((input: {
    args: readonly string[];
    lines: readonly string[];
    failed: boolean;
    authLabel: string;
  }) => readonly string[]) | undefined;
  private readonly refreshAuthState?: (() => Promise<{ authLabel: string; authIssueLines?: readonly string[] }>) | undefined;
  private readonly runInlineCommand?: ((
    args: readonly string[],
    onProgress?: ((line: string) => void) | undefined,
  ) => Promise<readonly string[]>) | undefined;
  private readonly saveApiKeyAuth?: ((raw: string) => Promise<readonly string[]>) | undefined;
  private readonly resolveComposerInput: (value: string, cwd: string) => Promise<WorkShellComposerResolution<Attachment>>;
  private readonly publishContextBridge: (input: {
    cwd: string;
    summary: string;
    source: string;
    target: string;
    kind: "summary" | "decision" | "fact" | "file-change" | "task-state" | "warning";
  }) => Promise<{ bridgeId: string; line: string }>;
  private readonly writeScopedMemory: (input: {
    scope: WorkShellMemoryScope;
    cwd: string;
    summary: string;
    sessionId?: string;
    agentId?: string;
  }) => Promise<{ memoryId: string }>;
  private readonly listAvailableSkills: (cwd: string) => Promise<readonly WorkShellSkillListItem[]>;
  private readonly loadNamedSkill: (name: string, cwd: string) => Promise<WorkShellLoadedSkill>;
  private readonly reloadWorkspaceContext?: ((cwd: string) => Promise<readonly string[]>) | undefined;
  private readonly toolLines: readonly string[];
  private readonly extractAuthLabel?: ((lines: readonly string[]) => string | undefined) | undefined;
  private readonly onExit: () => void;
  private readonly sessionId: string;
  private readonly subscribers = new Set<(state: WorkShellEngineState<Reasoning>) => void>();
  private currentContextSummaryLines: readonly string[];
  private lastSessionSummary = "Work shell ready.";
  private state: WorkShellEngineState<Reasoning>;

  constructor(input: WorkShellEngineInput<Attachment, Reasoning, TraceEvent>) {
    this.agent = input.agent;
    this.options = input.options;
    this.buildContextPanel = input.buildContextPanel;
    this.buildHelpPanel = input.buildHelpPanel;
    this.buildStatusPanel = input.buildStatusPanel;
    this.buildInlineCommandPanel = input.buildInlineCommandPanel;
    this.formatInlineCommandResultSummary = input.formatInlineCommandResultSummary;
    this.formatAgentTraceLine = input.formatAgentTraceLine;
    this.formatWorkShellError = input.formatWorkShellError;
    this.listProjectBridgeLines = input.listProjectBridgeLines;
    this.listScopedMemoryLines = input.listScopedMemoryLines;
    this.listSessionLines = input.listSessionLines;
    this.persistWorkShellSessionSnapshot = input.persistWorkShellSessionSnapshot;
    this.resolveReasoningCommand = input.resolveReasoningCommand;
    this.resolveModelCommand = input.resolveModelCommand;
    this.resolveWorkShellSlashCommand = input.resolveWorkShellSlashCommand;
    this.resolveWorkShellInlineCommand = input.resolveWorkShellInlineCommand;
    this.refineInlineCommandResultLines = input.refineInlineCommandResultLines;
    this.refreshAuthState = input.refreshAuthState;
    this.runInlineCommand = input.runInlineCommand;
    this.saveApiKeyAuth = input.saveApiKeyAuth;
    this.resolveComposerInput = input.resolveComposerInput;
    this.publishContextBridge = input.publishContextBridge;
    this.writeScopedMemory = input.writeScopedMemory;
    this.listAvailableSkills = input.listAvailableSkills ?? (async () => []);
    this.loadNamedSkill = input.loadNamedSkill ?? (async (name) => ({ name, path: name, content: "", attempts: [] }));
    this.reloadWorkspaceContext = input.reloadWorkspaceContext;
    this.toolLines = input.toolLines ?? [];
    this.extractAuthLabel = input.extractAuthLabel;
    this.onExit = input.onExit;
    this.sessionId = input.sessionId ?? `work-${randomUUID()}`;
    this.currentContextSummaryLines = input.options.contextSummaryLines;
    this.state = createInitialWorkShellEngineState({
      options: input.options,
      contextSummaryLines: this.currentContextSummaryLines,
      buildContextPanel: input.buildContextPanel,
    });
  }

  getState(): WorkShellEngineState<Reasoning> {
    return this.state;
  }

  subscribe(listener: (state: WorkShellEngineState<Reasoning>) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    this.agent.setTraceListener((event) => {
      void this.handleTraceEvent(event);
    });
    await this.persistSessionSnapshot("idle", this.lastSessionSummary).catch(() => undefined);

    const [bridgeLines, memoryLines] = await Promise.all([
      this.listProjectBridgeLines(this.options.cwd),
      this.listScopedMemoryLines({ scope: "session", cwd: this.options.cwd, sessionId: this.sessionId }),
    ]).catch(() => [[], []] as const);

    this.setState({
      bridgeLines,
      memoryLines,
      panel: this.buildContextPanel(this.currentContextSummaryLines, bridgeLines, memoryLines, []),
    });
  }

  dispose(): void {
    this.agent.setTraceListener(undefined);
  }

  async openSessionsPanel(): Promise<void> {
    this.setState({ panel: { title: "Recent sessions", lines: ["Loading sessions…"] } });
    const lines = await this.listSessionLines(this.options.cwd);
    this.setState({ panel: { title: "Recent sessions", lines } });
  }

  cancelSensitiveInput(): void {
    if (this.state.composerMode === "default") {
      return;
    }

    this.appendEntries({ role: "system", text: "API key entry canceled." });
    this.setState({
      composerMode: "default",
      panel: this.buildStatusPanelFor(this.state.reasoning, this.state.authLabel),
    });
  }

  closeOverlay(): void {
    if (this.state.panel.title !== "Context expanded") {
      return;
    }

    this.setState({
      panel: this.buildContextPanel(
        this.currentContextSummaryLines,
        this.state.bridgeLines,
        this.state.memoryLines,
        this.state.traceLines,
      ),
    });
  }

  async handleSubmit(value: string): Promise<void> {
    const line = value.trim();
    if (!line || this.state.isBusy) {
      return;
    }

    if (this.state.composerMode === "api-key-entry") {
      this.setState({ isBusy: true });
      try {
        const result = await WorkShellOperations.resolveSecureApiKeyEntrySubmission({
          line,
          currentAuthLabel: this.state.authLabel,
          saveApiKeyAuth: this.saveApiKeyAuth,
          refreshAuthState: this.refreshAuthState,
          extractAuthLabel: this.extractAuthLabel,
          applyAuthIssueLines: (authIssueLines) => this.applyAuthIssueLines(authIssueLines),
          formatWorkShellError: this.formatWorkShellError,
        });
        if (result.kind === "unavailable") {
          this.appendEntries({ role: "system", text: "Secure API key entry is unavailable." });
          this.setState({
            composerMode: "default",
            panel: this.buildStatusPanelFor(this.state.reasoning, this.state.authLabel),
          });
          return;
        }
        if (result.kind === "error") {
          this.appendEntries({ role: "system", text: result.message });
          this.setState({
            panel: createSecureApiKeyEntryPanel(result.message),
          });
          return;
        }
        this.appendEntries(
          { role: "tool", text: "✓ auth key" },
          { role: "system", text: this.formatInlineCommandResultSummary(["auth", "key"], result.resultLines) },
        );
        this.setState({
          composerMode: "default",
          ...createWorkShellAuthStatePatch({
            state: this.state,
            authLabel: result.nextAuthLabel,
            authLauncherLines: result.resultLines,
          }),
          panel: this.buildInlineCommandPanel(["auth", "key"], result.resultLines),
        });
        this.pushTraceLine("→ auth key", true);
        this.pushTraceLine("✓ auth key", true);
      } finally {
        this.setState({ isBusy: false });
      }
      return;
    }

    const builtinCommand = resolveWorkShellBuiltinCommand(line);
    if (builtinCommand) {
      switch (builtinCommand.kind) {
        case "exit":
          this.onExit();
          return;
        case "clear":
          this.agent.clear();
          this.setState({ entries: [{ role: "system", text: "Conversation cleared." }] });
          return;
        case "help": {
          const result = createHelpBuiltinResult(line, this.buildHelpPanel);
          this.appendEntries(...result.entries);
          this.setState({ panel: result.panel });
          return;
        }
        case "context": {
          const result = createContextBuiltinResult({
            line,
            contextSummaryLines: this.currentContextSummaryLines,
            state: this.state,
            buildContextPanel: this.buildContextPanel,
          });
          this.appendEntries(...result.entries);
          this.setState({ panel: result.panel });
          return;
        }
        case "reload":
          this.appendEntries(
            { role: "user", text: line },
            { role: "system", text: "Reloading workspace context…" },
          );
          await this.reloadContextState();
          this.appendEntries({ role: "system", text: "Workspace context reloaded." });
          return;
        case "status": {
          const result = createStatusBuiltinResult({
            line,
            reasoning: this.state.reasoning,
            authLabel: this.state.authLabel,
            buildStatusPanel: (reasoning, authLabel) => this.buildStatusPanelFor(reasoning, authLabel),
          });
          this.appendEntries(...result.entries);
          this.setState({ panel: result.panel });
          return;
        }
        case "trace-mode": {
          const result = createTraceModeBuiltinResult({
            line,
            traceMode: builtinCommand.traceMode,
            state: this.state,
            contextSummaryLines: this.currentContextSummaryLines,
            buildContextPanel: this.buildContextPanel,
          });
          this.appendEntries(...result.entries);
          this.setState(result.patch);
          await this.persistSessionSnapshot("idle", this.lastSessionSummary, builtinCommand.traceMode).catch(() => undefined);
          return;
        }
        case "sessions":
          this.appendEntries({ role: "user", text: line });
          await this.openSessionsPanel();
          return;
        case "reasoning": {
          const result = resolveReasoningBuiltinResult({
            line,
            currentReasoning: this.state.reasoning,
            modeDefaultReasoning: this.modeDefaultReasoning(),
            authLabel: this.state.authLabel,
            resolveReasoningCommand: this.resolveReasoningCommand,
            buildStatusPanel: (reasoning, authLabel) => this.buildStatusPanelFor(reasoning, authLabel),
          });
          this.agent.updateRuntimeSettings({ reasoning: result.nextReasoning });
          this.appendEntries(...result.entries);
          this.setState({
            reasoning: result.nextReasoning,
            panel: result.panel,
          });
          return;
        }
        case "model": {
          const result = resolveModelBuiltinResult({
            line,
            currentModel: this.state.model,
            currentReasoning: this.state.reasoning,
            modeDefaultReasoning: this.modeDefaultReasoning(),
            resolveModelCommand: this.resolveModelCommand,
          });
          if (!result) {
            break;
          }
          if (result.shouldUpdateRuntime) {
            this.agent.updateRuntimeSettings({ model: result.nextModel, reasoning: result.nextReasoning });
          }
          this.appendEntries(...result.entries);
          this.setState({
            model: result.nextModel,
            reasoning: result.nextReasoning,
            panel: result.panel,
          });
          await this.persistSessionSnapshot("idle", this.lastSessionSummary).catch(() => undefined);
          return;
        }
        case "tools":
          this.appendEntries(...createToolsBuiltinResult(line, this.toolLines));
          return;
        case "auth-key": {
          const result = createAuthKeyBuiltinResult(line);
          this.appendEntries(...result.entries);
          this.setState({
            composerMode: result.composerMode,
            panel: result.panel,
          });
          return;
        }
        case "skills": {
          const skills = await this.listAvailableSkills(this.options.cwd);
          const result = createSkillsBuiltinResult(line, skills);
          this.appendEntries(...result.entries);
          this.setState({ panel: result.panel });
          return;
        }
        case "skill": {
          if (!builtinCommand.skillName) {
            this.appendEntries(...createSkillUsageErrorEntries(line));
            return;
          }

          try {
            const skill = await this.loadNamedSkill(builtinCommand.skillName, this.options.cwd);
            const result = createLoadedSkillBuiltinResult(line, skill);
            this.appendEntries(...result.entries);
            this.setState({ panel: result.panel });
          } catch (error) {
            this.appendEntries(...createSkillLoadErrorEntries(line, error));
          }
          return;
        }
      }
    }

    const slashCommand = this.resolveWorkShellSlashCommand(line);
    const promptCommand = resolvePromptSlashCommand(slashCommand);
    if (promptCommand) {
      await this.executePromptCommand(line, promptCommand);
      return;
    }

    if (slashCommand && this.runInlineCommand) {
      const { isAuthLogin } = resolveVisibleInlineCommand({
        line,
        slashCommand,
      });
      this.appendEntries({ role: "user", text: redactSensitiveInlineCommandLine(line) });
      this.setState({
        isBusy: true,
        ...(isAuthLogin ? { panel: createAuthLoginPendingPanel() } : {}),
      });

      try {
        const result = await WorkShellOperations.resolveInlineOperationalCommandResult({
          line,
          slashCommand,
          currentAuthLabel: this.state.authLabel,
          resolveWorkShellInlineCommand: this.resolveWorkShellInlineCommand,
          runInlineCommand: this.runInlineCommand,
          refineInlineCommandResultLines: this.refineInlineCommandResultLines,
          refreshAuthState: this.refreshAuthState,
          extractAuthLabel: this.extractAuthLabel,
          applyAuthIssueLines: (authIssueLines) => this.applyAuthIssueLines(authIssueLines),
          onAuthProgressLines: (lines) => {
            this.setState({
              panel: {
                title: "Auth",
                lines,
              },
            });
          },
        });
        this.appendEntries(
          { role: "tool", text: result.completionLine },
          { role: "system", text: this.formatInlineCommandResultSummary(result.visibleArgs, result.resultLines) },
        );
        this.setState({
          authLabel: result.nextAuthLabel,
          ...(result.isAuthCommand ? { authLauncherLines: result.resultLines } : {}),
          panel: this.buildInlineCommandPanel(result.visibleArgs, result.resultLines),
        });
        this.pushTraceLine(`→ ${result.visibleArgs.join(" ")}`, true);
        this.pushTraceLine(result.completionLine, true);
      } finally {
        this.setState({ isBusy: false });
      }
      return;
    }

    const localCommand = resolveWorkShellLocalCommand(line);
    if (localCommand?.kind === "memories") {
      const [sessionMemory, projectMemory] = await Promise.all([
        this.listScopedMemoryLines({ scope: "session", cwd: this.options.cwd, sessionId: this.sessionId }),
        this.listScopedMemoryLines({ scope: "project", cwd: this.options.cwd }),
      ]);
      this.appendEntries(
        { role: "user", text: line },
        { role: "system", text: "Memories shown." },
      );
      this.setState({
        memoryLines: sessionMemory,
        panel: createMemoriesPanel(sessionMemory, projectMemory),
      });
      return;
    }

    if (localCommand?.kind === "remember" && "usageError" in localCommand) {
      this.appendEntries(
        { role: "user", text: line },
        { role: "system", text: localCommand.usageError },
      );
      return;
    }

    if (localCommand?.kind === "remember") {
      const result = await this.writeScopedMemory({
        scope: localCommand.scope,
        cwd: this.options.cwd,
        summary: localCommand.summary,
        sessionId: this.sessionId,
        agentId: "work-shell",
      });
      const nextMemoryLines = await this.listScopedMemoryLines({
        scope: localCommand.scope === "project" ? "project" : localCommand.scope,
        cwd: this.options.cwd,
        sessionId: this.sessionId,
        agentId: "work-shell",
      });
      if (localCommand.scope === "session") {
        this.setState({ memoryLines: nextMemoryLines });
      }
      const memoryTrace = this.formatAgentTraceLine({
        type: "memory.written",
        level: "high-signal",
        memoryId: result.memoryId,
        scope: localCommand.scope,
        summary: localCommand.summary,
      });
      this.appendEntries(
        { role: "user", text: line },
        { role: "tool", text: memoryTrace },
      );
      this.pushTraceLine(memoryTrace);
      return;
    }

    const composer = await this.resolveComposerInput(line, this.options.cwd);
    await this.executePromptTurn(
      WorkShellTurns.createChatPromptTurnInput({
        line,
        composer,
      }),
    );
  }

  private async executePromptCommand(
    transcriptText: string,
    promptCommand: { readonly kind: "review" | "commit"; readonly focus?: string },
  ): Promise<void> {
    await this.executePromptTurn(
      WorkShellTurns.createPromptCommandTurnInput({
        transcriptText,
        prompt: buildPromptCommandPrompt(promptCommand),
        promptCommand,
      }),
    );
  }

  private async executePromptTurn(input: {
    transcriptText: string;
    prompt: string;
    sessionSummary: string;
    failureSummary: string;
    attachments?: readonly Attachment[];
  }): Promise<void> {
    this.appendEntries({ role: "user", text: input.transcriptText });
    const turnStartedAt = Date.now();
    this.setState({ isBusy: true, busyStatus: "thinking", currentTurnStartedAt: turnStartedAt });

    try {
      await this.persistSessionSnapshot("running", input.sessionSummary).catch(() => undefined);

      const result = await this.agent.runTurn(input.prompt, input.attachments ?? []);
      const lastTurnDurationMs = Date.now() - turnStartedAt;
      const assistantText = await WorkShellTurns.finalizeWorkShellAssistantReply({
        prompt: input.prompt,
        assistantText: result.text || "(empty response)",
        autoContinueOnPermissionStall: this.options.autoContinueOnPermissionStall,
        runTurn: (prompt) => this.agent.runTurn(prompt, []),
      });
      this.appendEntries({ role: "assistant", text: assistantText });

      const postTurnEffects = await WorkShellPostTurns.runWorkShellPostTurnSuccessEffects({
        cwd: this.options.cwd,
        transcriptText: input.transcriptText,
        assistantText,
        sessionId: this.sessionId,
        currentBridgeLines: this.state.bridgeLines,
        publishContextBridge: this.publishContextBridge,
        writeScopedMemory: this.writeScopedMemory,
        listScopedMemoryLines: this.listScopedMemoryLines,
      });
      this.setState({
        bridgeLines: postTurnEffects.bridgeLines,
        memoryLines: postTurnEffects.memoryLines,
      });
      this.pushTraceLine(this.formatAgentTraceLine(postTurnEffects.bridgeTraceEvent));
      this.pushTraceLine(this.formatAgentTraceLine(postTurnEffects.memoryTraceEvent));


      this.setState({ lastTurnDurationMs });
      await this.persistSessionSnapshot("idle", input.sessionSummary).catch(() => undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isAuthFailure = WorkShellPostTurns.isWorkShellAuthFailure(message);
      const nextAuthLabel = await WorkShellPostTurns.resolveWorkShellFailureAuthLabel({
        message,
        currentAuthLabel: this.state.authLabel,
        refreshAuthState: this.refreshAuthState,
        applyAuthIssueLines: (authIssueLines) => this.applyAuthIssueLines(authIssueLines),
      });
      this.appendEntries({ role: "system", text: this.formatWorkShellError(message) });
      this.setState({
        ...createWorkShellAuthStatePatch({
          state: this.state,
          authLabel: nextAuthLabel,
        }),
        currentTurnStartedAt: undefined,
        lastTurnDurationMs: Date.now() - turnStartedAt,
        ...(isAuthFailure
          ? { panel: this.buildStatusPanelFor(this.state.reasoning, nextAuthLabel) }
          : {}),
      });
      await this.persistSessionSnapshot("requires_action", input.failureSummary).catch(() => undefined);
    } finally {
      this.setState(createWorkShellBusyStatePatch({
        state: this.state,
        isBusy: false,
        clearCurrentTurnStartedAt: true,
      }));
    }
  }

  private async handleTraceEvent(event: TraceEvent): Promise<void> {
    const line = this.formatAgentTraceLine(event);
    const busyStatus = resolveBusyStatusFromTraceEvent(event, line);
    if (busyStatus !== null) {
      const currentTurnStartedAt = extractCurrentTurnStartedAt(
        event as { readonly type: string; readonly startedAt?: unknown },
      );
      this.setState(createWorkShellBusyStatePatch({
        state: this.state,
        isBusy: this.state.isBusy,
        ...(busyStatus ? { busyStatus } : {}),
        ...(currentTurnStartedAt !== undefined ? { currentTurnStartedAt } : {}),
        ...(event.type === "turn.completed"
          ? { clearCurrentTurnStartedAt: true }
          : {}),
      }));
    }

    if (this.state.traceMode !== "verbose") {
      return;
    }

    if (!line) {
      return;
    }

    const role = resolveTraceEntryRole(event);
    this.appendEntries({ role, text: line });
    this.pushTraceLine(line);
  }

  private modeDefaultReasoning(): Reasoning {
    if (this.options.reasoning.support.status === "unsupported") {
      return this.options.reasoning;
    }

    return {
      ...this.options.reasoning,
      effort: this.options.reasoning.effort,
      source: "mode-default",
    };
  }

  private buildStatusPanelFor(reasoning: Reasoning, authLabel: string): WorkShellPanel {
    return createBuiltinStatusPanel({
      options: this.options,
      stateModel: this.state.model,
      reasoning,
      authLabel,
      buildStatusPanel: this.buildStatusPanel,
    });
  }

  private applyAuthIssueLines(authIssueLines: readonly string[] = []): void {
    const nonAuthIssueLines = this.currentContextSummaryLines.filter((line) => !line.startsWith("Auth issue:"));
    this.currentContextSummaryLines = [...authIssueLines, ...nonAuthIssueLines];
  }

  private appendEntries(...entries: readonly WorkShellChatEntry[]): void {
    this.setState(appendWorkShellEntries(this.state, ...entries));
  }

  private async persistSessionSnapshot(
    state: "running" | "idle" | "requires_action",
    summary: string,
    traceMode = this.state.traceMode,
  ): Promise<void> {
    this.lastSessionSummary = summary;
    await this.persistWorkShellSessionSnapshot(createWorkShellSessionSnapshotInput({
      cwd: this.options.cwd,
      sessionId: this.sessionId,
      model: this.state.model,
      mode: this.options.mode,
      state,
      summary,
      traceMode,
    }));
  }

  private async reloadContextState(): Promise<void> {
    const { contextSummaryLines, bridgeLines, memoryLines } = await loadWorkShellContextState({
      cwd: this.options.cwd,
      sessionId: this.sessionId,
      currentContextSummaryLines: this.currentContextSummaryLines,
      reloadWorkspaceContext: this.reloadWorkspaceContext,
      listProjectBridgeLines: this.listProjectBridgeLines,
      listScopedMemoryLines: this.listScopedMemoryLines,
    });
    this.currentContextSummaryLines = contextSummaryLines;
    this.setState({
      bridgeLines,
      memoryLines,
      panel: this.buildContextPanel(this.currentContextSummaryLines, bridgeLines, memoryLines, this.state.traceLines),
    });
  }

  private pushTraceLine(line: string, preservePanel = false): void {
    this.setState(createWorkShellTraceLinePatch({
      state: this.state,
      line,
      preservePanel,
      contextSummaryLines: this.currentContextSummaryLines,
      buildContextPanel: this.buildContextPanel,
    }));
  }

  private setState(patch: Partial<WorkShellEngineState<Reasoning>>): void {
    this.state = { ...this.state, ...patch };
    for (const subscriber of this.subscribers) {
      subscriber(this.state);
    }
  }
}
