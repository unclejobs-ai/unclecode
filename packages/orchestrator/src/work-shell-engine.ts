import { randomUUID } from "node:crypto";

import {
  buildAuthProgressPanelLines,
  buildPromptCommandPrompt,
  createAuthLoginPendingPanel,
  createLoadedSkillPanel,
  createSecureApiKeyEntryPanel,
  createSkillsPanel,
  resolvePromptSlashCommand,
  resolveWorkShellBuiltinCommand,
} from "./work-shell-engine-commands.js";
import * as WorkShellPostTurns from "./work-shell-engine-post-turns.js";
import * as WorkShellTurns from "./work-shell-engine-turns.js";
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
      if (!this.saveApiKeyAuth) {
        this.appendEntries({ role: "system", text: "Secure API key entry is unavailable." });
        this.setState({
          composerMode: "default",
          panel: this.buildStatusPanelFor(this.state.reasoning, this.state.authLabel),
        });
        return;
      }

      this.setState({ isBusy: true });
      try {
        const resultLines = await this.saveApiKeyAuth(line);
        let nextAuthLabel = this.extractAuthLabel?.(resultLines) ?? this.state.authLabel;
        if (this.refreshAuthState) {
          try {
            const refreshed = await this.refreshAuthState();
            nextAuthLabel = refreshed.authLabel;
            this.applyAuthIssueLines(refreshed.authIssueLines);
          } catch {
            nextAuthLabel = this.extractAuthLabel?.(resultLines) ?? this.state.authLabel;
          }
        }
        this.appendEntries(
          { role: "tool", text: "✓ auth key" },
          { role: "system", text: this.formatInlineCommandResultSummary(["auth", "key"], resultLines) },
        );
        this.setState({
          composerMode: "default",
          ...createWorkShellAuthStatePatch({
            state: this.state,
            authLabel: nextAuthLabel,
            authLauncherLines: resultLines,
          }),
          panel: this.buildInlineCommandPanel(["auth", "key"], resultLines),
        });
        this.pushTraceLine("→ auth key", true);
        this.pushTraceLine("✓ auth key", true);
      } catch (error) {
        const message = this.formatWorkShellError(error instanceof Error ? error.message : String(error));
        this.appendEntries({ role: "system", text: message });
        this.setState({
          panel: {
            title: "Auth",
            lines: [
              "Current",
              "Secure API key entry.",
              "",
              "Next",
              message,
              "Enter saves · Esc cancels.",
            ],
          },
        });
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
        case "help":
          this.appendEntries(
            { role: "user", text: line },
            { role: "system", text: "Help shown." },
          );
          this.setState({ panel: this.buildHelpPanel() });
          return;
        case "context":
          this.appendEntries(
            { role: "user", text: line },
            { role: "system", text: "Context shown." },
          );
          this.setState({
            panel: this.buildContextPanel(
              this.currentContextSummaryLines,
              this.state.bridgeLines,
              this.state.memoryLines,
              this.state.traceLines,
              true,
            ),
          });
          return;
        case "reload":
          this.appendEntries(
            { role: "user", text: line },
            { role: "system", text: "Reloading workspace context…" },
          );
          await this.reloadContextState();
          this.appendEntries({ role: "system", text: "Workspace context reloaded." });
          return;
        case "status":
          this.appendEntries(
            { role: "user", text: line },
            { role: "system", text: "Status shown. Live steps return on the next action." },
          );
          this.setState({ panel: this.buildStatusPanelFor(this.state.reasoning, this.state.authLabel) });
          return;
        case "trace-mode":
          this.appendEntries(
            { role: "user", text: line },
            { role: "system", text: builtinCommand.traceMode === "verbose" ? "Verbose trace mode enabled." : "Minimal trace mode enabled." },
          );
          this.setState(createWorkShellTraceModePatch({
            state: this.state,
            traceMode: builtinCommand.traceMode,
            contextSummaryLines: this.currentContextSummaryLines,
            buildContextPanel: this.buildContextPanel,
          }));
          await this.persistSessionSnapshot("idle", this.lastSessionSummary, builtinCommand.traceMode).catch(() => undefined);
          return;
        case "sessions":
          this.appendEntries({ role: "user", text: line });
          await this.openSessionsPanel();
          return;
        case "reasoning": {
          const modeDefault = this.modeDefaultReasoning();
          const result = this.resolveReasoningCommand(line, this.state.reasoning, modeDefault);
          this.agent.updateRuntimeSettings({ reasoning: result.nextReasoning });
          this.appendEntries(
            { role: "user", text: line },
            { role: "system", text: result.message },
          );
          this.setState({
            reasoning: result.nextReasoning,
            panel: this.buildStatusPanelFor(result.nextReasoning, this.state.authLabel),
          });
          return;
        }
        case "model": {
          const modeDefault = this.modeDefaultReasoning();
          const result = this.resolveModelCommand?.(line, this.state.model, this.state.reasoning, modeDefault);
          if (!result) {
            break;
          }
          if (result.nextModel !== this.state.model || result.nextReasoning !== this.state.reasoning) {
            this.agent.updateRuntimeSettings({ model: result.nextModel, reasoning: result.nextReasoning });
          }
          this.appendEntries(
            { role: "user", text: line },
            { role: "system", text: result.message },
          );
          this.setState({
            model: result.nextModel,
            reasoning: result.nextReasoning,
            panel: result.panel,
          });
          await this.persistSessionSnapshot("idle", this.lastSessionSummary).catch(() => undefined);
          return;
        }
        case "tools":
          this.appendEntries(
            { role: "user", text: line },
            { role: "system", text: this.toolLines.join("\n") },
          );
          return;
        case "auth-key":
          this.appendEntries({ role: "user", text: line });
          this.setState({
            composerMode: "api-key-entry",
            panel: createSecureApiKeyEntryPanel(),
          });
          return;
        case "skills": {
          const skills = await this.listAvailableSkills(this.options.cwd);
          this.appendEntries(
            { role: "user", text: line },
            { role: "system", text: skills.length > 0 ? `Loaded ${skills.length} skills.` : "No skills found." },
          );
          this.setState({ panel: createSkillsPanel(skills) });
          return;
        }
        case "skill": {
          if (!builtinCommand.skillName) {
            this.appendEntries(
              { role: "user", text: line },
              { role: "system", text: "Usage: /skill <name>" },
            );
            return;
          }

          try {
            const skill = await this.loadNamedSkill(builtinCommand.skillName, this.options.cwd);
            this.appendEntries(
              { role: "user", text: line },
              ...skill.attempts.flatMap((attempt) => [
                { role: "tool" as const, text: `read ${attempt.path}` },
                ...(attempt.ok ? [] : [{ role: "system" as const, text: attempt.error ?? "Failed to read skill." }]),
              ]),
              { role: "system", text: `Loaded skill ${skill.name}.` },
            );
            this.setState({ panel: createLoadedSkillPanel(skill) });
          } catch (error) {
            this.appendEntries(
              { role: "user", text: line },
              { role: "system", text: error instanceof Error ? error.message : String(error) },
            );
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
      const visibleLine = redactSensitiveInlineCommandLine(line);
      const visibleInlineCommand = redactSensitiveInlineCommandArgs(slashCommand);
      const isAuthLogin = slashCommand[0] === "auth" && slashCommand[1] === "login";
      this.appendEntries({ role: "user", text: visibleLine });
      this.setState({
        isBusy: true,
        ...(isAuthLogin ? { panel: createAuthLoginPendingPanel() } : {}),
      });

      try {
        const authProgressLines: string[] = [];
        const commandResult = await this.resolveWorkShellInlineCommand(
          slashCommand,
          this.runInlineCommand,
          isAuthLogin
            ? (line) => {
                authProgressLines.push(line);
                this.setState({
                  panel: {
                    title: "Auth",
                    lines: buildAuthProgressPanelLines(authProgressLines),
                  },
                });
              }
            : undefined,
        );
        const resultLines = this.refineInlineCommandResultLines
          ? this.refineInlineCommandResultLines({
              args: slashCommand,
              lines: commandResult.lines,
              failed: commandResult.failed,
              authLabel: this.state.authLabel,
            })
          : commandResult.lines;
        const completionLine = commandResult.failed ? `✖ ${visibleInlineCommand.join(" ")}` : `✓ ${visibleInlineCommand.join(" ")}`;
        let nextAuthLabel = this.extractAuthLabel?.(resultLines) ?? this.state.authLabel;
        if (slashCommand[0] === "auth" && this.refreshAuthState) {
          try {
            const refreshed = await this.refreshAuthState();
            nextAuthLabel = refreshed.authLabel;
            this.applyAuthIssueLines(refreshed.authIssueLines);
          } catch {
            nextAuthLabel = this.extractAuthLabel?.(resultLines) ?? this.state.authLabel;
          }
        }
        this.appendEntries(
          { role: "tool", text: completionLine },
          { role: "system", text: this.formatInlineCommandResultSummary(visibleInlineCommand, resultLines) },
        );
        this.setState({
          authLabel: nextAuthLabel,
          ...(slashCommand[0] === "auth" ? { authLauncherLines: resultLines } : {}),
          panel: this.buildInlineCommandPanel(visibleInlineCommand, resultLines),
        });
        this.pushTraceLine(`→ ${visibleInlineCommand.join(" ")}`, true);
        this.pushTraceLine(completionLine, true);
      } finally {
        this.setState({ isBusy: false });
      }
      return;
    }

    if (line === "/memories") {
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
        panel: {
          title: "Memories",
          lines: [
            "Session",
            ...(sessionMemory.length > 0 ? sessionMemory : ["No session memories yet."]),
            "",
            "Project",
            ...(projectMemory.length > 0 ? projectMemory : ["No project memories yet."]),
          ],
        },
      });
      return;
    }

    if (line.startsWith("/remember")) {
      const parts = line.split(/\s+/).filter(Boolean);
      const scope = parts[1] === "session" || parts[1] === "project" || parts[1] === "user" || parts[1] === "agent"
        ? parts[1]
        : "project";
      const summary = (scope === "project" ? parts.slice(1) : parts.slice(2)).join(" ").trim();
      if (!summary) {
        this.appendEntries(
          { role: "user", text: line },
          { role: "system", text: "Usage: /remember [session|project|user|agent] <text>" },
        );
        return;
      }

      const result = await this.writeScopedMemory({
        scope,
        cwd: this.options.cwd,
        summary,
        sessionId: this.sessionId,
        agentId: "work-shell",
      });
      const nextMemoryLines = await this.listScopedMemoryLines({
        scope: scope === "project" ? "project" : scope,
        cwd: this.options.cwd,
        sessionId: this.sessionId,
        agentId: "work-shell",
      });
      if (scope === "session") {
        this.setState({ memoryLines: nextMemoryLines });
      }
      const memoryTrace = this.formatAgentTraceLine({
        type: "memory.written",
        level: "high-signal",
        memoryId: result.memoryId,
        scope,
        summary,
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
    return this.buildStatusPanel(
      {
        ...this.options,
        model: this.state.model,
      },
      reasoning,
      authLabel,
    );
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
    await this.persistWorkShellSessionSnapshot({
      cwd: this.options.cwd,
      sessionId: this.sessionId,
      model: this.state.model,
      mode: this.options.mode,
      state,
      summary,
      traceMode,
    });
  }

  private async reloadContextState(): Promise<void> {
    const [contextSummaryLines, bridgeLines, memoryLines] = await Promise.all([
      this.reloadWorkspaceContext ? this.reloadWorkspaceContext(this.options.cwd) : Promise.resolve(this.currentContextSummaryLines),
      this.listProjectBridgeLines(this.options.cwd),
      this.listScopedMemoryLines({ scope: "session", cwd: this.options.cwd, sessionId: this.sessionId }),
    ]);
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

function redactSensitiveInlineCommandArgs(args: readonly string[]): readonly string[] {
  const redacted = [...args];
  const apiKeyIndex = redacted.findIndex((arg) => arg === "--api-key");
  if (apiKeyIndex >= 0 && apiKeyIndex + 1 < redacted.length) {
    redacted[apiKeyIndex + 1] = "[REDACTED]";
  }
  return redacted;
}

function redactSensitiveInlineCommandLine(line: string): string {
  return redactSensitiveInlineCommandArgs(line.trim().split(/\s+/).filter(Boolean)).join(" ");
}
