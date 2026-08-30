import { useStdout } from "ink";
import React from "react";

import {
  captureClipboardImage as defaultCaptureClipboardImage,
  getWorkShellMessages,
  type ClipboardImageResult,
} from "@unclecode/orchestrator";

import type { TuiShellHomeState } from "./shell-state.js";
import {
  Composer,
  handleComposerClipboardPaste,
  isRawComposerEmpty,
} from "./composer.js";
import {
  buildAttachmentPreviewLines,
  formatAttachmentErrorLine,
  formatInlineImageSupportLine,
  type WorkShellImageAttachment,
} from "./work-shell-attachments.js";
import {
  useWorkShellPaneState,
  type WorkShellComposerPreview,
  type WorkShellEngineOwnership,
  type WorkShellPaneEngine,
  type WorkShellPaneRuntimeState,
  type WorkShellSlashSuggestion,
} from "./work-shell-hooks.js";
import { useGitFacts } from "./facts.js";
import { hasActiveAgentConsoleWork } from "./work-shell-agent-console-model.js";
import { formatAuthLabelForDisplay } from "./work-shell-panels.js";
import {
  getWorkShellComposerTextColor,
  resolveWorkShellComposerAdditionalRows,
  WorkShellView,
} from "./work-shell-view.js";
import { useOmpAuthProviderPicker } from "./work-shell-auth-provider-picker-state.js";
import {
  shouldShowOmpAuthPicker,
  type OmpAuthCatalogPort,
} from "./work-shell-auth-provider-picker-model.js";

export type WorkShellPaneProps<
  Attachment extends WorkShellImageAttachment,
  State extends WorkShellPaneRuntimeState,
> = {
  readonly provider: string;
  readonly model: string;
  readonly mode: string;
  readonly engine: WorkShellPaneEngine<State>;
  /** Explicit lifecycle ownership: shared runtime engines survive pane detach. */
  readonly engineOwnership?: WorkShellEngineOwnership | undefined;
  readonly cwd: string;
  readonly resolveComposerInput: (
    value: string,
    cwd: string,
  ) => Promise<WorkShellComposerPreview<Attachment>>;
  readonly getSuggestions: (
    value: string,
  ) => readonly WorkShellSlashSuggestion[];
  readonly browserOAuthAvailable?: boolean | undefined;
  /**
   * OMP credential catalog for the `/auth` surface, injected by the app. Left
   * undefined, `/auth` keeps its existing panel rather than inventing rows.
   */
  readonly ompAuthCatalog?: OmpAuthCatalogPort | undefined;
  readonly onExit: () => void;
  readonly onRequestSessionsView?: (() => void) | undefined;
  readonly onSyncHomeState?: ((homeState: Partial<TuiShellHomeState>) => void) | undefined;
  readonly refreshHomeState?: (() => Promise<TuiShellHomeState>) | undefined;
  readonly shouldBlockSlashSubmit: (line: string) => boolean;
  readonly getReasoningLabel: (reasoning: State["reasoning"]) => string;
  readonly isReasoningSupported: (reasoning: State["reasoning"]) => boolean;
  /**
   * Injectable clipboard capture for Ctrl+V and exact `/attach clipboard`.
   * Production defaults to the platform capture; tests inject synthetic PNGs.
   */
  readonly captureClipboardImage?: (() => ClipboardImageResult) | undefined;
};

const AUTO_PROMOTE_IMAGE_PROMPTS = new Set([
  "Please inspect the attached image.",
  "Please inspect the attached images.",
]);
const STANDALONE_IMAGE_PATH_PATTERN = /^(?:"(?:file:\/\/|\/|[A-Za-z]:[\\/]).+\.(?:png|jpe?g|gif|webp|bmp)"|'(?:file:\/\/|\/|[A-Za-z]:[\\/]).+\.(?:png|jpe?g|gif|webp|bmp)'|(?:file:\/\/|\/|[A-Za-z]:[\\/])(?:\\ |[^\s])+\.(?:png|jpe?g|gif|webp|bmp))$/i;

export function resolveWorkShellPaneTerminalColumns(stdout: NodeJS.WriteStream): number {
  return stdout.columns ?? process.stdout.columns ?? 96;
}

export function resolveWorkShellPaneTerminalRows(stdout: NodeJS.WriteStream): number {
  return stdout.rows ?? process.stdout.rows ?? 24;
}

const ATTACH_CLIPBOARD_COMMAND = "/attach clipboard";
const ATTACH_CLIPBOARD_USAGE =
  "Use /attach clipboard to capture the current clipboard image.";

/** Masked entry: Enter commits the key, it never reaches the transcript. */
const SECURE_API_KEY_COMPOSER_HINT = "Enter saves · Esc cancels";
/**
 * Shown only while the Context Desk holds an empty composer. Both variants
 * deliberately omit "Enter send": on this state Enter either opens the
 * selected source's details or does nothing at all, never a submit. The
 * details promise is reserved for a host that wired an expansion handler.
 */
const CONTEXT_DESK_COMPOSER_HINT =
  "Context Desk · h/j/k/l move · Enter details · Esc close · type to draft";
const CONTEXT_DESK_NO_EXPAND_COMPOSER_HINT =
  "Context Desk · h/j/k/l move · Esc close · type to draft";

export function normalizeComposerSlashLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function isExactAttachClipboardCommand(value: string): boolean {
  return normalizeComposerSlashLine(value) === ATTACH_CLIPBOARD_COMMAND;
}

export function isAttachClipboardNearMiss(value: string): boolean {
  const normalized = normalizeComposerSlashLine(value).toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  if (normalized === ATTACH_CLIPBOARD_COMMAND) {
    return false;
  }
  return normalized === "/attach" || normalized.startsWith("/attach ");
}

export function resolveAttachmentOnlyInspectionPrompt(attachmentCount: number): string {
  return attachmentCount === 1
    ? "Please inspect the attached image."
    : "Please inspect the attached images.";
}

export function formatClipboardCaptureFriendlyError(
  status: "no-image" | "unsupported" | "failed",
  reason: string,
): string {
  switch (status) {
    case "no-image":
      return "Clipboard has no image to attach.";
    case "unsupported":
      return "Clipboard image capture is not supported on this platform.";
    case "failed":
      return reason.trim() || "Could not capture clipboard image.";
  }
}

export function looksLikeStandaloneImagePathInput(value: string): boolean {
  return STANDALONE_IMAGE_PATH_PATTERN.test(value.trim());
}

export function shouldAutoPromoteStandaloneImagePreview<Attachment extends WorkShellImageAttachment>(input: {
  readonly inputValue: string;
  readonly composerPreview: Pick<WorkShellComposerPreview<Attachment>, "prompt" | "attachments">;
}): boolean {
  return looksLikeStandaloneImagePathInput(input.inputValue)
    && input.composerPreview.attachments.length > 0
    && AUTO_PROMOTE_IMAGE_PROMPTS.has(input.composerPreview.prompt);
}

export function WorkShellPane<
  Attachment extends WorkShellImageAttachment,
  State extends WorkShellPaneRuntimeState,
>(props: WorkShellPaneProps<Attachment, State>) {
  const standaloneImageResolveRequestIdRef = React.useRef(0);
  // Terminal size is measured ahead of the pane-state hook so the Task 11
  // scrollback step can share the same rows the view renders from.
  const { stdout } = useStdout();
  const [terminalColumns, setTerminalColumns] = React.useState(() => resolveWorkShellPaneTerminalColumns(stdout));
  const [terminalRows, setTerminalRows] = React.useState(() => resolveWorkShellPaneTerminalRows(stdout));
  React.useEffect(() => {
    const updateTerminalSize = () => {
      setTerminalColumns(resolveWorkShellPaneTerminalColumns(stdout));
      setTerminalRows(resolveWorkShellPaneTerminalRows(stdout));
    };
    updateTerminalSize();
    stdout.on("resize", updateTerminalSize);
    return () => {
      stdout.off("resize", updateTerminalSize);
    };
  }, [stdout]);
  const {
    inputValue,
    setInputValue,
    composerResetEpoch,
    engineState,
    transcriptScrollOffset,
    composerPreview,
    activePanel,
    queueSelectedId,
    slashSuggestionCount,
    selectedSlashCommand,
    contextAdviceKeyActionsEnabled,
    contextPinKeyActionsEnabled,
    contextDeliveryKeyActionsEnabled,
    contextUndoKeyActionsEnabled,
    contextExpandActionsEnabled,
    suppressAgentConsoleKey,
    suppressShellActionKeys,
    agentConsoleOwnsKeyboard,
    agentConsoleSteering,
    submit,
    addClipboardAttachment,
    clearClipboardAttachments,
    pendingClipboardAttachments,
    pendingClipboardAttachmentCount,
  } = useWorkShellPaneState<Attachment, State>({
    engine: props.engine,
    engineOwnership: props.engineOwnership ?? "owned",
    cwd: props.cwd,
    resolveComposerInput: props.resolveComposerInput,
    getSuggestions: props.getSuggestions,
    ...(props.browserOAuthAvailable !== undefined
      ? { browserOAuthAvailable: props.browserOAuthAvailable }
      : {}),
    onExit: props.onExit,
    ...(props.onRequestSessionsView
      ? { onRequestSessionsView: props.onRequestSessionsView }
      : {}),
    ...(props.onSyncHomeState ? { onSyncHomeState: props.onSyncHomeState } : {}),
    ...(props.refreshHomeState
      ? { refreshHomeState: props.refreshHomeState }
      : {}),
    shouldBlockSlashSubmit: props.shouldBlockSlashSubmit,
    terminalColumns,
    terminalRows,
  });

  const captureClipboardImage = props.captureClipboardImage ?? defaultCaptureClipboardImage;

  React.useEffect(() => {
    props.engine.updateTerminalColumns?.(terminalColumns);
  }, [terminalColumns, props.engine]);

  React.useEffect(() => {
    const contextDeskTerminalRows = Math.max(
      1,
      terminalRows - resolveWorkShellComposerAdditionalRows({
        inputValue,
        terminalColumns,
        attachmentCount: pendingClipboardAttachmentCount,
      }),
    );
    props.engine.updateTerminalRows?.(contextDeskTerminalRows);
  }, [
    inputValue,
    pendingClipboardAttachmentCount,
    props.engine,
    terminalColumns,
    terminalRows,
  ]);

  const {
    entries,
    streamingAssistantText,
    model,
    mode,
    reasoning,
    authLabel,
    isBusy,
    busyStatus,
    currentTurnStartedAt,
    lastTurnDurationMs,
    liveTraceLines,
    contextIndicator,
    contextActionReceipt,
    contextPreviewReceipt,
    contextSubmittedReceipt,
    contextPacketChange,
    contextSourceActionsEnabled,
    contextPolicySuggestions,
    contextAdviceUnavailable,
    contextInspectorCursor,
    contextInspectorOpen,
    contextInspectorPane,
    contextInspectorCollection,
    contextInspectorExpanded,
    contextInspectorDetailContent,
    contextInspectorDetailOffset,
    contextPacket,
    modelWindow,
    queuedCount,
    queuePaused,
    agentConsole,
    agentConsoleView,
    traceMode,
    uiLocale,
  } = engineState;
  // `git status` forks a child process, so it is synced outside render and
  // refreshed only while the main turn or a delegated run could still be
  // touching files. The footer reads state, never Git.
  const gitFacts = useGitFacts(
    props.cwd ?? process.cwd(),
    isBusy || (agentConsole !== undefined && hasActiveAgentConsoleWork(agentConsole)),
  );
  const isSecureApiKeyEntry = engineState.composerMode === "api-key-entry";
  // Most recent rejection reason from the clipboard capture or cap gate.
  // Surfaces in the attachment preview area so the user sees one line of
  // explanation instead of a paste silently disappearing. Auto-clears when
  // the user starts typing again or successfully attaches the next image.
  const [lastClipboardError, setLastClipboardError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (lastClipboardError === null) return;
    if (inputValue.length > 0) {
      setLastClipboardError(null);
    }
  }, [inputValue, lastClipboardError]);
  const reasoningLabel = React.useMemo(
    () => props.getReasoningLabel(reasoning),
    [props.getReasoningLabel, reasoning],
  );
  // Task 10: the dock's live tool feed carries only the trace tail — what the
  // running turn touched most recently. The feed reads the engine's
  // always-filled liveTraceLines buffer (cap 8, every trace mode), not the
  // verbose-only traceLines, so it stays alive in default (minimal) mode.
  // The transcript's own trace filtering is untouched; these raw lines never
  // enter the conversation rail.
  const liveToolTraceLines = liveTraceLines !== undefined && liveTraceLines.length > 0
    ? liveTraceLines.slice(-3)
    : undefined;
  const reasoningSupported = React.useMemo(
    () => props.isReasoningSupported(reasoning),
    [props.isReasoningSupported, reasoning],
  );
  const authDisplayLabel = React.useMemo(
    () => formatAuthLabelForDisplay(authLabel),
    [authLabel],
  );
  const authPickerActive =
    activePanel.title === "Auth" && shouldShowOmpAuthPicker(inputValue);
  const authPicker = useOmpAuthProviderPicker({
    ...(props.ompAuthCatalog ? { port: props.ompAuthCatalog } : {}),
    active: authPickerActive,
    inputValue,
  });
  // Context Inspector (Sprint 2): when the /context overlay is open and the
  // composer is empty, yield the action keys to the inspector. The controller
  // dispatches the engine action; the Composer skips inserting the char.
  // The steer composer outranks both panels: the controller has already
  // stopped them acting, so their suppressions must not eat the steer text.
  // Ownership is engine state, not a panel title: the desk can own the
  // keyboard while the title is stale, and a title match must not claim keys
  // for a desk the engine has closed. The title stays as the fallback for
  // hosts that have not wired `contextInspectorOpen` yet.
  const contextDeskOpen = contextInspectorOpen
    ?? activePanel.title === "Context expanded";
  // Navigation ownership is per-axis because the runtime wires the two moves
  // independently: claiming `h`/`l` for a desk that never wired pane movement
  // dispatches into an absent handler and the letter reaches neither the desk
  // nor the draft.
  const canMoveDeskCursor = props.engine.moveContextInspectorCursor !== undefined;
  const canMoveDeskPane = props.engine.moveContextInspectorPane !== undefined;
  // Enter ownership is the final callback-and-row capability computed by the
  // hook from the canonical active collection and selected source.
  const canExpandDeskSource = contextExpandActionsEnabled;
  const shouldSuppressComposerKeysForInspector = React.useMemo(
    () =>
      !agentConsoleSteering
      && contextDeskOpen
      && isRawComposerEmpty(inputValue)
      && (
        canMoveDeskCursor
        || canMoveDeskPane
        || canExpandDeskSource
        || contextPinKeyActionsEnabled
        || contextDeliveryKeyActionsEnabled
      ),
    [
      agentConsoleSteering,
      canExpandDeskSource,
      contextDeliveryKeyActionsEnabled,
      contextPinKeyActionsEnabled,
      canMoveDeskCursor,
      canMoveDeskPane,
      contextDeskOpen,
      inputValue,
    ],
  );
  const shouldSuppressComposerKeysForTelemetry =
    !agentConsoleSteering
    && (activePanel.title === "Cache Telemetry" || activePanel.title === "Agent History")
    && isRawComposerEmpty(inputValue);
  // The dock hint has to name whoever holds the keys. While the desk owns an
  // empty composer Enter never sends, so the shell's normal help would be a
  // promise the composer cannot keep. A draft hands the keys straight back,
  // and with them the normal help.
  const contextDeskComposerHint = canExpandDeskSource
    ? CONTEXT_DESK_COMPOSER_HINT
    : CONTEXT_DESK_NO_EXPAND_COMPOSER_HINT;
  const composerHintOverride = isSecureApiKeyEntry
    ? SECURE_API_KEY_COMPOSER_HINT
    : shouldSuppressComposerKeysForInspector
      ? contextDeskComposerHint
      : undefined;
  const attachmentLines = React.useMemo(() => {
    const lines = composerPreview.attachments.length > 0
      ? [
          ...buildAttachmentPreviewLines(composerPreview.attachments),
          formatInlineImageSupportLine(),
        ]
      : [];
    if (lastClipboardError) {
      lines.push(formatAttachmentErrorLine(lastClipboardError));
    }
    return lines.length > 0 ? lines : undefined;
  }, [composerPreview.attachments, lastClipboardError]);

  const acceptClipboardImage = React.useCallback((attachment: Attachment) => {
    const outcome = addClipboardAttachment(attachment);
    if (outcome.accepted === false) {
      setLastClipboardError(outcome.reason);
      return false;
    }
    setLastClipboardError(null);
    return true;
  }, [addClipboardAttachment]);

  const handleComposerChange = React.useCallback((nextValue: string) => {
    const requestId = standaloneImageResolveRequestIdRef.current + 1;
    standaloneImageResolveRequestIdRef.current = requestId;

    if (!looksLikeStandaloneImagePathInput(nextValue)) {
      setInputValue(nextValue);
      return;
    }

    setInputValue("");
    void props.resolveComposerInput(nextValue, props.cwd)
      .then((resolved) => {
        if (standaloneImageResolveRequestIdRef.current !== requestId) {
          return;
        }
        if (!shouldAutoPromoteStandaloneImagePreview({
          inputValue: nextValue,
          composerPreview: resolved,
        })) {
          setInputValue((current) => (current.length === 0 ? nextValue : current));
          return;
        }
        for (const attachment of resolved.attachments) {
          if (!acceptClipboardImage(attachment as Attachment)) {
            return;
          }
        }
      })
      .catch(() => {
        if (standaloneImageResolveRequestIdRef.current !== requestId) {
          return;
        }
        setInputValue((current) => (current.length === 0 ? nextValue : current));
      });
  }, [acceptClipboardImage, props.cwd, props.resolveComposerInput, setInputValue]);

  return (
    <WorkShellView
      provider={props.provider}
      model={model}
      reasoningLabel={reasoningLabel}
      reasoningSupported={reasoningSupported}
      mode={mode}
      authLabel={authDisplayLabel}
      {...(contextIndicator ? { contextIndicator } : {})}
      entries={entries}
      {...(traceMode ? { traceMode } : {})}
      uiLocale={uiLocale ?? "en"}
      {...(streamingAssistantText ? { streamingAssistantText } : {})}
      isBusy={isBusy}
      {...(busyStatus ? { busyStatus } : {})}
      {...(currentTurnStartedAt !== undefined ? { currentTurnStartedAt } : {})}
      {...(lastTurnDurationMs !== undefined ? { lastTurnDurationMs } : {})}
      {...(liveToolTraceLines ? { liveToolTraceLines } : {})}
      activePanel={activePanel}
      {...(queueSelectedId !== undefined ? { queueSelectedId } : {})}
      {...(contextActionReceipt ? { contextActionReceipt } : {})}
      {...(contextPreviewReceipt ? { contextPreviewReceipt } : {})}
      {...(contextSubmittedReceipt ? { contextSubmittedReceipt } : {})}
      {...(contextPacketChange ? { contextPacketChange } : {})}
      contextSourceActionsEnabled={contextSourceActionsEnabled ?? false}
      contextPolicySuggestions={contextPolicySuggestions ?? []}
      {...(contextAdviceUnavailable ? { contextAdviceUnavailable } : {})}
      contextAdviceActionsEnabled={contextAdviceKeyActionsEnabled}
      {...(contextInspectorCursor !== undefined ? { contextInspectorCursor } : {})}
      {...(contextInspectorPane !== undefined ? { contextInspectorPane } : {})}
      {...(contextInspectorCollection !== undefined ? { contextInspectorCollection } : {})}
      {...(contextInspectorExpanded !== undefined ? { contextInspectorExpanded } : {})}
      {...(contextInspectorDetailContent !== undefined ? { contextInspectorDetailContent } : {})}
      {...(contextInspectorDetailOffset !== undefined ? { contextInspectorDetailOffset } : {})}
      {...(contextPacket ? { contextPacket } : {})}
      {...(modelWindow !== undefined ? { modelWindow } : {})}
      {...(agentConsole ? { agentConsole } : {})}
      {...(agentConsoleView ? { agentConsoleView } : {})}
      {...(attachmentLines ? { attachmentLines } : {})}
      {...(pendingClipboardAttachmentCount > 0 ? { attachmentCount: pendingClipboardAttachmentCount } : {})}
      {...{ terminalRows }}
      {...(transcriptScrollOffset > 0 ? { transcriptScrollOffset } : {})}
      {...(authPickerActive && authPicker.catalog ? { ompAuthCatalog: authPicker.catalog } : {})}
      ompAuthPickerCursor={authPicker.cursor}
      {...(authPickerActive && authPicker.signInReceipt ? { ompAuthSignInReceipt: authPicker.signInReceipt } : {})}
      composer={
        <Composer
          value={inputValue}
          resetEpoch={composerResetEpoch}
          onChange={handleComposerChange}
          onSubmit={async (line) => {
            // The steer composer routes to an agent's control mailbox, which
            // carries no attachments and understands no composer command. Its
            // line must reach the engine verbatim — an empty one included,
            // because that is a real (rejected) steer that exits the mode —
            // so it goes before the /attach handling, the /auth catalog, and
            // the attachment-only rewrite that would otherwise speak for the
            // operator.
            const liveState = props.engine.getState();
            const liveAgentConsoleSteering = props.engine.openAgentConsole !== undefined
              && liveState.agentConsoleView?.open === true
              && liveState.composerMode === "agent-steer";
            if (liveAgentConsoleSteering) {
              await submit(line);
              return;
            }

            const normalized = normalizeComposerSlashLine(line);

            if (isExactAttachClipboardCommand(normalized)) {
              handleComposerClipboardPaste({
                capture: captureClipboardImage,
                onClipboardImage: (attachment) => {
                  acceptClipboardImage(attachment as Attachment);
                },
                onClipboardImageError: (reason, status) => {
                  setLastClipboardError(formatClipboardCaptureFriendlyError(status, reason));
                },
              });
              setInputValue("");
              return;
            }

            if (isAttachClipboardNearMiss(normalized)) {
              setLastClipboardError(ATTACH_CLIPBOARD_USAGE);
              setInputValue("");
              return;
            }

            // The /auth catalog owns Enter for a provider row; `/auth status`
            // and friends fall through to the engine untouched.
            if (await authPicker.submit(normalized)) {
              return;
            }

            const submittedClipboardAttachments = pendingClipboardAttachments;
            if (normalized.length === 0 && pendingClipboardAttachmentCount > 0) {
              const prompt = resolveAttachmentOnlyInspectionPrompt(pendingClipboardAttachmentCount);
              const accepted = await submit(prompt);
              if (accepted) {
                clearClipboardAttachments(submittedClipboardAttachments);
              }
              return;
            }

            // Run the engine submit FIRST (it closes over the live pending
            // list, so attachments cross the engine boundary correctly).
            // Clear only after an accepted submission — busy/noop paths must
            // keep the pending badge intact.
            const accepted = await submit(line);
            if (accepted) {
              clearClipboardAttachments(submittedClipboardAttachments);
            }
            return accepted;
          }}
          captureClipboardImage={captureClipboardImage}
          onClipboardImage={(attachment) => {
            // ClipboardImageAttachment is byte-identical to the project-wide
            // WorkShellImageAttachment alias from contracts. Cast at this
            // seam keeps the generic constraint honest.
            acceptClipboardImage(attachment as Attachment);
          }}
          onClipboardImageError={(reason, status) => {
            setLastClipboardError(formatClipboardCaptureFriendlyError(status, reason));
          }}
          terminalColumns={terminalColumns}
          textColor={getWorkShellComposerTextColor()}
          placeholder={getWorkShellMessages(uiLocale ?? "en").composerPlaceholder}
          {...(isSecureApiKeyEntry ? { mask: "•" } : {})}
          cursorVisible={
            !shouldSuppressComposerKeysForInspector
            && !shouldSuppressComposerKeysForTelemetry
            && !agentConsoleOwnsKeyboard
          }
          {...(suppressAgentConsoleKey ? { suppressAgentConsoleKey } : {})}
          suppressShellActionKeys={suppressShellActionKeys}
          {...(shouldSuppressComposerKeysForInspector
            ? { suppressInspectorKeys: true }
            : {})}
          suppressTelemetryHotkeys={shouldSuppressComposerKeysForTelemetry}
          suppressInspectorMutationKeys={false}
          suppressInspectorPinKey={contextPinKeyActionsEnabled}
          suppressInspectorDeliveryKey={contextDeliveryKeyActionsEnabled}
          suppressInspectorAdviceKeys={contextAdviceKeyActionsEnabled}
          suppressInspectorUndoKey={contextUndoKeyActionsEnabled}
          suppressInspectorExpandKey={
            shouldSuppressComposerKeysForInspector && canExpandDeskSource
          }
          suppressInspectorPaneNavigationKeys={
            shouldSuppressComposerKeysForInspector && canMoveDeskPane
          }
          suppressInspectorCursorNavigationKeys={
            shouldSuppressComposerKeysForInspector && canMoveDeskCursor
          }
        />
      }
      inputValue={inputValue}
      slashSuggestionCount={slashSuggestionCount}
      {...(selectedSlashCommand ? { selectedSlashCommand } : {})}
      terminalColumns={terminalColumns}
      cwd={props.cwd}
      gitFacts={gitFacts}
      {...(queuedCount !== undefined ? { queuedCount } : {})}
      {...(queuePaused !== undefined ? { queuePaused } : {})}
      {...(composerHintOverride ? { composerHintOverride } : {})}
    />
  );
}
