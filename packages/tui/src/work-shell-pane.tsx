import { useStdout } from "ink";
import React from "react";

import type { TuiShellHomeState } from "./shell-state.js";
import { Composer } from "./composer.js";
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
import { formatAuthLabelForDisplay } from "./work-shell-panels.js";
import { WorkShellView } from "./work-shell-view.js";

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
  readonly onExit: () => void;
  readonly onRequestSessionsView?: (() => void) | undefined;
  readonly onSyncHomeState?: ((homeState: Partial<TuiShellHomeState>) => void) | undefined;
  readonly refreshHomeState?: (() => Promise<TuiShellHomeState>) | undefined;
  readonly shouldBlockSlashSubmit: (line: string) => boolean;
  readonly getReasoningLabel: (reasoning: State["reasoning"]) => string;
  readonly isReasoningSupported: (reasoning: State["reasoning"]) => boolean;
};

const AUTO_PROMOTE_IMAGE_PROMPTS = new Set([
  "Please inspect the attached image.",
  "Please inspect the attached images.",
]);
const STANDALONE_IMAGE_PATH_PATTERN = /^(?:"(?:file:\/\/|\/|[A-Za-z]:[\\/]).+\.(?:png|jpe?g|gif|webp|bmp)"|'(?:file:\/\/|\/|[A-Za-z]:[\\/]).+\.(?:png|jpe?g|gif|webp|bmp)'|(?:file:\/\/|\/|[A-Za-z]:[\\/])(?:\\ |[^\s])+\.(?:png|jpe?g|gif|webp|bmp))$/i;

export function resolveWorkShellPaneTerminalColumns(stdout: NodeJS.WriteStream): number {
  return stdout.columns ?? process.stdout.columns ?? 96;
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
    submit,
    addClipboardAttachment,
    clearClipboardAttachments,
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
  const [terminalColumns, setTerminalColumns] = React.useState(() => resolveWorkShellPaneTerminalColumns(stdout));
  React.useEffect(() => {
    const updateTerminalColumns = () => {
      setTerminalColumns(resolveWorkShellPaneTerminalColumns(stdout));
    };
    updateTerminalColumns();
    stdout.on("resize", updateTerminalColumns);
    return () => {
      stdout.off("resize", updateTerminalColumns);
    };
  }, [stdout]);

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
    queuedCount,
    queuePaused,
  } = engineState;
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
          const outcome = addClipboardAttachment(attachment as Attachment);
          if (outcome.accepted === false) {
            setLastClipboardError(outcome.reason);
            return;
          }
        }
        setLastClipboardError(null);
      })
      .catch(() => {
        if (standaloneImageResolveRequestIdRef.current !== requestId) {
          return;
        }
        setInputValue((current) => (current.length === 0 ? nextValue : current));
      });
  }, [addClipboardAttachment, props.cwd, props.resolveComposerInput, setInputValue]);

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
      {...(attachmentLines ? { attachmentLines } : {})}
      {...(pendingClipboardAttachmentCount > 0 ? { attachmentCount: pendingClipboardAttachmentCount } : {})}
      composer={
        <Composer
          value={inputValue}
          onChange={handleComposerChange}
          onSubmit={async (line) => {
            // Run the engine submit FIRST (it closes over the live pending
            // list, so attachments cross the engine boundary correctly).
            // Then drop the local pending list — but only when the line had
            // content. An empty Enter today is a noop in the engine; if we
            // cleared first the user's paste would silently disappear.
            // Attachment-only submission (line=="" + attachments) is a
            // separate dispatch path tracked as a memo §4 follow-up.
            await submit(line);
            if (line.trim().length > 0) {
              clearClipboardAttachments();
            }
          }}
          onClipboardImage={(attachment) => {
            // ClipboardImageAttachment is byte-identical to the project-wide
            // WorkShellImageAttachment alias from contracts. Cast at this
            // seam keeps the generic constraint honest.
            const outcome = addClipboardAttachment(attachment as Attachment);
            if (outcome.accepted === false) {
              // Surface the cap rejection through the same channel the
              // capture-side errors use — the user sees a single line of
              // explanation instead of the pasted image silently
              // disappearing into the void.
              setLastClipboardError(outcome.reason);
              return;
            }
            setLastClipboardError(null);
          }}
          onClipboardImageError={(reason) => setLastClipboardError(reason)}
          terminalColumns={terminalColumns}
          {...(isSecureApiKeyEntry ? { mask: "•" } : {})}
        />
      }
      inputValue={inputValue}
      slashSuggestionCount={slashSuggestionCount}
      {...(selectedSlashCommand ? { selectedSlashCommand } : {})}
      terminalColumns={terminalColumns}
      cwd={props.cwd}
      {...(queuedCount !== undefined ? { queuedCount } : {})}
      {...(queuePaused !== undefined ? { queuePaused } : {})}
      {...(isSecureApiKeyEntry
        ? { composerHintOverride: "Enter saves · Esc cancels" }
        : {})}
    />
  );
}
