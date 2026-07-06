import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { executeWorkShellBuiltinSubmit } from "./work-shell-engine-builtin-runtime.js";
import {
  WORK_BOARD_PANEL_TITLE,
  buildWorkShellQueueBuiltinInput,
  createQueueBuiltinResult,
  resolveLastCompletedTurn,
} from "./work-shell-engine-builtins.js";
import { resolveWorkerBudget } from "./work-agent.js";
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
  createOpenSessionsFailurePanel,
  createOpenSessionsLoadingPanel,
  loadInitialWorkShellLifecycleState,
  loadOpenSessionsLoadedPanel,
  resolveCloseOverlayState,
  resolveSensitiveInputCancelState,
} from "./work-shell-engine-lifecycle.js";
import {
  resolveWorkShellSubmitRoute,
  type WorkShellSubmitRoute,
} from "./work-shell-engine-submit.js";
import { createWorkShellSessionSnapshotInput } from "./work-shell-engine-persistence.js";
import {
  composeWorkShellTurnPromptFromPacket,
  formatWorkShellContextPacketIndicator,
} from "./work-shell-context-packet.js";
import {
  appendWorkShellEntries,
  createInitialWorkShellEngineState,
  createWorkShellBusyStatePatch,
  createWorkShellTraceLinePatch,
  resolveModeDefaultReasoning,
} from "./work-shell-engine-state.js";
import { applyWorkShellTraceEvent } from "./work-shell-engine-trace.js";
import { runRustCommand, runRustCommandSync } from "./rust-command.js";
import type { ContextPacketView, ContextPacketViewItem } from "@unclecode/contracts";

/**
 * Render a one-liner for an attachment lifecycle trace event through the Rust
 * UX text contract. This wrapper stays narrowly typed so broadening the
 * generic agent-stream TraceEvent union does not cascade through every app
 * entry point.
 */
export function formatAttachmentTraceLine(event: {
  readonly type: "attachment.attached" | "attachment.dropped";
  readonly source: "clipboard";
  readonly mimeType?: string;
  readonly byteEstimate?: number;
  readonly reason?: "cap-exceeded" | "capture-too-large" | "user-cleared";
}): string {
  return runRustCommandSync(
    ["rust", "ux", "text", "trace-line"],
    process.cwd(),
    JSON.stringify(event),
  ).trimEnd();
}

function parseQueuedSubmit(stdout: string): { readonly id: number; readonly line: string } | undefined {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === "null") {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid Rust queue response: ${trimmed}`);
  }
  const candidate = parsed as { id?: unknown; line?: unknown };
  if (
    typeof candidate.id !== "number" ||
    !Number.isSafeInteger(candidate.id) ||
    candidate.id <= 0 ||
    typeof candidate.line !== "string"
  ) {
    throw new Error(`Invalid Rust queue response: ${trimmed}`);
  }
  return { id: candidate.id, line: candidate.line };
}

function parseQueueLength(stdout: string): number {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return 0;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid Rust queue length response.");
  }
  const length = (parsed as { length?: unknown }).length;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw new Error("Invalid Rust queue length response.");
  }
  return length;
}

function parseQueuedSubmitList(stdout: string): readonly { readonly id: number; readonly line: string }[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid Rust queue list response.");
  }
  return parsed.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("Invalid Rust queue list response.");
    }
    const candidate = item as { id?: unknown; line?: unknown };
    if (
      typeof candidate.id !== "number" ||
      !Number.isSafeInteger(candidate.id) ||
      candidate.id <= 0 ||
      typeof candidate.line !== "string"
    ) {
      throw new Error("Invalid Rust queue list response.");
    }
    return { id: candidate.id, line: candidate.line };
  });
}

type BusySubmitDecision =
  | { readonly action: "ignore" }
  | { readonly action: "show_queue"; readonly line: string }
  | { readonly action: "clear_queue"; readonly line: string; readonly message: string }
  | { readonly action: "cancel_turn"; readonly line: string; readonly message: string }
  | { readonly action: "reject_slash"; readonly line: string; readonly message: string }
  | { readonly action: "queue"; readonly line: string; readonly displayIndex: number; readonly message: string };

function parseBusySubmitDecision(stdout: string): BusySubmitDecision {
  const parsed = JSON.parse(stdout.trim()) as Partial<BusySubmitDecision>;
  if (parsed.action === "ignore") {
    return { action: "ignore" };
  }
  if (parsed.action === "show_queue" && typeof parsed.line === "string") {
    return { action: "show_queue", line: parsed.line };
  }
  if (parsed.action === "clear_queue" && typeof parsed.line === "string" && typeof parsed.message === "string") {
    return { action: "clear_queue", line: parsed.line, message: parsed.message };
  }
  if (parsed.action === "cancel_turn" && typeof parsed.line === "string" && typeof parsed.message === "string") {
    return { action: "cancel_turn", line: parsed.line, message: parsed.message };
  }
  if (parsed.action === "reject_slash" && typeof parsed.line === "string" && typeof parsed.message === "string") {
    return { action: "reject_slash", line: parsed.line, message: parsed.message };
  }
  if (
    parsed.action === "queue"
    && typeof parsed.line === "string"
    && typeof parsed.message === "string"
    && typeof parsed.displayIndex === "number"
    && Number.isSafeInteger(parsed.displayIndex)
    && parsed.displayIndex > 0
  ) {
    return {
      action: "queue",
      line: parsed.line,
      displayIndex: parsed.displayIndex,
      message: parsed.message,
    };
  }
  throw new Error("Invalid Rust busy submit response.");
}

type QueueDrainStartDecision = { readonly action: "skip" | "drain" };

function parseQueueDrainStartDecision(stdout: string): QueueDrainStartDecision {
  const parsed = JSON.parse(stdout.trim()) as Partial<QueueDrainStartDecision>;
  if (parsed.action === "skip" || parsed.action === "drain") {
    return { action: parsed.action };
  }
  throw new Error("Invalid Rust queue drain start response.");
}

type QueueDrainStepDecision =
  | { readonly action: "empty"; readonly queuedCount: number }
  | {
      readonly action: "run";
      readonly queuedCount: number;
      readonly message: string;
      readonly item: { readonly id: number; readonly line: string };
    };

function isQueueItem(value: unknown): value is { readonly id: number; readonly line: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { id?: unknown; line?: unknown };
  return typeof candidate.id === "number"
    && Number.isSafeInteger(candidate.id)
    && candidate.id > 0
    && typeof candidate.line === "string"
    && candidate.line.length > 0;
}

function parseQueueDrainStepDecision(stdout: string): QueueDrainStepDecision {
  const parsed = JSON.parse(stdout.trim()) as Partial<QueueDrainStepDecision>;
  if (
    parsed.action === "empty"
    && typeof parsed.queuedCount === "number"
    && Number.isSafeInteger(parsed.queuedCount)
    && parsed.queuedCount === 0
  ) {
    return { action: "empty", queuedCount: 0 };
  }
  if (
    parsed.action === "run"
    && typeof parsed.queuedCount === "number"
    && Number.isSafeInteger(parsed.queuedCount)
    && parsed.queuedCount >= 0
    && typeof parsed.message === "string"
    && isQueueItem(parsed.item)
  ) {
    return {
      action: "run",
      queuedCount: parsed.queuedCount,
      message: parsed.message,
      item: parsed.item,
    };
  }
  throw new Error("Invalid Rust queue drain step response.");
}
import type { WorkShellReasoningConfig } from "./reasoning.js";

export type WorkShellChatEntry = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly text: string;
};

export type WorkShellPanel = {
  readonly title: string;
  readonly lines: readonly string[];
};

export type WorkShellStatusContext = {
  readonly contextSummaryLines: readonly string[];
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
  readonly traceLines: readonly string[];
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
  readonly initialEntries?: readonly WorkShellChatEntry[] | undefined;
  readonly initialSessionSummary?: string | undefined;
  readonly autoContinueOnPermissionStall?: boolean | undefined;
};

export type WorkShellTraceMode = "minimal" | "verbose";

export type WorkShellComposerMode = "default" | "api-key-entry";

export type WorkShellEngineState<Reasoning extends WorkShellReasoningConfig> = {
  readonly entries: readonly WorkShellChatEntry[];
  readonly streamingAssistantText?: string | undefined;
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
  readonly contextPacket?: ContextPacketView | undefined;
  readonly contextIndicator?: string | undefined;
  readonly queuedCount: number;
  readonly queuePaused: boolean;
  readonly terminalColumns: number;
  // Context Inspector (Sprint 2): cursor highlight index into the navigable
  // source list (-1 = none) and the source id whose full content is expanded
  // (null = none). Owned by the engine so every mutation re-renders via the
  // existing subscriber fan-out.
  readonly contextInspectorCursor: number;
  readonly contextInspectorExpanded: string | null;
};

export interface WorkShellAgent<Attachment, TraceEvent, Reasoning extends WorkShellReasoningConfig> {
  clear(): void;
  runTurn(prompt: string, attachments?: readonly Attachment[], options?: { readonly signal?: AbortSignal | undefined }): Promise<{ text: string }>;
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
    statusContext?: WorkShellStatusContext,
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
  resolveContextPacket?: ((input: {
    readonly cwd: string;
    readonly sessionId: string;
    readonly contextSummaryLines: readonly string[];
    readonly bridgeLines: readonly string[];
    readonly memoryLines: readonly string[];
    readonly traceLines: readonly string[];
  }) => Promise<ContextPacketView>) | undefined;
  toolLines?: readonly string[];
  extractAuthLabel?: (lines: readonly string[]) => string | undefined;
  onExit: () => void;
  sessionId?: string;
  /** Optional agentops recorder callback. Non-blocking. Fired after every prompt turn. */
  recordTurn?: ((turn: { prompt: string; status: string; summary?: string }) => void) | undefined;
  /**
   * Context Inspector (Sprint 2): SQL mutation callback for the /context
   * overlay. Maps a pin/unpin/forget/include action to the AgentOpsStore
   * write. Optional — when absent, overlay actions are no-ops (the legacy
   * non-CRP path has no store).
   */
  mutateContextSource?: ((
    action: { readonly kind: "pin" | "unpin" | "forget" | "include"; readonly id: string },
  ) => void) | undefined;
};

export class WorkShellEngine<
  Attachment,
  Reasoning extends WorkShellReasoningConfig,
  TraceEvent extends { readonly type: string },
> {
  private readonly agent: WorkShellAgent<Attachment, TraceEvent, Reasoning>;
  private options: WorkShellEngineOptions<Reasoning>;
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
    statusContext?: WorkShellStatusContext,
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
  private readonly resolveContextPacket?: ((input: {
    readonly cwd: string;
    readonly sessionId: string;
    readonly contextSummaryLines: readonly string[];
    readonly bridgeLines: readonly string[];
    readonly memoryLines: readonly string[];
    readonly traceLines: readonly string[];
  }) => Promise<ContextPacketView>) | undefined;
  private readonly toolLines: readonly string[];
  private readonly extractAuthLabel?: ((lines: readonly string[]) => string | undefined) | undefined;
  private readonly onExit: () => void;
  private readonly sessionId: string;
  private readonly recordTurn?: ((turn: { prompt: string; status: string; summary?: string }) => void) | undefined;
  private readonly mutateContextSource?: ((
    action: { readonly kind: "pin" | "unpin" | "forget" | "include"; readonly id: string },
  ) => void) | undefined;
  private readonly subscribers = new Set<(state: WorkShellEngineState<Reasoning>) => void>();
  private readonly queuedAttachments = new Map<number, readonly Attachment[]>();
  private readonly queueDrainSkipTurnEpochs = new Set<number>();
  private queuedCountCache = 0;
  private currentContextSummaryLines: readonly string[];
  private lastSessionSummary: string;
  private drainingQueue = false;
  private activeTurnEpoch = 0;
  private activeTurnAbortController: AbortController | undefined;
  private queueAutoDrainPaused = false;
  private workBoardRebuildGeneration = 0;
  private lastCompletedTurnSnapshot:
    | { readonly user: string; readonly assistant: string }
    | undefined;
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
    this.resolveContextPacket = input.resolveContextPacket;
    this.toolLines = input.toolLines ?? [];
    this.extractAuthLabel = input.extractAuthLabel;
    this.onExit = input.onExit;
    this.recordTurn = input.recordTurn;
    this.mutateContextSource = input.mutateContextSource;
    this.sessionId = input.sessionId ?? `work-${randomUUID()}`;
    this.currentContextSummaryLines = input.options.contextSummaryLines;
    this.lastSessionSummary = input.options.initialSessionSummary ?? "Work shell ready.";
    this.state = createInitialWorkShellEngineState({
      options: input.options,
      contextSummaryLines: this.currentContextSummaryLines,
      buildContextPanel: input.buildContextPanel,
    });
    this.lastCompletedTurnSnapshot = resolveLastCompletedTurn(
      input.options.initialEntries ?? this.state.entries,
    );
  }

  getState(): WorkShellEngineState<Reasoning> {
    return this.state;
  }

  updateTerminalColumns(columns: number): void {
    const terminalColumns = Math.max(20, Math.floor(columns));
    if (this.state.terminalColumns === terminalColumns) {
      return;
    }
    this.setState({ terminalColumns });
    if (this.state.panel.title === WORK_BOARD_PANEL_TITLE) {
      void this.rebuildWorkBoardPanel();
    }
  }

  private async rebuildWorkBoardPanel(): Promise<void> {
    const generation = ++this.workBoardRebuildGeneration;
    let queuedItems: readonly { readonly id: number; readonly line: string }[] = [];
    try {
      queuedItems = await this.listQueuedSubmits();
    } catch {
      queuedItems = [];
    }
    if (generation !== this.workBoardRebuildGeneration) {
      return;
    }
    if (this.state.panel.title !== WORK_BOARD_PANEL_TITLE) {
      return;
    }
    const panel = createQueueBuiltinResult(buildWorkShellQueueBuiltinInput({
      line: "/queue",
      state: this.state,
      workerBudget: resolveWorkerBudget(this.state.mode),
      queuedCount: this.queuedCountCache,
      queuedItems,
      contextSummaryLines: this.currentContextSummaryLines,
      ...(this.lastCompletedTurnSnapshot ? { lastCompletedTurn: this.lastCompletedTurnSnapshot } : {}),
    })).panel;
    this.setState({ panel });
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

    try {
      this.setQueuedCount(await this.loadQueuedSubmitCount());
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
    } catch (error: unknown) {
      this.appendEntries({
        role: "system",
        text: `Initialization warning: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  dispose(): void {
    this.agent.setTraceListener(undefined);
  }

  async openSessionsPanel(): Promise<void> {
    this.setState({ panel: createOpenSessionsLoadingPanel() });
    try {
      const loadedPanel = await loadOpenSessionsLoadedPanel({
        cwd: this.options.cwd,
        listSessionLines: this.listSessionLines,
      });
      this.setState({ panel: loadedPanel });
    } catch (error: unknown) {
      this.setState({ panel: createOpenSessionsFailurePanel(error) });
    }
  }

  cancelSensitiveInput(): void {
    const result = resolveSensitiveInputCancelState({
      composerMode: this.state.composerMode,
      options: this.options,
      stateModel: this.state.model,
      reasoning: this.state.reasoning,
      authLabel: this.state.authLabel,
      statusContext: {
        contextSummaryLines: this.currentContextSummaryLines,
        bridgeLines: this.state.bridgeLines,
        memoryLines: this.state.memoryLines,
        traceLines: this.state.traceLines,
      },
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

    // Closing the overlay also resets the inspector cursor/expanded state so
    // the next open starts fresh.
    this.setState({
      panel,
      contextInspectorCursor: -1,
      contextInspectorExpanded: null,
    });
  }

  /**
   * Context Inspector (Sprint 2) — move the cursor within the navigable
   * source list. `direction` is -1 (up) or +1 (down). Wraps around the list
   * bounds. Clamped to -1 when the overlay is not open or the packet has no
   * sources.
   */
  moveContextInspectorCursor(direction: number): void {
    if (this.state.panel.title !== "Context expanded") {
      return;
    }
    const sources = this.resolveInspectorSourceList();
    if (sources.length === 0) {
      if (this.state.contextInspectorCursor !== -1) {
        this.setState({ contextInspectorCursor: -1 });
      }
      return;
    }
    const current = this.state.contextInspectorCursor;
    const base = current < 0 || current >= sources.length ? 0 : current;
    const next = (base + (direction >= 0 ? 1 : -1) + sources.length) % sources.length;
    if (next !== current) {
      this.setState({ contextInspectorCursor: next });
    }
  }

  /**
   * Context Inspector (Sprint 2) — toggle pin/unpin on the source under the
   * cursor. Pin sets salience to 1.0 (always include); unpin restores 0.5.
   * After the SQL write we re-select from the store and re-render so the
   * overlay reflects the new ranking immediately.
   */
  async toggleContextInspectorPin(): Promise<void> {
    const source = this.resolveInspectorSourceAtCursor();
    if (!source || !this.mutateContextSource) {
      return;
    }
    this.mutateContextSource({
      kind: source.pinned ? "unpin" : "pin",
      id: source.id,
    });
    await this.refreshContextPacket();
  }

  /**
   * Context Inspector (Sprint 2) — forget the source under the cursor
   * (included_in_model = 0). The source moves to the "Held back" section.
   */
  async forgetContextSourceAtCursor(): Promise<void> {
    const source = this.resolveInspectorSourceAtCursor();
    if (!source || !this.mutateContextSource) {
      return;
    }
    this.mutateContextSource({ kind: "forget", id: source.id });
    await this.refreshContextPacket();
  }

  /**
   * Context Inspector (Sprint 2) — re-include a held-back source
   * (included_in_model = 1). The source moves back into "Included".
   */
  async includeContextSourceAtCursor(): Promise<void> {
    const source = this.resolveInspectorSourceAtCursor();
    if (!source || !this.mutateContextSource) {
      return;
    }
    this.mutateContextSource({ kind: "include", id: source.id });
    await this.refreshContextPacket();
  }

  /**
   * Context Inspector (Sprint 2) — toggle expanded view for the source
   * under the cursor. Only one source expands at a time.
   */
  toggleContextInspectorExpanded(): void {
    const source = this.resolveInspectorSourceAtCursor();
    if (!source) {
      return;
    }
    const current = this.state.contextInspectorExpanded;
    const next = current === source.id ? null : source.id;
    if (next !== current) {
      this.setState({ contextInspectorExpanded: next });
    }
  }

  /**
   * Build the navigable source list for the inspector from the current
   * context packet: included sources first (sorted by salience desc), then
   * held-back sources. Each entry carries a `pinned` flag (salience === 1.0)
   * so the pin toggle and cursor glyph render correctly.
   */
  private resolveInspectorSourceList(): readonly {
    readonly id: string;
    readonly label: string;
    readonly category: string;
    readonly detail: string;
    readonly pinned: boolean;
    readonly heldBack: boolean;
  }[] {
    const packet = this.state.contextPacket;
    if (!packet) {
      return [];
    }
    const toEntry = (item: ContextPacketViewItem, heldBack: boolean) => {
      const content = item.preview ?? item.label;
      return {
        id: item.id,
        label: item.label,
        category: item.category,
        detail: content,
        pinned: false,
        heldBack,
      };
    };
    // NOTE: ContextPacketViewItem does not carry salience/included flags
    // (it's the projection sent to the model). Pin state is therefore
    // approximated as "included and previously pinned" — the authoritative
    // salience lives in the SQL store and is re-read on each packet
    // refresh. The pinned glyph here is a best-effort affordance; the store
    // mutation is the source of truth.
    return [
      ...packet.included.map((item) => toEntry(item, false)),
      ...packet.excluded.map((item) => toEntry(item, true)),
    ];
  }

  private resolveInspectorSourceAtCursor():
    | {
      readonly id: string;
      readonly label: string;
      readonly category: string;
      readonly detail: string;
      readonly pinned: boolean;
      readonly heldBack: boolean;
    }
    | undefined {
    const sources = this.resolveInspectorSourceList();
    const cursor = this.state.contextInspectorCursor;
    if (cursor < 0 || cursor >= sources.length) {
      return undefined;
    }
    return sources[cursor];
  }

  interruptTurn(): void {
    if (!this.state.isBusy) {
      this.appendEntries({ role: "system", text: "No active turn to interrupt." });
      return;
    }
    const interruptedTurnEpoch = this.activeTurnEpoch;
    const interruptedIdleEpoch = interruptedTurnEpoch + 1;
    this.queueDrainSkipTurnEpochs.add(interruptedTurnEpoch);
    this.queueAutoDrainPaused = this.queuedCountCache > 0;
    this.activeTurnEpoch = interruptedIdleEpoch;
    this.activeTurnAbortController?.abort();
    const lastTurnDurationMs = this.state.currentTurnStartedAt === undefined
      ? undefined
      : Math.max(0, Date.now() - this.state.currentTurnStartedAt);
    this.appendEntries({
      role: "system",
      text: "Turn interrupted. Queued follow-ups are paused; send a new message to resume or use /queue clear to drop them.",
    });
    this.setState({
      isBusy: false,
      busyStatus: undefined,
      currentTurnStartedAt: undefined,
      streamingAssistantText: undefined,
      queuePaused: this.queueAutoDrainPaused,
      ...(lastTurnDurationMs !== undefined ? { lastTurnDurationMs } : {}),
    });
    void this.persistSessionSnapshotForEpoch(interruptedIdleEpoch, "idle", "Turn interrupted.").catch(() => undefined);
  }

  private startActiveTurnAbortController(): AbortController {
    const abortController = new AbortController();
    this.activeTurnAbortController = abortController;
    return abortController;
  }

  private beginSubmitPreparation(): void {
    this.setState(createWorkShellBusyStatePatch({
      state: this.state,
      isBusy: true,
      busyStatus: "preparing context",
      currentTurnStartedAt: Date.now(),
    }));
  }

  private clearSubmitPreparationIfStillPending(isCurrentTurn: () => boolean): void {
    if (isCurrentTurn() && this.state.isBusy && this.state.busyStatus === "preparing context") {
      this.setState({
        isBusy: false,
        busyStatus: undefined,
        currentTurnStartedAt: undefined,
      });
    }
  }

  private clearActiveTurnAbortController(abortController: AbortController): void {
    if (this.activeTurnAbortController === abortController) {
      this.activeTurnAbortController = undefined;
    }
  }

  /**
   * Record an attachment lifecycle trace event from the TUI side. The
   * pane fires this when a clipboard image is accepted, rejected by the
   * pre-flight cap, or explicitly cleared. Non-attachment trace events
   * still flow through the agent listener installed in initialize() —
   * this method is the only seam for events the agent never sees.
   *
   * Routed through `applyWorkShellTraceEvent` so the same formatter,
   * trace-line buffer, and panel state machine handle it as the agent
   * stream. Unknown event types fall through harmlessly (formatter
   * returns empty string for anything it does not recognise).
   */
  recordTraceEvent(event: {
    readonly type: "attachment.attached" | "attachment.dropped";
    readonly source: "clipboard";
    readonly mimeType?: string;
    readonly byteEstimate?: number;
    readonly reason?: "cap-exceeded" | "capture-too-large" | "user-cleared";
    readonly startedAt: number;
  }): void {
    // Attachment lifecycle events are emitted from the TUI hook side.
    // Render inline here rather than routing through the agent stream
    // formatter (formatAgentTraceLine generic does not include these
    // types, and broadening it cascades into every app entry point).
    // Trace lines are diagnostic only — not appended to the conversation
    // transcript.
    const line = formatAttachmentTraceLine(event);
    if (line) {
      this.pushTraceLine(line);
    }
  }

  async setMode(mode: string): Promise<void> {
    this.applyMode(mode);
    await this.persistSessionSnapshot("idle", this.lastSessionSummary).catch(() => undefined);
  }

  private applyMode(mode: string): void {
    this.options = { ...this.options, mode };
    this.agent.updateMode?.(mode);
    this.setState({ mode });
  }

  /**
   * Submit the composer value plus any attachments produced outside the
   * text-resolution path (e.g. clipboard paste). The optional
   * `pendingAttachments` argument is the seam Hermes review of commit
   * 40ab895 caught — without it, paste-derived images stayed in TUI hook
   * state and never reached the provider.
   */
  async handleSubmit(
    value: string,
    pendingAttachments?: readonly Attachment[],
  ): Promise<void> {
    const line = value.trim();
    if (!line) {
      return;
    }
    if (this.state.isBusy) {
      await this.handleBusySubmit(line, pendingAttachments);
      return;
    }

    const route = resolveWorkShellSubmitRoute({
      value: line,
      isBusy: this.state.isBusy,
      composerMode: this.state.composerMode,
      resolveWorkShellSlashCommand: this.resolveWorkShellSlashCommand,
      hasInlineCommandRunner: Boolean(this.runInlineCommand),
    });
    if (!route) {
      return;
    }

    const turnEpoch = route.kind === "chat" || route.kind === "prompt-command"
      ? this.activeTurnEpoch + 1
      : this.activeTurnEpoch;
    this.activeTurnEpoch = turnEpoch;

    await this.executeSubmitRoute(route, pendingAttachments, turnEpoch);
    if (this.shouldSkipQueueDrainAfterTurn(turnEpoch, route.kind)) {
      return;
    }
    await this.drainQueuedSubmits();
  }

  private async executeSubmitRoute(
    route: WorkShellSubmitRoute,
    pendingAttachments?: readonly Attachment[],
    turnEpoch = this.activeTurnEpoch,
  ): Promise<void> {
    const isCurrentTurn = () => turnEpoch === this.activeTurnEpoch;
    switch (route.kind) {
      case "secure-api-key-entry":
        await this.handleSecureApiKeyEntrySubmit(route.line);
        break;
      case "builtin":
        await this.handleBuiltinSubmit(route.line, route.command);
        break;
      case "prompt-command": {
        const abortController = this.startActiveTurnAbortController();
        this.beginSubmitPreparation();
        try {
          const contextPacket = await this.refreshContextPacket();
          if (!isCurrentTurn()) {
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
          await executeWorkShellPromptCommandSubmit({
            transcriptText: route.line,
            promptCommand: route.promptCommand,
            state: this.state,
            options: this.options,
            sessionId: this.sessionId,
            buildStatusPanel: this.buildStatusPanel,
            autoContinueOnPermissionStall: this.options.autoContinueOnPermissionStall,
            runAgentTurn: (prompt: string, attachments?: readonly Attachment[]) => this.agent.runTurn(
              contextPacket ? composeWorkShellTurnPromptFromPacket({ packet: contextPacket, userPrompt: prompt }) : prompt,
              attachments,
              { signal: abortController.signal },
            ),
            publishContextBridge: this.publishContextBridge,
            writeScopedMemory: this.writeScopedMemory,
            listScopedMemoryLines: this.listScopedMemoryLines,
            refreshAuthState: this.refreshAuthState,
            applyAuthIssueLines: (authIssueLines) => this.applyAuthIssueLines(authIssueLines),
            formatWorkShellError: this.formatWorkShellError,
            formatAgentTraceLine: this.formatAgentTraceLine,
            appendEntries: (...entries) => {
              if (isCurrentTurn()) this.appendEntries(...entries);
            },
            setState: (patch) => {
              if (isCurrentTurn()) this.setState(patch);
            },
            pushTraceLine: (traceLine) => {
              if (isCurrentTurn()) this.pushTraceLine(traceLine);
            },
            persistSessionSnapshot: (sessionState, summary) => this.persistSessionSnapshotForEpoch(turnEpoch, sessionState, summary),
            ...(this.recordTurn !== undefined
              ? { recordTurn: (turn) => {
                if (isCurrentTurn()) this.recordTurn?.(turn);
              } }
              : {}),
          });
        } finally {
          this.clearActiveTurnAbortController(abortController);
          this.clearSubmitPreparationIfStillPending(isCurrentTurn);
        }
        break;
      }
      case "inline-command":
        await this.handleInlineCommandSubmit(route.line, route.slashCommand);
        break;
      case "local-command":
        await this.handleLocalCommandSubmit(route.line, route.localCommand);
        break;
      case "chat": {
        const abortController = this.startActiveTurnAbortController();
        this.beginSubmitPreparation();
        try {
          const contextPacket = await this.refreshContextPacket();
          if (!isCurrentTurn()) {
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
          await executeWorkShellChatSubmit({
            line: route.line,
            resolveComposerInput: this.resolveComposerInput,
            ...(pendingAttachments && pendingAttachments.length > 0
              ? { pendingAttachments }
              : {}),
            state: this.state,
            options: this.options,
            sessionId: this.sessionId,
            buildStatusPanel: this.buildStatusPanel,
            autoContinueOnPermissionStall: this.options.autoContinueOnPermissionStall,
            runAgentTurn: (prompt: string, attachments?: readonly Attachment[]) => this.agent.runTurn(
              contextPacket ? composeWorkShellTurnPromptFromPacket({ packet: contextPacket, userPrompt: prompt }) : prompt,
              attachments,
              { signal: abortController.signal },
            ),
            publishContextBridge: this.publishContextBridge,
            writeScopedMemory: this.writeScopedMemory,
            listScopedMemoryLines: this.listScopedMemoryLines,
            refreshAuthState: this.refreshAuthState,
            applyAuthIssueLines: (authIssueLines) => this.applyAuthIssueLines(authIssueLines),
            formatWorkShellError: this.formatWorkShellError,
            formatAgentTraceLine: this.formatAgentTraceLine,
            appendEntries: (...entries) => {
              if (isCurrentTurn()) this.appendEntries(...entries);
            },
            setState: (patch) => {
              if (isCurrentTurn()) this.setState(patch);
            },
            pushTraceLine: (traceLine) => {
              if (isCurrentTurn()) this.pushTraceLine(traceLine);
            },
            persistSessionSnapshot: (sessionState, summary) => this.persistSessionSnapshotForEpoch(turnEpoch, sessionState, summary),
            ...(this.recordTurn !== undefined
              ? { recordTurn: (turn) => {
                if (isCurrentTurn()) this.recordTurn?.(turn);
              } }
              : {}),
          });
        } finally {
          this.clearActiveTurnAbortController(abortController);
          this.clearSubmitPreparationIfStillPending(isCurrentTurn);
        }
        break;
      }
    }
  }

  private async handleBusySubmit(line: string, pendingAttachments?: readonly Attachment[]): Promise<void> {
    const decision = await this.resolveBusySubmitDecision(line);
    switch (decision.action) {
      case "ignore":
        return;
      case "show_queue":
        await this.handleBuiltinSubmit(decision.line, { kind: "queue" });
        return;
      case "clear_queue":
        await this.handleBuiltinSubmit(decision.line, { kind: "queue-clear" });
        return;
      case "cancel_turn":
        this.interruptTurn();
        return;
      case "reject_slash":
        this.appendEntries({ role: "system", text: decision.message });
        return;
      case "queue": {
        const item = await this.pushQueuedSubmit(decision.line);
        this.setQueuedCount(decision.displayIndex);
        if (pendingAttachments && pendingAttachments.length > 0) {
          this.queuedAttachments.set(item.id, pendingAttachments);
        }
        this.appendEntries({ role: "system", text: decision.message });
        return;
      }
    }
  }

  private async drainQueuedSubmits(): Promise<void> {
    const start = await this.resolveQueueDrainStartDecision();
    if (start.action === "skip") {
      return;
    }
    this.drainingQueue = true;
    try {
      while ((await this.resolveQueueDrainContinueDecision()).action === "drain") {
        const next = await this.popQueuedSubmit();
        const step = await this.resolveQueueDrainStepDecision(next);
        if (step.action === "empty") {
          this.setQueuedCount(step.queuedCount);
          break;
        }
        this.setQueuedCount(step.queuedCount);
        const pendingAttachments = this.queuedAttachments.get(step.item.id);
        this.queuedAttachments.delete(step.item.id);
        this.appendEntries({ role: "system", text: step.message });
        await this.handleSubmit(step.item.line, pendingAttachments);
      }
    } finally {
      this.drainingQueue = false;
    }
  }

  private shouldSkipQueueDrainAfterTurn(
    turnEpoch: number,
    routeKind: WorkShellSubmitRoute["kind"],
  ): boolean {
    const wasInterruptedTurn = this.queueDrainSkipTurnEpochs.delete(turnEpoch);
    if (wasInterruptedTurn) {
      return true;
    }
    if (
      this.queueAutoDrainPaused
      && (routeKind === "chat" || routeKind === "prompt-command")
    ) {
      this.queueAutoDrainPaused = false;
      this.setState({ queuePaused: false });
      return false;
    }
    return this.queueAutoDrainPaused;
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
      interruptTurn: () => this.interruptTurn(),
      updateRuntimeSettings: (settings) => this.agent.updateRuntimeSettings(settings),
      onExit: this.onExit,
      openSessionsPanel: () => this.openSessionsPanel(),
      reloadContextState: () => this.reloadContextState(),
      refreshContextPacket: () => this.refreshContextPacket(),
      queuedCount: () => this.queuedCountCache,
      queuedItems: () => this.listQueuedSubmits(),
      clearQueuedItems: () => this.clearQueuedSubmits(),
      appendEntries: (...entries) => this.appendEntries(...entries),
      setState: (patch) => this.setState(patch),
      persistSessionSnapshot: (state, summary, traceMode) => this.persistSessionSnapshot(state, summary, traceMode),
      lastSessionSummary: this.lastSessionSummary,
      lastCompletedTurn: () => this.lastCompletedTurnSnapshot,
      clearLastCompletedTurn: () => {
        this.lastCompletedTurnSnapshot = undefined;
      },
    });
  }

  private async handleInlineCommandSubmit(line: string, slashCommand: readonly string[]): Promise<void> {
    await executeInlineCommandSubmit<Reasoning>({
      line,
      slashCommand,
      state: this.state,
      onModeChanged: (mode) => this.setMode(mode),
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
    const overrideReasoningEffort =
      this.state.reasoning.support.status === "supported" &&
      this.state.reasoning.source === "override" &&
      (this.state.reasoning.effort === "low" ||
        this.state.reasoning.effort === "medium" ||
        this.state.reasoning.effort === "high")
        ? this.state.reasoning.effort
        : undefined;
    this.lastSessionSummary = summary;
    if (state === "idle") {
      this.lastCompletedTurnSnapshot = resolveLastCompletedTurn(this.state.entries);
    }
    await this.persistWorkShellSessionSnapshot(createWorkShellSessionSnapshotInput({
      cwd: this.options.cwd,
      sessionId: this.sessionId,
      model: this.state.model,
      mode: this.state.mode,
      state,
      summary,
      traceMode,
      reasoningEffort: overrideReasoningEffort,
      entries: this.state.entries,
    }));
  }

  private async persistSessionSnapshotForEpoch(
    turnEpoch: number,
    state: "running" | "idle" | "requires_action",
    summary: string,
    traceMode = this.state.traceMode,
  ): Promise<void> {
    if (turnEpoch !== this.activeTurnEpoch) {
      return;
    }
    await this.persistSessionSnapshot(state, summary, traceMode);
  }

  private async pushQueuedSubmit(line: string): Promise<{ readonly id: number; readonly line: string }> {
    const stdout = await runRustCommand(["rust", "queue", "push-json", this.sessionId, line], this.queueCommandCwd());
    const item = parseQueuedSubmit(stdout);
    if (!item) {
      throw new Error("Rust queue push did not return an item.");
    }
    return item;
  }

  private async resolveBusySubmitDecision(line: string): Promise<BusySubmitDecision> {
    const stdout = await runRustCommand(
      ["rust", "steer", "busy-submit", String(this.queuedCountCache)],
      this.queueCommandCwd(),
      line,
    );
    return parseBusySubmitDecision(stdout);
  }

  private async resolveQueueDrainStartDecision(): Promise<QueueDrainStartDecision> {
    const stdout = await runRustCommand(
      [
        "rust",
        "steer",
        "drain-start",
        String(this.drainingQueue),
        String(this.state.isBusy),
        String(this.queuedCountCache),
      ],
      this.queueCommandCwd(),
    );
    return parseQueueDrainStartDecision(stdout);
  }

  private async resolveQueueDrainContinueDecision(): Promise<QueueDrainStartDecision> {
    const stdout = await runRustCommand(
      [
        "rust",
        "steer",
        "drain-start",
        "false",
        String(this.state.isBusy),
        String(this.queuedCountCache),
      ],
      this.queueCommandCwd(),
    );
    return parseQueueDrainStartDecision(stdout);
  }

  private async resolveQueueDrainStepDecision(
    item: { readonly id: number; readonly line: string } | undefined,
  ): Promise<QueueDrainStepDecision> {
    const stdout = await runRustCommand(
      ["rust", "steer", "drain-step", String(this.queuedCountCache)],
      this.queueCommandCwd(),
      JSON.stringify(item ?? null),
    );
    return parseQueueDrainStepDecision(stdout);
  }

  private async popQueuedSubmit(): Promise<{ readonly id: number; readonly line: string } | undefined> {
    const stdout = await runRustCommand(["rust", "queue", "pop-json", this.sessionId], this.queueCommandCwd());
    return parseQueuedSubmit(stdout);
  }

  private async clearQueuedSubmits(): Promise<void> {
    await runRustCommand(["rust", "queue", "clear", this.sessionId], this.queueCommandCwd());
    this.setQueuedCount(0);
    this.queuedAttachments.clear();
    this.queueAutoDrainPaused = false;
    this.queueDrainSkipTurnEpochs.clear();
    this.setState({ queuePaused: false });
  }

  private async loadQueuedSubmitCount(): Promise<number> {
    return parseQueueLength(await runRustCommand(["rust", "queue", "len-json", this.sessionId], this.queueCommandCwd()));
  }

  private async listQueuedSubmits(): Promise<readonly { readonly id: number; readonly line: string }[]> {
    return parseQueuedSubmitList(await runRustCommand(["rust", "queue", "list", this.sessionId], this.queueCommandCwd()));
  }

  private queueCommandCwd(): string {
    return existsSync(this.options.cwd) ? this.options.cwd : process.cwd();
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
      expanded: this.state.panel.title === "Context expanded",
    });
    this.currentContextSummaryLines = contextState.contextSummaryLines;
    this.setState({
      bridgeLines: contextState.bridgeLines,
      memoryLines: contextState.memoryLines,
      panel: contextState.panel,
    });
    await this.refreshContextPacket();
  }

  private async refreshContextPacket(): Promise<ContextPacketView | undefined> {
    if (!this.resolveContextPacket) {
      return this.state.contextPacket;
    }
    const packet = await this.resolveContextPacket({
      cwd: this.options.cwd,
      sessionId: this.sessionId,
      contextSummaryLines: this.currentContextSummaryLines,
      bridgeLines: this.state.bridgeLines,
      memoryLines: this.state.memoryLines,
      traceLines: this.state.traceLines,
    });
    this.setState({
      contextPacket: packet,
      contextIndicator: formatWorkShellContextPacketIndicator(packet),
    });
    return packet;
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

  private setQueuedCount(count: number): void {
    this.queuedCountCache = count;
    this.setState({ queuedCount: count });
  }

  private setState(patch: Partial<WorkShellEngineState<Reasoning>>): void {
    this.state = { ...this.state, ...patch };
    for (const subscriber of this.subscribers) {
      subscriber(this.state);
    }
  }
}
