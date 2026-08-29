import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { executeWorkShellBuiltinSubmit } from "./work-shell-engine-builtin-runtime.js";
import {
  WORK_BOARD_PANEL_TITLE,
  buildWorkShellQueueBuiltinInput,
  createQueueBuiltinResult,
  resolveLastCompletedTurn,
} from "./work-shell-engine-builtins.js";
import { isAgentConsoleTab } from "./work-shell-engine-commands.js";
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
  resolveWorkShellChatPreflight,
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
import {
  createWorkShellSessionSnapshotInput,
  type WorkShellSessionState,
} from "./work-shell-engine-persistence.js";
import {
  CooperativePauseController,
  type WorkShellPauseBoundary,
  type WorkShellPauseReceipt,
  type WorkShellPauseSnapshot,
} from "./work-shell-pause-controller.js";
import type { ExecutionPausePort } from "./execution-pause.js";
import {
  buildWorkShellContextPacketPreviewLines,
  composeWorkShellTurnPromptFromPacket,
  computeContextOverlayViewportMaxRows,
  formatWorkShellContextPacketIndicator,
  resolveWorkShellContextDetailLayout,
} from "./work-shell-context-packet.js";
import {
  appendWorkShellEntries,
  createInitialWorkShellEngineState,
  createWorkShellBusyStatePatch,
  createWorkShellTraceLinePatch,
  createWorkShellTraceModePatch,
  resolveModeDefaultReasoning,
} from "./work-shell-engine-state.js";
import { runWorkShellContextAdviceEffects } from "./work-shell-engine-post-turns.js";
import {
  detectWorkShellUserLocale,
  workShellLanguageInstruction,
  type WorkShellUiLocale,
} from "./work-shell-locale.js";
import { applyWorkShellTraceEvent } from "./work-shell-engine-trace.js";
import {
  applyTraceEventToAgentConsole,
  type AgentConsoleUsageRecorder,
} from "./work-shell-agent-console.js";
import { isExecutorScopedTraceEvent } from "./work-agent-lifecycle.js";
import {
  clampAgentConsoleView,
  closeAgentConsoleView,
  createAgentConsoleViewState,
  isSettledAgentRun,
  isSettledAsyncJob,
  mergeAgentConsoleLifecycle,
  moveAgentConsoleCursor,
  openAgentConsoleView,
  requestAgentConsoleCancel,
  resolveAgentConsoleSelection,
  selectAgentConsoleTab,
  settleAgentConsoleControl,
  toggleAgentConsoleInspector,
  type AgentConsoleViewState,
} from "./work-shell-agent-console-state.js";
import { runRustCommand, runRustCommandSync } from "./rust-command.js";
import {
  CONTEXT_DESK_COLLECTIONS,
  CONTEXT_DESK_GROUPS,
  CONTEXT_DESK_PANES,
  createAgentConsoleSnapshot,
  resolveContextDeskGroup,
  type AskUserQuestionRequest,
  type AskUserQuestionAnswer,
  type AskUserQuestionResult,
} from "@unclecode/contracts";
import {
  formatWorkShellDecisionLines,
  resolveWorkShellDecisionAnswers,
  resolveWorkShellDecisionReply,
} from "./work-shell-decision.js";
import type { WorkShellInteractionBridge } from "./work-shell-interaction-bridge.js";
import type {
  AgentConsoleSnapshot,
  AgentConsoleTab,
  AgentControlPort,
  AgentControlReceipt,
  AgentRun,
  ContextDeskCollection,
  ContextDeskGroupId,
  ContextDeskPane,
  ContextPacketChangeClassification,
  ContextPacketReceipt,
  ContextPacketView,
  ContextPacketViewAction,
  ContextPacketViewActionReceipt,
  ContextPacketViewItem,
  ContextProfileId,
  ContextPolicySuggestion,
  ContextPolicySuggestionState,
  PromptManifest,
  SubmitContextPacketReceiptInput,
  WorkGraph,
} from "@unclecode/contracts";
import type { WorkAgentControlRuntime } from "./work-agent-run-controller.js";
import type { WorkAgentTurnResult } from "./work-agent.js";
import type {
  WorkShellDurablePauseCheckpoint,
  WorkShellSessionSnapshotInput,
} from "./work-shell-engine-persistence.js";
import type {
  MemoryLineageAdapter,
  PromoteScopedMemoryInput,
} from "@unclecode/context-broker";
import { wrapDisplayTextFast } from "@unclecode/context-broker";

type PromiseResolvers<Value> = {
  readonly promise: Promise<Value>;
  resolve(value: Value | PromiseLike<Value>): void;
  reject(reason?: unknown): void;
};

function createPromiseResolvers<Value>(): PromiseResolvers<Value> {
  return (
    Promise as PromiseConstructor & {
      withResolvers<Result>(): PromiseResolvers<Result>;
    }
  ).withResolvers<Value>();
}

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
  const parsed: unknown = JSON.parse(trimmed);
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
  const parsed: unknown = JSON.parse(trimmed);
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
  const parsed: unknown = JSON.parse(trimmed);
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
  | { readonly action: "open_agent_console"; readonly line: string; readonly tab: AgentConsoleTab }
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
  if (parsed.action === "open_agent_console" && typeof parsed.line === "string" && isAgentConsoleTab(parsed.tab)) {
    return { action: "open_agent_console", line: parsed.line, tab: parsed.tab };
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

export type WorkShellPromptManifestResolver = (input: {
  readonly packet: ContextPacketView;
  readonly userPrompt: string;
}) => PromptManifest;

export type WorkShellEngineOptions<Reasoning extends WorkShellReasoningConfig> = {
  readonly provider: string;
  readonly model: string;
  readonly mode: string;
  readonly authLabel: string;
  readonly reasoning: Reasoning;
  readonly cwd: string;
  readonly contextSummaryLines: readonly string[];
  readonly initialTraceMode?: WorkShellTraceMode | undefined;
  readonly initialUiLocale?: WorkShellUiLocale | undefined;
  /** False means terminal chrome is provisional until the first prose submit. */
  readonly initialUiLocaleLocked?: boolean | undefined;
  readonly initialEntries?: readonly WorkShellChatEntry[] | undefined;
  readonly initialSessionSummary?: string | undefined;
  readonly initialLastSubmittedContextReceiptId?: string | undefined;
  readonly autoContinueOnPermissionStall?: boolean | undefined;
  readonly modelWindow?: number | undefined;
  readonly contextProfile?: ContextProfileId | undefined;
  readonly initialAgentConsole?: AgentConsoleSnapshot | undefined;
  readonly interactionBridge?: WorkShellInteractionBridge | undefined;
};

export type WorkShellTraceMode = "minimal" | "verbose";

/**
 * `agent-steer` routes the composer line to the selected agent run's control
 * mailbox instead of opening a provider turn, so a steer can never be
 * mistaken for chat.
 */
export type WorkShellComposerMode = "default" | "api-key-entry" | "agent-steer";

export type WorkShellEngineState<Reasoning extends WorkShellReasoningConfig> = {
  readonly entries: readonly WorkShellChatEntry[];
  readonly streamingAssistantText?: string | undefined;
  /**
   * Per-turn reasoning accumulation: `reasoning.delta` events (both `text`
   * and `summary` kinds) append here, capped at 2000 chars. It flushes as
   * ONE `✻ `-prefixed assistant summary entry at the first assistant delta
   * or turn completion — whichever arrives first — and resets after the
   * flush and at every turn end (success, failure, cancel, interrupt).
   */
  readonly streamingReasoningText?: string | undefined;
  readonly model: string;
  readonly mode: string;
  readonly reasoning: Reasoning;
  readonly authLabel: string;
  readonly authLauncherLines: readonly string[];
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
  readonly panel: WorkShellPanel;
  readonly traceLines: readonly string[];
  /**
   * Always-filled live trace tail for the composer dock's busy feed. Unlike
   * `traceLines` (verbose-only, tied to the context panel and cleared by
   * `/minimal`), this buffer receives every meaningful formatted line in
   * EVERY trace mode and is capped at the newest 8 entries — so the dock
   * feed stays alive in default (minimal) mode. Overlay/panel semantics are
   * unchanged because nothing but the dock feed consumes it.
   */
  readonly liveTraceLines: readonly string[];
  readonly traceMode: WorkShellTraceMode;
  readonly uiLocale: WorkShellUiLocale;
  readonly uiLocaleLocked: boolean;
  readonly composerMode: WorkShellComposerMode;
  /** Immutable run identity captured when an agent-steer draft begins. */
  readonly agentSteerTarget?: {
    readonly kind: "agent-steer";
    readonly agentRunId: string;
  } | undefined;
  readonly isBusy: boolean;
  readonly busyStatus?: string | undefined;
  readonly currentTurnStartedAt?: number | undefined;
  readonly lastTurnDurationMs?: number | undefined;
  readonly contextPacket?: ContextPacketView | undefined;
  readonly contextActionReceipt?: ContextPacketViewActionReceipt | undefined;
  readonly contextPreviewReceipt?: ContextPacketReceipt | undefined;
  readonly contextSubmittedReceipt?: ContextPacketReceipt | undefined;
  readonly contextPacketChange?: ContextPacketChangeClassification | undefined;
  readonly contextIndicator?: string | undefined;
  readonly contextSourceActionsEnabled: boolean;
  readonly contextPolicySuggestions: readonly ContextPolicySuggestion[];
  readonly contextAdviceUnavailable?: string | undefined;
  readonly contextAdviceActionsEnabled: boolean;
  readonly modelWindow: number;
  readonly queuedCount: number;
  readonly queuePaused: boolean;
  /** Turn suspension is independent from queue pause and AbortSignal cancellation. */
  readonly turnLifecycle: WorkShellPauseSnapshot;
  readonly terminalColumns: number;
  readonly terminalRows?: number | undefined;
  // Context Inspector (Sprint 2): cursor highlight index into the navigable
  // source list (-1 = none) and the source id whose full content is expanded
  // (null = none). Owned by the engine so every mutation re-renders via the
  // existing subscriber fan-out.
  readonly contextInspectorCursor: number;
  readonly contextInspectorExpanded: string | null;
  readonly contextInspectorDetailContent?: string | undefined;
  readonly contextInspectorDetailOffset: number;
  // Context Desk (Pure Yazi): whether the three-pane desk overlay owns the
  // keyboard. Every desk key and mutation gates on this flag rather than on
  // the panel title, because a collapsed context panel can carry the same
  // title as the open overlay.
  readonly contextInspectorOpen: boolean;
  readonly contextInspectorPane: ContextDeskPane;
  readonly contextInspectorCollection: ContextDeskCollection;
  readonly agentConsole: AgentConsoleSnapshot;
  readonly agentConsoleView: AgentConsoleViewState;
};

export interface WorkShellAgent<Attachment, TraceEvent, Reasoning extends WorkShellReasoningConfig> {
  readonly supportsCooperativePause?: true | undefined;
  clear(): void;
  runTurn(
    prompt: string,
    attachments?: readonly Attachment[],
    options?: {
      readonly signal?: AbortSignal | undefined;
      readonly classificationPrompt?: string | undefined;
      readonly pause?: ExecutionPausePort | undefined;
    },
  ): Promise<WorkAgentTurnResult>;
  updateRuntimeSettings(settings: { reasoning?: Reasoning | undefined; model?: string | undefined }): void;
  updateMode?(mode: string): void;
  setTraceListener(listener?: ((event: TraceEvent) => void) | undefined): void;
  /**
   * Operator control surface for the runs this agent dispatched. Absent for
   * agents that never open background runs; the engine then reports controls
   * as undelivered instead of pretending they were queued.
   */
  getAgentControlRuntime?(): WorkAgentControlRuntime | undefined;
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
  formatAgentTraceLine: (
    event: TraceEvent | { readonly type: "bridge.published" | "memory.written"; readonly [key: string]: unknown },
    uiLocale?: WorkShellUiLocale,
  ) => string;
  formatWorkShellError: (message: string) => string;
  listProjectBridgeLines: (cwd: string) => Promise<readonly string[]>;
  listScopedMemoryLines: (input: {
    scope: WorkShellMemoryScope;
    cwd: string;
    sessionId?: string;
    agentId?: string;
    lineage?: MemoryLineageAdapter;
  }) => Promise<readonly string[]>;
  listSessionLines: (cwd: string) => Promise<readonly string[]>;
  persistWorkShellSessionSnapshot: (input: {
    cwd: string;
    sessionId: string;
    model: string;
    mode: string;
    state: WorkShellSessionState;
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
  memoryLineage?: MemoryLineageAdapter | undefined;
  promoteScopedMemory?: ((input: PromoteScopedMemoryInput) => Promise<{ memoryId: string }>) | undefined;
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
    readonly workGraph?: WorkGraph | undefined;
  }) => Promise<ContextPacketView>) | undefined;
  resolveContextSourceDetail?: ((sourceId: string) => Promise<string | undefined>) | undefined;
  resolvePromptManifest?: WorkShellPromptManifestResolver | undefined;
  toolLines?: readonly string[];
  extractAuthLabel?: (lines: readonly string[]) => string | undefined;
  onExit: () => void;
  sessionId?: string;
  /** Optional agentops recorder callback. Non-blocking. Fired after every prompt turn. */
  recordTurn?: ((turn: { prompt: string; status: string; summary?: string; turnId?: string; contextReceiptId?: string; packetId?: string }) => void) | undefined;
  /**
   * Context Inspector (Sprint 2): SQL mutation callback for the /context
   * overlay. Maps a pin/unpin/forget/include action to the AgentOpsStore
   * write. Optional — when absent, overlay actions are no-ops (the legacy
   * non-CRP path has no store).
   */
  mutateContextSource?: ((
    action: { readonly kind: "pin" | "unpin" | "forget" | "include"; readonly id: string },
  ) => ContextPacketViewActionReceipt | undefined) | undefined;
  readonly undoContextSourceAction?: (() => ContextPacketViewActionReceipt | undefined) | undefined;
  readonly previewContextPacket?: ((input: {
    readonly sessionId: string;
    readonly packet: ContextPacketView;
    readonly profile: string;
  }) => ContextPacketReceipt) | undefined;
  readonly revalidateContextPacket?: ((input: {
    readonly sessionId: string;
    readonly preview: ContextPacketReceipt;
    readonly packet: ContextPacketView;
  }) => ContextPacketChangeClassification) | undefined;
  readonly submitContextPacketReceipt?: ((
    input: Omit<SubmitContextPacketReceiptInput, "projectId">,
  ) => ContextPacketReceipt) | undefined;
  readonly generateContextSuggestions?: ((input: {
    readonly receipt: ContextPacketReceipt;
    readonly packet: ContextPacketView;
  }) => Promise<readonly ContextPolicySuggestion[]>) | undefined;
  readonly resolveContextSuggestion?: ((
    suggestionId: string,
    status: Extract<ContextPolicySuggestionState, "accepted" | "rejected">,
  ) => ContextPolicySuggestion) | undefined;
  readonly invalidateContextSuggestions?: ((receiptId: string) => number) | undefined;
  readonly refreshCondensedHistory?: (() => Promise<void>) | undefined;
};

type PendingDecision = {
  readonly request: AskUserQuestionRequest;
  settle(result: AskUserQuestionResult): void;
};

/**
 * One navigable row of the Context Desk source list. `actions` mirrors the
 * capability list the packet item advertises, so a key the desk does not
 * offer for a source can never mutate it.
 */
type InspectorSource = {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly group: ContextDeskGroupId;
  readonly item: ContextPacketViewItem;
  readonly detail: string;
  readonly pinned: boolean;
  readonly heldBack: boolean;
  readonly actions?: readonly ContextPacketViewAction[] | undefined;
};

/**
 * The engine owns desk navigation but not the terminal geometry, so a page
 * key jumps a fixed block of rows and clamps at the ends of whatever list the
 * active pane is showing. Clamping (never wrapping) is what makes PgUp/PgDn
 * reliable as "go to the top/bottom of this collection" on short lists.
 */
const CONTEXT_DESK_PAGE_ROWS = 10;

/**
 * Rank of one desk group in the descriptor table — the row order the desk
 * renderer draws, so the engine's cursor and the rendered list agree row for
 * row. `CONTEXT_DESK_COLLECTIONS` is deliberately not the table used for this:
 * it prefixes `all` and appends the two delivery buckets, and it has no entry
 * at all for a group projection this build does not recognise. An unknown
 * group ranks at `CONTEXT_DESK_GROUPS.length` — behind every canonical one,
 * exactly like the renderer.
 *
 * A `Map`, not an object literal, because the lookup key is an arbitrary
 * runtime string: a packet can carry a group from an older broker, and an
 * object index would resolve a name like `constructor` off `Object.prototype`
 * instead of missing. This mirrors the category table in `@unclecode/contracts`.
 */
const CONTEXT_DESK_GROUP_RANK: ReadonlyMap<string, number> = new Map(
  CONTEXT_DESK_GROUPS.map((group, index) => [group.id, index] as const),
);

/**
 * One publication per animation frame is all a terminal renderer can show, so
 * a lifecycle burst is folded into a single subscriber fan-out. Durable writes
 * are far more expensive than a render and coalesce on their own, longer
 * window.
 */
const AGENT_CONSOLE_PUBLISH_INTERVAL_MS = 16;
const AGENT_CONSOLE_PERSIST_INTERVAL_MS = 50;

const AGENT_RUN_UNKNOWN_MESSAGE = "That agent run is no longer in the console.";
const AGENT_CONTROLS_UNAVAILABLE_MESSAGE = "Agent controls are unavailable in this session.";

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
  private readonly formatAgentTraceLine: (
    event: TraceEvent | { readonly type: "bridge.published" | "memory.written"; readonly [key: string]: unknown },
    uiLocale?: WorkShellUiLocale,
  ) => string;
  private readonly formatWorkShellError: (message: string) => string;
  private readonly listProjectBridgeLines: (cwd: string) => Promise<readonly string[]>;
  private readonly listScopedMemoryLines: (input: {
    scope: WorkShellMemoryScope;
    cwd: string;
    sessionId?: string;
    agentId?: string;
    lineage?: MemoryLineageAdapter;
  }) => Promise<readonly string[]>;
  private readonly listSessionLines: (cwd: string) => Promise<readonly string[]>;
  private readonly persistWorkShellSessionSnapshot: (input: {
    cwd: string;
    sessionId: string;
    model: string;
    mode: string;
    state: WorkShellSessionState;
    summary: string;
    traceMode?: WorkShellTraceMode | undefined;
    agentConsole?: AgentConsoleSnapshot | undefined;
    pauseCheckpoint?: WorkShellDurablePauseCheckpoint | undefined;
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
  private readonly memoryLineage?: MemoryLineageAdapter | undefined;
  private readonly promoteScopedMemory?: ((input: PromoteScopedMemoryInput) => Promise<{ memoryId: string }>) | undefined;
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
    readonly workGraph?: WorkGraph | undefined;
  }) => Promise<ContextPacketView>) | undefined;
  private readonly resolveContextSourceDetail?: ((sourceId: string) => Promise<string | undefined>) | undefined;
  private readonly resolvePromptManifest?: WorkShellPromptManifestResolver | undefined;
  private readonly toolLines: readonly string[];
  private readonly extractAuthLabel?: ((lines: readonly string[]) => string | undefined) | undefined;
  private readonly onExit: () => void;
  private readonly sessionId: string;
  private readonly recordTurn?: ((turn: { prompt: string; status: string; summary?: string; turnId?: string; contextReceiptId?: string; packetId?: string }) => void) | undefined;
  private readonly mutateContextSource?: ((
    action: { readonly kind: "pin" | "unpin" | "forget" | "include"; readonly id: string },
  ) => ContextPacketViewActionReceipt | undefined) | undefined;
  private readonly undoContextSourceAction?: (() => ContextPacketViewActionReceipt | undefined) | undefined;
  private readonly previewContextPacket?: ((input: {
    readonly sessionId: string;
    readonly packet: ContextPacketView;
    readonly profile: string;
  }) => ContextPacketReceipt) | undefined;
  private readonly revalidateContextPacket?: ((input: {
    readonly sessionId: string;
    readonly preview: ContextPacketReceipt;
    readonly packet: ContextPacketView;
  }) => ContextPacketChangeClassification) | undefined;
  private readonly submitContextPacketReceipt?: ((
    input: Omit<SubmitContextPacketReceiptInput, "projectId">,
  ) => ContextPacketReceipt) | undefined;
  private readonly generateContextSuggestions?: ((input: {
    readonly receipt: ContextPacketReceipt;
    readonly packet: ContextPacketView;
  }) => Promise<readonly ContextPolicySuggestion[]>) | undefined;
  private readonly resolveContextSuggestion?: ((
    suggestionId: string,
    status: Extract<ContextPolicySuggestionState, "accepted" | "rejected">,
  ) => ContextPolicySuggestion) | undefined;
  private readonly invalidateContextSuggestions?: ((receiptId: string) => number) | undefined;
  private readonly refreshCondensedHistory?: (() => Promise<void>) | undefined;
  private readonly interactionBridge?: WorkShellInteractionBridge | undefined;
  private readonly subscribers = new Set<(state: WorkShellEngineState<Reasoning>) => void>();
  private readonly queuedAttachments = new Map<number, readonly Attachment[]>();
  private readonly queueDrainSkipTurnEpochs = new Set<number>();
  private readonly pendingContextSuggestionInvalidations = new Set<string>();
  private contextSuggestionAcceptanceInFlight = false;
  private queuedCountCache = 0;
  private currentContextSummaryLines: readonly string[];
  private lastSessionSummary: string;
  private lastSubmittedContextReceiptId: string | undefined;
  private drainingQueue = false;
  private contextSourceMutationQueue: Promise<void> = Promise.resolve();
  private cachedContextPacket: ContextPacketView | undefined;
  private cachedInspectorSourceList: readonly InspectorSource[] = [];
  private activeTurnEpoch = 0;
  private activeAttachmentRefs: readonly string[] = [];
  private activeTurnAbortController: AbortController | undefined;
  private admittedRuntimeTurns = 0;
  private cancelledAdmittedRuntimeTurns = 0;
  private runtimeRevisionClock: { readonly value: number } | undefined;
  private usageRecorder: AgentConsoleUsageRecorder | undefined;
  private readonly activeTurnSettlements = new Set<Promise<void>>();
  private disposed = false;
  private queueAutoDrainPaused = false;
  private workBoardRebuildGeneration = 0;
  private workBoardQueuedItemsSnapshot: readonly { readonly id: number; readonly line: string }[] = [];
  private lastCompletedTurnSnapshot:
    | { readonly user: string; readonly assistant: string }
    | undefined;
  private state: WorkShellEngineState<Reasoning>;
  private readonly pauseController: CooperativePauseController;
  private pendingDecision: PendingDecision | undefined;
  /**
   * Lifecycle events reduce here first, in arrival order, so a burst is
   * folded against every prior event before any subscriber sees it. Cleared
   * once the pending snapshot has been fanned out.
   */
  private pendingAgentConsole: AgentConsoleSnapshot | undefined;
  private agentConsolePublishTimer: NodeJS.Timeout | undefined;
  private agentConsolePersistTimer: NodeJS.Timeout | undefined;
  /**
   * Tail of the ordered durable-write chain. Never rejects: a failed write is
   * absorbed here so the next checkpoint still runs.
   */
  private sessionSnapshotWriteQueue: Promise<void> = Promise.resolve();

  constructor(input: WorkShellEngineInput<Attachment, Reasoning, TraceEvent>) {
    this.agent = input.agent;
    this.options = input.options;
    this.interactionBridge = input.options.interactionBridge;
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
    this.memoryLineage = input.memoryLineage;
    this.promoteScopedMemory = input.promoteScopedMemory;
    this.listAvailableSkills = input.listAvailableSkills ?? (async () => []);
    this.loadNamedSkill = input.loadNamedSkill ?? (async (name) => ({ name, path: name, content: "", attempts: [] }));
    this.reloadWorkspaceContext = input.reloadWorkspaceContext;
    this.resolveContextPacket = input.resolveContextPacket;
    this.resolvePromptManifest = input.resolvePromptManifest;
    this.resolveContextSourceDetail = input.resolveContextSourceDetail;
    this.toolLines = input.toolLines ?? [];
    this.extractAuthLabel = input.extractAuthLabel;
    this.onExit = input.onExit;
    this.recordTurn = input.recordTurn;
    this.mutateContextSource = input.mutateContextSource;
    this.undoContextSourceAction = input.undoContextSourceAction;
    this.previewContextPacket = input.previewContextPacket;
    this.revalidateContextPacket = input.revalidateContextPacket;
    this.submitContextPacketReceipt = input.submitContextPacketReceipt;
    this.generateContextSuggestions = input.generateContextSuggestions;
    this.resolveContextSuggestion = input.resolveContextSuggestion;
    this.invalidateContextSuggestions = input.invalidateContextSuggestions;
    this.refreshCondensedHistory = input.refreshCondensedHistory;
    this.sessionId = input.sessionId ?? `work-${randomUUID()}`;
    this.currentContextSummaryLines = input.options.contextSummaryLines;
    this.lastSessionSummary = input.options.initialSessionSummary ?? "Work shell ready.";
    this.lastSubmittedContextReceiptId =
      input.options.initialLastSubmittedContextReceiptId;
    this.state = {
      ...createInitialWorkShellEngineState({
        options: input.options,
        contextSummaryLines: this.currentContextSummaryLines,
        buildContextPanel: input.buildContextPanel,
      }),
      contextSourceActionsEnabled: input.mutateContextSource !== undefined,
      contextAdviceActionsEnabled: input.resolveContextSuggestion !== undefined,
    };
    this.pauseController = new CooperativePauseController({
      onStateChanged: (turnLifecycle) => this.setState({ turnLifecycle }),
    });
    this.lastCompletedTurnSnapshot = resolveLastCompletedTurn(
      input.options.initialEntries ?? this.state.entries,
    );
  }

  getState(): WorkShellEngineState<Reasoning> {
    return this.state;
  }

  /** Stable identity used by the session store and the loopback control room. */
  getSessionId(): string {
    return this.sessionId;
  }

  getTurnLifecycle(): WorkShellPauseSnapshot {
    return this.pauseController.snapshot();
  }

  bindRuntimeRevisionClock(clock: { readonly value: number }): void {
    this.runtimeRevisionClock = clock;
  }

  /** Runtime-owner-only usage identity port; remote clients never receive it. */
  bindRuntimeUsageRecorder(recorder: AgentConsoleUsageRecorder): void {
    this.usageRecorder = recorder;
  }

  persistRuntimeRevision(revision: number): Promise<void> {
    const lifecycle = this.pauseController.snapshot();
    const state: WorkShellSessionState = lifecycle.state === "pause_pending" || lifecycle.state === "paused"
      ? lifecycle.state
      : this.pendingDecision
        ? "requires_action"
        : this.state.isBusy
          ? "running"
          : "idle";
    return this.enqueueSessionSnapshotWrite(this.buildSessionSnapshotInput({
      state,
      summary: this.lastSessionSummary,
      traceMode: this.state.traceMode,
      ownerMutationRevision: revision,
    }));
  }

  requestTurnPause(): Promise<WorkShellPauseReceipt> {
    const requested = this.pauseController.requestPause();
    if (this.pendingDecision && this.pauseController.snapshot().state === "pause_pending") {
      void this.pauseController.checkpoint(
        "before_approval",
        () => this.pauseCheckpointForEpoch(this.activeTurnEpoch, "before_approval"),
      ).catch(() => undefined);
    }
    return requested;
  }

  resumeTurn(): boolean {
    return this.pauseController.resume();
  }

  updateTerminalColumns(columns: number): void {
    const terminalColumns = Math.max(20, Math.floor(columns));
    if (this.state.terminalColumns === terminalColumns) {
      return;
    }
    this.setState({ terminalColumns });
    if (this.state.panel.title === WORK_BOARD_PANEL_TITLE) {
      this.setState({ panel: this.createWorkBoardPanel(this.workBoardQueuedItemsSnapshot) });
      void this.rebuildWorkBoardPanel();
    }
  }

  updateTerminalRows(rows: number): void {
    const terminalRows = Math.max(1, Math.floor(rows));
    if (this.state.terminalRows !== terminalRows) {
      this.setState({ terminalRows });
    }
  }

  private createWorkBoardPanel(
    queuedItems: readonly { readonly id: number; readonly line: string }[],
  ): WorkShellPanel {
    return createQueueBuiltinResult(buildWorkShellQueueBuiltinInput({
      line: "/queue",
      state: this.state,
      workerBudget: resolveWorkerBudget(this.state.mode),
      queuedCount: this.queuedCountCache,
      queuedItems,
      contextSummaryLines: this.currentContextSummaryLines,
      ...(this.lastCompletedTurnSnapshot ? { lastCompletedTurn: this.lastCompletedTurnSnapshot } : {}),
    })).panel;
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
    this.workBoardQueuedItemsSnapshot = queuedItems;
    this.setState({ panel: this.createWorkBoardPanel(queuedItems) });
  }

  subscribe(listener: (state: WorkShellEngineState<Reasoning>) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    this.interactionBridge?.bind({
      ask: (request, signal) => this.openDecision(request, signal),
    });
    this.clearResumedPendingDecision();
    // A lifecycle burst is one render, not one render per event: the console
    // reduction, the busy status, the trace buffer, and any verbose trace entry
    // are all staged and fanned out once per publish window.
    this.agent.setTraceListener((event) => {
      this.reduceAgentConsoleTraceEvent(event);
      // An executor-scoped trace belongs to a delegated run, so the console
      // reduction above is its only destination. Letting it through here would
      // stream a sub-agent's `assistant.delta` into the operator's transcript
      // and drive this shell's busy clock from a turn the operator never
      // started.
      if (isExecutorScopedTraceEvent(event)) {
        return;
      }
      applyWorkShellTraceEvent({
        state: this.state,
        event,
        formatAgentTraceLine: this.formatAgentTraceLine,
        setState: (patch) => this.stageTraceState(patch),
        appendEntries: (...entries) => this.stageTraceState(
          appendWorkShellEntries(this.state, ...entries),
        ),
        pushTraceLine: (line) => this.stageTraceState(createWorkShellTraceLinePatch({
          state: this.state,
          line,
          preservePanel: false,
          contextSummaryLines: this.currentContextSummaryLines,
          buildContextPanel: this.buildContextPanel,
        })),
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
        ...(this.memoryLineage !== undefined ? { lineage: this.memoryLineage } : {}),
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
    if (this.disposed) return;
    this.disposed = true;
    this.pauseController.cancel();
    this.agent.setTraceListener(undefined);
    this.flushAgentConsole();
    this.clearAgentConsoleTimers();
    this.agent.getAgentControlRuntime?.()?.clear("Work Shell closed.");
    this.settlePendingDecision({ status: "unavailable", reason: "Work Shell closed." });
    this.interactionBridge?.unbind("Work Shell closed.");
  }

  /**
   * Owner-only async shutdown. Abort is only the request; returning requires
   * the provider/tool continuation itself to have settled. A signal-deaf
   * implementation is surfaced as an owner shutdown failure instead of being
   * detached and leaked.
   */
  async shutdown(input: { readonly timeoutMs?: number | undefined } = {}): Promise<boolean> {
    const timeoutMs = Math.max(0, input.timeoutMs ?? 5_000);
    if (this.state.isBusy) this.interruptTurn();
    else this.activeTurnAbortController?.abort();
    const deadline = Date.now() + timeoutMs;
    while (this.activeTurnSettlements.size > 0) {
      const active = [...this.activeTurnSettlements];
      const remaining = Math.max(0, deadline - Date.now());
      const settled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), remaining);
        Promise.allSettled(active).then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!settled) {
        throw new Error("Work Shell shutdown did not settle the active provider/tool turn.");
      }
    }
    const remaining = Math.max(0, deadline - Date.now());
    const writesSettled = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), remaining);
      this.sessionSnapshotWriteQueue.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!writesSettled) throw new Error("Work Shell shutdown did not settle durable session writes.");
    this.dispose();
    return true;
  }

  // ---------------------------------------------------------------------
  // Agent Console: navigation, operator controls, and coalesced lifecycle
  // publication. Console view state is engine-owned so every mutation
  // re-renders through the same subscriber fan-out as the rest of the shell.
  // ---------------------------------------------------------------------

  openAgentConsole(tab?: AgentConsoleTab): void {
    this.setState({
      agentConsoleView: openAgentConsoleView(
        this.state.agentConsoleView,
        this.state.agentConsole,
        tab,
      ),
    });
  }

  closeAgentConsole(): void {
    this.setState({
      agentConsoleView: closeAgentConsoleView(this.state.agentConsoleView),
      ...(this.state.composerMode === "agent-steer"
        ? { composerMode: "default", agentSteerTarget: undefined }
        : {}),
    });
  }

  selectAgentConsoleTab(tab: AgentConsoleTab): void {
    this.setState({
      agentConsoleView: selectAgentConsoleTab(
        this.state.agentConsoleView,
        this.state.agentConsole,
        tab,
      ),
    });
  }

  moveAgentConsoleCursor(delta: number): void {
    this.setState({
      agentConsoleView: moveAgentConsoleCursor(
        this.state.agentConsoleView,
        this.state.agentConsole,
        delta,
      ),
    });
  }

  toggleAgentConsoleInspector(): void {
    this.setState({
      agentConsoleView: toggleAgentConsoleInspector(this.state.agentConsoleView),
    });
  }

  /**
   * Operator control surface for the console. Every call validates the live
   * snapshot before it reaches the agent runtime, so a control can never be
   * delivered to a run the console no longer shows or that already settled.
   */
  getAgentControlPort(): AgentControlPort {
    return {
      steer: async (agentRunId, message) => {
        const trimmed = message.trim();
        if (!trimmed) {
          return { status: "rejected", message: "Type something to send to the agent." };
        }
        const run = this.state.agentConsole.agents.find((agent) => agent.id === agentRunId);
        if (!run) {
          return { status: "rejected", message: AGENT_RUN_UNKNOWN_MESSAGE };
        }
        if (isSettledAgentRun(run)) {
          return { status: "rejected", message: `${run.displayName} has already finished.` };
        }
        const runtime = this.agent.getAgentControlRuntime?.();
        if (!runtime) {
          return { status: "not_delivered", message: AGENT_CONTROLS_UNAVAILABLE_MESSAGE };
        }
        return runtime.steer(agentRunId, trimmed);
      },
      cancel: async (agentRunId) => {
        const run = this.state.agentConsole.agents.find((agent) => agent.id === agentRunId);
        if (!run) {
          return { status: "rejected", message: AGENT_RUN_UNKNOWN_MESSAGE };
        }
        if (isSettledAgentRun(run)) {
          return { status: "rejected", message: `${run.displayName} has already finished.` };
        }
        const runtime = this.agent.getAgentControlRuntime?.();
        if (!runtime) {
          return { status: "not_delivered", message: AGENT_CONTROLS_UNAVAILABLE_MESSAGE };
        }
        return runtime.cancel(agentRunId);
      },
      continue: async (agentRunId, message) => {
        // A continuation carries lineage, so it is started from the persisted
        // safe record rather than from an id the caller happens to hold.
        const run = this.state.agentConsole.agents.find((agent) => agent.id === agentRunId);
        if (!run) {
          return { status: "rejected", message: AGENT_RUN_UNKNOWN_MESSAGE };
        }
        const runtime = this.agent.getAgentControlRuntime?.();
        if (!runtime) {
          return { status: "not_delivered", message: AGENT_CONTROLS_UNAVAILABLE_MESSAGE };
        }
        return message === undefined
          ? runtime.continueRun(run)
          : runtime.continueRun(run, message);
      },
    };
  }

  /** Enter the steer composer for the selected live run. */
  beginAgentSteer(): void {
    const view = this.state.agentConsoleView;
    const selection = resolveAgentConsoleSelection(view, this.state.agentConsole);
    if (!view.open || selection?.tab !== "agents" || isSettledAgentRun(selection.run)) {
      this.setState({
        agentSteerTarget: undefined,
        agentConsoleView: settleAgentConsoleControl(view, {
          status: "rejected",
          message: "Select a running agent to steer.",
        }),
      });
      return;
    }
    this.setState({
      composerMode: "agent-steer",
      agentSteerTarget: { kind: "agent-steer", agentRunId: selection.run.id },
      agentConsoleView: settleAgentConsoleControl(view),
    });
  }

  /** Arm the cancel confirmation for the selected run. */
  requestAgentCancel(): void {
    this.setState({
      agentConsoleView: requestAgentConsoleCancel(
        this.state.agentConsoleView,
        this.state.agentConsole,
      ),
    });
  }

  async confirmAgentCancel(confirm: boolean): Promise<void> {
    const control = this.state.agentConsoleView.control;
    if (control.kind !== "confirm-cancel") {
      return;
    }
    // Leaving the confirmation before awaiting is what makes cancel one-shot:
    // a second confirmation finds a browsing console and never reaches the
    // runtime.
    this.setState({ agentConsoleView: settleAgentConsoleControl(this.state.agentConsoleView) });
    if (!confirm) {
      return;
    }
    const receipt = await this.getAgentControlPort().cancel(control.agentRunId);
    this.setState({
      agentConsoleView: settleAgentConsoleControl(this.state.agentConsoleView, receipt),
    });
  }

  async continueSelectedAgent(): Promise<void> {
    const selection = resolveAgentConsoleSelection(
      this.state.agentConsoleView,
      this.state.agentConsole,
    );
    if (selection?.tab !== "agents") {
      this.setState({
        agentConsoleView: settleAgentConsoleControl(this.state.agentConsoleView, {
          status: "rejected",
          message: "Select an agent run to continue.",
        }),
      });
      return;
    }
    const receipt = await this.getAgentControlPort().continue(selection.run.id);
    this.setState({
      agentConsoleView: settleAgentConsoleControl(this.state.agentConsoleView, receipt),
    });
  }

  /**
   * Deliver a composer line as control input. The steer composer always exits,
   * so a rejected or undeliverable steer cannot strand the operator in a mode
   * whose target has gone away.
   */
  private async submitAgentSteer(value: string): Promise<void> {
    const target = this.state.agentSteerTarget;
    // Consume the binding before awaiting so repeated Enter cannot deliver the
    // same draft twice or observe a cursor that moved during remote queuing.
    this.setState({ composerMode: "default", agentSteerTarget: undefined });
    const receipt: AgentControlReceipt = target?.kind === "agent-steer"
      ? await this.getAgentControlPort().steer(target.agentRunId, value)
      : { status: "rejected", message: "Select an agent run to steer." };
    this.setState({
      agentConsoleView: settleAgentConsoleControl(this.state.agentConsoleView, receipt),
    });
  }

  /**
   * Fold one lifecycle event into the private pending snapshot. The reduction
   * is synchronous so `getState()` and every control validate against the
   * newest projection; only the subscriber fan-out and the durable write are
   * coalesced. Rebasing on the live snapshot first is what keeps a decision or
   * manifest that arrived mid-window from being reduced away.
   */
  private reduceAgentConsoleTraceEvent(event: { readonly type: string }): void {
    const pending = this.pendingAgentConsole;
    const base = pending === undefined
      ? this.state.agentConsole
      : mergeAgentConsoleLifecycle(pending, this.state.agentConsole);
    const next = applyTraceEventToAgentConsole(base, event, this.usageRecorder);
    if (next === base) {
      return;
    }
    this.pendingAgentConsole = next;
    this.stageState({
      agentConsole: next,
      agentConsoleView: clampAgentConsoleView(this.state.agentConsoleView, next),
    });
    this.scheduleAgentConsolePublish();
    this.scheduleAgentConsolePersist();
  }

  /** Commit a trace-driven patch without fanning out; publish on the window. */
  private stageTraceState(patch: Partial<WorkShellEngineState<Reasoning>>): void {
    this.stageState(patch);
    this.scheduleAgentConsolePublish();
  }

  private scheduleAgentConsolePublish(): void {
    if (this.agentConsolePublishTimer !== undefined) {
      return;
    }
    this.agentConsolePublishTimer = setTimeout(() => {
      this.agentConsolePublishTimer = undefined;
      this.publishStagedTraceState();
    }, AGENT_CONSOLE_PUBLISH_INTERVAL_MS);
    this.agentConsolePublishTimer.unref();
  }

  private scheduleAgentConsolePersist(): void {
    if (this.agentConsolePersistTimer !== undefined) {
      return;
    }
    this.agentConsolePersistTimer = setTimeout(() => {
      this.agentConsolePersistTimer = undefined;
      void this.persistAgentConsoleSnapshot();
    }, AGENT_CONSOLE_PERSIST_INTERVAL_MS);
    this.agentConsolePersistTimer.unref();
  }

  private publishStagedTraceState(): void {
    const pending = this.pendingAgentConsole;
    if (pending === undefined) {
      // Only non-console trace effects were staged (busy status, trace buffer).
      this.setState({});
      return;
    }
    this.pendingAgentConsole = undefined;
    this.setState({ agentConsole: mergeAgentConsoleLifecycle(pending, this.state.agentConsole) });
  }

  /** Publish and durably record whatever the coalescing windows still hold. */
  private flushAgentConsole(): void {
    const hadPendingWrite = this.agentConsolePersistTimer !== undefined;
    if (this.agentConsolePublishTimer !== undefined || this.pendingAgentConsole !== undefined) {
      this.publishStagedTraceState();
    }
    if (hadPendingWrite) {
      void this.persistAgentConsoleSnapshot();
    }
  }

  private clearAgentConsoleTimers(): void {
    if (this.agentConsolePublishTimer !== undefined) {
      clearTimeout(this.agentConsolePublishTimer);
      this.agentConsolePublishTimer = undefined;
    }
    if (this.agentConsolePersistTimer !== undefined) {
      clearTimeout(this.agentConsolePersistTimer);
      this.agentConsolePersistTimer = undefined;
    }
  }

  /**
   * A console-driven checkpoint reports whether background work is still
   * outstanding. A failed write leaves the in-memory projection untouched and
   * stays out of the transcript: the next lifecycle event schedules another
   * attempt, and storage errors are not operator-facing prose.
   */
  private async persistAgentConsoleSnapshot(): Promise<void> {
    const snapshot = this.state.agentConsole;
    const active = snapshot.agents.some((agent) => !isSettledAgentRun(agent))
      || snapshot.jobs.some((job) => !isSettledAsyncJob(job));
    try {
      await this.enqueueSessionSnapshotWrite(this.buildSessionSnapshotInput({
        state: active ? "running" : "idle",
        summary: this.lastSessionSummary,
        traceMode: this.state.traceMode,
      }));
    } catch {
      /* durable-write failure is retried by the next lifecycle event */
    }
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
      if (!(error instanceof Error)) {
        throw error;
      }
      this.setState({ panel: createOpenSessionsFailurePanel(error) });
    }
  }

  cancelSensitiveInput(): void {
    // The steer composer is a console control, not sensitive auth input: it
    // exits locally instead of running the secure-entry cancellation path.
    if (this.state.composerMode === "agent-steer") {
      this.setState({
        composerMode: "default",
        agentSteerTarget: undefined,
        agentConsoleView: settleAgentConsoleControl(this.state.agentConsoleView),
      });
      return;
    }
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

    // Closing the overlay hands the keyboard back and resets the inspector
    // cursor/expanded state so the next open starts fresh. The pane and
    // collection are left alone: `/context` restores those defaults on open,
    // and keeping them here lets the closed state stay inspectable.
    this.setState({
      panel,
      contextInspectorOpen: false,
      contextInspectorCursor: -1,
      contextInspectorExpanded: null,
      contextInspectorDetailContent: undefined,
      contextInspectorDetailOffset: 0,
    });
  }

  /**
   * Context Desk — move focus across the Groups → Sources → Preview panes.
   * `direction` is -1 (left) or +1 (right). The tuple has hard edges: neither
   * end wraps, so holding a pane key parks focus on groups or preview instead
   * of cycling the user past the pane they were aiming for.
   */
  moveContextInspectorPane(direction: number): void {
    if (!this.state.contextInspectorOpen) {
      return;
    }
    const current = CONTEXT_DESK_PANES.indexOf(this.state.contextInspectorPane);
    const index = Math.min(
      CONTEXT_DESK_PANES.length - 1,
      Math.max(0, current + (direction >= 0 ? 1 : -1)),
    );
    const pane = CONTEXT_DESK_PANES[index];
    if (pane !== undefined && pane !== this.state.contextInspectorPane) {
      this.setState({ contextInspectorPane: pane });
    }
  }

  /**
   * Context Desk — the vertical key for whichever pane holds focus.
   * `direction` is -1 (up) or +1 (down): groups walks the collection menu and
   * reanchors the selection, sources walks the active collection, and preview
   * scrolls the selected row's body — expanded or not — without disturbing the
   * selection behind it.
   */
  moveContextInspectorCursor(direction: number): void {
    if (!this.state.contextInspectorOpen) {
      return;
    }
    const step = direction >= 0 ? 1 : -1;
    switch (this.state.contextInspectorPane) {
      case "groups":
        this.selectContextDeskCollectionAt(
          CONTEXT_DESK_COLLECTIONS.indexOf(this.state.contextInspectorCollection) + step,
        );
        return;
      case "preview":
        this.moveContextInspectorDetailOffset(step);
        return;
      case "sources":
        this.moveContextDeskSelection(
          (index, length) => (index + step + length) % length,
          step >= 0 ? "first" : "last",
        );
    }
  }

  /**
   * Context Desk — the page key for whichever pane holds focus. A page is a
   * fixed block of rows that clamps at the ends of the active list, so a page
   * key on a short collection is a jump to its first or last row.
   */
  moveContextInspectorPage(direction: number): void {
    if (!this.state.contextInspectorOpen) {
      return;
    }
    const step = (direction >= 0 ? 1 : -1) * CONTEXT_DESK_PAGE_ROWS;
    switch (this.state.contextInspectorPane) {
      case "groups":
        this.selectContextDeskCollectionAt(
          CONTEXT_DESK_COLLECTIONS.indexOf(this.state.contextInspectorCollection) + step,
        );
        return;
      case "preview":
        this.scrollContextDeskPreview(step);
        return;
      case "sources":
        // Enter expands a row in place without moving focus, so a page key
        // that arrives over an open detail belongs to that detail. Walking the
        // list behind it would move a selection the user cannot currently see.
        if (this.state.contextInspectorExpanded !== null) {
          this.scrollContextDeskPreview(step);
          return;
        }
        this.moveContextDeskSelection(
          (index, length) => Math.min(length - 1, Math.max(0, index + step)),
          step >= 0 ? "first" : "last",
        );
    }
  }

  /**
   * Focus one collection of the desk menu and reanchor the sources pane on its
   * first row. `index` is clamped, so the menu never wraps from DELIVERY back
   * to the all-sources row. An empty collection — `other` usually owns no
   * source — clears the selection rather than borrowing a row from elsewhere,
   * which is what keeps the source keys inert while it is focused.
   */
  private selectContextDeskCollectionAt(index: number): void {
    const collection = CONTEXT_DESK_COLLECTIONS[
      Math.min(CONTEXT_DESK_COLLECTIONS.length - 1, Math.max(0, index))
    ];
    if (collection === undefined || collection === this.state.contextInspectorCollection) {
      return;
    }
    const previousId = this.resolveInspectorSourceAtCursor()?.id;
    const anchor = this.resolveContextDeskCollectionSources(collection)[0];
    this.setState({
      contextInspectorCollection: collection,
      contextInspectorCursor: anchor === undefined ? -1 : 0,
      ...this.resolveExpansionIdentityReset(previousId, anchor?.id),
    });
  }

  /**
   * Move the selection inside the active collection. The cursor is an index
   * into the collection the sources pane is actually drawing, so row N of the
   * rendered list is always cursor N; `all` makes that the full grouped list,
   * which is the pre-desk behaviour.
   *
   * `unselectedTarget` is the row this key enters the list on when nothing is
   * selected yet — the state a desk lands in when a refresh brings rows in
   * behind an empty collection. `-1` is "nothing selected", not "row zero", so
   * it is resolved here instead of being clamped into `resolveIndex`: that
   * would spend the key travelling *out of* row 0 and skip the row the user
   * was aiming for. A cursor that already points at a row keeps the caller's
   * own wrap or clamp.
   */
  private moveContextDeskSelection(
    resolveIndex: (index: number, length: number) => number,
    unselectedTarget: "first" | "last",
  ): void {
    const sources = this.resolveContextDeskCollectionSources(
      this.state.contextInspectorCollection,
    );
    if (sources.length === 0) {
      if (this.state.contextInspectorCursor !== -1) {
        this.setState({ contextInspectorCursor: -1 });
      }
      return;
    }
    const previousId = this.resolveInspectorSourceAtCursor()?.id;
    const current = this.state.contextInspectorCursor;
    const next = current < 0
      ? (unselectedTarget === "first" ? 0 : sources.length - 1)
      : resolveIndex(current >= sources.length ? 0 : current, sources.length);
    if (next !== current) {
      this.setState({
        contextInspectorCursor: next,
        ...this.resolveExpansionIdentityReset(previousId, sources[next]?.id),
      });
    }
  }

  /**
   * Scroll the selected preview or expanded detail by `step` physical lines.
   * Expanded details use the same formatter, wrapping width, and row budget as
   * the renderer, so the engine's bottom clamp is the first marker-free page.
   */
  private scrollContextDeskPreview(step: number): void {
    const selected = this.resolveInspectorSourceAtCursor();
    if (selected === undefined) {
      return;
    }
    const expanded = this.state.contextInspectorExpanded === selected.id;
    let maxOffset: number;
    if (expanded) {
      const frameWidth = Math.max(32, this.state.terminalColumns - 4);
      const detailWidth = Math.max(24, frameWidth - 4);
      const receiptRows = this.state.contextActionReceipt === undefined ? 0 : 1;
      const maxRows = Math.max(
        1,
        computeContextOverlayViewportMaxRows({
          ...(this.state.terminalRows === undefined
            ? {}
            : { terminalRows: this.state.terminalRows }),
        }) - 1 - receiptRows,
      );
      maxOffset = resolveWorkShellContextDetailLayout({
        item: selected.item,
        ...(this.state.contextInspectorDetailContent === undefined
          ? {}
          : { content: this.state.contextInspectorDetailContent }),
        width: detailWidth,
        maxRows,
      }).maxOffset;
    } else {
      const body = selected.detail;
      const newlineCount = body.split("\n").length;
      const contentWidth = Math.max(24, this.state.terminalColumns - 4);
      const previewWidth = this.state.terminalColumns >= 96
        ? Math.min(58, Math.max(44, Math.floor(this.state.terminalColumns * 0.4) + 2)) - 2
        : this.state.terminalColumns >= 76
          ? Math.floor(contentWidth * 0.46) - 2
          : contentWidth;
      maxOffset = newlineCount > 1
        ? newlineCount - 1
        : Math.max(0, wrapDisplayTextFast(body, previewWidth).length - 1);
    }
    const offset = Math.min(
      maxOffset,
      Math.max(0, this.state.contextInspectorDetailOffset + step),
    );
    if (offset !== this.state.contextInspectorDetailOffset) {
      this.setState({ contextInspectorDetailOffset: offset });
    }
  }

  /**
   * The expansion, its resolved body and its scroll offset all belong to one
   * source id, so every move that can re-resolve the selection funnels through
   * here. Returns the patch that retires them when the row under the cursor
   * changed, and `undefined` when the same source is still selected — which is
   * what lets an expansion survive a reorder that keeps it in view.
   */
  private resolveExpansionIdentityReset(
    previousSourceId: string | undefined,
    nextSourceId: string | undefined,
  ): Partial<WorkShellEngineState<Reasoning>> | undefined {
    if (previousSourceId !== undefined && previousSourceId === nextSourceId) {
      return undefined;
    }
    return {
      contextInspectorExpanded: null,
      contextInspectorDetailContent: undefined,
      contextInspectorDetailOffset: 0,
    };
  }

  /**
   * The rows of one desk collection, in the same order the full source list
   * uses. `all` is every row, the DELIVERY pair splits on stage, and every
   * other collection is a group filter.
   */
  private resolveContextDeskCollectionSources(
    collection: ContextDeskCollection,
    packet: ContextPacketView | undefined = this.state.contextPacket,
  ): readonly InspectorSource[] {
    const sources = this.resolveInspectorSourceList(packet);
    switch (collection) {
      case "all":
        return sources;
      case "sent":
        return sources.filter((source) => !source.heldBack);
      case "held":
        return sources.filter((source) => source.heldBack);
      default:
        return sources.filter((source) => source.group === collection);
    }
  }

  /**
   * Context Inspector (Sprint 2) — toggle pin/unpin on the source under the
   * cursor. Pin sets salience to 1.0 (always include); unpin restores 0.5.
   * After the SQL write we re-select from the store and re-render so the
   * overlay reflects the new ranking immediately.
   *
   * A source that does not advertise the action the desk would show is left
   * untouched: the key the user pressed is not offered for that row.
   */
  async toggleContextInspectorPin(): Promise<void> {
    return this.enqueueContextSourceMutation(() => this.toggleContextInspectorPinImpl());
  }

  /**
   * Context Inspector (Sprint 2) — forget the source under the cursor
   * (included_in_model = 0). The source moves to the "Held back" section.
   */
  async forgetContextSourceAtCursor(): Promise<void> {
    return this.enqueueContextSourceMutation(() => this.forgetContextSourceAtCursorImpl());
  }

  /**
   * Context Inspector (Sprint 2) — re-include a held-back source
   * (included_in_model = 1). The source moves back into "Included".
   */
  async includeContextSourceAtCursor(): Promise<void> {
    return this.enqueueContextSourceMutation(() => this.includeContextSourceAtCursorImpl());
  }

  async undoLastContextSourceAction(): Promise<void> {
    return this.enqueueContextSourceMutation(() => this.undoLastContextSourceActionImpl());
  }

  private enqueueContextSourceMutation(operation: () => Promise<void>): Promise<void> {
    const result = this.contextSourceMutationQueue.then(operation);
    this.contextSourceMutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async toggleContextInspectorPinImpl(): Promise<void> {
    const source = this.resolveInspectorSourceAtCursor();
    if (!source || !this.mutateContextSource) {
      return;
    }
    const kind = source.pinned ? "unpin" : "pin";
    if (source.actions !== undefined && !source.actions.includes(kind)) {
      return;
    }
    await this.mutateInspectorContextSource({ kind, id: source.id });
  }

  private async forgetContextSourceAtCursorImpl(): Promise<void> {
    const source = this.resolveInspectorSourceAtCursor();
    if (!source || !this.mutateContextSource) {
      return;
    }
    if (source.actions !== undefined && !source.actions.includes("hold-back")) {
      return;
    }
    await this.mutateInspectorContextSource({ kind: "forget", id: source.id });
  }

  private async includeContextSourceAtCursorImpl(): Promise<void> {
    const source = this.resolveInspectorSourceAtCursor();
    if (!source || !this.mutateContextSource) {
      return;
    }
    if (source.actions !== undefined && !source.actions.includes("include")) {
      return;
    }
    await this.mutateInspectorContextSource({ kind: "include", id: source.id });
  }

  private async undoLastContextSourceActionImpl(): Promise<void> {
    if (!this.undoContextSourceAction || !this.state.contextActionReceipt?.canUndo) {
      return;
    }
    const beforePacketId = this.state.contextPacket?.id;
    const previousSourceId = this.resolveInspectorSourceAtCursor()?.id;
    const receipt = this.undoContextSourceAction();
    if (!receipt) {
      return;
    }
    const packet = await this.refreshContextPacket(true);
    this.captureContextPacketPreview(packet);
    const remappedCursor = this.resolveInspectorCursorForSourceId(receipt.sourceId);
    const remappedSourceId = this.resolveContextDeskCollectionSources(
      this.state.contextInspectorCollection,
    )[remappedCursor]?.id;
    this.setState({
      contextActionReceipt: {
        ...receipt,
        ...(beforePacketId !== undefined ? { beforePacketId } : {}),
        ...(packet !== undefined ? { afterPacketId: packet.id } : {}),
      },
      contextInspectorCursor: remappedCursor,
      ...this.resolveExpansionIdentityReset(previousSourceId, remappedSourceId),
    });
  }

  private canApplyContextSuggestion(suggestion: ContextPolicySuggestion): boolean {
    if (suggestion.action === "keep") {
      return true;
    }
    const packet = this.state.contextPacket;
    const source = packet?.included.find((item) => item.id === suggestion.sourceId)
      ?? packet?.excluded.find((item) => item.id === suggestion.sourceId);
    if (!source) {
      return false;
    }
    if (source.actions === undefined) {
      return true;
    }
    const requiredAction = suggestion.action === "hold-back" ? "hold-back" : "refresh";
    return source.actions.includes(requiredAction);
  }

  /**
   * Apply one piece of advice. The effect runs first and the `accepted`
   * resolution is persisted only once it lands, so a failed hold-back /
   * refresh / summarize leaves the advice `proposed` and retryable behind the
   * bounded unavailable line. Only one acceptance may be in flight: applying
   * advice rewrites the packet every other proposal was measured against.
   */
  async acceptContextSuggestion(suggestionId: string): Promise<void> {
    const resolveContextSuggestion = this.resolveContextSuggestion;
    const suggestion = this.state.contextPolicySuggestions.find(
      (candidate) => candidate.id === suggestionId && candidate.status === "proposed",
    );
    if (!suggestion || !resolveContextSuggestion || this.contextSuggestionAcceptanceInFlight) {
      return;
    }
    if (!this.canApplyContextSuggestion(suggestion)) {
      this.setState({
        contextAdviceUnavailable: "This suggestion is not available for the selected source.",
      });
      return;
    }
    this.contextSuggestionAcceptanceInFlight = true;
    try {
      switch (suggestion.action) {
        case "keep":
          break;
        case "hold-back":
          if (!this.mutateContextSource) {
            throw new Error("Context source mutation is unavailable.");
          }
          await this.mutateInspectorContextSource({
            kind: "forget",
            id: suggestion.sourceId,
          });
          break;
        case "refresh": {
          const packet = await this.refreshContextPacket(true);
          this.captureContextPacketPreview(packet);
          break;
        }
        case "summarize": {
          if (!this.refreshCondensedHistory) {
            throw new Error("Condensed history refresh is unavailable.");
          }
          await this.refreshCondensedHistory();
          const packet = await this.refreshContextPacket(true);
          this.captureContextPacketPreview(packet);
          break;
        }
      }
      const resolved = resolveContextSuggestion(suggestion.id, "accepted");
      this.setState({
        contextPolicySuggestions: this.state.contextPolicySuggestions.map((candidate) =>
          candidate.id === resolved.id ? resolved : candidate
        ),
        contextAdviceUnavailable: undefined,
      });
      if (suggestion.action !== "keep") {
        const retired = this.invalidateProposedContextSuggestions(
          suggestion.packetReceiptId,
        );
        if (!retired) {
          throw new Error("Context suggestion retirement is unavailable.");
        }
      }
    } catch {
      this.setState({
        contextAdviceUnavailable: "Context optimizer unavailable; reply kept.",
      });
    } finally {
      this.contextSuggestionAcceptanceInFlight = false;
    }
  }

  async rejectContextSuggestion(suggestionId: string): Promise<void> {
    const suggestion = this.state.contextPolicySuggestions.find(
      (candidate) => candidate.id === suggestionId && candidate.status === "proposed",
    );
    if (!suggestion || !this.resolveContextSuggestion) {
      return;
    }
    try {
      const resolved = this.resolveContextSuggestion(suggestion.id, "rejected");
      this.setState({
        contextPolicySuggestions: this.state.contextPolicySuggestions.map((candidate) =>
          candidate.id === resolved.id ? resolved : candidate
        ),
        contextAdviceUnavailable: undefined,
      });
    } catch {
      this.setState({
        contextAdviceUnavailable: "Context optimizer unavailable; reply kept.",
      });
    }
  }

  private invalidateProposedContextSuggestions(packetReceiptId: string): boolean {
    const resolvedAt = new Date().toISOString();
    this.setState({
      contextPolicySuggestions: this.state.contextPolicySuggestions.map((suggestion) =>
        suggestion.packetReceiptId === packetReceiptId && suggestion.status === "proposed"
          ? { ...suggestion, status: "stale", resolvedAt }
          : suggestion
      ),
    });
    if (!this.invalidateContextSuggestions) {
      return true;
    }
    this.pendingContextSuggestionInvalidations.add(packetReceiptId);
    return this.flushPendingContextSuggestionInvalidations(2);
  }

  private flushPendingContextSuggestionInvalidations(maxAttempts = 1): boolean {
    if (!this.invalidateContextSuggestions) {
      this.pendingContextSuggestionInvalidations.clear();
      return true;
    }
    for (
      let attempt = 0;
      attempt < maxAttempts && this.pendingContextSuggestionInvalidations.size > 0;
      attempt += 1
    ) {
      for (const receiptId of [...this.pendingContextSuggestionInvalidations]) {
        try {
          this.invalidateContextSuggestions(receiptId);
          this.pendingContextSuggestionInvalidations.delete(receiptId);
        } catch {
          // Keep the receipt pending for this bounded retry or the next ledger operation.
        }
      }
    }
    return this.pendingContextSuggestionInvalidations.size === 0;
  }

  private async mutateInspectorContextSource(action: {
    readonly kind: "pin" | "unpin" | "forget" | "include";
    readonly id: string;
  }): Promise<void> {
    if (!this.mutateContextSource) {
      return;
    }
    const beforePacketId = this.state.contextPacket?.id;
    const selectedSourceId = action.id;
    const previousSourceId = this.resolveInspectorSourceAtCursor()?.id;
    const receipt = this.mutateContextSource(action);
    const packet = await this.refreshContextPacket(true);
    this.captureContextPacketPreview(packet);
    const remappedCursor = this.resolveInspectorCursorForSourceId(selectedSourceId);
    // The cursor index can survive a mutation that moved a different row under
    // it — a hold-back drops the selected row out of a filtered collection and
    // the row below slides into the same slot — so identity, not the index,
    // decides whether the expansion travelled with the selection.
    const remappedSourceId = this.resolveContextDeskCollectionSources(
      this.state.contextInspectorCollection,
    )[remappedCursor]?.id;
    const expansionReset = this.resolveExpansionIdentityReset(previousSourceId, remappedSourceId);
    if (!receipt) {
      if (remappedCursor !== this.state.contextInspectorCursor || expansionReset !== undefined) {
        this.setState({ contextInspectorCursor: remappedCursor, ...expansionReset });
      }
      return;
    }
    this.setState({
      contextActionReceipt: {
        ...receipt,
        ...(beforePacketId !== undefined ? { beforePacketId } : {}),
        ...(packet !== undefined ? { afterPacketId: packet.id } : {}),
      },
      contextInspectorCursor: remappedCursor,
      ...expansionReset,
    });
  }

  /**
   * Keep the numeric cursor as compatibility output, but re-anchor it to the
   * same source id after include/hold refresh reorders the navigable list. The
   * search runs over the active collection because that is what the cursor
   * indexes; a hold-back that moves a row out of the focused collection falls
   * back to the nearest surviving row.
   */
  private resolveInspectorCursorForSourceId(
    sourceId: string | undefined,
    sources = this.resolveContextDeskCollectionSources(this.state.contextInspectorCollection),
    fallbackCursor = this.state.contextInspectorCursor,
  ): number {
    if (sources.length === 0) {
      return -1;
    }
    if (sourceId !== undefined) {
      const index = sources.findIndex((source) => source.id === sourceId);
      if (index >= 0) {
        return index;
      }
    }
    return fallbackCursor < 0 ? -1 : Math.min(fallbackCursor, sources.length - 1);
  }

  /**
   * Context Inspector (Sprint 2) — toggle expanded view for the source
   * under the cursor. Only one source expands at a time.
   */
  async toggleContextInspectorExpanded(): Promise<void> {
    const source = this.resolveInspectorSourceAtCursor();
    if (!source) {
      return;
    }
    if (source.actions !== undefined && !source.actions.includes("preview")) {
      return;
    }
    if (this.state.contextInspectorExpanded === source.id) {
      this.setState({
        contextInspectorExpanded: null,
        contextInspectorDetailContent: undefined,
        contextInspectorDetailOffset: 0,
      });
      return;
    }
    const content = await this.resolveContextSourceDetail?.(source.id);
    if (
      !this.state.contextInspectorOpen
      || this.resolveInspectorSourceAtCursor()?.id !== source.id
    ) {
      return;
    }
    this.setState({
      contextInspectorExpanded: source.id,
      contextInspectorDetailContent: content,
      contextInspectorDetailOffset: 0,
    });
  }

  /**
   * Scroll the preview body one line. This is the pane's own key, not the
   * expansion's: a collapsed row scrolls its preview text in place, so the
   * offset advances without the row ever becoming expanded. Inert while the
   * desk is closed.
   */
  moveContextInspectorDetailOffset(direction: number): void {
    if (!this.state.contextInspectorOpen) {
      return;
    }
    this.scrollContextDeskPreview(direction >= 0 ? 1 : -1);
  }

  /**
   * Build the navigable source list for the desk from the current context
   * packet. The desk renders every "In next request" row above the "Held back"
   * block, so stage decides the order first; within a stage rows follow the
   * canonical desk group order and then their packet index, which is exactly
   * the order the Groups pane advertises. Each entry carries its desk group
   * (so a collection is a filter, not a second grouping pass), a `pinned` flag
   * (salience === 1.0) for the pin toggle and cursor glyph, plus the
   * capability list that gates its mutations.
   */
  private resolveInspectorSourceList(
    packet: ContextPacketView | undefined = this.state.contextPacket,
  ): readonly InspectorSource[] {
    if (packet === this.cachedContextPacket) {
      return this.cachedInspectorSourceList;
    }
    if (!packet) {
      this.cachedContextPacket = undefined;
      this.cachedInspectorSourceList = [];
      return this.cachedInspectorSourceList;
    }
    const toEntry = (item: ContextPacketViewItem, heldBack: boolean, order: number) => ({
      id: item.id,
      label: item.label,
      category: item.category,
      group: item.group ?? resolveContextDeskGroup(item.category),
      item,
      detail: item.preview ?? item.label,
      pinned: (item.salience ?? 0) >= 1,
      heldBack: heldBack || item.includedInModel === false,
      ...(item.actions !== undefined ? { actions: item.actions } : {}),
      order,
    });
    const unsorted = [
      ...packet.included.map((item, index) => toEntry(item, false, index)),
      ...packet.excluded.map((item, index) => toEntry(item, true, packet.included.length + index)),
    ];
    this.cachedInspectorSourceList = unsorted
      .sort((left, right) => {
        if (left.heldBack !== right.heldBack) {
          return left.heldBack ? 1 : -1;
        }
        const groupOrder =
          (CONTEXT_DESK_GROUP_RANK.get(left.group) ?? CONTEXT_DESK_GROUPS.length)
          - (CONTEXT_DESK_GROUP_RANK.get(right.group) ?? CONTEXT_DESK_GROUPS.length);
        return groupOrder !== 0 ? groupOrder : left.order - right.order;
      })
      .map(({ order: _order, ...entry }) => entry);
    this.cachedContextPacket = packet;
    return this.cachedInspectorSourceList;
  }

  /**
   * The row the desk keys act on: the cursor indexes the collection the
   * sources pane is drawing. A closed desk has no selection at all, so every
   * mutation and the Enter/expand key go inert the moment the overlay hands
   * the keyboard back — even while a collapsed panel keeps the overlay's
   * title.
   */
  private resolveInspectorSourceAtCursor(): InspectorSource | undefined {
    if (!this.state.contextInspectorOpen) {
      return undefined;
    }
    const sources = this.resolveContextDeskCollectionSources(
      this.state.contextInspectorCollection,
    );
    const cursor = this.state.contextInspectorCursor;
    return cursor < 0 || cursor >= sources.length ? undefined : sources[cursor];
  }

  /** Marks a remotely accepted submit before its long execution leaves the owner admission lane. */
  admitRuntimeTurn(): void {
    this.admittedRuntimeTurns += 1;
  }

  interruptTurn(): boolean {
    if (!this.state.isBusy) {
      if (this.cancelledAdmittedRuntimeTurns < this.admittedRuntimeTurns) {
        this.cancelledAdmittedRuntimeTurns += 1;
        this.appendEntries({ role: "system", text: "Turn cancelled before it started." });
        return true;
      }
      this.appendEntries({ role: "system", text: "No active turn to interrupt." });
      return false;
    }
    const interruptedTurnEpoch = this.activeTurnEpoch;
    const interruptedIdleEpoch = interruptedTurnEpoch + 1;
    this.queueDrainSkipTurnEpochs.add(interruptedTurnEpoch);
    this.queueAutoDrainPaused = this.queuedCountCache > 0;
    this.activeTurnEpoch = interruptedIdleEpoch;
    this.pauseController.cancel();
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
      streamingReasoningText: undefined,
      queuePaused: this.queueAutoDrainPaused,
      ...(lastTurnDurationMs !== undefined ? { lastTurnDurationMs } : {}),
    });
    void this.persistSessionSnapshotForEpoch(interruptedIdleEpoch, "idle", "Turn interrupted.").catch(() => undefined);
    return true;
  }

  private consumeRuntimeTurnAdmission(): boolean {
    if (this.admittedRuntimeTurns === 0) return true;
    this.admittedRuntimeTurns -= 1;
    if (this.cancelledAdmittedRuntimeTurns === 0) return true;
    this.cancelledAdmittedRuntimeTurns -= 1;
    return false;
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

  /**
   * Ctrl+O changes only the presentation of retained tool history. It shares
   * `/minimal` and `/verbose`'s one durable traceMode field, but deliberately
   * emits no synthetic transcript entries and opens no panel.
   */
  async toggleToolHistoryDisplay(): Promise<void> {
    const traceMode: WorkShellTraceMode = this.state.traceMode === "verbose"
      ? "minimal"
      : "verbose";
    this.setState(createWorkShellTraceModePatch({
      state: this.state,
      traceMode,
      contextSummaryLines: this.currentContextSummaryLines,
      buildContextPanel: this.buildContextPanel,
    }));
    await this.persistSessionSnapshot("idle", this.lastSessionSummary, traceMode).catch(() => undefined);
  }

  private applyMode(mode: string): void {
    this.options = { ...this.options, mode };
    this.agent.updateMode?.(mode);
    this.setState({ mode });
  }

  private clearResumedPendingDecision(): void {
    if (!this.state.agentConsole.pendingDecision) {
      return;
    }
    const { pendingDecision: _pendingDecision, ...consoleWithoutDecision } = this.state.agentConsole;
    this.setState({
      agentConsole: createAgentConsoleSnapshot(consoleWithoutDecision),
    });
    this.appendEntries({
      role: "system",
      text: "A pending decision from the previous session could not be resumed. Re-run the request if it is still needed.",
    });
  }

  private openDecision(
    request: AskUserQuestionRequest,
    signal?: AbortSignal | undefined,
  ): Promise<AskUserQuestionResult> {
    if (signal?.aborted) {
      return Promise.resolve({ status: "cancelled" });
    }
    if (this.pendingDecision) {
      return Promise.resolve({
        status: "unavailable",
        reason: "A Work Shell decision is already pending.",
      });
    }

    const normalizedRequest: AskUserQuestionRequest = {
      ...request,
      kind: request.kind === "security-approval" ? "security-approval" : "user-decision",
    };

    const { promise, resolve } = createPromiseResolvers<AskUserQuestionResult>();
    let onAbort: () => void = () => {};
    const pending: PendingDecision = {
      request: normalizedRequest,
      settle: (result) => {
        if (this.pendingDecision !== pending) {
          return;
        }
        signal?.removeEventListener("abort", onAbort);
        this.pendingDecision = undefined;
        const { pendingDecision: _pendingDecision, ...consoleWithoutDecision } = this.state.agentConsole;
        this.setState({
          agentConsole: createAgentConsoleSnapshot(consoleWithoutDecision),
          panel: this.buildContextPanel(
            this.currentContextSummaryLines,
            this.state.bridgeLines,
            this.state.memoryLines,
            this.state.traceLines,
          ),
        });
        resolve(result);
        void this.persistSessionSnapshot(
          "running",
          result.status === "answered" ? "Decision answered." : "Decision cancelled.",
        ).catch(() => undefined);
      },
    };
    onAbort = () => pending.settle({ status: "cancelled" });
    this.pendingDecision = pending;
    signal?.addEventListener("abort", onAbort, { once: true });
    this.setState({
      agentConsole: createAgentConsoleSnapshot({
        ...this.state.agentConsole,
        pendingDecision: normalizedRequest,
      }),
      panel: {
        title: "Decision",
        lines: formatWorkShellDecisionLines(normalizedRequest),
      },
    });
    void this.persistSessionSnapshot(
      "requires_action",
      `Decision required: ${normalizedRequest.title?.trim() || normalizedRequest.id}`,
    ).catch(() => undefined);
    return promise;
  }

  private handlePendingDecisionReply(value: string): void {
    const pending = this.pendingDecision;
    if (!pending) {
      return;
    }
    const reply = resolveWorkShellDecisionReply({
      request: pending.request,
      value,
    });
    if (reply.kind === "cancelled") {
      pending.settle({ status: "cancelled" });
      return;
    }
    if (reply.kind === "answered") {
      pending.settle(reply.result);
      return;
    }
    this.setState({
      panel: {
        title: "Decision",
        lines: [...formatWorkShellDecisionLines(pending.request), `Input needed · ${reply.message}`],
      },
    });
  }

  /**
   * One-key reply for the decision bar. `handlePendingDecisionReply` is void,
   * so the range is validated up front: a pending decision with exactly one
   * question and an in-range option index settles through the same reply
   * path as a typed line, everything else is a no-op that keeps the decision
   * pending (multi-question requests need typed `id: n` answers).
   */
  answerPendingDecisionByIndex(index: number): boolean {
    const pending = this.pendingDecision;
    const question = pending?.request.questions.length === 1
      ? pending.request.questions[0]
      : undefined;
    if (!pending || !question) {
      return false;
    }
    if (!Number.isSafeInteger(index) || index < 1 || index > question.options.length) {
      return false;
    }
    this.handlePendingDecisionReply(String(index));
    return true;
  }

  /** Esc on the decision bar: `/cancel` through the same settle guard. */
  /** Settle one exact user decision without routing structured answers through chat input. */
  answerPendingUserDecision(
    decisionId: string,
    answers: readonly AskUserQuestionAnswer[],
  ): boolean {
    const pending = this.pendingDecision;
    if (!pending || pending.request.kind !== "user-decision") return false;
    const result = resolveWorkShellDecisionAnswers({ request: pending.request, decisionId, answers });
    if (!result) return false;
    pending.settle(result);
    return true;
  }

  cancelPendingDecision(): boolean {
    if (!this.pendingDecision) {
      return false;
    }
    this.handlePendingDecisionReply("/cancel");
    return true;
  }

  private settlePendingDecision(result: AskUserQuestionResult): void {
    this.pendingDecision?.settle(result);
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
    if (!this.consumeRuntimeTurnAdmission()) return;
    // The steer composer owns the whole submit: an empty line still leaves the
    // mode rather than falling through into the chat router.
    if (this.state.composerMode === "agent-steer") {
      await this.submitAgentSteer(value);
      return;
    }
    const line = value.trim();
    if (!line) {
      return;
    }
    if (this.pendingDecision) {
      // A pending decision must not lock the operator out of the console. Rust
      // stays the authority on what a slash line means mid-turn, so the line is
      // classified once here; only `open_agent_console` is handled early, and
      // every other action — including ordinary answers — falls through to the
      // decision untouched.
      //
      // Classification is a console convenience, never a gate on answering. If
      // it fails, the operator still gets their answer through: dropping the
      // line here would strand the run behind a question nothing can settle,
      // and the console command that failed was never the point of the line.
      let decision: BusySubmitDecision | undefined;
      try {
        decision = await this.resolveBusySubmitDecision(line);
      } catch {
        this.appendEntries({
          role: "system",
          text: this.formatWorkShellError(
            "Console commands are unavailable. This line was read as an answer to the pending decision.",
          ),
        });
      }
      if (decision?.action === "open_agent_console") {
        this.openAgentConsole(decision.tab);
        return;
      }
      this.handlePendingDecisionReply(line);
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

    if (route.kind === "chat" && !route.line.startsWith("!")) {
      this.lockUiLocaleFromFirstUserProse(route.line);
    } else if (route.kind === "prompt-command") {
      this.lockUiLocaleFromFirstUserProse(route.promptCommand.focus ?? "");
    }

    // Submitting a turn retires the Context Desk right away: the review is
    // over, so the desk yields the conversation space through the same close
    // path Esc uses. Scoped to operator-initiated turn starts — builtin
    // panels such as /reload keep the desk open, and queued replays never
    // touch it. The ledger guard matters: without a ledger an unforced packet
    // refresh reuses the packet the desk is showing only while the desk-open
    // flag is still up, so those engines close the desk after preparation
    // (below) instead and keep the previewed-packet reuse contract intact.
    if (
      !this.drainingQueue
      && (route.kind === "chat" || route.kind === "prompt-command")
      && this.hasContextLifecycleLedger()
    ) {
      this.closeOverlay();
    }

    const turnEpoch = route.kind === "chat" || route.kind === "prompt-command"
      ? this.activeTurnEpoch + 1
      : this.activeTurnEpoch;
    this.activeTurnEpoch = turnEpoch;

    const execution = this.executeSubmitRoute(route, pendingAttachments, turnEpoch);
    this.activeTurnSettlements.add(execution);
    try {
      await execution;
    } finally {
      this.activeTurnSettlements.delete(execution);
    }
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
        const turnId = `turn-${this.sessionId}-${turnEpoch}`;
        this.pauseController.beginTurn(turnId);
        try {
          const prepared = await this.prepareProviderContext(turnId, isCurrentTurn);
          if (prepared === "blocked") {
            this.pauseQueueAfterProofBlock(turnEpoch);
            return;
          }
          if (!isCurrentTurn()) {
            this.queueDrainSkipTurnEpochs.add(turnEpoch);
            return;
          }
          const contextPacket = prepared.packet;
          const contextReceipt = prepared.receipt;
          // Starting a turn collapses the context panel, so the desk is no
          // longer on screen and must stop owning the keyboard with it.
          this.setState({
            panel: this.buildContextPanel(
              this.currentContextSummaryLines,
              this.state.bridgeLines,
              this.state.memoryLines,
              this.state.traceLines,
            ),
            contextInspectorOpen: false,
            contextInspectorCursor: -1,
            contextInspectorExpanded: null,
            contextInspectorDetailContent: undefined,
            contextInspectorDetailOffset: 0,
          });
          const executionResult = await executeWorkShellPromptCommandSubmit({
            transcriptText: route.line,
            promptCommand: route.promptCommand,
            state: this.state,
            options: this.options,
            sessionId: this.sessionId,
            buildStatusPanel: this.buildStatusPanel,
            autoContinueOnPermissionStall: this.options.autoContinueOnPermissionStall,
            runAgentTurn: (prompt: string, attachments?: readonly Attachment[]) => this.runAgentTurnAtPauseBoundary({
              turnEpoch,
              prompt: contextPacket
                ? this.composeProviderPrompt(contextPacket, prompt)
                : this.decorateProviderPrompt(prompt),
              classificationPrompt: prompt,
              attachments,
              signal: abortController.signal,
            }),
            isTurnActive: isCurrentTurn,
            publishContextBridge: this.publishContextBridge,
            writeScopedMemory: this.writeScopedMemory,
            listScopedMemoryLines: this.listScopedMemoryLines,
            ...(this.memoryLineage !== undefined ? { memoryLineage: this.memoryLineage } : {}),
            ...(this.promoteScopedMemory !== undefined
              ? { promoteScopedMemory: this.promoteScopedMemory }
              : {}),
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
            turnId,
            ...(contextReceipt !== undefined ? { contextReceipt } : {}),
          });
          if (
            executionResult.completed
            && executionResult.replyPersisted
            && contextPacket
            && contextReceipt
            && isCurrentTurn()
          ) {
            // Context advice is deliberately supersedable by the next user
            // turn. Finish the durable provider turn before awaiting it so a
            // second turn never inherits the previous cooperative lifecycle.
            await this.finishCooperativeTurn(turnEpoch);
            await this.refreshContextAdvice(
              contextReceipt,
              contextPacket,
              isCurrentTurn,
            );
          }
        } finally {
          await this.finishCooperativeTurn(turnEpoch);
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
        const turnId = `turn-${this.sessionId}-${turnEpoch}`;
        this.pauseController.beginTurn(turnId);
        try {
          const preflight = await resolveWorkShellChatPreflight({
            line: route.line,
            cwd: this.options.cwd,
            mode: this.options.mode,
            resolveComposerInput: this.resolveComposerInput,
            ...(pendingAttachments && pendingAttachments.length > 0
              ? { pendingAttachments }
              : {}),
          });
          if (!isCurrentTurn()) {
            this.queueDrainSkipTurnEpochs.add(turnEpoch);
            return;
          }

          let contextPacket: ContextPacketView | undefined;
          let contextReceipt: ContextPacketReceipt | undefined;
          if (!preflight.readOnlyGuard) {
            const prepared = await this.prepareProviderContext(turnId, isCurrentTurn);
            if (prepared === "blocked") {
              this.pauseQueueAfterProofBlock(turnEpoch);
              return;
            }
            if (!isCurrentTurn()) {
              this.queueDrainSkipTurnEpochs.add(turnEpoch);
              return;
            }
            contextPacket = prepared.packet;
            contextReceipt = prepared.receipt;
          }
          // Starting a turn collapses the context panel, so the desk is no
          // longer on screen and must stop owning the keyboard with it.
          this.setState({
            panel: this.buildContextPanel(
              this.currentContextSummaryLines,
              this.state.bridgeLines,
              this.state.memoryLines,
              this.state.traceLines,
            ),
            contextInspectorOpen: false,
            contextInspectorCursor: -1,
            contextInspectorExpanded: null,
            contextInspectorDetailContent: undefined,
            contextInspectorDetailOffset: 0,
          });
          const executionResult = await executeWorkShellChatSubmit({
            line: route.line,
            resolveComposerInput: this.resolveComposerInput,
            ...(pendingAttachments && pendingAttachments.length > 0
              ? { pendingAttachments }
              : {}),
            preflight,
            state: this.state,
            options: this.options,
            sessionId: this.sessionId,
            buildStatusPanel: this.buildStatusPanel,
            autoContinueOnPermissionStall: this.options.autoContinueOnPermissionStall,
            runAgentTurn: (prompt: string, attachments?: readonly Attachment[]) => this.runAgentTurnAtPauseBoundary({
              turnEpoch,
              prompt: contextPacket
                ? this.composeProviderPrompt(contextPacket, prompt)
                : this.decorateProviderPrompt(prompt),
              classificationPrompt: prompt,
              attachments,
              signal: abortController.signal,
            }),
            isTurnActive: isCurrentTurn,
            publishContextBridge: this.publishContextBridge,
            writeScopedMemory: this.writeScopedMemory,
            listScopedMemoryLines: this.listScopedMemoryLines,
            ...(this.memoryLineage !== undefined ? { memoryLineage: this.memoryLineage } : {}),
            ...(this.promoteScopedMemory !== undefined
              ? { promoteScopedMemory: this.promoteScopedMemory }
              : {}),
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
            turnId,
            ...(contextReceipt !== undefined ? { contextReceipt } : {}),
          });
          if (
            executionResult.completed
            && executionResult.replyPersisted
            && contextPacket
            && contextReceipt
            && isCurrentTurn()
          ) {
            // Context advice is deliberately supersedable by the next user
            // turn. Finish the durable provider turn before awaiting it so a
            // second turn never inherits the previous cooperative lifecycle.
            await this.finishCooperativeTurn(turnEpoch);
            await this.refreshContextAdvice(
              contextReceipt,
              contextPacket,
              isCurrentTurn,
            );
          }
        } finally {
          await this.finishCooperativeTurn(turnEpoch);
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
      // Console access is read-only over the running turn: open it now, never
      // queue it, and leave the transcript alone.
      case "open_agent_console":
        this.openAgentConsole(decision.tab);
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
        const next = (await this.listQueuedSubmits())[0];
        const step = await this.resolveQueueDrainStepDecision(next);
        if (step.action === "empty") {
          this.setQueuedCount(step.queuedCount);
          break;
        }
        this.setQueuedCount(step.queuedCount);
        const pendingAttachments = this.queuedAttachments.get(step.item.id);
        this.appendEntries({ role: "system", text: step.message });
        await this.handleSubmit(step.item.line, pendingAttachments);
        if (this.queueAutoDrainPaused) {
          this.setQueuedCount(await this.loadQueuedSubmitCount());
          break;
        }
        const popped = await this.popQueuedSubmit();
        if (!popped || popped.id !== step.item.id) {
          throw new Error("Rust queue changed while a queued turn was running.");
        }
        this.queuedAttachments.delete(step.item.id);
      }
    } finally {
      this.drainingQueue = false;
    }
  }

  private pauseQueueAfterProofBlock(turnEpoch: number): void {
    this.queueDrainSkipTurnEpochs.add(turnEpoch);
    if (this.drainingQueue || this.queuedCountCache > 0) {
      this.queueAutoDrainPaused = true;
      this.setState({ queuePaused: true });
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
      openAgentConsole: (tab) => this.openAgentConsole(tab),
      reloadContextState: () => this.reloadContextState(),
      refreshContextPacket: async () => {
        const packet = await this.refreshContextPacket(true);
        this.captureContextPacketPreview(packet);
        return packet;
      },
      queuedCount: () => this.queuedCountCache,
      queuedItems: async () => {
        const queuedItems = await this.listQueuedSubmits();
        this.workBoardQueuedItemsSnapshot = queuedItems;
        return queuedItems;
      },
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
    if (builtinCommand.kind !== "context") {
      return;
    }
    // `/context` is the desk's only entry point, so it hands the keyboard over
    // and restores the default focus: the sources pane over the all-sources
    // collection. Without a resolved packet there is no desk to open — the
    // builtin fell back to the collapsed context panel — so the flag stays
    // down and every desk key remains inert.
    this.setState({
      contextInspectorOpen: this.state.contextPacket !== undefined,
      contextInspectorPane: "sources",
      contextInspectorCollection: "all",
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

  /**
   * Build the durable checkpoint payload from the live shell state. Shared by
   * the turn lifecycle and the console's own coalesced writes so both persist
   * the same reasoning override, receipt pointer, and console projection.
   */
  private buildSessionSnapshotInput(input: {
    readonly state: WorkShellSessionState;
    readonly summary: string;
    readonly traceMode: WorkShellTraceMode;
    readonly pauseCheckpoint?: WorkShellDurablePauseCheckpoint | undefined;
    readonly ownerMutationRevision?: number | undefined;
  }): WorkShellSessionSnapshotInput {
    const overrideReasoningEffort =
      this.state.reasoning.support.status === "supported" &&
      this.state.reasoning.source === "override" &&
      (this.state.reasoning.effort === "low" ||
        this.state.reasoning.effort === "medium" ||
        this.state.reasoning.effort === "high")
        ? this.state.reasoning.effort
        : undefined;
    return createWorkShellSessionSnapshotInput({
      cwd: this.options.cwd,
      sessionId: this.sessionId,
      model: this.state.model,
      mode: this.state.mode,
      state: input.state,
      summary: input.summary,
      traceMode: input.traceMode,
      uiLocale: this.state.uiLocale,
      reasoningEffort: overrideReasoningEffort,
      lastSubmittedContextReceiptId: this.lastSubmittedContextReceiptId,
      ownerMutationRevision: input.ownerMutationRevision ?? this.runtimeRevisionClock?.value,
      entries: this.state.entries,
      agentConsole: this.state.agentConsole,
      ...(input.pauseCheckpoint ? { pauseCheckpoint: input.pauseCheckpoint } : {}),
    });
  }

  private async persistSessionSnapshot(
    state: WorkShellSessionState,
    summary: string,
    traceMode = this.state.traceMode,
  ): Promise<void> {
    this.lastSessionSummary = summary;
    if (state === "idle") {
      this.lastCompletedTurnSnapshot = resolveLastCompletedTurn(this.state.entries);
    }
    await this.enqueueSessionSnapshotWrite(
      this.buildSessionSnapshotInput({ state, summary, traceMode }),
    );
  }

  /**
   * Every durable checkpoint goes through one ordered queue. A snapshot
   * describes a point in time, so letting an older in-flight write finish after
   * a newer one would roll durable session state backwards. The rejection stays
   * caller-visible (turn code still reports `replyPersisted: false`) while the
   * queue itself absorbs it and stays usable for the next write.
   */
  private enqueueSessionSnapshotWrite(input: WorkShellSessionSnapshotInput): Promise<void> {
    const write = this.sessionSnapshotWriteQueue.then(
      () => this.persistWorkShellSessionSnapshot(input),
    );
    this.sessionSnapshotWriteQueue = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  private async persistSessionSnapshotForEpoch(
    turnEpoch: number,
    state: WorkShellSessionState,
    summary: string,
    traceMode = this.state.traceMode,
  ): Promise<void> {
    if (turnEpoch !== this.activeTurnEpoch) {
      return;
    }
    await this.persistSessionSnapshot(state, summary, traceMode);
  }

  private pauseCheckpointForEpoch(
    turnEpoch: number,
    boundary: WorkShellPauseBoundary,
  ): Promise<void> {
    if (turnEpoch !== this.activeTurnEpoch) return Promise.resolve();
    const lifecycle = this.pauseController.snapshot();
    const turnId = lifecycle.turnId;
    if (!turnId) return Promise.reject(new Error("Pause checkpoint lost the active turn identity."));
    const console = this.state.agentConsole;
    const graph = console.workGraph;
    const activeNode = graph?.nodes.find((node) => node.status === "running" || node.status === "requires_action");
    const artifactRefs = [...new Set([
      ...(activeNode?.artifactRefs ?? []),
      ...(graph?.nodes.flatMap((node) => node.artifactRefs) ?? []),
    ])].filter((ref) => ref.trim().length > 0).slice(0, 64);
    const pauseCheckpoint: WorkShellDurablePauseCheckpoint = {
      turnId,
      boundary,
      ...(activeNode ? { activeNode: { id: activeNode.id, attempt: activeNode.attempt } } : {}),
      ...(graph ? {
        currentStage: graph.currentStage,
        gateStatus: graph.gateStatus,
        iteration: graph.iteration,
      } : {}),
      ...(console.pendingDecision?.id ? { decisionId: console.pendingDecision.id } : {}),
      ...(this.lastSubmittedContextReceiptId ? { contextReceiptId: this.lastSubmittedContextReceiptId } : {}),
      attachmentRefs: this.activeAttachmentRefs,
      artifactRefs,
    };
    this.lastSessionSummary = `Turn paused at ${boundary}.`;
    return this.enqueueSessionSnapshotWrite(this.buildSessionSnapshotInput({
      state: "paused",
      summary: this.lastSessionSummary,
      traceMode: this.state.traceMode,
      pauseCheckpoint,
    }));
  }

  private executionPausePort(turnEpoch: number): ExecutionPausePort {
    const persist = (snapshot: WorkShellPauseSnapshot) => this.pauseCheckpointForEpoch(
      turnEpoch,
      snapshot.boundary ?? "before_completion",
    );
    return {
      checkpoint: (boundary) => this.pauseController.checkpoint(boundary, persist),
      runNonInterruptible: (operation, run) => this.pauseController.runNonInterruptible(
        operation,
        run,
        persist,
      ),
    };
  }

  private async runAgentTurnAtPauseBoundary(input: {
    readonly turnEpoch: number;
    readonly prompt: string;
    readonly classificationPrompt: string;
    readonly attachments?: readonly Attachment[] | undefined;
    readonly signal: AbortSignal;
  }): Promise<WorkAgentTurnResult> {
    this.activeAttachmentRefs = (input.attachments ?? []).map((attachment, index) => {
      const value = attachment as unknown as Record<string, unknown>;
      const label = [value.type, value.mimeType, value.displayName]
        .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
        .join(":");
      return (label || `attachment-${index + 1}`).slice(0, 256);
    }).slice(0, 32);
    const run = () => this.agent.runTurn(
      input.prompt,
      input.attachments,
      {
        signal: input.signal,
        classificationPrompt: input.classificationPrompt,
        pause: this.executionPausePort(input.turnEpoch),
      },
    );
    try {
      if (this.agent.supportsCooperativePause) return await run();
      return await this.pauseController.runNonInterruptible(
        "provider.request",
        run,
        (snapshot) => this.pauseCheckpointForEpoch(
          input.turnEpoch,
          snapshot.boundary ?? "after_provider",
        ),
      );
    } finally {
      this.activeAttachmentRefs = [];
    }
  }

  private async finishCooperativeTurn(turnEpoch: number): Promise<void> {
    if (turnEpoch !== this.activeTurnEpoch) return;
    await this.pauseController.checkpoint(
      "before_completion",
      () => this.pauseCheckpointForEpoch(turnEpoch, "before_completion"),
    );
    this.pauseController.complete();
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
    this.workBoardQueuedItemsSnapshot = [];
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
      ...(this.memoryLineage !== undefined ? { lineage: this.memoryLineage } : {}),
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
    await this.refreshContextPacket(true);
  }

  private resolveContextLifecycleProfile(): string {
    return this.options.contextProfile
      ?? this.state.agentConsole.profileId
      ?? "build";
  }

  private hasContextLifecycleLedger(): boolean {
    return this.previewContextPacket !== undefined
      && this.revalidateContextPacket !== undefined
      && this.submitContextPacketReceipt !== undefined;
  }

  /**
   * Mint (or reuse) the preview receipt for a candidate packet. The last
   * submitted receipt stays on state: it is the "before" side the Context
   * Desk compares the new preview against, and dropping it here blanked the
   * compare view every time the desk refreshed.
   */
  private captureContextPacketPreview(packet: ContextPacketView | undefined): void {
    if (!packet || !this.previewContextPacket) {
      return;
    }
    const receipt = this.previewContextPacket({
      sessionId: this.sessionId,
      packet,
      profile: this.resolveContextLifecycleProfile(),
    });
    const submittedReceipt = this.state.contextSubmittedReceipt;
    const packetChange = submittedReceipt && this.revalidateContextPacket
      ? this.revalidateContextPacket({
          sessionId: this.sessionId,
          preview: submittedReceipt,
          packet,
        })
      : undefined;
    this.setState({
      contextPreviewReceipt: receipt,
      contextPacketChange: packetChange,
    });
  }

  private reopenContextDesk(packet: ContextPacketView): void {
    this.setState({
      contextPacket: packet,
      contextIndicator: formatWorkShellContextPacketIndicator(packet),
      panel: {
        title: "Context expanded",
        lines: buildWorkShellContextPacketPreviewLines(packet),
      },
      contextInspectorOpen: true,
      contextInspectorPane: "sources",
      contextInspectorCollection: "all",
      contextInspectorCursor: 0,
      contextInspectorExpanded: null,
      contextInspectorDetailContent: undefined,
      contextInspectorDetailOffset: 0,
      ...(packet.manifest
        ? {
            agentConsole: {
              ...this.state.agentConsole,
              manifest: packet.manifest,
            },
          }
        : {}),
    });
  }

  /**
   * Resolve/revalidate the candidate packet and durably submit exactly one
   * preview receipt before any provider turn. Returns undefined when the
   * provider call must not start (meaning-change, ledger failure, or stale turn).
   */
  private async prepareSubmittedContext(
    turnId: string,
    isCurrentTurn: () => boolean,
  ): Promise<{
    readonly packet: ContextPacketView;
    readonly receipt: ContextPacketReceipt;
  } | undefined> {
    try {
      this.flushPendingContextSuggestionInvalidations(2);
      const packet = await this.refreshContextPacket(true, isCurrentTurn);
      if (!isCurrentTurn()) {
        return undefined;
      }
      if (!packet || !this.hasContextLifecycleLedger()) {
        throw new Error("Context lifecycle ledger is unavailable.");
      }

      let preview = this.state.contextPreviewReceipt;
      if (!preview) {
        this.captureContextPacketPreview(packet);
        preview = this.state.contextPreviewReceipt;
      }
      if (!preview) {
        throw new Error("Context preview receipt is unavailable.");
      }

      const change = this.revalidateContextPacket!({
        sessionId: this.sessionId,
        preview,
        packet,
      });
      if (!isCurrentTurn()) {
        return undefined;
      }
      this.setState({ contextPacketChange: change });
      if (change.kind === "meaning-change") {
        this.reopenContextDesk(packet);
        return undefined;
      }

      // Production CRP assigns a fresh packet ID per resolve. Revalidation may
      // accept an unchanged source set, but the durable submitted receipt must
      // still identify the exact candidate sent to the provider.
      if (preview.packetId !== packet.id) {
        this.captureContextPacketPreview(packet);
        preview = this.state.contextPreviewReceipt;
      }
      if (!preview || preview.packetId !== packet.id) {
        throw new Error("Context preview does not identify the provider packet.");
      }
      if (!isCurrentTurn()) {
        return undefined;
      }

      const receipt = this.submitContextPacketReceipt!({
        receiptId: preview.id,
        sessionId: this.sessionId,
        turnId,
      });
      if (
        receipt.id !== preview.id
        || receipt.packetId !== packet.id
        || receipt.sessionId !== this.sessionId
        || receipt.turnId !== turnId
        || receipt.state !== "submitted"
      ) {
        throw new Error("Submitted context receipt does not match the provider turn.");
      }
      if (!isCurrentTurn()) {
        return undefined;
      }
      this.lastSubmittedContextReceiptId = receipt.id;

      // The submitted receipt is one-shot. Clear the preview pointer without
      // performing another ledger write after durable submission; the next
      // turn will create or reuse its own candidate preview before submission.
      this.setState({
        contextPreviewReceipt: undefined,
        contextSubmittedReceipt: receipt,
      });
      const priorReceiptIds = new Set(
        this.state.contextPolicySuggestions
          .filter(
            (suggestion) =>
              suggestion.status === "proposed"
              && suggestion.packetReceiptId !== receipt.id,
          )
          .map((suggestion) => suggestion.packetReceiptId),
      );
      let priorAdviceRetired = true;
      for (const priorReceiptId of priorReceiptIds) {
        priorAdviceRetired =
          this.invalidateProposedContextSuggestions(priorReceiptId)
          && priorAdviceRetired;
      }
      if (!priorAdviceRetired) {
        this.setState({
          contextAdviceUnavailable: "Context optimizer unavailable; reply kept.",
        });
      }
      return { packet, receipt };
    } catch {
      if (!isCurrentTurn()) {
        return undefined;
      }
      this.setState({ contextPreviewReceipt: undefined });
      this.appendEntries({
        role: "system",
        text: this.formatWorkShellError("Context proof unavailable. The provider call was not started."),
      });
      return undefined;
    }
  }

  private async prepareProviderContext(
    turnId: string,
    isCurrentTurn: () => boolean,
  ): Promise<
    | {
      readonly packet: ContextPacketView | undefined;
      readonly receipt?: ContextPacketReceipt | undefined;
    }
    | "blocked"
  > {
    if (!this.hasContextLifecycleLedger()) {
      const packet = await this.refreshContextPacket(false, isCurrentTurn);
      if (!isCurrentTurn()) {
        return "blocked";
      }
      return { packet };
    }
    const prepared = await this.prepareSubmittedContext(turnId, isCurrentTurn);
    if (!prepared) {
      return "blocked";
    }
    if (!isCurrentTurn()) {
      return "blocked";
    }
    return prepared;
  }

  private async refreshContextAdvice(
    receipt: ContextPacketReceipt,
    packet: ContextPacketView,
    isCurrentTurn: () => boolean,
  ): Promise<void> {
    const generateContextSuggestions = this.generateContextSuggestions;
    if (!generateContextSuggestions) {
      return;
    }
    if (!this.flushPendingContextSuggestionInvalidations(2)) {
      if (isCurrentTurn()) {
        this.setState({
          contextAdviceUnavailable: "Context optimizer unavailable; reply kept.",
        });
      }
      return;
    }

    const result = await runWorkShellContextAdviceEffects(
      () => generateContextSuggestions({ receipt, packet }),
    );

    if (!isCurrentTurn()) {
      this.invalidateProposedContextSuggestions(receipt.id);
      return;
    }

    this.setState({
      contextPolicySuggestions: result.suggestions,
      contextAdviceUnavailable: result.unavailable,
    });
  }

  private composeProviderPrompt(packet: ContextPacketView, userPrompt: string): string {
    const providerPrompt = this.resolvePromptManifest
      ? this.resolvePromptManifest({ packet, userPrompt }).providerPrompt
      : composeWorkShellTurnPromptFromPacket({ packet, userPrompt });
    return this.decorateProviderPrompt(providerPrompt);
  }

  private decorateProviderPrompt(providerPrompt: string): string {
    return `${workShellLanguageInstruction(this.state.uiLocale)}\n\n${providerPrompt}`;
  }

  private lockUiLocaleFromFirstUserProse(value: string): void {
    if (this.state.uiLocaleLocked) return;
    const uiLocale = detectWorkShellUserLocale(value);
    if (uiLocale === undefined) return;
    this.setState({ uiLocale, uiLocaleLocked: true });
  }

  private async refreshContextPacket(
    forceRefresh = false,
    isCurrentTurn?: () => boolean,
  ): Promise<ContextPacketView | undefined> {
    // While the desk owns the keyboard the rows must not shift underfoot, so
    // an unforced refresh reuses the packet the desk is showing. The open flag
    // decides that, not the panel title: a collapsed panel may carry the same
    // title and must still refresh normally.
    if (
      !this.resolveContextPacket
      || (!forceRefresh && this.state.contextInspectorOpen && this.state.contextPacket)
    ) {
      return this.state.contextPacket;
    }
    const deskWasVisible = this.state.contextInspectorOpen;
    const previousSourceId = deskWasVisible
      ? this.resolveInspectorSourceAtCursor()?.id
      : undefined;
    const previousCursor = this.state.contextInspectorCursor;
    const packet = await this.resolveContextPacket({
      cwd: this.options.cwd,
      sessionId: this.sessionId,
      contextSummaryLines: this.currentContextSummaryLines,
      bridgeLines: this.state.bridgeLines,
      memoryLines: this.state.memoryLines,
      traceLines: this.state.traceLines,
      ...(this.state.agentConsole.workGraph ? { workGraph: this.state.agentConsole.workGraph } : {}),
    });
    if (isCurrentTurn && !isCurrentTurn()) {
      return undefined;
    }
    const deskVisible = deskWasVisible && this.state.contextInspectorOpen;
    const activeSources = deskVisible
      ? this.resolveContextDeskCollectionSources(this.state.contextInspectorCollection, packet)
      : undefined;
    const remappedCursor = activeSources === undefined
      ? undefined
      : this.resolveInspectorCursorForSourceId(previousSourceId, activeSources, previousCursor);
    const remappedSourceId = remappedCursor === undefined || activeSources === undefined
      ? undefined
      : activeSources[remappedCursor]?.id;
    this.setState({
      contextPacket: packet,
      contextIndicator: formatWorkShellContextPacketIndicator(packet),
      ...(remappedCursor !== undefined
        ? {
            contextInspectorCursor: remappedCursor,
            ...this.resolveExpansionIdentityReset(previousSourceId, remappedSourceId),
          }
        : {}),
      ...(packet.manifest
        ? {
            agentConsole: {
              ...this.state.agentConsole,
              manifest: packet.manifest,
            },
          }
        : {}),
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

  /**
   * Commit a patch without fanning out. The Agent Console stages every
   * lifecycle reduction this way so `getState()` and the control validations
   * see the newest projection while renders stay on the coalescing window.
   */
  private stageState(patch: Partial<WorkShellEngineState<Reasoning>>): void {
    this.state = { ...this.state, ...patch };
  }

  private setState(patch: Partial<WorkShellEngineState<Reasoning>>): void {
    this.stageState(patch);
    for (const subscriber of this.subscribers) {
      subscriber(this.state);
    }
  }
}
