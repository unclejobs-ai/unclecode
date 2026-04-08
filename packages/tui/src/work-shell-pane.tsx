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

  const { entries, model, reasoning, authLabel, isBusy } = engineState;
  const isSecureApiKeyEntry = engineState.composerMode === "api-key-entry";

  return (
    <WorkShellView
      provider={props.provider}
      model={model}
      reasoningLabel={props.getReasoningLabel(reasoning)}
      reasoningSupported={props.isReasoningSupported(reasoning)}
      mode={props.mode}
      authLabel={formatAuthLabelForDisplay(authLabel)}
      entries={entries}
      isBusy={isBusy}
      activePanel={activePanel}
      {...(composerPreview.attachments.length > 0
        ? {
            attachmentLines: [
              ...buildAttachmentPreviewLines(composerPreview.attachments),
              formatInlineImageSupportLine(),
            ],
          }
        : {})}
      composer={
        <Composer
          value={inputValue}
          onChange={setInputValue}
          onSubmit={submit}
          {...(isSecureApiKeyEntry ? { mask: "•" } : {})}
        />
      }
      inputValue={inputValue}
      slashSuggestionCount={slashSuggestionCount}
      {...(isSecureApiKeyEntry
        ? { composerHintOverride: "Enter saves · Esc cancels" }
        : {})}
    />
  );
}
