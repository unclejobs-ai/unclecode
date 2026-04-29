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
          onSubmit={(line) => {
            // Pending clipboard attachments are flushed at submit time so a
            // paste-then-edit sequence carries the image into the turn but
            // a submitted turn does not leak attachments back into the next.
            clearClipboardAttachments();
            return submit(line);
          }}
          onClipboardImage={(attachment) => {
            // The composer surface is generic over Attachment but in
            // practice every consumer resolves it to ClipboardImageAttachment
            // (= WorkShellImageAttachment). The structural shape is
            // identical; cast at the seam keeps the generic constraint
            // honest without leaking ClipboardImageAttachment names into
            // every caller.
            addClipboardAttachment(attachment as Attachment);
          }}
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
