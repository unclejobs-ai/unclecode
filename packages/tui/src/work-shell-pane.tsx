import { useStdout } from "ink";
import React from "react";

import {
  captureClipboardImage as defaultCaptureClipboardImage,
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
  type WorkShellPaneEngine,
  type WorkShellPaneRuntimeState,
  type WorkShellSlashSuggestion,
} from "./work-shell-hooks.js";
import { useGitFacts } from "./facts.js";
import { hasActiveAgentConsoleWork } from "./work-shell-agent-console-model.js";
import { formatAuthLabelForDisplay } from "./work-shell-panels.js";
import { getWorkShellComposerTextColor, WorkShellView } from "./work-shell-view.js";
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
  const {
    inputValue,
    setInputValue,
    engineState,
    composerPreview,
    activePanel,
    slashSuggestionCount,
    selectedSlashCommand,
    contextAdviceKeyActionsEnabled,
    contextUndoKeyActionsEnabled,
    suppressAgentConsoleKey,
    agentConsoleOwnsKeyboard,
    agentConsoleSteering,
    submit,
    addClipboardAttachment,
    clearClipboardAttachments,
    pendingClipboardAttachments,
    pendingClipboardAttachmentCount,
  } = useWorkShellPaneState<Attachment, State>({
    engine: props.engine,
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
  });

  const { stdout } = useStdout();
  const captureClipboardImage = props.captureClipboardImage ?? defaultCaptureClipboardImage;
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

  React.useEffect(() => {
    props.engine.updateTerminalColumns?.(terminalColumns);
  }, [terminalColumns, props.engine]);

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
    contextIndicator,
    contextActionReceipt,
    contextPreviewReceipt,
    contextSubmittedReceipt,
    contextPacketChange,
    contextSourceActionsEnabled,
    contextPolicySuggestions,
    contextAdviceUnavailable,
    contextInspectorCursor,
    contextInspectorExpanded,
    contextInspectorDetailContent,
    contextInspectorDetailOffset,
    contextPacket,
    modelWindow,
    queuedCount,
    queuePaused,
    agentConsole,
    agentConsoleView,
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
  const shouldSuppressComposerKeysForInspector = React.useMemo(
    () =>
      !agentConsoleSteering
      && activePanel.title === "Context expanded"
      && isRawComposerEmpty(inputValue)
      && props.engine.moveContextInspectorCursor !== undefined,
    [agentConsoleSteering, activePanel.title, inputValue, props.engine],
  );
  const shouldSuppressComposerKeysForTelemetry =
    !agentConsoleSteering
    && (activePanel.title === "Cache Telemetry" || activePanel.title === "Agent History")
    && isRawComposerEmpty(inputValue);
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
      {...(streamingAssistantText ? { streamingAssistantText } : {})}
      isBusy={isBusy}
      {...(busyStatus ? { busyStatus } : {})}
      {...(currentTurnStartedAt !== undefined ? { currentTurnStartedAt } : {})}
      {...(lastTurnDurationMs !== undefined ? { lastTurnDurationMs } : {})}
      activePanel={activePanel}
      {...(contextActionReceipt ? { contextActionReceipt } : {})}
      {...(contextPreviewReceipt ? { contextPreviewReceipt } : {})}
      {...(contextSubmittedReceipt ? { contextSubmittedReceipt } : {})}
      {...(contextPacketChange ? { contextPacketChange } : {})}
      contextSourceActionsEnabled={contextSourceActionsEnabled ?? false}
      contextPolicySuggestions={contextPolicySuggestions ?? []}
      {...(contextAdviceUnavailable ? { contextAdviceUnavailable } : {})}
      contextAdviceActionsEnabled={contextAdviceKeyActionsEnabled}
      {...(contextInspectorCursor !== undefined ? { contextInspectorCursor } : {})}
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
      {...(authPickerActive && authPicker.catalog ? { ompAuthCatalog: authPicker.catalog } : {})}
      ompAuthPickerCursor={authPicker.cursor}
      {...(authPickerActive && authPicker.signInReceipt ? { ompAuthSignInReceipt: authPicker.signInReceipt } : {})}
      composer={
        <Composer
          value={inputValue}
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
          {...(isSecureApiKeyEntry ? { mask: "•" } : {})}
          cursorVisible={
            !shouldSuppressComposerKeysForInspector
            && !shouldSuppressComposerKeysForTelemetry
            && !agentConsoleOwnsKeyboard
          }
          {...(suppressAgentConsoleKey ? { suppressAgentConsoleKey } : {})}
          {...(shouldSuppressComposerKeysForInspector
            ? { suppressInspectorKeys: true }
            : {})}
          suppressTelemetryHotkeys={shouldSuppressComposerKeysForTelemetry}
          suppressInspectorMutationKeys={contextSourceActionsEnabled ?? false}
          suppressInspectorAdviceKeys={contextAdviceKeyActionsEnabled}
          suppressInspectorUndoKey={contextUndoKeyActionsEnabled}
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
      {...(isSecureApiKeyEntry
        ? { composerHintOverride: "Enter saves · Esc cancels" }
        : {})}
    />
  );
}
