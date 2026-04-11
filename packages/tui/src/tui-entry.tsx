import { render } from "ink";
import React from "react";
import type { WorkShellReasoningConfig } from "@unclecode/orchestrator";

import { Dashboard, type TuiRenderOptions } from "./dashboard-shell.js";
import {
  createManagedWorkShellDashboardProps,
  type ManagedWorkShellDashboardInput,
} from "./dashboard-render.js";
import type { WorkShellImageAttachment } from "./work-shell-attachments.js";
import type { TuiShellHomeState } from "./shell-state.js";

export function createDashboardElement(
  props: TuiRenderOptions<TuiShellHomeState>,
) {
  return (
    <Dashboard
      workspaceRoot={props.workspaceRoot ?? process.cwd()}
      {...(props.modeLabel ? { modeLabel: props.modeLabel } : {})}
      {...(props.authLabel ? { authLabel: props.authLabel } : {})}
      {...(props.sessionCount !== undefined
        ? { sessionCount: props.sessionCount }
        : {})}
      {...(props.mcpServerCount !== undefined
        ? { mcpServerCount: props.mcpServerCount }
        : {})}
      {...(props.mcpServers ? { mcpServers: props.mcpServers } : {})}
      {...(props.latestResearchSessionId !== undefined
        ? { latestResearchSessionId: props.latestResearchSessionId }
        : {})}
      {...(props.latestResearchSummary !== undefined
        ? { latestResearchSummary: props.latestResearchSummary }
        : {})}
      {...(props.latestResearchTimestamp !== undefined
        ? { latestResearchTimestamp: props.latestResearchTimestamp }
        : {})}
      {...(props.researchRunCount !== undefined
        ? { researchRunCount: props.researchRunCount }
        : {})}
      {...(props.initialSelectedSessionId
        ? { initialSelectedSessionId: props.initialSelectedSessionId }
        : {})}
      {...(props.sessions ? { sessions: props.sessions } : {})}
      contextLines={props.contextLines ?? []}
      bridgeLines={props.bridgeLines ?? []}
      memoryLines={props.memoryLines ?? []}
      {...(props.runAction ? { runAction: props.runAction } : {})}
      {...(props.runSession ? { runSession: props.runSession } : {})}
      {...(props.launchWorkSession
        ? { launchWorkSession: props.launchWorkSession }
        : {})}
      {...(props.renderWorkPane ? { renderWorkPane: props.renderWorkPane } : {})}
      {...(props.openEmbeddedWorkSession
        ? { openEmbeddedWorkSession: props.openEmbeddedWorkSession }
        : {})}
      {...(props.initialView ? { initialView: props.initialView } : {})}
      {...(props.refreshHomeState
        ? { refreshHomeState: props.refreshHomeState }
        : {})}
    />
  );
}

export async function renderEmbeddedWorkShellPaneDashboard(
  props: TuiRenderOptions<TuiShellHomeState>,
): Promise<void> {
  const instance = render(createDashboardElement(props));
  await instance.waitUntilExit();
}

export async function renderManagedWorkShellDashboard<
  Attachment extends WorkShellImageAttachment,
  Reasoning extends WorkShellReasoningConfig,
  TraceEvent extends { readonly type: string },
>(
  input: ManagedWorkShellDashboardInput<Attachment, Reasoning, TraceEvent>,
): Promise<void> {
  await renderEmbeddedWorkShellPaneDashboard(
    createManagedWorkShellDashboardProps(input),
  );
}

export async function renderTui(
  options?: TuiRenderOptions<TuiShellHomeState>,
): Promise<void> {
  const instance = render(createDashboardElement(options ?? {}));
  await instance.waitUntilExit();
}
