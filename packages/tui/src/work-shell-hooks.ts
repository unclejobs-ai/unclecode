import { useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createWorkShellDashboardHomePatch,
  createWorkShellDashboardHomeSyncState,
  shouldRefreshDashboardHomeState,
  type WorkShellDashboardHomeSyncState,
} from "./work-shell-dashboard-sync.js";
import type { TuiShellHomeState } from "./shell-state.js";
import {
  clampWorkShellSlashSelection,
  cycleWorkShellSlashSelection,
  resolveWorkShellActivePanel,
} from "./work-shell-panels.js";
import {
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

export function shouldUseSlowComposerPreview(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  return /(?:^|\s)@(?:"[^"\n]+"|\S+)/.test(trimmed) ||
    /(?:^|\s|"|')(?:[^\s"']+\.(?:png|jpe?g|gif|webp|bmp))(?:$|\s|"|')/i.test(trimmed);
}

export function createFastWorkShellComposerPreview<Attachment = never>(value: string): WorkShellComposerPreview<Attachment> {
  const trimmed = value.trim();
  return {
    prompt: trimmed,
    attachments: [],
    transcriptText: trimmed,
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

export type WorkShellSlashSuggestion = {
  readonly command: string;
  readonly description: string;
};

export type WorkShellPaneRuntimeState<Reasoning = unknown> = {
  readonly entries: readonly WorkShellEntry[];
  readonly model: string;
  readonly mode: string;
  readonly reasoning: Reasoning;
  readonly authLabel: string;
  readonly isBusy: boolean;
  readonly busyStatus?: string | undefined;
  readonly currentTurnStartedAt?: number | undefined;
  readonly lastTurnDurationMs?: number | undefined;
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
  readonly authLauncherLines?: readonly string[];
  readonly composerMode?: "default" | "api-key-entry";
  readonly panel: WorkShellPanel;
};

export interface WorkShellPaneEngine<State extends WorkShellPaneRuntimeState>
  extends WorkShellStateSource<State> {
  handleSubmit(line: string, attachments?: readonly unknown[]): Promise<void>;
  openSessionsPanel(): Promise<void>;
  cancelSensitiveInput?(): void;
  closeOverlay?(): void;
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

export function useWorkShellSlashState(input: {
  readonly value: string;
  readonly authLabel?: string;
  readonly authLauncherLines?: readonly string[];
  readonly browserOAuthAvailable?: boolean;
  readonly fallbackPanel: WorkShellPanel;
  readonly getSuggestions: (value: string) => readonly WorkShellSlashSuggestion[];
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const suggestions = useMemo(
    () =>
      input.value.trim().startsWith("/")
        ? input.getSuggestions(input.value)
        : [],
    [input.value, input.getSuggestions],
  );

  useEffect(() => {
    setSelectedIndex((current) =>
      clampWorkShellSlashSelection(current, suggestions.length),
    );
  }, [input.value, suggestions.length]);

  const selectedSuggestion = suggestions[selectedIndex];
  const activePanel = useMemo(
    () =>
      resolveWorkShellActivePanel({
        input: input.value,
        suggestions,
        selectedIndex,
        ...(input.authLabel ? { authLabel: input.authLabel } : {}),
        ...(input.browserOAuthAvailable !== undefined
          ? { browserOAuthAvailable: input.browserOAuthAvailable }
          : {}),
        ...(input.authLauncherLines
          ? { authLauncherLines: input.authLauncherLines }
          : {}),
        fallbackPanel: input.fallbackPanel,
      }),
    [
      input.authLabel,
      input.authLauncherLines,
      input.browserOAuthAvailable,
      input.fallbackPanel,
      input.value,
      selectedIndex,
      suggestions,
    ],
  );

  return {
    suggestions,
    selectedIndex,
    setSelectedIndex,
    selectedSuggestion,
    activePanel,
  };
}

export function useWorkShellInputController(input: {
  readonly value: string;
  readonly replaceValue: (value: string) => void;
  readonly slashSuggestionCount: number;
  readonly selectedSlashCommand?: string;
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
  readonly cancelSensitiveInput?: (() => void) | undefined;
  readonly closeOverlay?: (() => void) | undefined;
}): { readonly submit: (value: string) => Promise<void> } {
  useInput((value, key) => {
    const action = resolveWorkShellInputAction({
      value,
      key,
      input: input.value,
      slashSuggestionCount: input.slashSuggestionCount,
      ...(input.selectedSlashCommand
        ? { selectedSlashCommand: input.selectedSlashCommand }
        : {}),
      isBusy: input.isBusy,
      currentMode: input.currentMode,
      hasRequestSessionsView: Boolean(input.onRequestSessionsView),
      ...(input.hasSensitiveInput ? { hasSensitiveInput: input.hasSensitiveInput } : {}),
      ...(input.hasOverlayOpen ? { hasOverlayOpen: input.hasOverlayOpen } : {}),
    });

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
      case "cycle-mode":
        void Promise.resolve(input.cycleMode(action.nextMode)).catch(() => undefined);
        return;
      case "cancel-sensitive-input":
        input.cancelSensitiveInput?.();
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
    async (value: string) => {
      const line = value.trim();
      const action = resolveWorkShellSubmitAction({
        value,
        isBusy: input.isBusy,
        shouldBlockSlashSubmit: input.shouldBlockSlashSubmit(line),
        ...(input.selectedSlashCommand
          ? { selectedSlashCommand: input.selectedSlashCommand }
          : {}),
      });

      if (action.type === "noop") {
        return;
      }

      if (action.clearInput) {
        input.replaceValue("");
      }

      await input.handleSubmit(action.line);
    },
    [
      input.handleSubmit,
      input.isBusy,
      input.replaceValue,
      input.selectedSlashCommand,
      input.shouldBlockSlashSubmit,
    ],
  );

  return { submit };
}

export function useWorkShellPaneState<
  Attachment extends { readonly dataUrl: string },
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
  const [inputValue, setInputValue] = useState("");
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
      const violation = checkClipboardCapViolation(attachment, pendingClipboardAttachments);
      if (violation) {
        input.engine.recordTraceEvent?.({
          type: "attachment.dropped",
          level: "default",
          source: "clipboard",
          reason: "cap-exceeded",
          byteEstimate: estimateAttachmentBytes(attachment),
          mimeType:
            (attachment as { readonly mimeType?: string }).mimeType ?? "application/octet-stream",
          startedAt,
        });
        return violation;
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
        mimeType:
          (attachment as { readonly mimeType?: string }).mimeType ?? "application/octet-stream",
        byteEstimate: estimateAttachmentBytes(attachment),
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
          mimeType:
            (item as { readonly mimeType?: string }).mimeType ?? "application/octet-stream",
          startedAt,
        });
      }
      return [];
    });
  }, [input.engine]);
  const clearClipboardAttachments = useCallback(() => {
    // Submit-time clear — stays silent (no dropped events) so a normal
    // turn does not log N attached + N dropped lines. The same-reference
    // return on empty avoids re-rendering when there was nothing to clear.
    setPendingClipboardAttachments((current) => (current.length === 0 ? current : []));
  }, []);
  const engineState = useWorkShellEngineState(input.engine);
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
    activePanel,
  } = useWorkShellSlashState({
    value: inputValue,
    ...(engineState.authLabel ? { authLabel: engineState.authLabel } : {}),
    ...(input.browserOAuthAvailable !== undefined
      ? { browserOAuthAvailable: input.browserOAuthAvailable }
      : {}),
    ...(engineState.authLauncherLines
      ? { authLauncherLines: engineState.authLauncherLines }
      : {}),
    fallbackPanel: engineState.panel,
    getSuggestions: input.getSuggestions,
  });

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
      await input.engine.handleSubmit(`/mode set ${nextMode}`);
    },
    [input.engine],
  );

  const { submit } = useWorkShellInputController({
    value: inputValue,
    replaceValue: setInputValue,
    slashSuggestionCount: slashSuggestions.length,
    ...(selectedSuggestion?.command
      ? { selectedSlashCommand: selectedSuggestion.command }
      : {}),
    setSelectedSlashIndex,
    isBusy: engineState.isBusy,
    currentMode: engineState.mode,
    onExit: input.onExit,
    onRequestSessionsView: input.onRequestSessionsView,
    openEngineSessions,
    cycleMode,
    shouldBlockSlashSubmit: input.shouldBlockSlashSubmit,
    handleSubmit,
    hasSensitiveInput: engineState.composerMode === "api-key-entry",
    hasOverlayOpen: engineState.panel.title === "Context expanded",
    ...(input.engine.cancelSensitiveInput
      ? { cancelSensitiveInput: () => input.engine.cancelSensitiveInput?.() }
      : {}),
    ...(input.engine.closeOverlay
      ? { closeOverlay: () => input.engine.closeOverlay?.() }
      : {}),
  });

  return {
    inputValue,
    setInputValue,
    engineState,
    composerPreview,
    activePanel,
    slashSuggestionCount: slashSuggestions.length,
    submit,
    addClipboardAttachment,
    clearClipboardAttachments,
    pendingClipboardAttachmentCount: pendingClipboardAttachments.length,
  };
}

/**
 * Pre-flight cap defaults. v1 keeps these inline here — Gemini's design
 * memo recommends promoting them to packages/config-core under a new
 * `composer` subkey of UncleCodeConfigLayer so the precedence chain
 * (built-in → plugin → project → user → env → cli → session) can override.
 * Tracked as memo §4 follow-up; for v1 the constants below match the
 * Anthropic vision per-image limit (5 MiB) and a TUI-friendly count
 * ceiling that prevents runaway clipboard accumulation.
 */
export const MAX_CLIPBOARD_ATTACHMENT_COUNT = 5;
export const MAX_CLIPBOARD_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export type ClipboardAttachmentRejection = {
  readonly accepted: false;
  readonly reason: string;
  readonly status: "no-image" | "unsupported" | "failed";
};

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
): ClipboardAttachmentRejection | undefined {
  if (current.length >= MAX_CLIPBOARD_ATTACHMENT_COUNT) {
    return {
      accepted: false,
      status: "failed",
      reason: `clipboard attachment cap reached (${MAX_CLIPBOARD_ATTACHMENT_COUNT} images max — submit or clear before adding more)`,
    };
  }
  const bytes = estimateDataUrlBytes(attachment.dataUrl);
  if (bytes > MAX_CLIPBOARD_ATTACHMENT_BYTES) {
    const mib = (bytes / (1024 * 1024)).toFixed(1);
    return {
      accepted: false,
      status: "failed",
      reason: `image too large (${mib} MiB — max ${MAX_CLIPBOARD_ATTACHMENT_BYTES / (1024 * 1024)} MiB per image)`,
    };
  }
  return undefined;
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
  const seen = new Set<string>();
  const out: A[] = [];
  for (const item of items) {
    if (seen.has(item.dataUrl)) {
      continue;
    }
    seen.add(item.dataUrl);
    out.push(item);
  }
  return out;
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
    if (!input.value.trim()) {
      setPreview(createEmptyWorkShellComposerPreview());
      return;
    }

    if (!shouldUseSlowComposerPreview(input.value)) {
      setPreview(createFastWorkShellComposerPreview(input.value));
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
