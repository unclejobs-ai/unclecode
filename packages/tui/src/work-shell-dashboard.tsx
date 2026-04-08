import { useApp } from "ink";
import React, { useMemo } from "react";

import type { TuiShellHomeState } from "./shell-state.js";
import type { WorkShellImageAttachment } from "./work-shell-attachments.js";
import type { WorkShellPaneRuntimeState } from "./work-shell-hooks.js";
import {
  WorkShellPane,
  type WorkShellPaneProps,
} from "./work-shell-pane.js";

export type EmbeddedWorkShellPaneProps<
  Attachment extends WorkShellImageAttachment,
  State extends WorkShellPaneRuntimeState,
> = Omit<
  WorkShellPaneProps<Attachment, State>,
  "onExit" | "onRequestSessionsView" | "onSyncHomeState" | "refreshHomeState"
>;

export function EmbeddedWorkShellPane<
  Attachment extends WorkShellImageAttachment,
  State extends WorkShellPaneRuntimeState,
>(props: {
  readonly buildPane: (input: {
    readonly onExit: () => void;
  }) => EmbeddedWorkShellPaneProps<Attachment, State>;
  readonly onRequestSessionsView?: (() => void) | undefined;
  readonly onSyncHomeState?: ((homeState: Partial<TuiShellHomeState>) => void) | undefined;
  readonly refreshHomeState?: (() => Promise<TuiShellHomeState>) | undefined;
}) {
  const { exit } = useApp();
  const pane = useMemo(() => props.buildPane({ onExit: exit }), [props.buildPane, exit]);

  return (
    <WorkShellPane<Attachment, State>
      {...pane}
      onExit={exit}
      {...(props.onRequestSessionsView
        ? { onRequestSessionsView: props.onRequestSessionsView }
        : {})}
      {...(props.onSyncHomeState ? { onSyncHomeState: props.onSyncHomeState } : {})}
      {...(props.refreshHomeState
        ? { refreshHomeState: props.refreshHomeState }
        : {})}
    />
  );
}
