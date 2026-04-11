import {
  createWorkShellPaneRuntime,
  type CreateWorkShellEngineInput,
  type WorkShellEngineState,
  type WorkShellReasoningConfig,
} from "@unclecode/orchestrator";
import React from "react";

import type { TuiRenderOptions } from "./index.js";
import type { TuiShellHomeState } from "./shell-state.js";
import type { WorkShellImageAttachment } from "./work-shell-attachments.js";
import type { WorkShellPaneRuntimeState } from "./work-shell-hooks.js";
import {
  EmbeddedWorkShellPane,
  type EmbeddedWorkShellPaneProps,
} from "./work-shell-dashboard.js";

export function createEmbeddedWorkShellDashboardProps(input: {
  readonly workspaceRoot: string;
  readonly homeState: TuiShellHomeState;
  readonly contextLines: readonly string[];
  readonly refreshHomeState?: (() => Promise<TuiShellHomeState>) | undefined;
  readonly renderWorkPane: NonNullable<
    TuiRenderOptions<TuiShellHomeState>["renderWorkPane"]
  >;
}): TuiRenderOptions<TuiShellHomeState> {
  return {
    workspaceRoot: input.workspaceRoot,
    modeLabel: input.homeState.modeLabel,
    authLabel: input.homeState.authLabel,
    sessionCount: input.homeState.sessionCount,
    mcpServerCount: input.homeState.mcpServerCount,
    mcpServers: input.homeState.mcpServers,
    latestResearchSessionId: input.homeState.latestResearchSessionId,
    latestResearchSummary: input.homeState.latestResearchSummary,
    latestResearchTimestamp: input.homeState.latestResearchTimestamp,
    researchRunCount: input.homeState.researchRunCount,
    sessions: input.homeState.sessions,
    bridgeLines: input.homeState.bridgeLines ?? [],
    memoryLines: input.homeState.memoryLines ?? [],
    refreshHomeState: input.refreshHomeState,
    initialView: "work",
    contextLines: input.contextLines,
    renderWorkPane: input.renderWorkPane,
  };
}

export function createEmbeddedWorkShellPaneDashboardProps<
  Attachment extends WorkShellImageAttachment,
  State extends WorkShellPaneRuntimeState,
>(input: {
  readonly workspaceRoot: string;
  readonly homeState: TuiShellHomeState;
  readonly contextLines: readonly string[];
  readonly refreshHomeState?: (() => Promise<TuiShellHomeState>) | undefined;
  readonly buildPane: (input: {
    readonly onExit: () => void;
  }) => EmbeddedWorkShellPaneProps<Attachment, State>;
}): TuiRenderOptions<TuiShellHomeState> {
  return createEmbeddedWorkShellDashboardProps({
    workspaceRoot: input.workspaceRoot,
    homeState: input.homeState,
    contextLines: input.contextLines,
    ...(input.refreshHomeState
      ? { refreshHomeState: input.refreshHomeState }
      : {}),
    renderWorkPane: ({ openSessions, syncHomeState }) => (
      <EmbeddedWorkShellPane<Attachment, State>
        buildPane={input.buildPane}
        onRequestSessionsView={openSessions}
        onSyncHomeState={syncHomeState}
        {...(input.refreshHomeState
          ? { refreshHomeState: input.refreshHomeState }
          : {})}
      />
    ),
  });
}

export type ManagedWorkShellDashboardInput<
  Attachment extends WorkShellImageAttachment,
  Reasoning extends WorkShellReasoningConfig,
  TraceEvent extends { readonly type: string },
> = {
  readonly homeState: TuiShellHomeState;
  readonly refreshHomeState?: (() => Promise<TuiShellHomeState>) | undefined;
  readonly paneRuntime: Omit<
    CreateWorkShellEngineInput<Attachment, Reasoning, TraceEvent>,
    "onExit"
  >;
  readonly getReasoningLabel: (reasoning: Reasoning) => string;
  readonly isReasoningSupported: (reasoning: Reasoning) => boolean;
};

export function createManagedWorkShellDashboardProps<
  Attachment extends WorkShellImageAttachment,
  Reasoning extends WorkShellReasoningConfig,
  TraceEvent extends { readonly type: string },
>(
  input: ManagedWorkShellDashboardInput<Attachment, Reasoning, TraceEvent>,
): TuiRenderOptions<TuiShellHomeState> {
  return createEmbeddedWorkShellPaneDashboardProps<
    Attachment,
    WorkShellEngineState<Reasoning>
  >({
    workspaceRoot: input.paneRuntime.options.cwd,
    homeState: input.homeState,
    contextLines: input.paneRuntime.options.contextSummaryLines,
    ...(input.refreshHomeState
      ? { refreshHomeState: input.refreshHomeState }
      : {}),
    buildPane: ({ onExit }): EmbeddedWorkShellPaneProps<
      Attachment,
      WorkShellEngineState<Reasoning>
    > => {
      const runtime = createWorkShellPaneRuntime({
        ...input.paneRuntime,
        onExit,
      });

      return {
        provider: input.paneRuntime.options.provider,
        model: input.paneRuntime.options.model,
        mode: input.paneRuntime.options.mode,
        engine: runtime.engine,
        cwd: input.paneRuntime.options.cwd,
        resolveComposerInput: input.paneRuntime.resolveComposerInput,
        getSuggestions: runtime.getSuggestions,
        browserOAuthAvailable: runtime.browserOAuthAvailable,
        shouldBlockSlashSubmit: runtime.shouldBlockSlashSubmit,
        getReasoningLabel: input.getReasoningLabel,
        isReasoningSupported: input.isReasoningSupported,
      };
    },
  });
}
