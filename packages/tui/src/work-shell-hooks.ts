import { useInput, useStdin } from "ink";
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getWorkShellMessages,
  resolveAgentConsoleSelection,
  runRustCommandSync,
  type AgentConsoleViewState,
  type WorkShellComposerMode,
} from "@unclecode/orchestrator";
import type {
  AgentConsoleSnapshot,
  AgentConsoleTab,
  ContextDeskCollection,
  ContextDeskPane,
  ContextPacketChangeClassification,
  ContextPacketReceipt,
  ContextPacketView,
  ContextPacketViewActionReceipt,
  ContextPolicySuggestion,
} from "@unclecode/contracts";

import {
  createWorkShellDashboardHomePatch,
  createWorkShellDashboardHomeSyncState,
  shouldRefreshDashboardHomeState,
  type WorkShellDashboardHomeSyncState,
} from "./work-shell-dashboard-sync.js";
import type { TuiShellHomeState } from "./shell-state.js";
import {
  buildContextInspectorRows,
  filterContextDeskRows,
  resolveContextDeskSelectedRow,
} from "./work-shell-context-inspector-model.js";
import { resolveContextInspectorSourceCapabilities } from "./work-shell-context-inspector.js";
import { getSelectedVisibleContextPolicySuggestion } from "./work-shell-context-advice.js";
import { isRawComposerEmpty } from "./composer.js";
import {
  clampWorkShellSlashSelection,
  cycleWorkShellSlashSelection,
  resolveWorkShellActivePanel,
} from "./work-shell-panels.js";
import {
  resolveWorkShellContextInspectorAction,
  resolveWorkShellInputAction,
  resolveWorkShellRawTranscriptNavigation,
  resolveWorkShellTranscriptNavigation,
  resolveWorkShellSubmitAction,
} from "./work-shell-input.js";
import {
  dispatchAgentConsoleAction,
  resolveAgentConsoleInputDecision,
  type AgentConsoleControls,
  type AgentConsoleInputContext,
  type AgentConsoleInputDecision,
  type AgentConsoleKeyState,
} from "./work-shell-agent-console-input.js";
import {
  createWorkShellTranscriptAnchor,
  getWorkShellTranscriptAvailableRows,
  measureWorkShellEntryRows,
  projectWorkShellTranscript,
  resolveWorkShellTranscriptOffsetFromAnchor,
  shouldShowWorkShellConversationEntry,
  type WorkShellEntry,
  type WorkShellPanel,
} from "./work-shell-view.js";

export type WorkShellComposerPreview<Attachment = never> = {
  readonly prompt: string;
  readonly attachments: readonly Attachment[];
  readonly transcriptText: string;
};

export function createEmptyWorkShellComposerPreview<Attachment = never>(): WorkShellComposerPreview<Attachment> {
  return {
    prompt: "",
    attachments: [],
    transcriptText: "",
  };
}

type WorkShellComposerPreviewMode = {
  readonly mode: "empty" | "fast" | "slow";
  readonly prompt: string;
  readonly transcriptText: string;
};

function resolveComposerPreviewMode(value: string): WorkShellComposerPreviewMode {
  const prompt = value.trim();
  if (prompt.length === 0) {
    return {
      mode: "empty",
      prompt: "",
      transcriptText: "",
    };
  }

  return {
    mode: hasComposerFileReferenceToken(prompt) || hasComposerImagePathToken(prompt)
      ? "slow"
      : "fast",
    prompt,
    transcriptText: prompt,
  };
}

function hasComposerFileReferenceToken(value: string): boolean {
  for (const match of value.matchAll(/@/g)) {
    const index = match.index ?? 0;
    if (index > 0 && !/\s/u.test(value[index - 1] ?? "")) {
      continue;
    }
    const rest = value.slice(index + 1);
    if (rest.startsWith("\"")) {
      const endQuoteIndex = rest.indexOf("\"", 1);
      if (endQuoteIndex > 1 && !rest.slice(1, endQuoteIndex).includes("\n")) {
        return true;
      }
      continue;
    }
    if (rest.length > 0 && !/^\s/u.test(rest)) {
      return true;
    }
  }
  return false;
}

function hasComposerImagePathToken(value: string): boolean {
  return value
    .split(/[\s"']+/u)
    .filter((token) => token.length > 0)
    .some((token) => /\.(?:png|jpe?g|gif|webp|bmp)$/iu.test(token));
}

export function shouldUseSlowComposerPreview(value: string): boolean {
  return resolveComposerPreviewMode(value).mode === "slow";
}

export function createFastWorkShellComposerPreview<Attachment = never>(value: string): WorkShellComposerPreview<Attachment> {
  const previewMode = resolveComposerPreviewMode(value);
  return {
    prompt: previewMode.prompt,
    attachments: [],
    transcriptText: previewMode.transcriptText,
  };
}

export interface WorkShellStateSource<State> {
  getState(): State;
  subscribe(listener: (state: State) => void): () => void;
  initialize(): Promise<void>;
  dispose(): void;
}

export type WorkShellEngineOwnership = "owned" | "shared";

export function useWorkShellEngineState<State>(
  engine: WorkShellStateSource<State>,
  lifecycle: { readonly ownership?: WorkShellEngineOwnership } = {},
): State {
  const [state, setState] = useState(() => engine.getState());
  const ownership = lifecycle.ownership ?? "owned";

  useEffect(() => {
    setState(engine.getState());
    const unsubscribe = engine.subscribe(setState);
    void engine.initialize();
    return () => {
      unsubscribe();
      if (ownership === "owned") {
        engine.dispose();
      }
    };
  }, [engine, ownership]);

  return state;
}

export function useWorkShellDashboardHomeSync(input: {
  readonly isBusy: boolean;
  readonly authLabel: string;
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
  readonly onSyncHomeState?: ((homeState: Partial<TuiShellHomeState>) => void) | undefined;
  readonly refreshHomeState?: (() => Promise<TuiShellHomeState>) | undefined;
}): void {
  const previousHomeSyncStateRef = useRef<WorkShellDashboardHomeSyncState | undefined>(undefined);

  useEffect(() => {
    input.onSyncHomeState?.(
      createWorkShellDashboardHomePatch({
        authLabel: input.authLabel,
        bridgeLines: input.bridgeLines,
        memoryLines: input.memoryLines,
      }),
    );
  }, [
    input.authLabel,
    input.bridgeLines,
    input.memoryLines,
    input.onSyncHomeState,
  ]);

  useEffect(() => {
    const nextHomeSyncState = createWorkShellDashboardHomeSyncState({
      isBusy: input.isBusy,
      authLabel: input.authLabel,
      bridgeLines: input.bridgeLines,
      memoryLines: input.memoryLines,
    });
    const previousHomeSyncState = previousHomeSyncStateRef.current;
    previousHomeSyncStateRef.current = nextHomeSyncState;

    if (!input.refreshHomeState || !input.onSyncHomeState) {
      return;
    }
    if (!shouldRefreshDashboardHomeState(previousHomeSyncState, nextHomeSyncState)) {
      return;
    }

    let cancelled = false;
    void input.refreshHomeState()
      .then((homeState) => {
        if (!cancelled) {
          input.onSyncHomeState?.(homeState);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [
    input.authLabel,
    input.bridgeLines,
    input.isBusy,
    input.memoryLines,
    input.onSyncHomeState,
    input.refreshHomeState,
  ]);
}

export function shouldReportWorkShellOverlayOpen(input: {
  readonly panelTitle: string;
  readonly inputValue: string;
}): boolean {
  return input.panelTitle === "Context expanded" && input.inputValue.trim().length === 0;
}

export type WorkShellSlashSuggestion = {
  readonly command: string;
  readonly description: string;
};

export function resolveWorkShellActiveSlashInput(input: {
  readonly value: string;
  readonly fallbackPanelTitle: string;
  readonly fallbackPanelDismissed?: boolean | undefined;
}): string | undefined {
  const trimmed = input.value.trim();
  if (trimmed.startsWith("/")) {
    return input.value;
  }
  if (input.fallbackPanelDismissed) {
    return undefined;
  }
  if (input.fallbackPanelTitle === "Model picker") {
    return trimmed.length === 0 ? "/model" : `/model ${trimmed}`;
  }
  if (input.fallbackPanelTitle === "Auth") {
    return trimmed.length === 0 ? "/auth" : `/auth ${trimmed}`;
  }
  return undefined;
}

function getWorkShellPanelDismissKey(panel: WorkShellPanel): string {
  return `${panel.title}\n${panel.lines.join("\n")}`;
}

const DISMISSED_SLASH_PICKER_PANEL: WorkShellPanel = {
  title: "Context",
  lines: ["Slash command closed.", "Type / for commands."],
};

export type WorkShellPaneRuntimeState<Reasoning = unknown> = {
  readonly entries: readonly WorkShellEntry[];
  readonly streamingAssistantText?: string | undefined;
  readonly model: string;
  readonly mode: string;
  readonly reasoning: Reasoning;
  readonly authLabel: string;
  readonly isBusy: boolean;
  readonly busyStatus?: string | undefined;
  readonly currentTurnStartedAt?: number | undefined;
  readonly lastTurnDurationMs?: number | undefined;
  readonly contextIndicator?: string | undefined;
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
  // Raw engine trace lines (`→ read …`, `✓ …`). The transcript keeps
  // filtering these out; the pane forwards only the tail (Task 10's live
  // tool feed in the composer dock). Optional so hosts and test fakes
  // without engine trace state render no feed.
  readonly traceLines?: readonly string[];
  /** Shared `/minimal`/`/verbose` tool-history presentation preference. */
  readonly traceMode?: "minimal" | "verbose" | undefined;
  readonly uiLocale?: "en" | "ko" | undefined;
  // Always-filled live trace tail (engine-owned, capped at 8). The pane's
  // dock feed reads THIS buffer — not the verbose-only `traceLines` above —
  // so the busy feed stays alive in default (minimal) trace mode.
  // Optional so hosts and test fakes without engine trace state render no
  // feed.
  readonly liveTraceLines?: readonly string[];
  readonly authLauncherLines?: readonly string[];
  readonly composerMode?: WorkShellComposerMode;
  readonly panel: WorkShellPanel;
  readonly queuedCount?: number | undefined;
  readonly queuePaused?: boolean | undefined;
  readonly contextInspectorCursor?: number | undefined;
  // Context Desk (Pure Yazi): explicit overlay ownership plus the active pane
  // and collection, so the keyboard gate and the renderer read one source of
  // truth instead of re-deriving it from the panel title.
  readonly contextInspectorOpen?: boolean | undefined;
  readonly contextInspectorPane?: ContextDeskPane | undefined;
  readonly contextInspectorCollection?: ContextDeskCollection | undefined;
  readonly contextInspectorExpanded?: string | null | undefined;
  readonly contextInspectorDetailContent?: string | undefined;
  readonly contextInspectorDetailOffset?: number | undefined;
  readonly contextPacket?: ContextPacketView | undefined;
  readonly contextActionReceipt?: ContextPacketViewActionReceipt | undefined;
  readonly contextPreviewReceipt?: ContextPacketReceipt | undefined;
  readonly contextSubmittedReceipt?: ContextPacketReceipt | undefined;
  readonly contextPacketChange?: ContextPacketChangeClassification | undefined;
  readonly contextSourceActionsEnabled?: boolean | undefined;
  readonly contextPolicySuggestions?: readonly ContextPolicySuggestion[] | undefined;
  readonly contextAdviceUnavailable?: string | undefined;
  readonly contextAdviceActionsEnabled?: boolean | undefined;
  // Adaptive model context window (tokens) threaded from engine state so the
  // budget meter scales with the active model instead of an env var.
  readonly modelWindow?: number | undefined;
  readonly agentConsole?: AgentConsoleSnapshot | undefined;
  readonly agentConsoleView?: AgentConsoleViewState | undefined;
};

export interface WorkShellPaneEngine<State extends WorkShellPaneRuntimeState>
  extends WorkShellStateSource<State> {
  handleSubmit(line: string, attachments?: readonly unknown[]): Promise<void>;
  toggleToolHistoryDisplay?(): Promise<void>;
  setMode(mode: string): void | Promise<void>;
  openSessionsPanel(): Promise<void>;
  interruptTurn?(): void;
  cancelSensitiveInput?(): void;
  closeOverlay?(): void;
  updateTerminalColumns?(columns: number): void;
  updateTerminalRows?(rows: number): void;
  // Context Inspector (Sprint 2) — keyboard actions for the /context overlay.
  // All are optional so test harnesses / legacy panes that never open the
  // overlay don't need stubs.
  moveContextInspectorCursor?(direction: number): void;
  moveContextInspectorPane?(direction: number): void;
  moveContextInspectorPage?(direction: number): void;
  moveContextInspectorDetailOffset?(direction: number): void;
  toggleContextInspectorPin?(): Promise<void>;
  forgetContextSourceAtCursor?(): Promise<void>;
  includeContextSourceAtCursor?(): Promise<void>;
  toggleContextInspectorExpanded?(): Promise<void>;
  undoLastContextSourceAction?(): Promise<void>;
  acceptContextSuggestion?(suggestionId: string): Promise<void>;
  rejectContextSuggestion?(suggestionId: string): Promise<void>;
  // Agent Console (Sprint 3) — keyboard controls for the Alt+A console.
  // `openAgentConsole` is the capability probe: a host that does not wire it
  // keeps Alt+A as ordinary typing instead of gaining a dead key.
  openAgentConsole?(tab?: AgentConsoleTab): void;
  closeAgentConsole?(): void;
  selectAgentConsoleTab?(tab: AgentConsoleTab): void;
  moveAgentConsoleCursor?(delta: number): void;
  toggleAgentConsoleInspector?(): void;
  beginAgentSteer?(agentRunId?: string): unknown;
  submitAgentSteer?(value: string): Promise<void>;
  requestAgentCancel?(): void;
  confirmAgentCancel?(confirm: boolean): Promise<void>;
  continueSelectedAgent?(): Promise<void>;
  // Decision bar (main-screen UX overhaul) — one-key replies and Esc cancel
  // for a pending AskUserQuestion. Both optional so hosts without decision
  // plumbing keep digits and Esc on their existing meanings.
  submitPendingDecisionText?(value: string, decisionId: string): boolean | Promise<boolean>;
  answerPendingDecisionByIndex?(index: number, decisionId: string): boolean | Promise<boolean>;
  cancelPendingDecision?(decisionId: string): boolean | Promise<boolean>;
  removeQueueItem?(id: number): Promise<boolean>;
  moveQueueItem?(id: number, direction: "up" | "down"): Promise<boolean>;
  clearQueueItems?(): Promise<void>;
  resumeQueueItems?(): Promise<void>;
  retryQueueItem?(id: number): Promise<boolean>;
  discardQueueItem?(id: number): Promise<boolean>;
  // Optional because not every pane host wires trace plumbing — when
  // absent, the hook silently drops the event. In practice WorkShellEngine
  // always implements this since commit b891c19's follow-up.
  recordTraceEvent?(event: AttachmentLifecycleTraceEvent): void;
}

/**
 * Subset of ExecutionTraceEvent the TUI hook emits on its own. Kept as a
 * narrower type at the seam so hosts that opt in cannot accidentally
 * forward arbitrary trace events through this channel — agent traces
 * still flow through the regular setTraceListener path inside the
 * engine.
 */
export type AttachmentLifecycleTraceEvent =
  | {
      readonly type: "attachment.attached";
      readonly level: "default";
      readonly source: "clipboard";
      readonly mimeType: string;
      readonly byteEstimate: number;
      readonly startedAt: number;
    }
  | {
      readonly type: "attachment.dropped";
      readonly level: "default";
      readonly source: "clipboard";
      readonly reason: "cap-exceeded" | "capture-too-large" | "user-cleared";
      readonly byteEstimate?: number;
      readonly mimeType?: string;
      readonly startedAt: number;
    };

function filterSelectableSlashSuggestions(
  slashInput: string | undefined,
  suggestions: readonly WorkShellSlashSuggestion[],
): readonly WorkShellSlashSuggestion[] {
  if (!slashInput?.trim().startsWith("/model")) {
    return suggestions;
  }
  return suggestions.filter((suggestion) => {
    const command = suggestion.command.trim();
    return command.startsWith("/model ")
      && command !== "/model list"
      && command.slice("/model ".length).trim().length > 0;
  });
}

export function useWorkShellSlashState(input: {
  readonly value: string;
  readonly activeSlashInput?: string | undefined;
  readonly currentModel?: string;
  readonly authLabel?: string;
  readonly authLauncherLines?: readonly string[];
  readonly browserOAuthAvailable?: boolean;
  readonly fallbackPanel: WorkShellPanel;
  readonly getSuggestions: (value: string) => readonly WorkShellSlashSuggestion[];
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const slashInput = input.activeSlashInput;

  const suggestions = useMemo(() => {
    if (!slashInput) {
      return [];
    }
    return filterSelectableSlashSuggestions(
      slashInput,
      input.getSuggestions(slashInput),
    );
  }, [slashInput, input.getSuggestions]);

  useEffect(() => {
    setSelectedIndex((current) =>
      clampWorkShellSlashSelection(current, suggestions.length),
    );
  }, [slashInput, suggestions.length]);

  const selectedSuggestion = suggestions[selectedIndex];
  const activePanel = useMemo(
    () =>
      resolveWorkShellActivePanel({
        input: slashInput ?? input.value,
        suggestions,
        selectedIndex,
        ...(input.authLabel ? { authLabel: input.authLabel } : {}),
        ...(input.browserOAuthAvailable !== undefined
          ? { browserOAuthAvailable: input.browserOAuthAvailable }
          : {}),
        ...(input.authLauncherLines
          ? { authLauncherLines: input.authLauncherLines }
          : {}),
        ...(input.currentModel ? { currentModel: input.currentModel } : {}),
        fallbackPanel: input.fallbackPanel,
      }),
    [
      input.authLabel,
      input.authLauncherLines,
      input.browserOAuthAvailable,
      input.currentModel,
      input.fallbackPanel,
      input.value,
      slashInput,
      selectedIndex,
      suggestions,
    ],
  );

  return {
    suggestions,
    selectedIndex,
    setSelectedIndex,
    selectedSuggestion,
    activeSlashInput: slashInput,
    activePanel,
  };
}

function agentConsoleKeyMask(key: AgentConsoleKeyState): number {
  return (key.meta ? 1 : 0)
    | (key.ctrl ? 2 : 0)
    | (key.shift ? 4 : 0)
    | (key.tab ? 8 : 0)
    | (key.return ? 16 : 0)
    | (key.escape ? 32 : 0)
    | (key.upArrow ? 64 : 0)
    | (key.downArrow ? 128 : 0);
}

/**
 * The live console one decision was resolved against. The view is immutable,
 * so every fresh decision reads one coherent console state even when the
 * previous key changed tabs, control mode, or composer mode.
 */
type AgentConsoleDecisionScope = {
  readonly view: AgentConsoleViewState | undefined;
  readonly composerMode: WorkShellComposerMode;
};

/**
 * The console keyboard seam handed to the controller, to the Composer's
 * suppression gate, and to the pane's submit routing. Every Composer key asks
 * the suppression gate before its own short-circuits, so `decide` can cache one
 * normalized physical event: dispatch and suppression share the decision, and
 * the Composer consumes the cache before Ink emits the next event.
 */
export type WorkShellAgentConsoleKeyboard = {
  readonly steering: boolean;
  readonly buildContext: (
    value: string,
    key: AgentConsoleKeyState,
    composerEmpty: boolean,
  ) => AgentConsoleInputContext;
  readonly decide: (
    value: string,
    key: AgentConsoleKeyState,
    composerEmpty: boolean,
    phase: "dispatch" | "suppress",
  ) => AgentConsoleInputDecision;
  readonly controls: AgentConsoleControls;
};

/**
 * Which shell surface — if any — owns a single-character keystroke ahead of
 * the generic Rust resolver. The empty-screen starter prompts (`1`-`3`), the
 * decision bar's one-key replies, and the `?` keymap all resolve here so the
 * input controller's dispatch branch and the Composer's suppression callback
 * share one predicate instead of two copies that drift apart and produce a
 * key that is swallowed yet does nothing.
 */
export type ShellActionKeyOwnership = "starter" | "decision" | "keymap";

/**
 * Per-keystroke state the ownership predicate reads. `overlayOpen` is the
 * disjunction of every surface that outranks shell action keys: the context
 * desk, the telemetry panels, the agent console, and the slash picker.
 */
export type ShellActionKeyOwnershipState = {
  /** The pressed character exactly as Ink delivered it. */
  readonly input: string;
  /** Ctrl chords keep their global meaning and never become action keys. */
  readonly ctrl: boolean;
  /** Whether the keystroke was Esc (Ink delivers it with an empty `input`). */
  readonly escape?: boolean | undefined;
  /** Whether the composer is raw-empty (no pending local draft either). */
  readonly composerEmpty: boolean;
  /** Whether the conversation transcript already has entries. */
  readonly hasConversation: boolean;
  readonly isBusy: boolean;
  readonly composerMode: WorkShellComposerMode | undefined;
  readonly overlayOpen: boolean;
  /** A pending AskUserQuestion is awaiting a reply (only exists mid-turn). */
  readonly decisionPending?: boolean | undefined;
  /** Option count when the pending decision has exactly one question. */
  readonly decisionOptionCount?: number | undefined;
};

/** Hotkey → starter prompt; only exact single digits `1`-`3` match. */
function getWorkShellStarterPromptForKey(
  key: string,
  uiLocale: "en" | "ko" = "en",
): string | undefined {
  const prompts = getWorkShellMessages(uiLocale).starterPrompts;
  const index = prompts.findIndex((_, promptIndex) =>
    key === String(promptIndex + 1)
  );
  return index >= 0 ? prompts[index] : undefined;
}

/**
 * Decision one-key replies: exact digits `1`-`9`, only when the pending
 * decision has exactly one question (`optionCount` known) and the digit is
 * within the rendered option count. A multi-question decision leaves
 * `optionCount` undefined and must type its `id: n` answers, so its digits
 * stay ordinary draft input instead of being swallowed with no action.
 */
function isDecisionOneKeyDigit(input: string, optionCount: number | undefined): boolean {
  if (!/^[1-9]$/.test(input)) {
    return false;
  }
  return optionCount !== undefined && Number(input) <= optionCount;
}

export function resolveShellActionKeyOwnership(
  state: ShellActionKeyOwnershipState,
): ShellActionKeyOwnership | undefined {
  if (state.ctrl) {
    return undefined;
  }
  // A locally pending draft owns the keyboard outright.
  if (!state.composerEmpty) {
    return undefined;
  }
  // Sensitive entry must receive every character exactly as typed.
  if (state.composerMode === "api-key-entry") {
    return undefined;
  }
  // Overlays that own the keyboard outrank every shell action key.
  if (state.overlayOpen) {
    return undefined;
  }
  // Decision bar one-key replies. A pending AskUserQuestion only exists
  // mid-turn, so this gate sits ahead of the isBusy bail below (which exists
  // for exactly that turn) — after it, the branch would be dead code. Esc
  // cancels any pending decision; digits answer only a single-question
  // decision, and only within the rendered option count, so no key is ever
  // swallowed without an action behind it.
  if (state.decisionPending) {
    if (state.escape) {
      return "decision";
    }
    if (isDecisionOneKeyDigit(state.input, state.decisionOptionCount)) {
      return "decision";
    }
    return undefined;
  }
  if (state.isBusy) {
    return undefined;
  }
  if (!state.hasConversation) {
    if (getWorkShellStarterPromptForKey(state.input) !== undefined) {
      return "starter";
    }
  }
  // `?` keymap: one keystroke opens /help. It works from the empty screen and
  // a grown conversation alike — key discovery matters most once the starter
  // prompts have scrolled away — and every gate above (empty composer,
  // sensitive entry, overlays, pending decision, busy turn) has passed.
  if (state.input === "?") {
    return "keymap";
  }
  return undefined;
}

/**
 * The `overlayOpen` disjunction the ownership predicate reads: the context
 * desk, the telemetry panels, the agent console, and the slash picker. One
 * helper keeps the controller's dispatch branch and the Composer's
 * suppression callback rolling up the same set of surfaces.
 */
export function isShellActionKeyOverlayOpen(input: {
  readonly hasOverlayOpen?: boolean | undefined;
  readonly contextInspectorOpen?: boolean | undefined;
  readonly telemetryPanelOpen: boolean;
  readonly agentConsoleOpen?: boolean | undefined;
  readonly activeSlashInput?: string | undefined;
}): boolean {
  return (
    Boolean(input.hasOverlayOpen)
    || Boolean(input.contextInspectorOpen)
    || input.telemetryPanelOpen
    || Boolean(input.agentConsoleOpen)
    || input.activeSlashInput !== undefined
  );
}

export type QueueOverlayKeyAction =
  | { readonly action: "pass" | "consume" | "remove" | "clear" | "resume" | "retry" | "discard" | "close" }
  | { readonly action: "select"; readonly delta: -1 | 1 }
  | { readonly action: "move"; readonly direction: "up" | "down" };

export function resolveQueueOverlayKeyAction(
  value: string,
  key: {
    readonly upArrow?: boolean;
    readonly downArrow?: boolean;
    readonly shift?: boolean;
    readonly escape?: boolean;
    readonly delete?: boolean;
    readonly backspace?: boolean;
    readonly ctrl?: boolean;
  },
  queueOpen: boolean,
): QueueOverlayKeyAction {
  if (!queueOpen) return { action: "pass" };
  if (key.escape) return { action: "close" };
  if (key.upArrow || key.downArrow) {
    const direction = key.upArrow ? "up" : "down";
    return key.shift
      ? { action: "move", direction }
      : { action: "select", delta: direction === "up" ? -1 : 1 };
  }
  if (key.delete || key.backspace || value.toLowerCase() === "d") return { action: "remove" };
  if (!key.ctrl && value.toLowerCase() === "c") return { action: "clear" };
  if (!key.ctrl && value.toLowerCase() === "r") return { action: "resume" };
  if (!key.ctrl && value.toLowerCase() === "t") return { action: "retry" };
  if (!key.ctrl && value.toLowerCase() === "x") return { action: "discard" };
  return { action: "consume" };
}

export function parseQueuePanelItemIds(lines: readonly string[]): readonly number[] {
  return lines.flatMap((line) => {
    const match = line.match(/^(?:Next|#\d+) · id (\d+) ·/u);
    if (!match?.[1]) return [];
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id >= 0 ? [id] : [];
  });
}

export function useWorkShellInputController(input: {
  readonly value: string;
  readonly uiLocale?: "en" | "ko" | undefined;
  readonly replaceValue: (value: string) => void;
  readonly slashSuggestionCount: number;
  readonly selectedSlashCommand?: string;
  readonly activeSlashInput?: string | undefined;
  readonly setSelectedSlashIndex: (value: number | ((current: number) => number)) => void;
  readonly isBusy: boolean;
  readonly currentMode: string;
  readonly onExit: () => void;
  readonly onRequestSessionsView?: (() => void) | undefined;
  readonly toggleQualityPlan?: (() => void) | undefined;
  readonly toggleToolHistoryDisplay?: (() => void | Promise<void>) | undefined;
  readonly openEngineSessions: () => void;
  readonly cycleMode: (nextMode: string) => void | Promise<void>;
  readonly shouldBlockSlashSubmit: (line: string) => boolean;
  readonly handleSubmit: (line: string) => Promise<void>;
  readonly hasSensitiveInput?: boolean;
  readonly hasOverlayOpen?: boolean;
  /**
   * Shell action keys (starter prompts, decision replies, the `?` keymap): the
   * controller historically knows nothing about the transcript or composer
   * mode, so pane hosts thread these from engine state. `hasConversation`
   * must arrive as an explicit `false` — a host that never wired it keeps
   * digits as ordinary typing instead of guessing at the transcript.
   */
  readonly hasConversation?: boolean | undefined;
  readonly composerMode?: WorkShellComposerMode | undefined;
  /** Whether the agent console overlay is open (it outranks action keys). */
  readonly agentConsoleOpen?: boolean | undefined;
  /**
   * Decision bar: a pending AskUserQuestion is awaiting a reply, and (for a
   * single-question decision) how many options it renders. Threaded from the
   * agent console snapshot because the controller has no snapshot of its own.
   */
  readonly decisionPending?: boolean | undefined;
  readonly pendingDecisionId?: string | undefined;
  readonly decisionOptionCount?: number | undefined;
  /** Decision bar capability probes — wired by engines that own decisions. */
  readonly submitPendingDecisionText?: ((value: string, decisionId: string) => boolean | Promise<boolean>) | undefined;
  readonly answerPendingDecisionByIndex?: ((index: number, decisionId: string) => boolean | Promise<boolean>) | undefined;
  readonly cancelPendingDecision?: ((decisionId: string) => boolean | Promise<boolean>) | undefined;
  readonly queueOverlayOpen?: boolean | undefined;
  readonly queueSelectedId?: number | undefined;
  readonly moveQueueSelection?: ((delta: -1 | 1) => void) | undefined;
  readonly removeSelectedQueueItem?: (() => Promise<void>) | undefined;
  readonly moveSelectedQueueItem?: ((direction: "up" | "down") => Promise<void>) | undefined;
  readonly clearQueueItems?: (() => Promise<void>) | undefined;
  readonly resumeQueueItems?: (() => Promise<void>) | undefined;
  readonly retrySelectedQueueItem?: (() => Promise<void>) | undefined;
  readonly discardSelectedQueueItem?: (() => Promise<void>) | undefined;
  readonly activePanelTitle?: string;
  readonly closeSlashPicker?: ((panelTitle?: string) => void) | undefined;
  readonly interruptTurn?: (() => void) | undefined;
  readonly cancelSensitiveInput?: (() => void) | undefined;
  readonly closeOverlay?: (() => void) | undefined;
  readonly contextSourceActionsEnabled?: boolean | undefined;
  readonly contextPinActionsEnabled?: boolean | undefined;
  readonly contextDeliveryActionsEnabled?: boolean | undefined;
  readonly contextAdviceActionsEnabled?: boolean | undefined;
  readonly contextUndoActionsEnabled?: boolean | undefined;
  /**
   * Whether the selected source can be expanded. Pane hosts supply the final
   * callback-and-preview ownership; legacy direct controller callers omit it.
   */
  readonly contextExpandActionsEnabled?: boolean | undefined;
  readonly isComposerRawEmpty?: (() => boolean) | undefined;
  readonly acceptContextSuggestion?: (() => Promise<void>) | undefined;
  readonly rejectContextSuggestion?: (() => Promise<void>) | undefined;
  readonly contextInspectorExpanded?: string | null | undefined;
  /**
   * Task 11 transcript scrollback: PageUp/PageDown move the visible window.
   * Wired by pane hosts that track the offset; a host that never wired it
   * keeps both keys dead (the Rust resolver maps neither) instead of having
   * them swallowed with no action. Unlike the shell action characters, these
   * are not print keys, so they fire with a draft in the composer too.
   */
  readonly moveTranscriptPage?: ((direction: -1 | 1) => void) | undefined;
  /** Returns the transcript to bottom-follow (the newest entry). */
  readonly returnTranscriptToNewest?: (() => void) | undefined;
  /** Whether the transcript is currently scrolled away from the newest entry. */
  readonly transcriptScrolledUp?: boolean | undefined;
  /**
   * Context Desk ownership, supplied from engine state. A panel title alone
   * cannot say whether the desk owns the keyboard, so the gate reads this
   * flag first and only falls back to the title for hosts that have not
   * wired it yet.
   */
  readonly contextInspectorOpen?: boolean | undefined;
  /**
   * Focused desk pane. The expanded-detail redirect below consults it so a
   * blown-open source cannot make the GROUPS pane unreachable: undefined
   * keeps the pane-blind legacy scroll for hosts that never wired it.
   */
  readonly contextInspectorPane?: ContextDeskPane | undefined;
  // Context Inspector (Sprint 2): engine callbacks for the /context overlay
  // keyboard actions. All optional — only dispatched when the overlay is open
  // and the engine wires them.
  readonly moveContextInspectorCursor?: ((direction: number) => void) | undefined;
  readonly moveContextInspectorPane?: ((direction: number) => void) | undefined;
  readonly moveContextInspectorPage?: ((direction: number) => void) | undefined;
  readonly moveContextInspectorDetailOffset?: ((direction: number) => void) | undefined;
  readonly toggleContextInspectorPin?: (() => Promise<void>) | undefined;
  readonly forgetContextSourceAtCursor?: (() => Promise<void>) | undefined;
  readonly includeContextSourceAtCursor?: (() => Promise<void>) | undefined;
  readonly toggleContextSourceDelivery?: (() => Promise<void>) | undefined;
  readonly toggleContextInspectorExpanded?: (() => Promise<void>) | undefined;
  readonly undoContextSourceAction?: (() => Promise<void>) | undefined;
  // Agent Console (Sprint 3): present only when the engine wires the console
  // controls. `buildContext` is the single place the per-keystroke ownership
  // context is assembled, so the Composer's suppression and this dispatch can
  // never drift apart.
  readonly agentConsole?: WorkShellAgentConsoleKeyboard | undefined;
}): { readonly submit: (value: string) => Promise<boolean> } {
  const escapeResetArmedAtRef = useRef<number | undefined>(undefined);
  const { stdin } = useStdin();
  const rawTranscriptNavigationRef = useRef<(value: unknown) => void>(() => undefined);

  // Ink's public `useInput` flags cover the normal VT/SS3 PageUp/PageDown and
  // End sequences, but Kitty's CSI-u keypad variants are delivered to the
  // stdin stream as `kppageup`/`kppagedown`/`kpend` and then become an empty
  // value with no public flag. Subscribe at the raw stream boundary so the
  // fallback is part of the same ownership ladder as ordinary keys. The ref
  // keeps this listener stable while giving it the latest overlay/draft state;
  // re-subscribing on every render would race a partially delivered escape
  // sequence and make key ownership flicker.
  rawTranscriptNavigationRef.current = (rawValue: unknown): void => {
    if (typeof rawValue !== "string") return;
    const navigation = resolveWorkShellRawTranscriptNavigation(rawValue);
    if (navigation.type === "none") return;

    const telemetryPanelOpen =
      input.activePanelTitle === "Cache Telemetry"
      || input.activePanelTitle === "Agent History";
    const contextDeskOwnsKeyboard = input.contextInspectorOpen
      ?? input.activePanelTitle === "Context expanded";
    const transcriptOverlayOpen = isShellActionKeyOverlayOpen({
      hasOverlayOpen: input.hasOverlayOpen,
      contextInspectorOpen: input.contextInspectorOpen,
      telemetryPanelOpen,
      agentConsoleOpen: input.agentConsoleOpen,
      activeSlashInput: input.activeSlashInput,
    });

    // Queue, agent-console, telemetry, slash-picker, and generic overlays are
    // authoritative owners. A raw page key must not leak through and move the
    // transcript underneath an overlay that cannot render that movement.
    if (input.queueOverlayOpen === true || transcriptOverlayOpen) {
      if (
        navigation.type === "page"
        && input.hasOverlayOpen
        && contextDeskOwnsKeyboard
      ) {
        input.moveContextInspectorPage?.(navigation.direction);
      }
      return;
    }
    if (contextDeskOwnsKeyboard) {
      if (navigation.type === "page") {
        input.moveContextInspectorPage?.(navigation.direction);
      }
      return;
    }

    if (navigation.type === "page") {
      input.moveTranscriptPage?.(navigation.direction);
      return;
    }
    if (
      navigation.type === "latest"
      && input.transcriptScrolledUp
      && input.returnTranscriptToNewest
      && !input.isBusy
      && input.composerMode !== "api-key-entry"
    ) {
      input.returnTranscriptToNewest();
    }
  };

  useEffect(() => {
    const onInput = (value: unknown): void => {
      rawTranscriptNavigationRef.current(value);
    };
    stdin.on("data", onInput);
    return () => {
      stdin.removeListener("data", onInput);
    };
  }, [stdin]);

  // The controller's own submit — the exact route Enter takes on a typed
  // line. Defined ahead of `useInput` so single-key dispatches (`?` → /help)
  // reuse the slash submission path instead of a parallel one.
  const submit = useCallback(
    async (value: string): Promise<boolean> => {
      // The steer composer routes to the agent's control mailbox, not to the
      // chat router. The generic resolver would turn an empty (or busy-turn)
      // line into a `noop`, and the engine would never get the chance to
      // reject it and leave the mode — stranding the operator in a composer
      // whose Enter does nothing.
      const liveAgentConsole = input.agentConsole?.buildContext(
        value,
        {},
        isRawComposerEmpty(value),
      );
      if (
        liveAgentConsole?.open === true
        && liveAgentConsole.composerMode === "agent-steer"
      ) {
        input.replaceValue("");
        await input.handleSubmit(value);
        // No provider turn opened and no attachment was delivered, so the
        // pane must keep its pending clipboard badge intact.
        return false;
      }
      // A typed answer is a control for the exact decision rendered when
      // Enter was pressed, never a generic prompt. Keeping the identity in
      // this call prevents a delayed remote A submission from being replayed
      // against replacement decision B at the same owner revision.
      if (input.pendingDecisionId && input.submitPendingDecisionText) {
        if (value.trim().length === 0) return false;
        try {
          return await input.submitPendingDecisionText(value, input.pendingDecisionId);
        } catch {
          // The Composer interprets false as "not accepted" and restores the
          // submitted draft. The owner remains the authority on the current
          // decision, so a transport/revision rejection changes no UI state.
          return false;
        }
      }
      const typedLine = value.trim();
      const submitValue =
        input.activeSlashInput && (typedLine.length === 0 || !typedLine.startsWith("/"))
          ? input.activeSlashInput
          : value;
      const line = submitValue.trim();
      const action = resolveWorkShellSubmitAction({
        value: submitValue,
        isBusy: input.isBusy,
        shouldBlockSlashSubmit: input.shouldBlockSlashSubmit(line),
        ...(input.activePanelTitle
          ? { activePanelTitle: input.activePanelTitle }
          : {}),
        ...(input.selectedSlashCommand
          ? { selectedSlashCommand: input.selectedSlashCommand }
          : {}),
      });

      if (action.type === "noop") {
        return false;
      }

      if (action.type === "replace-input") {
        input.replaceValue(action.value);
        return false;
      }

      if (action.clearInput) {
        input.replaceValue("");
      }

      await input.handleSubmit(action.line);
      if (input.activePanelTitle === "Model picker" || action.line.trim().startsWith("/model ")) {
        input.closeSlashPicker?.("Model picker");
      }
      return true;
    },
    [
      input.handleSubmit,
      input.isBusy,
      input.replaceValue,
      input.activePanelTitle,
      input.activeSlashInput,
      input.closeSlashPicker,
      input.selectedSlashCommand,
      input.shouldBlockSlashSubmit,
      input.agentConsole?.buildContext,
      input.pendingDecisionId,
      input.submitPendingDecisionText,
    ],
  );

  useInput((value, key) => {
    const ctrlTCount = value.split("\u0014").length - 1;
    if (
      input.toggleQualityPlan
      && (ctrlTCount > 0 || (key.ctrl && value.toLowerCase() === "t"))
    ) {
      escapeResetArmedAtRef.current = undefined;
      for (let index = 0; index < Math.max(1, ctrlTCount); index += 1) {
        input.toggleQualityPlan();
      }
      return;
    }
    const ctrlOCount = value.split("\u000f").length - 1;
    if (input.toggleToolHistoryDisplay && (ctrlOCount > 0 || (key.ctrl && value.toLowerCase() === "o"))) {
      escapeResetArmedAtRef.current = undefined;
      const requestCount = Math.max(1, ctrlOCount);
      for (let index = 0; index < requestCount; index += 1) {
        void Promise.resolve(input.toggleToolHistoryDisplay()).catch(() => undefined);
      }
      return;
    }
    const queueAction = resolveQueueOverlayKeyAction(value, key, input.queueOverlayOpen === true);
    if (queueAction.action !== "pass") {
      escapeResetArmedAtRef.current = undefined;
      switch (queueAction.action) {
        case "close": input.closeOverlay?.(); break;
        case "select": input.moveQueueSelection?.(queueAction.delta); break;
        case "remove": void input.removeSelectedQueueItem?.().catch(() => undefined); break;
        case "move": void input.moveSelectedQueueItem?.(queueAction.direction).catch(() => undefined); break;
        case "clear": void input.clearQueueItems?.().catch(() => undefined); break;
        case "resume": void input.resumeQueueItems?.().catch(() => undefined); break;
        case "retry": void input.retrySelectedQueueItem?.().catch(() => undefined); break;
        case "discard": void input.discardSelectedQueueItem?.().catch(() => undefined); break;
        case "consume": break;
      }
      return;
    }
    // Agent Console (Sprint 3): the console takes the frame ahead of every
    // panel overlay, so it is asked before the telemetry hotkeys, the Context
    // Inspector, and the general Rust resolver. Only `pass` lets the shell's
    // downstream handlers see the keystroke at all.
    if (input.agentConsole) {
      const decision = input.agentConsole.decide(
        value,
        key,
        input.isComposerRawEmpty?.() ?? isRawComposerEmpty(input.value),
        "dispatch",
      );
      if (decision.kind !== "pass") {
        escapeResetArmedAtRef.current = undefined;
        if (decision.kind === "dispatch") {
          dispatchAgentConsoleAction(decision.action, input.agentConsole.controls);
        }
        // `consume` swallows the key outright; `compose` leaves it to the
        // Composer. Either way nothing behind the console may act on it.
        return;
      }
    }
    const telemetryPanelOpen =
      input.activePanelTitle === "Cache Telemetry"
      || input.activePanelTitle === "Agent History";
    const telemetryHotkey = value.toLowerCase();
    if (
      telemetryPanelOpen
      && !key.ctrl
      && (input.isComposerRawEmpty?.() ?? isRawComposerEmpty(input.value))
      && (telemetryHotkey === "c" || telemetryHotkey === "a")
    ) {
      escapeResetArmedAtRef.current = undefined;
      input.replaceValue("");
      void input.handleSubmit(telemetryHotkey === "c" ? "/cache" : "/agents").catch(() => undefined);
      return;
    }
    // Context Inspector (Sprint 2): when the overlay is open, intercept the
    // action keys before the composer can consume them. The slash picker
    // always wins (resolver returns "none" when input starts with "/").
    // Raw composer emptiness is read once per keystroke and gates every desk
    // key alike — letters, arrows, PageUp/PageDown, and Enter. Navigation gets
    // no exemption: a locally pending draft owns the keyboard outright.
    const composerRawEmpty = input.isComposerRawEmpty?.() ?? isRawComposerEmpty(input.value);
    // The desk owns the keyboard when engine state says it is open; the panel
    // title is only the fallback for hosts that have not wired the flag.
    const contextDeskOwnsKeyboard = input.contextInspectorOpen
      ?? input.activePanelTitle === "Context expanded";
    if (
      input.hasOverlayOpen
      && contextDeskOwnsKeyboard
      && !input.value.trim().startsWith("/")
      && composerRawEmpty
    ) {
      const inspectorAction = resolveWorkShellContextInspectorAction({
        value,
        key,
        panelTitle: "Context expanded",
        actionsEnabled: input.contextSourceActionsEnabled ?? false,
        ...(input.contextPinActionsEnabled !== undefined
          ? { pinActionsEnabled: input.contextPinActionsEnabled }
          : {}),
        ...(input.contextDeliveryActionsEnabled !== undefined
          ? { deliveryActionsEnabled: input.contextDeliveryActionsEnabled }
          : {}),
        adviceActionsEnabled: input.contextAdviceActionsEnabled ?? false,
        undoActionsEnabled: input.contextUndoActionsEnabled ?? false,
        ...(input.contextExpandActionsEnabled !== undefined
          ? { expandActionsEnabled: input.contextExpandActionsEnabled }
          : {}),
        composerEmpty: composerRawEmpty,
      });
      switch (inspectorAction.type) {
        case "move-pane":
          input.moveContextInspectorPane?.(inspectorAction.direction);
          return;
        case "move-cursor":
          // An expanded source owns the detail scroll everywhere except the
          // groups pane, which must keep walking collections so the menu stays
          // reachable without collapsing the row first. The engine routes the
          // preview pane to the same offset, so nothing regresses there.
          if (
            input.contextInspectorExpanded
            && input.contextInspectorPane !== "groups"
          ) {
            input.moveContextInspectorDetailOffset?.(inspectorAction.direction);
          } else {
            input.moveContextInspectorCursor?.(inspectorAction.direction);
          }
          return;
        case "move-page":
          input.moveContextInspectorPage?.(inspectorAction.direction);
          return;
        case "toggle-pin":
          escapeResetArmedAtRef.current = undefined;
          void input.toggleContextInspectorPin?.().catch(() => undefined);
          return;
        case "toggle-delivery":
          escapeResetArmedAtRef.current = undefined;
          void input.toggleContextSourceDelivery?.().catch(() => undefined);
          return;
        case "undo":
          escapeResetArmedAtRef.current = undefined;
          void input.undoContextSourceAction?.().catch(() => undefined);
          return;
        case "accept-advice":
          escapeResetArmedAtRef.current = undefined;
          void input.acceptContextSuggestion?.().catch(() => undefined);
          return;
        case "reject-advice":
          escapeResetArmedAtRef.current = undefined;
          void input.rejectContextSuggestion?.().catch(() => undefined);
          return;
        case "expand":
          void Promise.resolve()
            .then(() => input.toggleContextInspectorExpanded?.())
            .catch(() => undefined);
          return;
        case "none":
          break;
      }
    }

    // Shell action keys (the empty-screen starter prompts, the decision
    // bar's one-key replies, the `?` keymap). Every owner above —
    // the console, the telemetry hotkeys, the context desk — has passed on
    // the keystroke, so the shared predicate decides whether the character
    // acts for the shell instead of joining the draft. The Composer consults
    // the same predicate at its own insertion point, so a claimed key can
    // never be swallowed yet do nothing.
    const shellActionOwnership = resolveShellActionKeyOwnership({
      input: value,
      ctrl: key.ctrl === true,
      escape: key.escape === true,
      composerEmpty: composerRawEmpty,
      hasConversation: input.hasConversation ?? true,
      isBusy: input.isBusy,
      composerMode: input.composerMode,
      decisionPending: input.decisionPending,
      decisionOptionCount: input.decisionOptionCount,
      overlayOpen: isShellActionKeyOverlayOpen({
        hasOverlayOpen: input.hasOverlayOpen,
        contextInspectorOpen: input.contextInspectorOpen,
        telemetryPanelOpen,
        agentConsoleOpen: input.agentConsoleOpen,
        activeSlashInput: input.activeSlashInput,
      }),
    });
    if (shellActionOwnership === "starter") {
      const starterPrompt = getWorkShellStarterPromptForKey(value, input.uiLocale ?? "en");
      if (starterPrompt !== undefined) {
        escapeResetArmedAtRef.current = undefined;
        input.replaceValue(starterPrompt);
        return;
      }
    }
    // Decision bar one-key replies. The shared predicate above already
    // narrowed the keystroke to Esc or an in-range digit for a single-question
    // decision, so consuming it here keeps the Rust Esc ladder (busy-turn
    // interrupt, overlay close) untouched whenever no decision is pending.
    if (shellActionOwnership === "decision") {
      if (key.escape && input.cancelPendingDecision && input.pendingDecisionId) {
        escapeResetArmedAtRef.current = undefined;
        const decisionId = input.pendingDecisionId;
        void Promise.resolve()
          .then(() => input.cancelPendingDecision?.(decisionId))
          .catch(() => undefined);
        return;
      }
      const oneKeyIndex = Number(value);
      if (
        !key.escape
        && input.answerPendingDecisionByIndex
        && input.pendingDecisionId
        && Number.isSafeInteger(oneKeyIndex)
        && oneKeyIndex >= 1
      ) {
        escapeResetArmedAtRef.current = undefined;
        const decisionId = input.pendingDecisionId;
        void Promise.resolve()
          .then(() => input.answerPendingDecisionByIndex?.(oneKeyIndex, decisionId))
          .catch(() => undefined);
        return;
      }
    }
    // `?` keymap: the shared predicate claimed the character for the shell,
    // so one keystroke dispatches /help through the controller's own submit —
    // the exact route typing "/help" + Enter takes. The engine's slash
    // handling owns opening the panel; this branch never builds one itself.
    if (shellActionOwnership === "keymap") {
      escapeResetArmedAtRef.current = undefined;
      input.replaceValue("");
      void submit("/help").catch(() => undefined);
      return;
    }

    // Task 11 transcript scrollback (PageUp/PageDown). Every owner above —
    // the console, the telemetry hotkeys, the context desk (its pagination
    // outranks this branch), the shell action keys — has passed on the
    // keystroke, and the Rust resolver maps neither key in the main view, so
    // this branch is their only meaning. Scrolling is not a print key: it
    // must work with a draft in the composer, unlike the characters above.
    // The wiring gate keeps both keys dead on hosts that never threaded the
    // offset instead of swallowing them with no action behind them.
    const transcriptScrollOverlayOpen = isShellActionKeyOverlayOpen({
      hasOverlayOpen: input.hasOverlayOpen,
      contextInspectorOpen: input.contextInspectorOpen,
      telemetryPanelOpen,
      agentConsoleOpen: input.agentConsoleOpen,
      activeSlashInput: input.activeSlashInput,
    })
      // The desk's title fallback also blocks scrolling behind an open desk
      // when a draft has already taken the desk branch out of play — the
      // transcript is not rendered there, so a scroll would be invisible.
      || contextDeskOwnsKeyboard;
    const transcriptNavigation = resolveWorkShellTranscriptNavigation({ value, key });
    if (
      !key.ctrl
      && !transcriptScrollOverlayOpen
      && transcriptNavigation.type === "page"
      && input.moveTranscriptPage
    ) {
      escapeResetArmedAtRef.current = undefined;
      input.moveTranscriptPage(transcriptNavigation.direction);
      return;
    }
    // Esc gains one meaning: while the transcript is scrolled, an Esc that no
    // earlier owner claimed returns it to the newest entry. It sits behind
    // the console close, the decision cancel, and the desk branch above, and
    // its gates yield to the resolver's remaining Esc owners (busy-turn
    // interrupt, sensitive-entry cancel, draft clear-arm), so no existing Esc
    // behavior is replaced — this only consumes an Esc that would otherwise
    // do nothing: idle, no overlay, empty composer, scrolled.
    if (
      key.escape
      && !key.ctrl
      && !transcriptScrollOverlayOpen
      && input.transcriptScrolledUp
      && input.returnTranscriptToNewest
      && !input.isBusy
      && input.composerMode !== "api-key-entry"
      && composerRawEmpty
    ) {
      escapeResetArmedAtRef.current = undefined;
      input.returnTranscriptToNewest();
      return;
    }
    if (
      !key.ctrl
      && !transcriptScrollOverlayOpen
      && transcriptNavigation.type === "latest"
      && input.transcriptScrolledUp
      && input.returnTranscriptToNewest
      && !input.isBusy
      && input.composerMode !== "api-key-entry"
    ) {
      escapeResetArmedAtRef.current = undefined;
      input.returnTranscriptToNewest();
      return;
    }

    const slashInput = input.activeSlashInput;
    const nowMs = Date.now();
    const escapeResetArmedAt = escapeResetArmedAtRef.current;
    const escapeResetArmed = key.escape
      && escapeResetArmedAt !== undefined
      && nowMs - escapeResetArmedAt <= 1200;
    const action = resolveWorkShellInputAction({
      value,
      key,
      input: slashInput ?? input.value,
      slashSuggestionCount: input.slashSuggestionCount,
      ...(input.selectedSlashCommand
        ? { selectedSlashCommand: input.selectedSlashCommand }
        : {}),
      isBusy: input.isBusy,
      currentMode: input.currentMode,
      hasRequestSessionsView: Boolean(input.onRequestSessionsView),
      ...(input.hasSensitiveInput ? { hasSensitiveInput: input.hasSensitiveInput } : {}),
      ...(input.hasOverlayOpen ? { hasOverlayOpen: input.hasOverlayOpen } : {}),
      ...(slashInput ? { hasSlashPicker: true } : {}),
      ...(escapeResetArmed ? { escapeResetArmed } : {}),
    });
    const canArmEscapeReset = key.escape
      && action.type === "none"
      && !input.isBusy
      && !input.hasSensitiveInput
      && !input.hasOverlayOpen
      && !slashInput
      && input.value.trim().length > 0;
    escapeResetArmedAtRef.current = canArmEscapeReset ? nowMs : undefined;

    switch (action.type) {
      case "exit":
        input.onExit();
        return;
      case "complete-slash":
        input.replaceValue(action.value);
        return;
      case "move-slash-selection":
        input.setSelectedSlashIndex((current) =>
          cycleWorkShellSlashSelection(current, input.slashSuggestionCount, action.direction),
        );
        return;
      case "close-slash-picker":
        input.replaceValue("");
        input.closeSlashPicker?.();
        return;
      case "cycle-mode":
        void Promise.resolve(input.cycleMode(action.nextMode)).catch(() => undefined);
        return;
      case "cancel-sensitive-input":
        input.cancelSensitiveInput?.();
        return;
      case "interrupt-turn":
        input.interruptTurn?.();
        return;
      case "clear-input":
        input.replaceValue("");
        return;
      case "close-overlay":
        input.closeOverlay?.();
        return;
      case "open-engine-sessions":
        input.openEngineSessions();
        return;
      case "none":
        return;
    }
  }, { isActive: true });

  return { submit };
}

export function areContextAdviceActionsAvailable(input: {
  readonly enabled: boolean;
  readonly selectedSuggestion?: ContextPolicySuggestion | undefined;
  readonly accept?: ((suggestionId: string) => Promise<void>) | undefined;
  readonly reject?: ((suggestionId: string) => Promise<void>) | undefined;
}): boolean {
  return input.enabled
    && input.selectedSuggestion !== undefined
    && input.accept !== undefined
    && input.reject !== undefined;
}

/**
 * Enter belongs to Context Desk expansion only when the host wires the
 * handler and the canonical active-collection row declares preview support.
 * The selected row is resolved after collection filtering so cursor identity
 * matches the renderer and engine.
 */
export function resolveContextInspectorExpandOwnership(input: {
  readonly hostExpandAvailable: boolean;
  readonly packet?: ContextPacketView | undefined;
  readonly collection?: ContextDeskCollection | undefined;
  readonly cursor?: number | undefined;
}): boolean {
  if (!input.hostExpandAvailable || !input.packet) {
    return false;
  }
  const rows = filterContextDeskRows(
    buildContextInspectorRows(input.packet),
    input.collection ?? "all",
  );
  const selectedRow = resolveContextDeskSelectedRow(rows, input.cursor ?? -1);
  return resolveContextInspectorSourceCapabilities(selectedRow?.item).preview;
}

export function useWorkShellPaneState<
  Attachment extends { readonly dataUrl: string; readonly mimeType?: string },
  State extends WorkShellPaneRuntimeState,
>(input: {
  readonly engine: WorkShellPaneEngine<State>;
  readonly cwd: string;
  readonly resolveComposerInput: (
    value: string,
    cwd: string,
  ) => Promise<WorkShellComposerPreview<Attachment>>;
  readonly getSuggestions: (value: string) => readonly WorkShellSlashSuggestion[];
  readonly browserOAuthAvailable?: boolean;
  readonly onExit: () => void;
  readonly onRequestSessionsView?: (() => void) | undefined;
  readonly onSyncHomeState?: ((homeState: Partial<TuiShellHomeState>) => void) | undefined;
  readonly refreshHomeState?: (() => Promise<TuiShellHomeState>) | undefined;
  readonly shouldBlockSlashSubmit: (line: string) => boolean;
  /** The pane disposes only engines it created; shared runtime owners outlive a view detach. */
  readonly engineOwnership?: WorkShellEngineOwnership | undefined;
  /**
   * Task 11 scrollback: the pane's measured terminal rows, threaded so the
   * PageUp/PageDown step and the rendered window derive from one capacity
   * calculation. Left undefined, a legacy host keeps a default-rows step.
   */
  readonly terminalRows?: number | undefined;
  /** Physical columns used for wrapped rendered-row scroll anchoring. */
  readonly terminalColumns?: number | undefined;
}) {
  const [inputValue, setInputValueState] = useState("");
  const [composerResetEpoch, setComposerResetEpoch] = useState(0);
  const pendingInputValueRef = useRef("");
  const setInputValue = useCallback((value: SetStateAction<string>): void => {
    const nextValue = typeof value === "function"
      ? value(pendingInputValueRef.current)
      : value;
    pendingInputValueRef.current = nextValue;
    setInputValueState(nextValue);
  }, []);
  // Clipboard-pasted attachments live alongside the input value but
  // outside the text-derived `resolveComposerInput` flow. They are kept
  // in pane state so they survive every keystroke and only flush on
  // submit. The structural shape is identical to text-derived
  // attachments (dataUrl + mimeType + path + displayName), so the merge
  // in useWorkShellComposerPreview can dedup by dataUrl.
  const [pendingClipboardAttachments, setPendingClipboardAttachments] = useState<
    readonly Attachment[]
  >([]);
  const addClipboardAttachment = useCallback(
    (attachment: Attachment): { readonly accepted: true } | ClipboardAttachmentRejection => {
      const startedAt = Date.now();
      const capDecision = checkClipboardCapViolation(attachment, pendingClipboardAttachments);
      if (!capDecision.accepted) {
        input.engine.recordTraceEvent?.({
          type: "attachment.dropped",
          level: "default",
          source: "clipboard",
          reason: "cap-exceeded",
          byteEstimate: capDecision.byteEstimate,
          mimeType: attachment.mimeType ?? "application/octet-stream",
          startedAt,
        });
        return capDecision;
      }
      setPendingClipboardAttachments((current) => {
        if (current.some((existing) => existing.dataUrl === attachment.dataUrl)) {
          return current;
        }
        return [...current, attachment];
      });
      input.engine.recordTraceEvent?.({
        type: "attachment.attached",
        level: "default",
        source: "clipboard",
        mimeType: attachment.mimeType ?? "application/octet-stream",
        byteEstimate: capDecision.byteEstimate,
        startedAt,
      });
      return { accepted: true };
    },
    [pendingClipboardAttachments, input.engine],
  );
  // User-initiated clear (NOT submit clear — that path stays silent per
  // the Q6 design: emitting one dropped per cleared attachment on every
  // successful turn would create N attached + N dropped noise).
  const dropClipboardAttachmentsAsUserCleared = useCallback(() => {
    setPendingClipboardAttachments((current) => {
      if (current.length === 0) return current;
      const startedAt = Date.now();
      for (const item of current) {
        input.engine.recordTraceEvent?.({
          type: "attachment.dropped",
          level: "default",
          source: "clipboard",
          reason: "user-cleared",
          byteEstimate: estimateAttachmentBytes(item),
          mimeType: item.mimeType ?? "application/octet-stream",
          startedAt,
        });
      }
      return [];
    });
  }, [input.engine]);
  const clearClipboardAttachments = useCallback((submitted: readonly Attachment[]) => {
    // Submit-time clear stays silent. Remove only the captured submission
    // snapshot so an image pasted while the engine is awaiting remains queued.
    const submittedDataUrls = new Set(submitted.map((item) => item.dataUrl));
    setPendingClipboardAttachments((current) => {
      const remaining = current.filter((item) => !submittedDataUrls.has(item.dataUrl));
      return remaining.length === current.length ? current : remaining;
    });
  }, []);
  const engineState = useWorkShellEngineState(input.engine, {
    ownership: input.engineOwnership ?? "owned",
  });
  // Task 11 transcript scrollback: the offset counts rendered terminal rows
  // hidden below the visible window; 0 is bottom-follow. New entries arrive
  // from the engine outside React events, so the arrival reset is a
  // subscription-shaped effect keyed on rendered row count, not a prop mirror:
  // an engine emit that rebuilds the array without new rows does not move it.
  const [transcriptAnchor, setTranscriptAnchor] = useState<
    ReturnType<typeof createWorkShellTranscriptAnchor>
  >(undefined);
  const transcriptEntries = projectWorkShellTranscript(
    engineState.entries,
    engineState.streamingAssistantText,
  );
  const transcriptRowWidth = Math.max(8, (input.terminalColumns ?? 80) - 4);
  // The scroll position is content-addressed, not a mutable row delta. New
  // entries, streaming updates, and terminal resize all recompute from the
  // same entry id + intra-entry row and therefore cannot reinterpret wrapping
  // growth as an append.
  const transcriptScrollOffset = resolveWorkShellTranscriptOffsetFromAnchor(
    transcriptEntries,
    transcriptRowWidth,
    transcriptAnchor,
    engineState.traceMode ?? "verbose",
  );
  // One page is exactly the rendered row budget used by the view. Wrapped CJK
  // and multi-row tool output therefore move and clamp in the same units.
  const moveTranscriptPage = useCallback(
    (direction: -1 | 1) => {
      setTranscriptAnchor((currentAnchor) => {
        const visibleEntries = projectWorkShellTranscript(
          engineState.entries,
          engineState.streamingAssistantText,
        );
        const rowWidth = Math.max(8, (input.terminalColumns ?? 80) - 4);
        const current = resolveWorkShellTranscriptOffsetFromAnchor(
          visibleEntries,
          rowWidth,
          currentAnchor,
          engineState.traceMode ?? "verbose",
        );
        const transcriptPageRows = getWorkShellTranscriptAvailableRows(input.terminalRows);
        const totalRows = visibleEntries.reduce(
          (sum, entry) => sum + measureWorkShellEntryRows(entry, rowWidth, engineState.traceMode ?? "verbose"),
          0,
        );
        const maxOffset = Math.max(0, totalRows - transcriptPageRows);
        // PageUp (direction -1) moves toward older entries, which hides more
        // of them below the window — the offset grows, not shrinks.
        const next = current - direction * transcriptPageRows;
        return createWorkShellTranscriptAnchor(
          visibleEntries,
          rowWidth,
          Math.max(0, Math.min(maxOffset, next)),
          engineState.traceMode ?? "verbose",
        );
      });
    },
    [engineState.entries, engineState.streamingAssistantText, engineState.traceMode, input.terminalColumns, input.terminalRows],
  );
  const returnTranscriptToNewest = useCallback(() => {
    setTranscriptAnchor(undefined);
  }, []);
  const contextExpandActionsEnabled = resolveContextInspectorExpandOwnership({
    hostExpandAvailable: typeof input.engine.toggleContextInspectorExpanded === "function",
    packet: engineState.contextPacket,
    collection: engineState.contextInspectorCollection,
    cursor: engineState.contextInspectorCursor,
  });
  const enginePanelKey = getWorkShellPanelDismissKey(engineState.panel);
  const ignoreNextSlashDismissResetRef = useRef(false);
  const [dismissedSlashPickerPanelTitle, setDismissedSlashPickerPanelTitle] = useState<string | undefined>(undefined);
  const [dismissedSlashPickerPanelKey, setDismissedSlashPickerPanelKey] = useState<string | undefined>(undefined);
  const isFallbackPanelDismissed =
    dismissedSlashPickerPanelKey === enginePanelKey ||
    dismissedSlashPickerPanelTitle === engineState.panel.title;
  const fallbackPanel = isFallbackPanelDismissed
    ? DISMISSED_SLASH_PICKER_PANEL
    : engineState.panel;
  const composerPreview = useWorkShellComposerPreview({
    value: inputValue,
    cwd: input.cwd,
    resolveComposerInput: input.resolveComposerInput,
    pendingAttachments: pendingClipboardAttachments,
  });

  useWorkShellDashboardHomeSync({
    isBusy: engineState.isBusy,
    authLabel: engineState.authLabel,
    bridgeLines: engineState.bridgeLines,
    memoryLines: engineState.memoryLines,
    onSyncHomeState: input.onSyncHomeState,
    refreshHomeState: input.refreshHomeState,
  });

  const {
    suggestions: slashSuggestions,
    setSelectedIndex: setSelectedSlashIndex,
    selectedSuggestion,
    activeSlashInput,
    activePanel,
  } = useWorkShellSlashState({
    value: inputValue,
    activeSlashInput: resolveWorkShellActiveSlashInput({
      value: inputValue,
      fallbackPanelTitle: fallbackPanel.title,
      fallbackPanelDismissed: isFallbackPanelDismissed,
    }),
    currentModel: engineState.model,
    ...(engineState.authLabel ? { authLabel: engineState.authLabel } : {}),
    ...(input.browserOAuthAvailable !== undefined
      ? { browserOAuthAvailable: input.browserOAuthAvailable }
      : {}),
    ...(engineState.authLauncherLines
      ? { authLauncherLines: engineState.authLauncherLines }
      : {}),
    fallbackPanel,
    getSuggestions: input.getSuggestions,
  });
  const isStickySlashPicker =
    activeSlashInput !== undefined && !inputValue.trim().startsWith("/");
  const queueOverlayOpen = activePanel.title === "Queue · follow-ups";
  const queueItemIds = useMemo(
    () => queueOverlayOpen ? parseQueuePanelItemIds(activePanel.lines) : [],
    [activePanel.lines, queueOverlayOpen],
  );
  const [storedQueueSelectedId, setQueueSelectedId] = useState<number | undefined>(undefined);
  const [queueActionError, setQueueActionError] = useState<string | undefined>(undefined);
  const queueSelectedId = storedQueueSelectedId !== undefined && queueItemIds.includes(storedQueueSelectedId)
    ? storedQueueSelectedId
    : queueItemIds[0];
  // Ink rebinds useInput in a passive effect. Keep the visible selection in a
  // synchronous ref so a mutation key arriving in the same terminal burst as
  // ↑/↓ can never act on the previously rendered row.
  const queueSelectedIdRef = useRef<number | undefined>(queueSelectedId);
  queueSelectedIdRef.current = queueSelectedId;
  const moveQueueSelection = useCallback((delta: -1 | 1) => {
    if (queueItemIds.length === 0) return;
    const selectedId = queueSelectedIdRef.current;
    const currentIndex = selectedId === undefined ? 0 : queueItemIds.indexOf(selectedId);
    const nextIndex = Math.max(0, Math.min(queueItemIds.length - 1, currentIndex + delta));
    const nextId = queueItemIds[nextIndex];
    queueSelectedIdRef.current = nextId;
    setQueueSelectedId(nextId);
  }, [queueItemIds]);
  const presentedActivePanel = queueOverlayOpen && queueActionError
    ? { ...activePanel, lines: [...activePanel.lines, "", `Queue action failed · ${queueActionError}`] }
    : activePanel;
  useEffect(() => {
    if (inputValue.trim().startsWith("/")) {
      if (ignoreNextSlashDismissResetRef.current) {
        return;
      }
      setDismissedSlashPickerPanelKey(undefined);
      setDismissedSlashPickerPanelTitle(undefined);
    } else {
      ignoreNextSlashDismissResetRef.current = false;
    }
  }, [inputValue]);

  const openEngineSessions = useCallback(() => {
    void input.engine.openSessionsPanel().catch(() => undefined);
  }, [input.engine]);

  const handleSubmit = useCallback(
    // Close over the live pending list so paste-derived attachments cross the
    // engine boundary at submit time. Without this closure, attachments stay
    // in TUI hook state and the agent never sees them — Hermes review of
    // commit 40ab895 caught the regression.
    (line: string) => {
      // A submission always returns the transcript to the newest entry:
      // the operator has moved on from reading history.
      setTranscriptAnchor(undefined);
      return input.engine.getState().composerMode === "agent-steer"
        && input.engine.submitAgentSteer !== undefined
        ? input.engine.submitAgentSteer(line)
        : input.engine.handleSubmit(line, pendingClipboardAttachments);
    },
    [input.engine, pendingClipboardAttachments],
  );

  const cycleMode = useCallback(
    async (nextMode: string) => {
      await input.engine.setMode(nextMode);
    },
    [input.engine],
  );
  const selectedContextRow = useMemo(() => {
    const packet = engineState.contextPacket;
    const cursor = engineState.contextInspectorCursor ?? -1;
    if (!packet || cursor < 0) {
      return undefined;
    }
    return resolveContextDeskSelectedRow(
      filterContextDeskRows(
        buildContextInspectorRows(packet),
        engineState.contextInspectorCollection ?? "all",
      ),
      cursor,
    );
  }, [
    engineState.contextInspectorCollection,
    engineState.contextInspectorCursor,
    engineState.contextPacket,
  ]);
  const selectedContextSuggestion = useMemo(() => {
    return getSelectedVisibleContextPolicySuggestion({
      packet: engineState.contextPacket,
      suggestions: engineState.contextPolicySuggestions ?? [],
      selectedSourceId: selectedContextRow?.item.id,
    });
  }, [
    engineState.contextPacket,
    engineState.contextPolicySuggestions,
    selectedContextRow,
  ]);
  const selectedContextCapabilities = resolveContextInspectorSourceCapabilities(
    selectedContextRow?.item,
  );
  const contextPinActionsAvailable = Boolean(
    engineState.contextSourceActionsEnabled
    && input.engine.toggleContextInspectorPin
    && (selectedContextCapabilities.pin || selectedContextCapabilities.unpin),
  );
  const contextDeliveryActionsAvailable = Boolean(
    engineState.contextSourceActionsEnabled
    && (
      selectedContextCapabilities.delivery === "include"
        ? input.engine.includeContextSourceAtCursor
        : selectedContextCapabilities.delivery === "hold-back"
          ? input.engine.forgetContextSourceAtCursor
          : false
    ),
  );
  const contextAdviceActionsAvailable = areContextAdviceActionsAvailable({
    enabled: engineState.contextAdviceActionsEnabled ?? false,
    selectedSuggestion: selectedContextSuggestion,
    accept: input.engine.acceptContextSuggestion,
    reject: input.engine.rejectContextSuggestion,
  });
  const contextUndoActionsAvailable = Boolean(
    engineState.contextSourceActionsEnabled
    && engineState.contextActionReceipt?.canUndo
    && input.engine.undoLastContextSourceAction,
  );
  const agentConsoleDecisionCacheRef = useRef<{
    readonly value: string;
    readonly keyMask: number;
    readonly composerEmpty: boolean;
    readonly decision: AgentConsoleInputDecision;
  } | undefined>(undefined);

  // Agent Console (Sprint 3). The seam exists only when the engine wires the
  // controls AND publishes a view, so a pane without console support keeps
  // Alt+A as ordinary typing instead of gaining a dead key.
  const agentConsoleView = engineState.agentConsoleView;
  const agentConsoleComposerMode = engineState.composerMode ?? "default";
  const agentConsoleWired = agentConsoleView !== undefined
    && input.engine.openAgentConsole !== undefined;
  // The one definition of "the steer composer is live". The controller's
  // submit routing, the pane's submit routing, the cursor, and the panel
  // suppressions all read this, so none of them can disagree.
  const agentConsoleSteering = agentConsoleWired
    && agentConsoleView.open
    && agentConsoleComposerMode === "agent-steer";
  // Leaving the steer composer, by `Esc` or by closing the console, has to
  // take the draft with it: a half-typed message addressed to an agent must
  // never be left behind as a chat prompt one Enter away from the provider.
  const leaveAgentSteerComposer = () => {
    setInputValue("");
    setComposerResetEpoch((current) => current + 1);
    input.engine.cancelSensitiveInput?.();
  };
  const buildAgentConsoleContextForScope = (
    scope: AgentConsoleDecisionScope,
    value: string,
    key: AgentConsoleKeyState,
    composerEmpty: boolean,
  ): AgentConsoleInputContext => ({
    value,
    key,
    composerEmpty,
    open: scope.view?.open ?? false,
    tab: scope.view?.tab ?? "agents",
    control: scope.view?.control.kind ?? "browse",
    composerMode: scope.composerMode,
    // A sticky picker panel keeps its keys even with an empty composer, so
    // the panel-derived slash input counts too.
    slashPickerActive:
      activeSlashInput !== undefined || value.trim().startsWith("/"),
  });
  const buildAgentConsoleContext = (
    value: string,
    key: AgentConsoleKeyState,
    composerEmpty: boolean,
  ): AgentConsoleInputContext => {
    const liveState = input.engine.getState();
    return buildAgentConsoleContextForScope(
      {
        view: liveState.agentConsoleView ?? agentConsoleView,
        composerMode: liveState.composerMode ?? "default",
      },
      value,
      key,
      composerEmpty,
    );
  };
  const decideAgentConsoleInput = (
    value: string,
    key: AgentConsoleKeyState,
    composerEmpty: boolean,
    phase: "dispatch" | "suppress",
  ): AgentConsoleInputDecision => {
    const keyMask = agentConsoleKeyMask(key);
    // One engine read feeds the fresh decision and its resolver context.
    const liveState = input.engine.getState();
    const scope: AgentConsoleDecisionScope = {
      view: liveState.agentConsoleView ?? agentConsoleView,
      composerMode: liveState.composerMode ?? "default",
    };
    const cached = agentConsoleDecisionCacheRef.current;
    // The controller computes and caches; Composer consumes. A standalone
    // suppression check never leaves a decision behind for another event.
    if (
      phase === "suppress"
      && cached
      && cached.value === value
      && cached.keyMask === keyMask
      && cached.composerEmpty === composerEmpty
    ) {
      agentConsoleDecisionCacheRef.current = undefined;
      return cached.decision;
    }
    if (phase === "suppress") {
      agentConsoleDecisionCacheRef.current = undefined;
    }
    const resolvedDecision = resolveAgentConsoleInputDecision(
      buildAgentConsoleContextForScope(scope, value, key, composerEmpty),
    );
    const decision: AgentConsoleInputDecision =
      scope.composerMode === "agent-steer"
      && resolvedDecision.kind === "dispatch"
      && (resolvedDecision.action.kind === "close" || resolvedDecision.action.kind === "cancel-steer")
        ? { ...resolvedDecision, discardComposer: true }
        : resolvedDecision;
    if (phase === "dispatch") {
      const next = { value, keyMask, composerEmpty, decision };
      agentConsoleDecisionCacheRef.current = next;
      queueMicrotask(() => {
        if (agentConsoleDecisionCacheRef.current === next) {
          agentConsoleDecisionCacheRef.current = undefined;
        }
      });
    }
    return decision;
  };
  const agentConsoleKeyboard: WorkShellAgentConsoleKeyboard | undefined =
    agentConsoleView && agentConsoleWired
      ? {
          steering: agentConsoleSteering,
          buildContext: buildAgentConsoleContext,
          decide: decideAgentConsoleInput,
          controls: {
            open: () => input.engine.openAgentConsole?.(),
            close: () => {
              if (input.engine.getState().composerMode === "agent-steer") {
                leaveAgentSteerComposer();
              }
              input.engine.closeAgentConsole?.();
            },
            selectTab: (tab) => input.engine.selectAgentConsoleTab?.(tab),
            moveCursor: (delta) => input.engine.moveAgentConsoleCursor?.(delta),
            toggleInspector: () => input.engine.toggleAgentConsoleInspector?.(),
            beginSteer: () => {
              const liveState = input.engine.getState();
              const liveView = liveState.agentConsoleView;
              const liveSnapshot = liveState.agentConsole;
              const selection = liveView && liveSnapshot
                ? resolveAgentConsoleSelection(liveView, liveSnapshot)
                : undefined;
              const started = input.engine.beginAgentSteer?.(
                selection?.tab === "agents" ? selection.run.id : undefined,
              );
              if (started && typeof (started as PromiseLike<unknown>).then === "function") {
                void Promise.resolve(started).catch(() => {
                  leaveAgentSteerComposer();
                });
              }
            },
            cancelSteer: leaveAgentSteerComposer,
            requestCancel: () => input.engine.requestAgentCancel?.(),
            confirmCancel: (confirmed) => {
              void input.engine.confirmAgentCancel?.(confirmed).catch(() => undefined);
            },
            continueRun: () => {
              void input.engine.continueSelectedAgent?.().catch(() => undefined);
            },
          },
        }
      : undefined;
  const suppressAgentConsoleKey = agentConsoleKeyboard
    ? (value: string, key: AgentConsoleKeyState, composerEmpty: boolean) => {
      const decision = agentConsoleKeyboard.decide(value, key, composerEmpty, "suppress");
      if (decision.kind === "compose") {
        return "compose" as const;
      }
      if (decision.kind === "dispatch" && decision.discardComposer === true) {
        return "consume-reset" as const;
      }
      return decision.kind === "dispatch" || decision.kind === "consume";
    }
    : undefined;
  const agentConsoleOwnsKeyboard = agentConsoleWired
    && agentConsoleView.open
    && !agentConsoleSteering;

  // Decision bar threading: the pending AskUserQuestion lives on the agent
  // console snapshot, and the one-key capability is probed on the engine the
  // same way the console controls are. A host that wires neither method keeps
  // digits and Esc on their existing meanings instead of gaining dead keys.
  const pendingDecisionRequest = engineState.agentConsole?.pendingDecision;
  const decisionSingleQuestion = pendingDecisionRequest?.questions.length === 1
    ? pendingDecisionRequest.questions[0]
    : undefined;
  const decisionOneKeyWired = input.engine.answerPendingDecisionByIndex !== undefined
    && input.engine.cancelPendingDecision !== undefined;
  const decisionPending = decisionOneKeyWired && pendingDecisionRequest !== undefined;
  const decisionOptionCount = decisionSingleQuestion?.options.length;

  // The Composer asks the same shared ownership predicate the input
  // controller dispatched on, so a shell action character (a starter digit,
  // a decision one-key reply) never also lands in the draft. Ctrl chords
  // arrive as control codes, which the predicate's exact character match
  // already rejects, so the keystroke's ctrl flag is not needed on this side.
  const suppressShellActionKeys = (value: string, composerEmpty: boolean): boolean =>
    resolveShellActionKeyOwnership({
      input: value,
      ctrl: false,
      composerEmpty,
      hasConversation: engineState.entries.some(shouldShowWorkShellConversationEntry),
      isBusy: engineState.isBusy,
      composerMode: engineState.composerMode,
      decisionPending,
      decisionOptionCount,
      overlayOpen: isShellActionKeyOverlayOpen({
        hasOverlayOpen: shouldReportWorkShellOverlayOpen({
          panelTitle: engineState.panel.title,
          inputValue,
        }),
        contextInspectorOpen: engineState.contextInspectorOpen,
        telemetryPanelOpen:
          activePanel.title === "Cache Telemetry"
          || activePanel.title === "Agent History",
        agentConsoleOpen: agentConsoleView?.open === true,
        activeSlashInput,
      }),
    }) !== undefined;



  const { submit } = useWorkShellInputController({
    value: inputValue,
    uiLocale: engineState.uiLocale ?? "en",
    replaceValue: setInputValue,
    slashSuggestionCount: slashSuggestions.length,
    ...(selectedSuggestion?.command
      ? { selectedSlashCommand: selectedSuggestion.command }
      : {}),
    ...(activeSlashInput ? { activeSlashInput } : {}),
    setSelectedSlashIndex,
    isBusy: engineState.isBusy,
    currentMode: engineState.mode,
    onExit: input.onExit,
    onRequestSessionsView: input.onRequestSessionsView,
    ...(input.engine.toggleToolHistoryDisplay
      ? { toggleToolHistoryDisplay: () => input.engine.toggleToolHistoryDisplay!() }
      : {}),
    ...(engineState.agentConsole?.workGraph?.qualityProfile
      ? {
          toggleQualityPlan: () => {
            const view = input.engine.getState().agentConsoleView;
            if (view?.open && view.tab === "plan") input.engine.closeAgentConsole?.();
            else input.engine.openAgentConsole?.("plan");
          },
        }
      : {}),
    openEngineSessions,
    cycleMode,
    shouldBlockSlashSubmit: input.shouldBlockSlashSubmit,
    handleSubmit,
    isComposerRawEmpty: () => isRawComposerEmpty(
      inputValue,
      pendingInputValueRef.current,
    ),
    hasSensitiveInput: engineState.composerMode === "api-key-entry",
    hasOverlayOpen: shouldReportWorkShellOverlayOpen({
      panelTitle: engineState.panel.title,
      inputValue,
    }),
    // Shell action keys: the controller has no transcript or composer-mode
    // knowledge of its own, so the pane threads the live engine facts the
    // shared ownership predicate reads. `hasConversation` mirrors the view's
    // own emptiness test (internal traces and hidden worker meta do not
    // count), keeping the rendered starter list and the hotkey gate in sync.
    hasConversation: engineState.entries.some(shouldShowWorkShellConversationEntry),
    composerMode: engineState.composerMode,
    agentConsoleOpen: agentConsoleView?.open === true,
    // Decision bar: pending state from the agent console snapshot plus the
    // engine capability probes, so the ladder can answer or cancel with one
    // key while the decision is on screen.
    decisionPending,
    ...(pendingDecisionRequest?.id ? { pendingDecisionId: pendingDecisionRequest.id } : {}),
    ...(decisionOptionCount !== undefined ? { decisionOptionCount } : {}),
    ...(input.engine.submitPendingDecisionText
      ? {
          submitPendingDecisionText: (value: string, decisionId: string) =>
            input.engine.submitPendingDecisionText?.(value, decisionId) ?? false,
        }
      : {}),
    ...(input.engine.answerPendingDecisionByIndex
      ? {
          answerPendingDecisionByIndex: (index: number, decisionId: string) =>
            input.engine.answerPendingDecisionByIndex?.(index, decisionId) ?? false,
        }
      : {}),
    ...(input.engine.cancelPendingDecision
      ? {
          cancelPendingDecision: (decisionId: string) =>
            input.engine.cancelPendingDecision?.(decisionId) ?? false,
        }
      : {}),
    queueOverlayOpen,
    ...(queueSelectedId !== undefined ? { queueSelectedId } : {}),
    moveQueueSelection,
    ...(queueSelectedId !== undefined && input.engine.removeQueueItem
      ? {
          removeSelectedQueueItem: async () => {
            const selectedId = queueSelectedIdRef.current;
            if (selectedId === undefined) return;
            const index = queueItemIds.indexOf(selectedId);
            const fallback = queueItemIds[index + 1] ?? queueItemIds[index - 1];
            try {
              const removed = await input.engine.removeQueueItem?.(selectedId);
              if (!removed) throw new Error(`item ${selectedId} is not pending`);
              setQueueActionError(undefined);
              queueSelectedIdRef.current = fallback;
              setQueueSelectedId(fallback);
            } catch (error) {
              setQueueActionError(error instanceof Error ? error.message : String(error));
            }
          },
        }
      : {}),
    ...(queueSelectedId !== undefined && input.engine.moveQueueItem
      ? { moveSelectedQueueItem: async (direction: "up" | "down") => {
          const selectedId = queueSelectedIdRef.current;
          if (selectedId === undefined) return;
          try {
            const moved = await input.engine.moveQueueItem?.(selectedId, direction);
            if (!moved) throw new Error(`item ${selectedId} cannot move ${direction}`);
            setQueueActionError(undefined);
          } catch (error) {
            setQueueActionError(error instanceof Error ? error.message : String(error));
          }
        } }
      : {}),
    ...(input.engine.clearQueueItems
      ? { clearQueueItems: async () => {
          try {
            await input.engine.clearQueueItems?.();
            setQueueActionError(undefined);
          } catch (error) {
            setQueueActionError(error instanceof Error ? error.message : String(error));
          }
        } }
      : {}),
    ...(input.engine.resumeQueueItems
      ? { resumeQueueItems: async () => {
          try {
            await input.engine.resumeQueueItems?.();
            setQueueActionError(undefined);
          } catch (error) {
            setQueueActionError(error instanceof Error ? error.message : String(error));
          }
        } }
      : {}),
    ...(queueSelectedId !== undefined && input.engine.retryQueueItem
      ? { retrySelectedQueueItem: async () => {
          const selectedId = queueSelectedIdRef.current;
          if (selectedId === undefined) return;
          try {
            const retried = await input.engine.retryQueueItem?.(selectedId);
            if (!retried) throw new Error(`item ${selectedId} cannot be retried`);
            setQueueActionError(undefined);
          } catch (error) {
            setQueueActionError(error instanceof Error ? error.message : String(error));
          }
        } }
      : {}),
    ...(queueSelectedId !== undefined && input.engine.discardQueueItem
      ? { discardSelectedQueueItem: async () => {
          const selectedId = queueSelectedIdRef.current;
          if (selectedId === undefined) return;
          try {
            const discarded = await input.engine.discardQueueItem?.(selectedId);
            if (!discarded) throw new Error(`item ${selectedId} cannot be discarded`);
            setQueueActionError(undefined);
            const fallback = queueItemIds.find((id) => id !== selectedId);
            queueSelectedIdRef.current = fallback;
            setQueueSelectedId(fallback);
          } catch (error) {
            setQueueActionError(error instanceof Error ? error.message : String(error));
          }
        } }
      : {}),
    activePanelTitle: activePanel.title,
    closeSlashPicker: (panelTitle) => {
      if (isStickySlashPicker) {
        setDismissedSlashPickerPanelKey(enginePanelKey);
      }
      const dismissedPanelTitle = panelTitle ?? activePanel.title;
      if (dismissedPanelTitle === "Model picker") {
        if (panelTitle === "Model picker") {
          ignoreNextSlashDismissResetRef.current = true;
        }
        setDismissedSlashPickerPanelTitle(dismissedPanelTitle);
      }
    },
    ...(input.engine.cancelSensitiveInput
      ? { cancelSensitiveInput: () => input.engine.cancelSensitiveInput?.() }
      : {}),
    ...(input.engine.interruptTurn
      ? { interruptTurn: () => input.engine.interruptTurn?.() }
      : {}),
    ...(input.engine.closeOverlay
      ? { closeOverlay: () => input.engine.closeOverlay?.() }
      : {}),
    contextSourceActionsEnabled: engineState.contextSourceActionsEnabled ?? false,
    contextAdviceActionsEnabled: contextAdviceActionsAvailable,
    contextUndoActionsEnabled: contextUndoActionsAvailable,
    contextPinActionsEnabled: contextPinActionsAvailable,
    contextDeliveryActionsEnabled: contextDeliveryActionsAvailable,
    contextExpandActionsEnabled,
    ...(contextAdviceActionsAvailable && selectedContextSuggestion
      ? {
          acceptContextSuggestion: async () => {
            await input.engine.acceptContextSuggestion?.(selectedContextSuggestion.id);
          },
          rejectContextSuggestion: async () => {
            await input.engine.rejectContextSuggestion?.(selectedContextSuggestion.id);
          },
        }
      : {}),
    ...(contextUndoActionsAvailable
      ? {
          undoContextSourceAction: async () => {
            await input.engine.undoLastContextSourceAction?.();
          },
        }
      : {}),
    contextInspectorExpanded: engineState.contextInspectorExpanded,
    // Task 11 scrollback: the PageUp/PageDown branch and the scrolled-Esc
    // return above resolve through these; the offset lives here next to the
    // engine seams (entry arrival, submit) that reset it.
    moveTranscriptPage,
    returnTranscriptToNewest,
    transcriptScrolledUp: transcriptScrollOffset > 0,
    // Explicit desk ownership from engine state — the controller falls back to
    // the panel title only when a host has not wired this yet.
    contextInspectorOpen: engineState.contextInspectorOpen,
    contextInspectorPane: engineState.contextInspectorPane,
    // Context Inspector (Sprint 2): forward engine callbacks so the
    // controller's useInput can dispatch overlay keyboard actions.
    ...(input.engine.moveContextInspectorCursor
      ? { moveContextInspectorCursor: (direction: number) => { void input.engine.moveContextInspectorCursor?.(direction); } }
      : {}),
    ...(input.engine.moveContextInspectorPane
      ? { moveContextInspectorPane: (direction: number) => { input.engine.moveContextInspectorPane?.(direction); } }
      : {}),
    ...(input.engine.moveContextInspectorPage
      ? { moveContextInspectorPage: (direction: number) => { input.engine.moveContextInspectorPage?.(direction); } }
      : {}),
    ...(input.engine.moveContextInspectorDetailOffset
      ? { moveContextInspectorDetailOffset: (direction: number) => { input.engine.moveContextInspectorDetailOffset?.(direction); } }
      : {}),
    ...(input.engine.toggleContextInspectorPin
      ? { toggleContextInspectorPin: async () => { await input.engine.toggleContextInspectorPin?.(); } }
      : {}),
    ...(input.engine.forgetContextSourceAtCursor
      ? { forgetContextSourceAtCursor: async () => { await input.engine.forgetContextSourceAtCursor?.(); } }
      : {}),
    ...(input.engine.includeContextSourceAtCursor
      ? { includeContextSourceAtCursor: async () => { await input.engine.includeContextSourceAtCursor?.(); } }
      : {}),
    ...(input.engine.forgetContextSourceAtCursor && input.engine.includeContextSourceAtCursor
      ? {
          toggleContextSourceDelivery: async () => {
            const packet = engineState.contextPacket;
            const cursor = engineState.contextInspectorCursor;
            // Same collection-relative cursor as the advice lookup above, so
            // Space toggles the delivery of the row the user is actually on.
            const heldBack = packet && cursor !== undefined && cursor >= 0
              ? (resolveContextDeskSelectedRow(
                  filterContextDeskRows(
                    buildContextInspectorRows(packet),
                    engineState.contextInspectorCollection ?? "all",
                  ),
                  cursor,
                )?.heldBack ?? false)
              : false;
            if (heldBack) {
              await input.engine.includeContextSourceAtCursor?.();
            } else {
              await input.engine.forgetContextSourceAtCursor?.();
            }
          },
        }
      : {}),
    ...(input.engine.toggleContextInspectorExpanded
      ? { toggleContextInspectorExpanded: async () => { await input.engine.toggleContextInspectorExpanded?.(); } }
      : {}),
    ...(agentConsoleKeyboard ? { agentConsole: agentConsoleKeyboard } : {}),
  });

  return {
    inputValue,
    setInputValue,
    composerResetEpoch,
    engineState,
    /** Task 11 scrollback: entries hidden below the transcript window. */
    transcriptScrollOffset,
    composerPreview,
    activePanel: presentedActivePanel,
    queueSelectedId,
    slashSuggestionCount: slashSuggestions.length,
    selectedSlashCommand: selectedSuggestion?.command,
    contextAdviceKeyActionsEnabled: contextAdviceActionsAvailable,
    contextUndoKeyActionsEnabled: contextUndoActionsAvailable,
    contextPinKeyActionsEnabled: contextPinActionsAvailable,
    contextDeliveryKeyActionsEnabled: contextDeliveryActionsAvailable,
    contextExpandActionsEnabled,
    ...(suppressAgentConsoleKey ? { suppressAgentConsoleKey } : {}),
    suppressShellActionKeys,
    agentConsoleOwnsKeyboard,
    agentConsoleSteering,
    submit,
    addClipboardAttachment,
    clearClipboardAttachments,
    pendingClipboardAttachments,
    pendingClipboardAttachmentCount: pendingClipboardAttachments.length,
  };
}

/**
 * Pre-flight cap defaults — canonical values live in
 * packages/config-core/src/defaults.ts (CONFIG_CORE_DEFAULT_MAX_CLIPBOARD_*).
 * These re-exports keep the TUI public API stable while the config-core
 * resolution chain (built-in → plugin → project → user → env → cli →
 * session) matures.
 */
export const MAX_CLIPBOARD_ATTACHMENT_COUNT = 5;
export const MAX_CLIPBOARD_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export type ClipboardAttachmentRejection = {
  readonly accepted: false;
  readonly reason: string;
  readonly status: "no-image" | "unsupported" | "failed";
};

type ClipboardAttachmentCapDecision =
  | { readonly accepted: true; readonly byteEstimate: number }
  | (ClipboardAttachmentRejection & { readonly byteEstimate: number });

/**
 * Estimate the decoded byte size of a data URL payload without allocating
 * the buffer. We slice past the comma so the `data:image/png;base64,`
 * header bytes do not inflate the count — Hermes review of the v1 cap
 * scope flagged that header inclusion makes the cap conservatively wrong.
 * Each base64 character encodes 3/4 of a byte after dropping padding.
 */
function estimateDataUrlBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  const payload = commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
  let trailingPad = 0;
  for (let i = payload.length - 1; i >= 0; i -= 1) {
    if (payload[i] !== "=") break;
    trailingPad += 1;
  }
  return Math.max(0, Math.floor((payload.length * 3) / 4) - trailingPad);
}

/**
 * Pre-flight cap check applied at the addClipboardAttachment seam. Returns
 * a rejection record on violation so the caller can surface a one-line
 * toast through the existing onClipboardImageError channel without growing
 * the status taxonomy. v1 enforces only at the TUI boundary; provider-side
 * defensive caps are tracked as a follow-up per the Gemini design memo.
 */
/**
 * Decoded byte estimate for an attachment, exposed so the trace emit
 * sites and the cap check can share a single calculation. Sliced past
 * the comma so the `data:image/png;base64,` header bytes do not inflate
 * the count.
 */
function estimateAttachmentBytes(attachment: { readonly dataUrl: string }): number {
  return estimateDataUrlBytes(attachment.dataUrl);
}

function checkClipboardCapViolation<A extends { readonly dataUrl: string }>(
  attachment: A,
  current: readonly A[],
): ClipboardAttachmentCapDecision {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "clipboard-cap"],
      process.cwd(),
      JSON.stringify({ currentCount: current.length, dataUrl: attachment.dataUrl }),
    ),
  ) as unknown;
  if (
    typeof parsed !== "object"
    || parsed === null
    || !("accepted" in parsed)
    || typeof parsed.accepted !== "boolean"
    || !("byteEstimate" in parsed)
    || typeof parsed.byteEstimate !== "number"
    || !Number.isSafeInteger(parsed.byteEstimate)
  ) {
    throw new Error("Rust clipboard attachment cap returned an invalid payload.");
  }
  if (parsed.accepted) {
    return {
      accepted: true,
      byteEstimate: parsed.byteEstimate,
    };
  }
  if (
    !("status" in parsed)
    || parsed.status !== "failed"
    || !("reason" in parsed)
    || typeof parsed.reason !== "string"
  ) {
    throw new Error("Rust clipboard attachment cap returned an invalid rejection.");
  }
  return {
    accepted: false,
    status: "failed",
    reason: parsed.reason,
    byteEstimate: parsed.byteEstimate,
  };
}

/**
 * Two attachments are the same payload when their dataUrls are byte-equal —
 * that captures both the source bytes and the mime header without forcing
 * both producer paths to agree on a stable id. Exported so tests exercise
 * the production helper directly instead of byte-copying its body.
 */
export function dedupAttachmentsByDataUrl<A extends { readonly dataUrl: string }>(
  items: readonly A[],
): readonly A[] {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "attachment-dedup"],
      process.cwd(),
      JSON.stringify(items),
    ),
  ) as unknown;
  if (
    typeof parsed !== "object"
    || parsed === null
    || !("attachments" in parsed)
    || !Array.isArray(parsed.attachments)
  ) {
    throw new Error("Rust attachment dedup returned an invalid payload.");
  }
  const originalsByDataUrl = new Map<string, A>();
  for (const item of items) {
    if (!originalsByDataUrl.has(item.dataUrl)) {
      originalsByDataUrl.set(item.dataUrl, item);
    }
  }
  return parsed.attachments.map((attachment) => {
    if (
      typeof attachment !== "object"
      || attachment === null
      || !("dataUrl" in attachment)
      || typeof attachment.dataUrl !== "string"
    ) {
      throw new Error("Rust attachment dedup returned an invalid attachment.");
    }
    const original = originalsByDataUrl.get(attachment.dataUrl);
    if (!original) {
      throw new Error("Rust attachment dedup returned an unknown attachment.");
    }
    return original;
  });
}

export function useWorkShellComposerPreview<Attachment extends { readonly dataUrl: string }>(input: {
  readonly value: string;
  readonly cwd: string;
  readonly resolveComposerInput: (
    value: string,
    cwd: string,
  ) => Promise<WorkShellComposerPreview<Attachment>>;
  readonly pendingAttachments?: readonly Attachment[] | undefined;
}): WorkShellComposerPreview<Attachment> {
  const [preview, setPreview] = useState<WorkShellComposerPreview<Attachment>>(
    () => createEmptyWorkShellComposerPreview(),
  );

  useEffect(() => {
    const previewMode = resolveComposerPreviewMode(input.value);

    if (previewMode.mode === "empty") {
      setPreview(createEmptyWorkShellComposerPreview());
      return;
    }

    if (previewMode.mode === "fast") {
      setPreview({
        prompt: previewMode.prompt,
        attachments: [],
        transcriptText: previewMode.transcriptText,
      });
      return;
    }

    let cancelled = false;
    void input.resolveComposerInput(input.value, input.cwd)
      .then((nextPreview) => {
        if (!cancelled) {
          setPreview(nextPreview);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [input.cwd, input.resolveComposerInput, input.value]);

  // Merge text-derived attachments with clipboard / pending attachments at
  // render time so a paste-then-keystroke sequence does not lose the
  // pasted image. Memoised on (preview, pending) so downstream consumers
  // keep referential stability between renders that did not change either
  // input — without it every parent render allocated a new attachments
  // array and broke any useMemo keyed on the preview shape.
  const pending = input.pendingAttachments;
  return useMemo(() => {
    if (!pending || pending.length === 0) {
      return preview;
    }
    return {
      ...preview,
      attachments: dedupAttachmentsByDataUrl([...preview.attachments, ...pending]),
    };
  }, [preview, pending]);
}
