import { render } from "ink";
import React from "react";
import type { WorkShellReasoningConfig } from "@unclecode/orchestrator";

import { Dashboard, type TuiRenderOptions } from "./dashboard-shell.js";
import { resolveTuiRendererPlan } from "./renderer-capabilities.js";
import {
  createManagedWorkShellDashboardProps,
  type ManagedWorkShellDashboardInput,
} from "./dashboard-render.js";
import { enterAlternateScreen } from "./alt-screen.js";
import type { WorkShellImageAttachment } from "./work-shell-attachments.js";
import type { TuiShellHomeState } from "./shell-state.js";
import { probeTerminalBackground } from "./terminal-theme.js";

let rendererFallbackWarned = false;
// Ink 7 fixes the trailing-newline cursor rewind that made incremental frames
// drift under Ink 6. Column-shrink residue remains handled by the terminal
// resize clear, while ordinary streaming now updates only changed rows.
const DASHBOARD_RENDER_OPTIONS = { incrementalRendering: true } as const;
const ESC = String.fromCharCode(27);

export const RUNTIME_CONNECTION_STATUS = {
  en: "Connecting to UncleCode runtime…",
  ko: "UncleCode 런타임에 연결 중…",
} as const;

/**
 * Paint a useful first frame before the persistent runtime owner is ready.
 * Owner discovery and session attachment intentionally happen before Ink owns
 * stdin, so this tiny synchronous frame prevents a slow cold start from
 * looking like a dead terminal. The returned handle is idempotent and must be
 * restored before mounting the real dashboard.
 */
export function showRuntimeConnectionStatus(input: {
  readonly locale?: "en" | "ko" | undefined;
  readonly stdout?: NodeJS.WriteStream | undefined;
} = {}): { readonly restore: () => void; readonly active: boolean } {
  const stdout = input.stdout ?? process.stdout;
  const altScreen = enterAlternateScreen(stdout);
  if (!altScreen.active) return altScreen;
  const message = RUNTIME_CONNECTION_STATUS[input.locale ?? "en"];
  stdout.write(`${ESC}[2J${ESC}[HUncleCode\n\n● ${message}\n`);
  return altScreen;
}

function warnIfRequestedRendererFallsBack(): void {
  const plan = resolveTuiRendererPlan();
  if (plan.renderer !== "opentui" || plan.status !== "blocked" || rendererFallbackWarned) {
    return;
  }
  rendererFallbackWarned = true;
  process.stderr.write(`[unclecode] ${plan.reason ?? "OpenTUI renderer is not available yet."} Falling back to Ink.\n`);
}

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
  warnIfRequestedRendererFallsBack();
  // Ask the terminal for its background before Ink claims stdin. The palette's
  // primary text tier depends on the answer, and COLORFGBG is unset on most
  // modern terminals.
  await probeTerminalBackground();
  // Probe first, then take the screen: the OSC 11 reply would otherwise be
  // written into a buffer we are about to swap away.
  const altScreen = enterAlternateScreen();
  try {
    const instance = render(createDashboardElement(props), DASHBOARD_RENDER_OPTIONS);
    await instance.waitUntilExit();
  } finally {
    altScreen.restore();
  }
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
  warnIfRequestedRendererFallsBack();
  await probeTerminalBackground();
  const altScreen = enterAlternateScreen();
  try {
    const instance = render(createDashboardElement(options ?? {}), DASHBOARD_RENDER_OPTIONS);
    await instance.waitUntilExit();
  } finally {
    altScreen.restore();
  }
}
