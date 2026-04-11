import { randomUUID } from "node:crypto";

import { executeWorkShellBuiltinSubmit } from "./work-shell-engine-builtin-runtime.js";
import {
  executeInlineCommandSubmit,
  executeLocalCommandSubmit,
  executeSecureApiKeyEntrySubmit,
} from "./work-shell-engine-command-runtime.js";
import {
  applyAuthIssueLinesToContextSummaryLines,
  reloadWorkShellContextState,
} from "./work-shell-engine-context.js";
import {
  executeWorkShellChatSubmit,
  executeWorkShellPromptCommandSubmit,
} from "./work-shell-engine-prompt-runtime.js";
import {
  loadInitialWorkShellLifecycleState,
  loadOpenSessionsPanelState,
  resolveCloseOverlayState,
  resolveSensitiveInputCancelState,
} from "./work-shell-engine-lifecycle.js";
import {
  resolveWorkShellSubmitRoute,
  type WorkShellSubmitRoute,
} from "./work-shell-engine-submit.js";
import { createWorkShellSessionSnapshotInput } from "./work-shell-engine-persistence.js";
import {
  appendWorkShellEntries,
  createInitialWorkShellEngineState,
  createWorkShellTraceLinePatch,
  resolveModeDefaultReasoning,
} from "./work-shell-engine-state.js";
import { applyWorkShellTraceEvent } from "./work-shell-engine-trace.js";
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
  readonly mode: string;
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
  updateMode?(mode: string): void;
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
      applyWorkShellTraceEvent({
        state: this.state,
        event,
        formatAgentTraceLine: this.formatAgentTraceLine,
        setState: (patch) => this.setState(patch),
        appendEntries: (...entries) => this.appendEntries(...entries),
        pushTraceLine: (line) => this.pushTraceLine(line),
      });
    });
    await this.persistSessionSnapshot("idle", this.lastSessionSummary).catch(() => undefined);

    const contextState = await loadInitialWorkShellLifecycleState({
      cwd: this.options.cwd,
      sessionId: this.sessionId,
      currentContextSummaryLines: this.currentContextSummaryLines,
      listProjectBridgeLines: this.listProjectBridgeLines,
      listScopedMemoryLines: this.listScopedMemoryLines,
      buildContextPanel: this.buildContextPanel,
    });

    this.setState(contextState);
  }

  dispose(): void {
    this.agent.setTraceListener(undefined);
  }

  async openSessionsPanel(): Promise<void> {
    const { loadingPanel, loadedPanel } = await loadOpenSessionsPanelState({
      cwd: this.options.cwd,
      listSessionLines: this.listSessionLines,
    });
    this.setState({ panel: loadingPanel });
    this.setState({ panel: loadedPanel });
  }

  cancelSensitiveInput(): void {
    const result = resolveSensitiveInputCancelState({
      composerMode: this.state.composerMode,
      options: this.options,
      stateModel: this.state.model,
      reasoning: this.state.reasoning,
      authLabel: this.state.authLabel,
      buildStatusPanel: this.buildStatusPanel,
    });
    if (!result) {
      return;
    }

    this.appendEntries(...result.entries);
    this.setState({
      composerMode: result.composerMode,
      panel: result.panel,
    });
  }

  closeOverlay(): void {
    const panel = resolveCloseOverlayState({
      panel: this.state.panel,
      currentContextSummaryLines: this.currentContextSummaryLines,
      bridgeLines: this.state.bridgeLines,
      memoryLines: this.state.memoryLines,
      traceLines: this.state.traceLines,
      buildContextPanel: this.buildContextPanel,
    });
    if (!panel) {
      return;
    }

    this.setState({ panel });
  }

  async handleSubmit(value: string): Promise<void> {
    const route = resolveWorkShellSubmitRoute({
      value,
      isBusy: this.state.isBusy,
      composerMode: this.state.composerMode,
      resolveWorkShellSlashCommand: this.resolveWorkShellSlashCommand,
      hasInlineCommandRunner: Boolean(this.runInlineCommand),
    });
    if (!route) {
      return;
    }

    switch (route.kind) {
      case "secure-api-key-entry":
        await this.handleSecureApiKeyEntrySubmit(route.line);
        return;
      case "builtin":
        await this.handleBuiltinSubmit(route.line, route.command);
        return;
      case "prompt-command":
        await executeWorkShellPromptCommandSubmit({
          transcriptText: route.line,
          promptCommand: route.promptCommand,
          state: this.state,
          options: this.options,
          sessionId: this.sessionId,
          buildStatusPanel: this.buildStatusPanel,
          autoContinueOnPermissionStall: this.options.autoContinueOnPermissionStall,
          runAgentTurn: (prompt: string, attachments?: readonly Attachment[]) => this.agent.runTurn(prompt, attachments),
          publishContextBridge: this.publishContextBridge,
          writeScopedMemory: this.writeScopedMemory,
          listScopedMemoryLines: this.listScopedMemoryLines,
          refreshAuthState: this.refreshAuthState,
          applyAuthIssueLines: (authIssueLines) => this.applyAuthIssueLines(authIssueLines),
          formatWorkShellError: this.formatWorkShellError,
          formatAgentTraceLine: this.formatAgentTraceLine,
          appendEntries: (...entries) => this.appendEntries(...entries),
          setState: (patch) => this.setState(patch),
          pushTraceLine: (traceLine) => this.pushTraceLine(traceLine),
          persistSessionSnapshot: (sessionState, summary) => this.persistSessionSnapshot(sessionState, summary),
        });
        return;
      case "inline-command":
        await this.handleInlineCommandSubmit(route.line, route.slashCommand);
        return;
      case "local-command":
        await this.handleLocalCommandSubmit(route.line, route.localCommand);
        return;
      case "chat":
        await executeWorkShellChatSubmit({
          line: route.line,
          resolveComposerInput: this.resolveComposerInput,
          state: this.state,
          options: this.options,
          sessionId: this.sessionId,
          buildStatusPanel: this.buildStatusPanel,
          autoContinueOnPermissionStall: this.options.autoContinueOnPermissionStall,
          runAgentTurn: (prompt: string, attachments?: readonly Attachment[]) => this.agent.runTurn(prompt, attachments),
          publishContextBridge: this.publishContextBridge,
          writeScopedMemory: this.writeScopedMemory,
          listScopedMemoryLines: this.listScopedMemoryLines,
          refreshAuthState: this.refreshAuthState,
          applyAuthIssueLines: (authIssueLines) => this.applyAuthIssueLines(authIssueLines),
          formatWorkShellError: this.formatWorkShellError,
          formatAgentTraceLine: this.formatAgentTraceLine,
          appendEntries: (...entries) => this.appendEntries(...entries),
          setState: (patch) => this.setState(patch),
          pushTraceLine: (traceLine) => this.pushTraceLine(traceLine),
          persistSessionSnapshot: (sessionState, summary) => this.persistSessionSnapshot(sessionState, summary),
        });
        return;
    }
  }

  private async handleSecureApiKeyEntrySubmit(line: string): Promise<void> {
    await executeSecureApiKeyEntrySubmit<Reasoning>({
      line,
      state: this.state,
      options: this.options,
      buildStatusPanel: this.buildStatusPanel,
      buildInlineCommandPanel: this.buildInlineCommandPanel,
      formatInlineCommandResultSummary: this.formatInlineCommandResultSummary,
      saveApiKeyAuth: this.saveApiKeyAuth,
      refreshAuthState: this.refreshAuthState,
      extractAuthLabel: this.extractAuthLabel,
      applyAuthIssueLines: (authIssueLines) => this.applyAuthIssueLines(authIssueLines),
      formatWorkShellError: this.formatWorkShellError,
      appendEntries: (...entries) => this.appendEntries(...entries),
      setState: (patch) => this.setState(patch),
      pushTraceLine: (traceLine, preservePanel) => this.pushTraceLine(traceLine, preservePanel),
    });
  }

  private async handleBuiltinSubmit(
    line: string,
    builtinCommand: Extract<WorkShellSubmitRoute, { readonly kind: "builtin" }>["command"],
  ): Promise<void> {
    await executeWorkShellBuiltinSubmit({
      line,
      builtinCommand,
      state: this.state,
      options: this.options,
      currentContextSummaryLines: this.currentContextSummaryLines,
      buildHelpPanel: this.buildHelpPanel,
      buildContextPanel: this.buildContextPanel,
      buildStatusPanel: this.buildStatusPanel,
      resolveReasoningCommand: this.resolveReasoningCommand,
      resolveModelCommand: this.resolveModelCommand,
      modeDefaultReasoning: resolveModeDefaultReasoning(this.options.reasoning),
      listAvailableSkills: this.listAvailableSkills,
      loadNamedSkill: this.loadNamedSkill,
      toolLines: this.toolLines,
      clearAgent: () => this.agent.clear(),
      updateRuntimeSettings: (settings) => this.agent.updateRuntimeSettings(settings),
      onExit: this.onExit,
      openSessionsPanel: () => this.openSessionsPanel(),
      reloadContextState: () => this.reloadContextState(),
      appendEntries: (...entries) => this.appendEntries(...entries),
      setState: (patch) => this.setState(patch),
      persistSessionSnapshot: (state, summary, traceMode) => this.persistSessionSnapshot(state, summary, traceMode),
      lastSessionSummary: this.lastSessionSummary,
    });
  }

  private async handleInlineCommandSubmit(line: string, slashCommand: readonly string[]): Promise<void> {
    await executeInlineCommandSubmit<Reasoning>({
      line,
      slashCommand,
      state: this.state,
      onModeChanged: async (mode) => {
        this.agent.updateMode?.(mode);
        this.setState({ mode });
      },
      resolveWorkShellInlineCommand: this.resolveWorkShellInlineCommand,
      runInlineCommand: this.runInlineCommand,
      refineInlineCommandResultLines: this.refineInlineCommandResultLines,
      refreshAuthState: this.refreshAuthState,
      extractAuthLabel: this.extractAuthLabel,
      applyAuthIssueLines: (authIssueLines) => this.applyAuthIssueLines(authIssueLines),
      buildInlineCommandPanel: this.buildInlineCommandPanel,
      formatInlineCommandResultSummary: this.formatInlineCommandResultSummary,
      appendEntries: (...entries) => this.appendEntries(...entries),
      setState: (patch) => this.setState(patch),
      pushTraceLine: (traceLine, preservePanel) => this.pushTraceLine(traceLine, preservePanel),
    });
  }

  private async handleLocalCommandSubmit(
    line: string,
    localCommand: Extract<WorkShellSubmitRoute, { readonly kind: "local-command" }>["localCommand"],
  ): Promise<void> {
    await executeLocalCommandSubmit<Reasoning>({
      line,
      localCommand,
      cwd: this.options.cwd,
      sessionId: this.sessionId,
      listScopedMemoryLines: this.listScopedMemoryLines,
      writeScopedMemory: this.writeScopedMemory,
      formatAgentTraceLine: this.formatAgentTraceLine,
      appendEntries: (...entries) => this.appendEntries(...entries),
      setState: (patch) => this.setState(patch),
      pushTraceLine: (traceLine, preservePanel) => this.pushTraceLine(traceLine, preservePanel),
    });
  }

  private applyAuthIssueLines(authIssueLines: readonly string[] = []): void {
    this.currentContextSummaryLines = applyAuthIssueLinesToContextSummaryLines(
      this.currentContextSummaryLines,
      authIssueLines,
    );
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
      mode: this.state.mode,
      state,
      summary,
      traceMode,
    }));
  }

  private async reloadContextState(): Promise<void> {
    const contextState = await reloadWorkShellContextState({
      cwd: this.options.cwd,
      sessionId: this.sessionId,
      currentContextSummaryLines: this.currentContextSummaryLines,
      reloadWorkspaceContext: this.reloadWorkspaceContext,
      listProjectBridgeLines: this.listProjectBridgeLines,
      listScopedMemoryLines: this.listScopedMemoryLines,
      traceLines: this.state.traceLines,
      buildContextPanel: this.buildContextPanel,
    });
    this.currentContextSummaryLines = contextState.contextSummaryLines;
    this.setState({
      bridgeLines: contextState.bridgeLines,
      memoryLines: contextState.memoryLines,
      panel: contextState.panel,
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
