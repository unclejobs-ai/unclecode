import { useInput } from "ink";
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { runRustCommandSync } from "@unclecode/orchestrator";
import type {
  AgentConsoleSnapshot,
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
  isContextInspectorSourceHeldBack,
} from "./work-shell-context-inspector-model.js";
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
  resolveWorkShellSubmitAction,
} from "./work-shell-input.js";
import type { WorkShellEntry, WorkShellPanel } from "./work-shell-view.js";

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

export function useWorkShellEngineState<State>(engine: WorkShellStateSource<State>): State {
  const [state, setState] = useState(() => engine.getState());

  useEffect(() => {
    setState(engine.getState());
    const unsubscribe = engine.subscribe(setState);
    void engine.initialize();
    return () => {
      unsubscribe();
      engine.dispose();
    };
  }, [engine]);

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
  readonly authLauncherLines?: readonly string[];
  readonly composerMode?: "default" | "api-key-entry";
  readonly panel: WorkShellPanel;
  readonly queuedCount?: number | undefined;
  readonly queuePaused?: boolean | undefined;
  readonly contextInspectorCursor?: number | undefined;
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
};

export interface WorkShellPaneEngine<State extends WorkShellPaneRuntimeState>
  extends WorkShellStateSource<State> {
  handleSubmit(line: string, attachments?: readonly unknown[]): Promise<void>;
  setMode(mode: string): void | Promise<void>;
  openSessionsPanel(): Promise<void>;
  interruptTurn?(): void;
  cancelSensitiveInput?(): void;
  closeOverlay?(): void;
  updateTerminalColumns?(columns: number): void;
  // Context Inspector (Sprint 2) — keyboard actions for the /context overlay.
  // All are optional so test harnesses / legacy panes that never open the
  // overlay don't need stubs.
  moveContextInspectorCursor?(direction: number): void;
  moveContextInspectorDetailOffset?(direction: number): void;
  toggleContextInspectorPin?(): Promise<void>;
  forgetContextSourceAtCursor?(): Promise<void>;
  includeContextSourceAtCursor?(): Promise<void>;
  toggleContextInspectorExpanded?(): Promise<void>;
  undoLastContextSourceAction?(): Promise<void>;
  acceptContextSuggestion?(suggestionId: string): Promise<void>;
  rejectContextSuggestion?(suggestionId: string): Promise<void>;
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

export function useWorkShellInputController(input: {
  readonly value: string;
  readonly replaceValue: (value: string) => void;
  readonly slashSuggestionCount: number;
  readonly selectedSlashCommand?: string;
  readonly activeSlashInput?: string | undefined;
  readonly setSelectedSlashIndex: (value: number | ((current: number) => number)) => void;
  readonly isBusy: boolean;
  readonly currentMode: string;
  readonly onExit: () => void;
  readonly onRequestSessionsView?: (() => void) | undefined;
  readonly openEngineSessions: () => void;
  readonly cycleMode: (nextMode: string) => void | Promise<void>;
  readonly shouldBlockSlashSubmit: (line: string) => boolean;
  readonly handleSubmit: (line: string) => Promise<void>;
  readonly hasSensitiveInput?: boolean;
  readonly hasOverlayOpen?: boolean;
  readonly activePanelTitle?: string;
  readonly closeSlashPicker?: ((panelTitle?: string) => void) | undefined;
  readonly interruptTurn?: (() => void) | undefined;
  readonly cancelSensitiveInput?: (() => void) | undefined;
  readonly closeOverlay?: (() => void) | undefined;
  readonly contextSourceActionsEnabled?: boolean | undefined;
  readonly contextAdviceActionsEnabled?: boolean | undefined;
  readonly contextUndoActionsEnabled?: boolean | undefined;
  readonly isComposerRawEmpty?: (() => boolean) | undefined;
  readonly acceptContextSuggestion?: (() => Promise<void>) | undefined;
  readonly rejectContextSuggestion?: (() => Promise<void>) | undefined;
  readonly contextInspectorExpanded?: string | null | undefined;
  // Context Inspector (Sprint 2): engine callbacks for the /context overlay
  // keyboard actions. All optional — only dispatched when the overlay is open
  // and the engine wires them.
  readonly moveContextInspectorCursor?: ((direction: number) => void) | undefined;
  readonly moveContextInspectorDetailOffset?: ((direction: number) => void) | undefined;
  readonly toggleContextInspectorPin?: (() => Promise<void>) | undefined;
  readonly forgetContextSourceAtCursor?: (() => Promise<void>) | undefined;
  readonly includeContextSourceAtCursor?: (() => Promise<void>) | undefined;
  readonly toggleContextSourceDelivery?: (() => Promise<void>) | undefined;
  readonly toggleContextInspectorExpanded?: (() => Promise<void>) | undefined;
  readonly undoContextSourceAction?: (() => Promise<void>) | undefined;
}): { readonly submit: (value: string) => Promise<boolean> } {
  const escapeResetArmedAtRef = useRef<number | undefined>(undefined);
  useInput((value, key) => {
    const ctrlOCount = value.split("\u000f").length - 1;
    if (
      input.onRequestSessionsView &&
      (ctrlOCount > 0 || (key.ctrl && value.toLowerCase() === "o"))
    ) {
      escapeResetArmedAtRef.current = undefined;
      input.replaceValue("");
      const requestCount = Math.max(1, ctrlOCount);
      for (let index = 0; index < requestCount; index += 1) {
        input.onRequestSessionsView();
      }
      return;
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
    // We check the composer value AFTER the key arrives — if the composer
    // already has text, don't steal keys. But for navigation keys (arrows,
    // Enter) we always intercept since those aren't text input.
    const isNavigationKey = key.upArrow || key.downArrow || key.return;
    if (
      input.hasOverlayOpen
      && input.activePanelTitle === "Context expanded"
      && !input.value.trim().startsWith("/")
      && (
        isNavigationKey
        || (input.isComposerRawEmpty?.() ?? isRawComposerEmpty(input.value))
      )
    ) {
      const inspectorAction = resolveWorkShellContextInspectorAction({
        value,
        key,
        panelTitle: "Context expanded",
        actionsEnabled: input.contextSourceActionsEnabled ?? false,
        adviceActionsEnabled: input.contextAdviceActionsEnabled ?? false,
        undoActionsEnabled: input.contextUndoActionsEnabled ?? false,
      });
      switch (inspectorAction.type) {
        case "move-cursor":
          if (input.contextInspectorExpanded) {
            input.moveContextInspectorDetailOffset?.(inspectorAction.direction);
          } else {
            input.moveContextInspectorCursor?.(inspectorAction.direction);
          }
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
          input.toggleContextInspectorExpanded?.();
          return;
        case "none":
          break;
      }
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
      case "open-sessions-view":
        input.onRequestSessionsView?.();
        return;
      case "open-engine-sessions":
        input.openEngineSessions();
        return;
      case "none":
        return;
    }
  }, { isActive: true });

  const submit = useCallback(
    async (value: string): Promise<boolean> => {
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
    ],
  );

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
}) {
  const [inputValue, setInputValueState] = useState("");
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
  const engineState = useWorkShellEngineState(input.engine);
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
    (line: string) => input.engine.handleSubmit(line, pendingClipboardAttachments),
    [input.engine, pendingClipboardAttachments],
  );

  const cycleMode = useCallback(
    async (nextMode: string) => {
      await input.engine.setMode(nextMode);
    },
    [input.engine],
  );
  const selectedContextSuggestion = useMemo(() => {
    const packet = engineState.contextPacket;
    const cursor = engineState.contextInspectorCursor ?? -1;
    if (!packet || cursor < 0) {
      return undefined;
    }
    const sourceId = buildContextInspectorRows(packet).find(
      (row) => row.sourceIndex === cursor,
    )?.item.id;
    return getSelectedVisibleContextPolicySuggestion({
      suggestions: engineState.contextPolicySuggestions ?? [],
      selectedSourceId: sourceId,
    });
  }, [
    engineState.contextInspectorCursor,
    engineState.contextPacket,
    engineState.contextPolicySuggestions,
  ]);
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



  const { submit } = useWorkShellInputController({
    value: inputValue,
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
    // Context Inspector (Sprint 2): forward engine callbacks so the
    // controller's useInput can dispatch overlay keyboard actions.
    ...(input.engine.moveContextInspectorCursor
      ? { moveContextInspectorCursor: (direction: number) => { void input.engine.moveContextInspectorCursor?.(direction); } }
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
            const heldBack = packet && cursor !== undefined && cursor >= 0
              ? isContextInspectorSourceHeldBack(packet, cursor)
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
  });

  return {
    inputValue,
    setInputValue,
    engineState,
    composerPreview,
    activePanel,
    slashSuggestionCount: slashSuggestions.length,
    selectedSlashCommand: selectedSuggestion?.command,
    contextAdviceKeyActionsEnabled: contextAdviceActionsAvailable,
    contextUndoKeyActionsEnabled: contextUndoActionsAvailable,
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
