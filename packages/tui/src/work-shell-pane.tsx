import React from "react";

import type { TuiShellHomeState } from "./shell-state.js";
import { Composer } from "./composer.js";
import {
  buildAttachmentPreviewLines,
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

export function WorkShellPane<
  Attachment extends WorkShellImageAttachment,
  State extends WorkShellPaneRuntimeState,
>(props: WorkShellPaneProps<Attachment, State>) {
  const {
    inputValue,
    setInputValue,
    engineState,
    composerPreview,
    activePanel,
    slashSuggestionCount,
    submit,
    addClipboardAttachment,
    clearClipboardAttachments,
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

  const {
    entries,
    model,
    mode,
    reasoning,
    authLabel,
    isBusy,
    busyStatus,
    currentTurnStartedAt,
    lastTurnDurationMs,
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
  const attachmentLines = React.useMemo(
    () => composerPreview.attachments.length > 0
      ? [
          ...buildAttachmentPreviewLines(composerPreview.attachments),
          formatInlineImageSupportLine(),
        ]
      : undefined,
    [composerPreview.attachments],
  );

  return (
    <WorkShellView
      provider={props.provider}
      model={model}
      reasoningLabel={reasoningLabel}
      reasoningSupported={reasoningSupported}
      mode={mode}
      authLabel={authDisplayLabel}
      entries={entries}
      isBusy={isBusy}
      {...(busyStatus ? { busyStatus } : {})}
      {...(currentTurnStartedAt !== undefined ? { currentTurnStartedAt } : {})}
      {...(lastTurnDurationMs !== undefined ? { lastTurnDurationMs } : {})}
      activePanel={activePanel}
      {...(attachmentLines ? { attachmentLines } : {})}
      composer={
        <Composer
          value={inputValue}
          onChange={setInputValue}
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
            }
          }}
          onClipboardImageError={(reason) => setLastClipboardError(reason)}
          {...(isSecureApiKeyEntry ? { mask: "•" } : {})}
        />
      }
      inputValue={inputValue}
      slashSuggestionCount={slashSuggestionCount}
      cwd={props.cwd}
      {...(isSecureApiKeyEntry
        ? { composerHintOverride: "Enter saves · Esc cancels" }
        : {})}
    />
  );
}
