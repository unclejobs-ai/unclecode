import { UNCLECODE_COMMAND_NAME } from "@unclecode/contracts";
import {
  createWorkShellPaneRuntime,
  type CreateWorkShellEngineInput,
  type WorkShellEngineState,
  type WorkShellReasoningConfig,
} from "@unclecode/orchestrator";
import { Box, Text, render, useApp, useInput } from "ink";
import React, { useCallback, useEffect, useReducer, useState } from "react";

import { getGitBranch, getGitStatus, getRuntimeFacts } from "./facts.js";
export * from "./composer.js";
export * from "./work-shell-attachments.js";
export * from "./work-shell-dashboard-sync.js";
export * from "./work-shell-dashboard.js";
export * from "./work-shell-formatters.js";
export * from "./work-shell-hooks.js";
export * from "./work-shell-input.js";
export * from "./work-shell-pane.js";
export * from "./work-shell-panels.js";
export * from "./work-shell-view.js";
export type { TuiShellHomeState } from "./shell-state.js";
import {
  EmbeddedWorkShellPane,
  type EmbeddedWorkShellPaneProps,
} from "./work-shell-dashboard.js";
import type { WorkShellImageAttachment } from "./work-shell-attachments.js";
import type { WorkShellPaneRuntimeState } from "./work-shell-hooks.js";
import {
  createInitialShellState,
  reduceShellEvent,
  type TuiActivityEntry as TuiShellActivityEntry,
  type TuiShellFocusState,
  type TuiShellHomeState,
  type TuiShellState,
  type TuiApprovalRequest,
  type TuiStepTraceEntry as TuiShellStepTraceEntry,
  type TuiWorkerStatus,
} from "./shell-state.js";

const C = {
  bg: "#faf8f5",
  surface: "#ffffff",
  border: "#e2ddd5",
  borderActive: "#a8a29e",
  text: "#292524",
  textSecondary: "#78716c",
  textMuted: "#a8a29e",
  accent: "#059669",
  accentBright: "#10b981",
  warning: "#d97706",
  error: "#dc2626",
  info: "#0891b2",
  success: "#059669",
  statusBg: "#d1fae5",
  statusBgWarning: "#fef3c7",
  statusBgError: "#fee2e2",
  tagBg: "#f5f5f4",
} as const;

const B = {
  tl: "┌", tr: "┐", bl: "└", br: "┘",
  h: "─", v: "│",
  tDown: "┬", tUp: "┴", tRight: "├", tLeft: "┤",
} as const;

function PanelBox(props: {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly width?: number;
  readonly height?: number;
}) {
  const w = props.width ?? 40;
  const innerW = w - 2;
  const titleLen = props.title.length;
  const rightPad = Math.max(0, innerW - titleLen - 2);

  return (
    <Box flexDirection="column">
      <Text color={C.border}>
        {B.tl}{B.h}{B.h} {props.title}{B.h.repeat(rightPad)}{B.tr}
      </Text>
      <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
        {props.children}
      </Box>
      <Text color={C.border}>{B.bl}{B.h.repeat(innerW)}{B.br}</Text>
    </Box>
  );
}

function ThinDivider() {
  return <Text color={C.border}>{B.h.repeat(72)}</Text>;
}

function StatusBadge(props: { readonly label: string; readonly status: "running" | "queued" | "completed" | "idle" }) {
  const colorMap = {
    running: { fg: C.surface, bg: C.success },
    queued: { fg: C.textMuted, bg: C.tagBg },
    completed: { fg: C.accent, bg: C.statusBg },
    idle: { fg: C.textMuted, bg: C.tagBg },
  } as const;
  const c = colorMap[props.status];
  return (
    <Text backgroundColor={c.bg} color={c.fg}>
      {" "}{props.status}{" "}
    </Text>
  );
}

function KeyValue(props: { readonly label: string; readonly value: string; readonly valueColor?: string }) {
  return (
    <Box>
      <Text color={C.textMuted}>{props.label} </Text>
      <Text color={props.valueColor ?? C.text}>{props.value}</Text>
    </Box>
  );
}

function LogLine(props: {
  readonly time: string;
  readonly level: "INF" | "WRN" | "ERR";
  readonly message: string;
}) {
  const levelColor = props.level === "INF" ? C.info : props.level === "WRN" ? C.warning : C.error;
  return (
    <Box>
      <Text color={C.textMuted}>{props.time}  </Text>
      <Text color={levelColor} bold>{props.level} </Text>
      <Text color={C.text}>{props.message}</Text>
    </Box>
  );
}

function KeyHint(props: { readonly keys: string; readonly label: string }) {
  return (
    <Box gap={1}>
      <Text backgroundColor={C.tagBg} color={C.textSecondary} bold> {props.keys} </Text>
      <Text color={C.textMuted}>{props.label}</Text>
    </Box>
  );
}

export type WorkspaceShellSections = {
  readonly title: string;
  readonly subtitle: string;
  readonly workspaceLine: string;
  readonly statusLine: string;
  readonly actions: ReadonlyArray<{
    readonly label: string;
    readonly command: string;
  }>;
};

export function createWorkspaceShellSections(input: {
  workspaceRoot: string;
}): WorkspaceShellSections {
  return {
    title: UNCLECODE_COMMAND_NAME,
    subtitle: "Local coding shell ready for UncleCode workspace setup.",
    workspaceLine: input.workspaceRoot,
    statusLine: "Session center is live. Recent work and utility actions are available now.",
    actions: [
      { label: "Check auth status", command: "unclecode auth status" },
      { label: "Start browser login", command: "unclecode auth login --browser" },
      { label: "Inspect effective config", command: "unclecode config explain" },
      { label: "Browse commands", command: "unclecode --help" },
    ],
  };
}

export type DashboardAction = {
  readonly label: string;
  readonly command: string;
  readonly description: string;
  readonly category: "auth" | "config" | "workspace" | "session";
};

export type DashboardView = "browse" | "detail";

export type DashboardInputResult = {
  readonly view: DashboardView;
  readonly selectedIndex: number;
  readonly shouldExit: boolean;
  readonly exitCommand: string | undefined;
};

export type SessionCenterSession = {
  readonly sessionId: string;
  readonly state: string;
  readonly updatedAt: string;
  readonly model: string | null;
  readonly taskSummary: string | null;
  readonly mode?: string | null;
  readonly pendingAction?: string | null;
  readonly worktreeBranch?: string | null;
};

export type SessionCenterAction = {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly description: string;
};

export type SessionCenterModel = {
  readonly title: string;
  readonly subtitle: string;
  readonly modeLabel: string;
  readonly authLabel: string;
  readonly sessionCount: number;
  readonly mcpServerCount: number;
  readonly mcpServers: readonly { name: string; transport: string; scope: string; trustTier: string; originLabel: string }[];
  readonly latestResearchSessionId: string | null;
  readonly latestResearchSummary: string | null;
  readonly latestResearchTimestamp: string | null;
  readonly researchRunCount: number;
  readonly primarySessions: readonly SessionCenterSession[];
  readonly utilityActions: readonly SessionCenterAction[];
  readonly emptyState: string;
};

export type TuiActivityEntry = {
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly timestamp: string;
  readonly lines: readonly string[];
  readonly tone: "info" | "success" | "warning";
};

export function createEmbeddedWorkShellDashboardProps(input: {
  readonly workspaceRoot: string;
  readonly homeState: TuiShellHomeState;
  readonly contextLines: readonly string[];
  readonly refreshHomeState?: (() => Promise<TuiShellHomeState>) | undefined;
  readonly renderWorkPane: NonNullable<React.ComponentProps<typeof Dashboard>["renderWorkPane"]>;
}): React.ComponentProps<typeof Dashboard> {
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
}): React.ComponentProps<typeof Dashboard> {
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
): React.ComponentProps<typeof Dashboard> {
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

export async function renderEmbeddedWorkShellPaneDashboard(
  props: React.ComponentProps<typeof Dashboard>,
): Promise<void> {
  const instance = render(<Dashboard {...props} />);
  await instance.waitUntilExit();
}

export async function renderManagedWorkShellDashboard<
  Attachment extends WorkShellImageAttachment,
  Reasoning extends WorkShellReasoningConfig,
  TraceEvent extends { readonly type: string },
>(input: ManagedWorkShellDashboardInput<Attachment, Reasoning, TraceEvent>): Promise<void> {
  await renderEmbeddedWorkShellPaneDashboard(
    createManagedWorkShellDashboardProps(input),
  );
}

export type ResearchDraftResult = {
  readonly value: string;
  readonly submitted: boolean;
};

export type SessionCenterFocusState = {
  readonly column: "sessions" | "actions";
  readonly sessionIndex: number;
  readonly actionIndex: number;
  readonly detailOpen: boolean;
  readonly shouldExit?: boolean | undefined;
  readonly selectedCommand?: string | undefined;
};

type SessionCenterResolvedState = TuiShellFocusState;

export const DASHBOARD_ACTIONS: ReadonlyArray<DashboardAction> = [
  {
    label: "Check Auth",
    command: "unclecode auth status",
    description: "Verify your OpenAI provider authentication state, token expiry, and organization context.",
    category: "auth",
  },
  {
    label: "Browser Login",
    command: "unclecode auth login --browser",
    description: "Start an OAuth browser-based login flow. Requires OPENAI_OAUTH_CLIENT_ID in environment.",
    category: "auth",
  },
  {
    label: "Config Explain",
    command: "unclecode config explain",
    description: "Inspect the resolved configuration: settings, prompt sections, and active mode overlays.",
    category: "config",
  },
  {
    label: "Browse Commands",
    command: "unclecode --help",
    description: "View all available CLI commands, subcommands, flags, and their descriptions.",
    category: "config",
  },
  {
    label: "Workspace Health",
    command: "unclecode doctor",
    description: "Run the local doctor surface and inspect workspace readiness.",
    category: "workspace",
  },
  {
    label: "Session Center",
    command: "unclecode center",
    description: "Open the secondary session center launcher and inspector surface.",
    category: "session",
  },
];

const SESSION_CENTER_ACTIONS: readonly SessionCenterAction[] = [
  { id: "work-session", label: "W Work", command: "unclecode work", description: "Launch the real interactive coding assistant session." },
  { id: "browser-login", label: "B Browser", command: "unclecode auth login --browser", description: "Launch the browser OAuth flow and wait for the callback to complete." },
  { id: "api-key-login", label: "K Key", command: "unclecode auth login --api-key-stdin", description: "Paste an OpenAI API key to save local auth. Optional: append --org <id> --project <id>." },
  { id: "auth-logout", label: "L Logout", command: "unclecode auth logout", description: "Clear locally stored UncleCode auth credentials." },
  { id: "new-research", label: "R Research", command: "unclecode research run", description: "Start a fresh local research pass for the current workspace." },
  { id: "doctor", label: "D Doctor", command: "unclecode doctor", description: "Check auth, runtime, session-store, and MCP readiness." },
] as const;

export function getWorkspaceDisplayName(workspacePath: string): string {
  const segments = workspacePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? workspacePath;
}

export function truncateForPane(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 1)}…`;
}

export function formatSessionHeadline(session: SessionCenterSession): string {
  if (session.taskSummary && session.taskSummary.trim().length > 0) {
    return session.taskSummary.trim();
  }
  if (session.sessionId.startsWith("research-")) {
    return "Research session";
  }
  if (session.sessionId.startsWith("work-")) {
    return "Work session";
  }
  return "Saved session";
}

export function handleDashboardInput(
  input: string,
  key: { readonly upArrow?: boolean; readonly downArrow?: boolean; readonly return?: boolean; readonly escape?: boolean; readonly ctrl?: boolean },
  view: DashboardView,
  selectedIndex: number,
  actionCount: number,
): DashboardInputResult {
  const stay = { view, selectedIndex, shouldExit: false, exitCommand: undefined } as const;
  if (view === "browse") {
    if (input === "q" || (key.ctrl && input === "c")) return { view: "browse", selectedIndex, shouldExit: true, exitCommand: undefined };
    if (key.upArrow) return { view: "browse", selectedIndex: Math.max(0, selectedIndex - 1), shouldExit: false, exitCommand: undefined };
    if (key.downArrow) return { view: "browse", selectedIndex: Math.min(actionCount - 1, selectedIndex + 1), shouldExit: false, exitCommand: undefined };
    if (key.return) return { view: "detail", selectedIndex, shouldExit: false, exitCommand: undefined };
    return stay;
  }
  if (key.escape) return { view: "browse", selectedIndex, shouldExit: false, exitCommand: undefined };
  if (key.return) return { view: "detail", selectedIndex, shouldExit: true, exitCommand: DASHBOARD_ACTIONS[selectedIndex]?.command };
  if (key.ctrl && input === "c") return { view: "detail", selectedIndex, shouldExit: true, exitCommand: undefined };
  return stay;
}

export function createSessionCenterModel(input: {
  workspaceRoot: string;
  modeLabel: string;
  authLabel: string;
  sessionCount?: number;
  mcpServerCount?: number;
  mcpServers?: readonly { name: string; transport: string; scope: string; trustTier: string; originLabel: string }[];
  latestResearchSessionId?: string | null;
  latestResearchSummary?: string | null;
  latestResearchTimestamp?: string | null;
  researchRunCount?: number;
  sessions: readonly SessionCenterSession[];
}): SessionCenterModel {
  return {
    title: UNCLECODE_COMMAND_NAME,
    subtitle: "Resume recent work. Use Work to continue or connect auth with Browser, Key, or Logout.",
    modeLabel: input.modeLabel,
    authLabel: input.authLabel,
    sessionCount: input.sessionCount ?? input.sessions.length,
    mcpServerCount: input.mcpServerCount ?? 0,
    mcpServers: input.mcpServers ?? [],
    latestResearchSessionId: input.latestResearchSessionId ?? null,
    latestResearchSummary: input.latestResearchSummary ?? null,
    latestResearchTimestamp: input.latestResearchTimestamp ?? null,
    researchRunCount: input.researchRunCount ?? 0,
    primarySessions: input.sessions.slice(0, 6),
    utilityActions: SESSION_CENTER_ACTIONS,
    emptyState: "Press W to open work. Sessions will appear here after your first run.",
  };
}

export function handleSessionCenterInput(
  input: string,
  key: { readonly upArrow?: boolean; readonly downArrow?: boolean; readonly leftArrow?: boolean; readonly rightArrow?: boolean; readonly return?: boolean; readonly escape?: boolean; readonly ctrl?: boolean },
  state: SessionCenterFocusState,
  counts: { readonly sessionCount: number; readonly actionCount: number },
  actionCommands: readonly string[] = SESSION_CENTER_ACTIONS.map((action) => action.command),
  sessionCommands?: readonly string[],
): SessionCenterResolvedState {
  const isSubmitInput = input === "\r" || input === "\n" || (input === "" && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.escape && !key.ctrl);
  const base: SessionCenterResolvedState = { column: state.column, sessionIndex: state.sessionIndex, actionIndex: state.actionIndex, detailOpen: state.detailOpen, shouldExit: false, selectedCommand: undefined };
  if (input === "q" || (key.ctrl && input === "c")) return { ...base, shouldExit: true };
  if (state.detailOpen) {
    if (key.escape) return { ...base, detailOpen: false };
    if (key.leftArrow || input === "h") return { ...base, column: "sessions", detailOpen: false };
    if (key.rightArrow || input === "l") return { ...base, column: "actions", detailOpen: false };
    if (input === "\t") return { ...base, column: state.column === "sessions" ? "actions" : "sessions", detailOpen: false };
    if (key.upArrow || input === "k") {
      return state.column === "sessions"
        ? { ...base, sessionIndex: Math.max(0, state.sessionIndex - 1), detailOpen: false }
        : { ...base, actionIndex: Math.max(0, state.actionIndex - 1), detailOpen: false };
    }
    if (key.downArrow || input === "j") {
      return state.column === "sessions"
        ? { ...base, sessionIndex: Math.min(Math.max(0, counts.sessionCount - 1), state.sessionIndex + 1), detailOpen: false }
        : { ...base, actionIndex: Math.min(Math.max(0, counts.actionCount - 1), state.actionIndex + 1), detailOpen: false };
    }
    if (key.return || isSubmitInput) {
      const selectedCommand = state.column === "actions" ? actionCommands[state.actionIndex] : sessionCommands?.[state.sessionIndex];
      return { ...base, shouldExit: true, selectedCommand };
    }
    return base;
  }
  if (key.leftArrow || input === "h") return { ...base, column: "sessions" };
  if (key.rightArrow || input === "l") return { ...base, column: "actions" };
  if (input === "\t") return { ...base, column: state.column === "sessions" ? "actions" : "sessions" };
  if (key.upArrow || input === "k") {
    return state.column === "sessions" ? { ...base, sessionIndex: Math.max(0, state.sessionIndex - 1) } : { ...base, actionIndex: Math.max(0, state.actionIndex - 1) };
  }
  if (key.downArrow || input === "j") {
    return state.column === "sessions" ? { ...base, sessionIndex: Math.min(Math.max(0, counts.sessionCount - 1), state.sessionIndex + 1) } : { ...base, actionIndex: Math.min(Math.max(0, counts.actionCount - 1), state.actionIndex + 1) };
  }
  if (key.return || isSubmitInput) {
    if (state.column === "actions") return { ...base, shouldExit: true, selectedCommand: actionCommands[state.actionIndex] };
    return { ...base, detailOpen: true };
  }
  return base;
}

export function handleResearchDraftInput(currentValue: string, input: string, key: { readonly return?: boolean; readonly backspace?: boolean; readonly delete?: boolean }): ResearchDraftResult {
  if (key.backspace || key.delete) return { value: currentValue.slice(0, -1), submitted: false };
  if (key.return || input === "\r" || input === "\n") { const nextValue = currentValue.trim(); return { value: nextValue, submitted: nextValue.length > 0 }; }
  return { value: `${currentValue}${input}`, submitted: false };
}

export function formatSessionCenterDraftValue(actionId: string | undefined, draft: string): string {
  if (actionId !== "api-key-login") {
    return draft;
  }

  const parts = draft.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return draft;
  }

  return ["[REDACTED]", ...parts.slice(1)].join(" ");
}

export function appendActivityEntry(entries: readonly TuiActivityEntry[], nextEntry: TuiActivityEntry): readonly TuiActivityEntry[] {
  return [nextEntry, ...entries].slice(0, 20);
}

export function createApprovalRequestForAction(actionId: string) {
  if (actionId === "browser-login") return { id: "approval-browser-login", title: "Open Browser Login", detail: "Launch the browser OAuth flow and wait for the callback to complete.", severity: "info" as const };
  if (actionId === "device-login") return { id: "approval-device-login", title: "Start Device Login", detail: "Begin the device-code login flow from this shell.", severity: "warning" as const };
  return undefined;
}

export function getSessionCenterActionShortcut(input: string): string | undefined {
  switch (input.toLowerCase()) {
    case "w": return "work-session";
    case "b": return "browser-login";
    case "k": return "api-key-login";
    case "l": return "auth-logout";
    case "r": return "new-research";
    case "d": return "doctor";
    default: return undefined;
  }
}

export function getImmediateActionShortcut(input: string): string | undefined {
  switch (input) {
    case "W": return "work-session";
    case "B": return "browser-login";
    case "K": return "api-key-login";
    case "L": return "auth-logout";
    case "R": return "new-research";
    case "D": return "doctor";
    default: return undefined;
  }
}

export function getSessionCenterViewShortcut(input: string): TuiShellState["view"] | undefined {
  switch (input) {
    case "1": return "work";
    case "2": return "sessions";
    case "3": return "mcp";
    case "4": return "research";
    default: return undefined;
  }
}

export function shouldRenderEmbeddedWorkPaneFullscreen(view: TuiShellState["view"], hasEmbeddedWorkPane: boolean): boolean {
  return view === "work" && hasEmbeddedWorkPane;
}

export function shouldCaptureDashboardInput(view: TuiShellState["view"], hasEmbeddedWorkPane: boolean): boolean {
  return !shouldRenderEmbeddedWorkPaneFullscreen(view, hasEmbeddedWorkPane);
}

export function handleApprovalInput(input: string, key: { readonly return?: boolean; readonly escape?: boolean }): { decision: "approve" | "reject" | "noop" } {
  if (input === "x" || key.escape) return { decision: "reject" };
  if (input === "a" || input === "\r" || input === "\n" || key.return) return { decision: "approve" };
  return { decision: "noop" };
}

function HeaderChrome(props: { readonly branch: string; readonly gitStatus: string; readonly workspacePath: string }) {
  const dirName = getWorkspaceDisplayName(props.workspacePath);
  const statusColor = props.gitStatus === "clean" ? C.success : C.warning;
  const showDir = dirName !== UNCLECODE_COMMAND_NAME;

  return (
    <Box>
      <Text color={C.accent} bold>{UNCLECODE_COMMAND_NAME}</Text>
      {showDir ? (
        <>
          <Text color={C.textMuted}> · </Text>
          <Text color={C.text}>{dirName}</Text>
        </>
      ) : null}
      <Text color={C.textMuted}> · </Text>
      <Text color={C.accentBright}>{props.branch}</Text>
      <Text color={C.textMuted}> · </Text>
      <Text color={statusColor}>{props.gitStatus}</Text>
    </Box>
  );
}

function StatusBar(props: {
  readonly runtime: { readonly node: string; readonly platform: string; readonly arch: string };
  readonly modeLabel: string;
  readonly authLabel: string;
  readonly approvalCount: number;
  readonly workerCount: number;
}) {
  const sep = <Text color={C.textMuted}> {B.v} </Text>;
  return (
    <Box>
      <Text color={C.warning}>mode {props.modeLabel}</Text>
      {sep}
      <Text color={C.info}>auth {props.authLabel}</Text>
      {sep}
      <Text color={props.approvalCount > 0 ? C.warning : C.textMuted}>approvals {props.approvalCount}</Text>
      {sep}
      <Text color={props.workerCount > 0 ? C.success : C.textMuted}>workers {props.workerCount}</Text>
      {sep}
      <Text color={C.textMuted}>↑↓ move · Tab switch · Enter run</Text>
    </Box>
  );
}

const VIEW_TABS = [
  { key: "1", label: "Work", view: "work" as const },
  { key: "2", label: "Sessions", view: "sessions" as const },
  { key: "3", label: "MCP", view: "mcp" as const },
  { key: "4", label: "Research", view: "research" as const },
] as const;

function ViewTabs(props: { activeView: TuiShellState["view"] }) {
  return (
    <Box gap={1}>
      {VIEW_TABS.map((tab) => {
        const isActive = props.activeView === tab.view;
        return (
          <Box key={tab.view}>
            <Text color={isActive ? C.accent : C.textMuted}>{tab.key}</Text>
            <Text color={isActive ? C.text : C.textMuted}> {tab.label}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function SessionList(props: {
  readonly sessions: readonly SessionCenterSession[];
  readonly selectedIndex: number;
  readonly isActive: boolean;
  readonly emptyState: string;
}) {
  if (props.sessions.length === 0) return <Text color={C.textMuted}>{props.emptyState}</Text>;
  return (
    <Box flexDirection="column">
      {props.sessions.map((session, index) => {
        const isSelected = props.isActive && props.selectedIndex === index;
        const prefix = isSelected ? <Text color={C.accent}>▸ </Text> : <Text color={C.textMuted}>  </Text>;
        const stateColor = session.state === "running" ? C.success : session.state === "completed" ? C.info : session.state === "requires_action" ? C.warning : C.textMuted;
        return (
          <Box key={session.sessionId} flexDirection="column">
            <Box>
              {prefix}
              <Text color={isSelected ? C.accentBright : C.textSecondary} bold={isSelected}>{truncateForPane(formatSessionHeadline(session), 24)}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text color={stateColor}>{session.state}</Text>
              <Text color={C.textMuted}> · </Text>
              <Text color={C.textMuted}>{session.model ?? "none"}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text color={C.textMuted}>{truncateForPane(session.sessionId, 22)}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function ActionList(props: {
  readonly actions: readonly SessionCenterAction[];
  readonly selectedIndex: number;
  readonly isActive: boolean;
}) {
  return (
    <Box flexDirection="column">
      {props.actions.map((action, index) => {
        const isSelected = props.isActive && props.selectedIndex === index;
        const prefix = isSelected ? <Text color={C.accent}>▸ </Text> : <Text color={C.textMuted}>  </Text>;
        return (
          <Box key={action.id}>
            {prefix}
            <Text color={isSelected ? C.accentBright : C.textSecondary} bold={isSelected}>{truncateForPane(action.label, 18)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function buildActivityInspectorModel(input: {
  readonly approvals: readonly TuiApprovalRequest[];
  readonly workers: readonly TuiWorkerStatus[];
  readonly outputLines: readonly string[];
  readonly traceEntries: readonly TuiShellStepTraceEntry[];
  readonly activityEntries: readonly TuiShellActivityEntry[];
}): {
  readonly currentLines: readonly string[];
  readonly traceLines: readonly { message: string; timestamp: string; color: string }[];
  readonly historyLines: readonly string[];
} {
  const currentLines = [
    ...(input.approvals[0] ? [`Approval: ${input.approvals[0].title}`] : []),
    ...(input.workers[0] ? [`Worker: ${input.workers[0].label} · ${input.workers[0].detail}`] : []),
    ...(input.outputLines[0] ? [`Result: ${input.outputLines[0]}`] : []),
  ];

  return {
    currentLines,
    traceLines: input.traceEntries.slice(0, 6).map((entry) => ({
      message: entry.message,
      timestamp: entry.timestamp,
      color: entry.kind === "approval" ? C.warning : entry.kind === "result" ? C.success : entry.level === "low-signal" ? C.textMuted : C.info,
    })),
    historyLines: input.activityEntries.slice(0, 6).map((entry) => entry.title),
  };
}

export function buildInspectorContextLines(input: {
  readonly contextLines: readonly string[];
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
}): readonly string[] {
  const sections = [
    input.contextLines.length > 0 ? ["Workspace", ...input.contextLines] : [],
    input.bridgeLines.length > 0 ? ["Bridge", ...input.bridgeLines] : [],
    input.memoryLines.length > 0 ? ["Memory", ...input.memoryLines] : [],
  ].filter((section) => section.length > 0);

  return sections.flatMap((section, index) => (index === 0 ? section : ["", ...section]));
}

function InspectorContext(props: {
  readonly contextLines: readonly string[];
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
}) {
  const lines = buildInspectorContextLines(props);
  if (lines.length === 0) {
    return <Text color={C.textMuted}>No workspace context yet.</Text>;
  }

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        line === "" ? (
          <Text key={`gap-${String(index)}`}> </Text>
        ) : (
          <Text key={`${line}-${String(index)}`} color={line === "Workspace" || line === "Bridge" || line === "Memory" ? C.text : C.textMuted}>
            {truncateForPane(line, 40)}
          </Text>
        )
      ))}
    </Box>
  );
}

function DetailPanel(props: {
  readonly selectedSession: SessionCenterSession | undefined;
  readonly selectedAction: SessionCenterAction | undefined;
  readonly selectedApproval: TuiApprovalRequest | undefined;
  readonly selectedActionId: string | undefined;
  readonly view: TuiShellState["view"];
  readonly shellState: TuiShellState;
  readonly model: SessionCenterModel;
  readonly researchDraft: string;
  readonly contextLines: readonly string[];
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
}) {
  if (props.selectedApproval) {
    return (
      <Box flexDirection="column">
        <Text color={props.selectedApproval.severity === "warning" ? C.warning : C.info}>{props.selectedApproval.title}</Text>
        <Text color={C.textMuted}>{truncateForPane(props.selectedApproval.detail, 40)}</Text>
        <Box marginTop={1}>
          <Text color={C.success}>Enter / a → approve</Text>
          <Text color={C.textMuted}>  </Text>
          <Text color={C.warning}>x / Esc → cancel</Text>
        </Box>
      </Box>
    );
  }

  if (props.view === "work") {
    const activityModel = buildActivityInspectorModel({
      approvals: props.shellState.approvals,
      workers: props.shellState.workers,
      outputLines: props.shellState.outputLines,
      traceEntries: props.shellState.traceEntries,
      activityEntries: props.shellState.activityEntries,
    });

    return (
      <Box flexDirection="column">
        <Text color={C.textMuted}>Current state for this shell session.</Text>
        <Box marginTop={1}><Text bold color={C.text}>Now</Text></Box>
        {activityModel.currentLines.length === 0 ? (
          <Text color={C.textMuted}>Nothing active right now.</Text>
        ) : (
          activityModel.currentLines.map((line, index) => (
            <Text key={`${String(index)}-${line}`} color={C.text}>{truncateForPane(line, 40)}</Text>
          ))
        )}
        <Box marginTop={1}><Text bold color={C.text}>Live steps</Text></Box>
        {activityModel.traceLines.length === 0 ? (
          <Text color={C.textMuted}>No trace yet.</Text>
        ) : (
          activityModel.traceLines.map((entry) => (
            <Box key={`${entry.timestamp}-${entry.message}`} flexDirection="column">
              <Text color={entry.color}>{truncateForPane(entry.message, 40)}</Text>
              <Text color={C.textMuted}>{truncateForPane(entry.timestamp, 24)}</Text>
            </Box>
          ))
        )}
        <Box marginTop={1}><Text bold color={C.text}>Recent</Text></Box>
        {activityModel.historyLines.length === 0 ? (
          <Text color={C.textMuted}>No recent activity.</Text>
        ) : (
          activityModel.historyLines.map((line, index) => (
            <Text key={`${String(index)}-${line}`} color={C.textMuted}>{truncateForPane(line, 40)}</Text>
          ))
        )}
      </Box>
    );
  }

  if (props.view === "research") {
    return (
      <Box flexDirection="column">
        <Text color={C.textMuted}>Latest research summary</Text>
        <Text color={C.textMuted}>session: {props.model.latestResearchSessionId ?? "none"}</Text>
        <Text color={C.textMuted}>runs: {String(props.model.researchRunCount)}</Text>
        <Text color={C.textMuted}>updated: {props.model.latestResearchTimestamp ?? "none"}</Text>
        <Text color={C.text}>{truncateForPane(props.model.latestResearchSummary ?? "No research run recorded yet.", 40)}</Text>
        <Box marginTop={1}><Text color={C.success}>unclecode research run &lt;your prompt&gt;</Text></Box>
        {props.model.latestResearchSessionId ? (
          <Box marginTop={1}><Text color={C.success}>unclecode resume {truncateForPane(props.model.latestResearchSessionId, 24)}</Text></Box>
        ) : null}
      </Box>
    );
  }

  if (props.view === "mcp") {
    return (
      <Box flexDirection="column">
        <Text color={C.textMuted}>MCP status</Text>
        <Text color={C.text}>{props.model.mcpServerCount} configured server(s)</Text>
        {props.model.mcpServers.length === 0 ? (
          <Box flexDirection="column">
            <Text color={C.textMuted}>No MCP servers configured.</Text>
            <Text color={C.success}>Add .mcp.json here or ~/.unclecode/mcp.json</Text>
          </Box>
        ) : (
          props.model.mcpServers.slice(0, 4).map((server) => (
            <Box key={server.name} flexDirection="column">
              <Text color={C.textMuted}>{truncateForPane(`${server.name} · ${server.transport}`, 36)}</Text>
              <Text color={C.textMuted}>{truncateForPane(`${server.scope} · ${server.trustTier}`, 36)}</Text>
              <Text color={C.textMuted}>{truncateForPane(server.originLabel, 36)}</Text>
            </Box>
          ))
        )}
        <Box marginTop={1}><Text color={C.success}>unclecode mcp list</Text></Box>
      </Box>
    );
  }

  if (props.selectedSession) {
    return (
      <Box flexDirection="column">
        <Text color={C.text}>{truncateForPane(formatSessionHeadline(props.selectedSession), 32)}</Text>
        <Text color={C.textMuted}>{truncateForPane(props.selectedSession.sessionId, 32)}</Text>
        <Text color={C.textMuted}>state: {props.selectedSession.state}</Text>
        <Text color={C.textMuted}>model: {props.selectedSession.model ?? "none"}</Text>
        {props.selectedSession.mode ? <Text color={C.textMuted}>mode: {props.selectedSession.mode}</Text> : null}
        {props.selectedSession.pendingAction ? <Text color={C.textMuted}>pending: {props.selectedSession.pendingAction}</Text> : null}
        {props.selectedSession.worktreeBranch ? <Text color={C.textMuted}>branch: {props.selectedSession.worktreeBranch}</Text> : null}
        <Text color={C.textMuted}>updated: {props.selectedSession.updatedAt}</Text>
        <Box marginTop={1}><Text color={C.success}>unclecode resume {props.selectedSession.sessionId}</Text></Box>
        <Box marginTop={1}>
          <InspectorContext contextLines={props.contextLines} bridgeLines={props.bridgeLines} memoryLines={props.memoryLines} />
        </Box>
      </Box>
    );
  }

  if (props.selectedAction) {
    return (
      <Box flexDirection="column">
        <Text color={C.text}>{props.selectedAction.description}</Text>
        <Box marginTop={1}><Text color={C.success}>{props.selectedAction.command}</Text></Box>
        {createApprovalRequestForAction(props.selectedAction.id) ? (
          <Box marginTop={1}>
            <Text color={C.warning}>Approval required</Text>
            <Text color={C.textMuted}>Press Enter to review before running.</Text>
          </Box>
        ) : null}
        {props.selectedActionId === "new-research" ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={C.textMuted}>Prompt</Text>
            <Text color={C.warning}>{props.researchDraft.length > 0 ? formatSessionCenterDraftValue(props.selectedActionId, props.researchDraft) : "Type a research prompt and press Enter"}</Text>
          </Box>
        ) : null}
        {props.selectedActionId === "api-key-login" ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={C.textMuted}>API key</Text>
            <Text color={C.warning}>{props.researchDraft.length > 0 ? formatSessionCenterDraftValue(props.selectedActionId, props.researchDraft) : "Paste an OpenAI API key and press Enter"}</Text>
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text color={C.textMuted}>mode {props.model.modeLabel} · auth {props.model.authLabel}</Text>
        </Box>
        <Box marginTop={1}>
          <InspectorContext contextLines={props.contextLines} bridgeLines={props.bridgeLines} memoryLines={props.memoryLines} />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={C.textMuted}>Workspace state</Text>
      <Box marginTop={1}>
        <InspectorContext contextLines={props.contextLines} bridgeLines={props.bridgeLines} memoryLines={props.memoryLines} />
      </Box>
    </Box>
  );
}

export function Dashboard(props: {
  readonly workspaceRoot: string;
  readonly modeLabel?: string;
  readonly authLabel?: string;
  readonly sessionCount?: number;
  readonly mcpServerCount?: number;
  readonly mcpServers?: readonly { name: string; transport: string; scope: string; trustTier: string; originLabel: string }[];
  readonly latestResearchSessionId?: string | null;
  readonly latestResearchSummary?: string | null;
  readonly latestResearchTimestamp?: string | null;
  readonly researchRunCount?: number;
  readonly initialSelectedSessionId?: string | undefined;
  readonly initialView?: TuiShellState["view"] | undefined;
  readonly sessions?: readonly SessionCenterSession[];
  readonly contextLines?: readonly string[];
  readonly bridgeLines?: readonly string[];
  readonly memoryLines?: readonly string[];
  readonly runAction?: ((input: { actionId: string; prompt?: string; onProgress?: ((line: string) => void) | undefined }) => Promise<readonly string[]>) | undefined;
  readonly runSession?: ((sessionId: string) => Promise<readonly string[]>) | undefined;
  readonly launchWorkSession?: ((forwardedArgs?: readonly string[]) => Promise<void>) | undefined;
  readonly renderWorkPane?: ((controls: {
    openSessions: () => void;
    syncHomeState: (homeState: Partial<TuiShellHomeState>) => void;
  }) => React.ReactNode) | undefined;
  readonly refreshHomeState?: (() => Promise<TuiShellHomeState>) | undefined;
}) {
  const { exit } = useApp();
  const [branch, setBranch] = useState("...");
  const [gitStatus, setGitStatus] = useState("...");
  const [runtime, setRuntime] = useState({ node: "", platform: "", arch: "" });
  const [researchDraft, setResearchDraft] = useState("");
  const initialHomeState = {
    modeLabel: props.modeLabel ?? "default",
    authLabel: props.authLabel ?? "none",
    sessionCount: props.sessionCount ?? props.sessions?.length ?? 0,
    mcpServerCount: props.mcpServerCount ?? 0,
    mcpServers: props.mcpServers ?? [],
    latestResearchSessionId: props.latestResearchSessionId ?? null,
    latestResearchSummary: props.latestResearchSummary ?? null,
    latestResearchTimestamp: props.latestResearchTimestamp ?? null,
    researchRunCount: props.researchRunCount ?? 0,
    sessions: props.sessions ?? [],
    bridgeLines: props.bridgeLines ?? [],
    memoryLines: props.memoryLines ?? [],
  };
  const [shellState, dispatch] = useReducer(
    reduceShellEvent,
    createInitialShellState(initialHomeState, {
      ...(props.initialSelectedSessionId ? { selectedSessionId: props.initialSelectedSessionId } : {}),
      ...(props.initialView ? { initialView: props.initialView } : {}),
    }),
  );
  const model = createSessionCenterModel({
    workspaceRoot: props.workspaceRoot,
    modeLabel: shellState.homeState.modeLabel,
    authLabel: shellState.homeState.authLabel,
    sessionCount: shellState.homeState.sessionCount,
    mcpServerCount: shellState.homeState.mcpServerCount,
    mcpServers: shellState.homeState.mcpServers,
    latestResearchSessionId: shellState.homeState.latestResearchSessionId,
    latestResearchSummary: shellState.homeState.latestResearchSummary,
    latestResearchTimestamp: shellState.homeState.latestResearchTimestamp,
    researchRunCount: shellState.homeState.researchRunCount,
    sessions: shellState.homeState.sessions,
  });
  const centerState = shellState.focus as SessionCenterResolvedState;

  useEffect(() => {
    setBranch(getGitBranch(props.workspaceRoot));
    setGitStatus(getGitStatus(props.workspaceRoot));
    setRuntime(getRuntimeFacts());
  }, [props.workspaceRoot]);

  const selectedSession = model.primarySessions[centerState.sessionIndex];
  const selectedAction = model.utilityActions[centerState.actionIndex];
  const sessionCommands = model.primarySessions.map((session) => `unclecode resume ${session.sessionId}`);
  const handoffToWorkSession = (forwardedArgs: readonly string[] = []) => {
    if (!props.launchWorkSession) {
      return;
    }

    exit();
    setTimeout(() => {
      void props.launchWorkSession?.(forwardedArgs);
    }, 0);
  };
  const selectedApproval = selectedAction
    ? shellState.approvals.find((approval) => approval.id === createApprovalRequestForAction(selectedAction.id)?.id)
    : undefined;
  const activeWorkerCount = shellState.workers.filter((worker) => worker.status === "running").length;
  const syncHomeState = useCallback((homeState: Partial<TuiShellHomeState>) => {
    dispatch({ type: "home.updated", homeState });
  }, []);
  const openSessionsView = () => {
    void (async () => {
      const refreshedHomeState = props.refreshHomeState ? await props.refreshHomeState() : shellState.homeState;
      dispatch({ type: "home.updated", homeState: refreshedHomeState });
      dispatch({ type: "view.changed", view: "sessions" });
    })();
  };
  const renderFullscreenWorkPane = shouldRenderEmbeddedWorkPaneFullscreen(shellState.view, Boolean(props.renderWorkPane));

  const runUtilityAction = (action: SessionCenterAction, detail: string) => {
    const runAction = props.runAction;
    if (!runAction) {
      return;
    }

    void (async () => {
      dispatch({ type: "action.started", actionId: action.id });
      dispatch({ type: "worker.progressed", worker: { id: action.id, label: action.label, status: "running", detail } });
      try {
        const lines = await runAction({
          actionId: action.id,
          onProgress: (line) => dispatch({ type: "worker.progressed", worker: { id: action.id, label: action.label, status: "running", detail: line } }),
        });
        const refreshedHomeState = props.refreshHomeState ? await props.refreshHomeState() : shellState.homeState;
        dispatch({
          type: "action.completed",
          entry: { id: `${action.id}-${Date.now()}`, source: action.id, title: action.label, timestamp: new Date().toISOString(), lines, tone: "success" },
          outputLines: lines,
          homeState: refreshedHomeState,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dispatch({
          type: "action.failed",
          entry: { id: `${action.id}-error-${Date.now()}`, source: action.id, title: action.label, timestamp: new Date().toISOString(), lines: [message], tone: "warning" },
          outputLines: [message],
        });
      }
    })();
  };

  const triggerActionById = (actionId: string, detail: string) => {
    const shortcutIndex = model.utilityActions.findIndex((action) => action.id === actionId);
    if (shortcutIndex < 0) {
      return false;
    }

    const action = model.utilityActions[shortcutIndex];
    if (!action) {
      return false;
    }

    if (shellState.isRunning && shellState.runningActionId === action.id) {
      dispatch({
        type: "focus.changed",
        focus: { ...centerState, column: "actions", actionIndex: shortcutIndex, detailOpen: false, shouldExit: false, selectedCommand: undefined },
      });
      return true;
    }

    if (action.id === "work-session" && props.launchWorkSession) {
      handoffToWorkSession();
      return true;
    }

    const approval = createApprovalRequestForAction(action.id);
    const hasMatchingApproval = approval ? shellState.approvals.some((item) => item.id === approval.id) : false;
    if (shellState.approvals.length > 0 && !hasMatchingApproval) {
      return true;
    }

    if (action.id === "new-research" || action.id === "api-key-login") {
      dispatch({
        type: "focus.changed",
        focus: { ...centerState, column: "actions", actionIndex: shortcutIndex, detailOpen: true, shouldExit: false, selectedCommand: undefined },
      });
      return true;
    }

    if (approval) {
      if (!hasMatchingApproval) {
        dispatch({ type: "approval.requested", approval });
      }
      dispatch({
        type: "focus.changed",
        focus: { ...centerState, column: "actions", actionIndex: shortcutIndex, detailOpen: true, shouldExit: false, selectedCommand: undefined },
      });
      return true;
    }

    dispatch({
      type: "focus.changed",
      focus: { ...centerState, column: "actions", actionIndex: shortcutIndex, detailOpen: false, shouldExit: false, selectedCommand: undefined },
    });
    runUtilityAction(action, detail);
    return true;
  };

  useInput((input, key) => {
    if (!shouldCaptureDashboardInput(shellState.view, Boolean(props.renderWorkPane))) {
      return;
    }

    const immediateAction = getImmediateActionShortcut(input);
    if (immediateAction && triggerActionById(immediateAction, "running shortcut action")) {
      return;
    }

    const actionShortcut = getSessionCenterActionShortcut(input);
    if (actionShortcut && !(centerState.column === "actions" && centerState.detailOpen && selectedApproval)) {
      if (triggerActionById(actionShortcut, "running shortcut action")) {
        return;
      }
    }

    const viewShortcut = getSessionCenterViewShortcut(input);
    if (viewShortcut) {
      dispatch({ type: "view.changed", view: viewShortcut });
      return;
    }

    if (centerState.column === "actions" && !centerState.detailOpen && (selectedAction?.id === "new-research" || selectedAction?.id === "api-key-login") && key.return) {
      dispatch({ type: "focus.changed", focus: { ...centerState, detailOpen: true, shouldExit: false, selectedCommand: undefined } });
      return;
    }

    if (centerState.column === "actions" && !centerState.detailOpen && selectedAction && !selectedApproval && (input === "a" || input === "\r" || input === "\n" || input === "" || key.return)) {
      const approval = createApprovalRequestForAction(selectedAction.id);
      if (approval) {
        dispatch({ type: "approval.requested", approval });
        dispatch({ type: "focus.changed", focus: { ...centerState, detailOpen: true, shouldExit: false, selectedCommand: undefined } });
        return;
      }
    }

    if (centerState.column === "actions" && selectedAction && selectedApproval) {
      const decision = handleApprovalInput(input, { return: key.return, escape: key.escape });
      if (decision.decision === "reject") {
        dispatch({ type: "approval.resolved", approvalId: selectedApproval.id });
        dispatch({
          type: "action.failed",
          entry: { id: `${selectedApproval.id}-rejected-${Date.now()}`, source: selectedAction.id, title: `${selectedAction.label} rejected`, timestamp: new Date().toISOString(), lines: ["User rejected approval."], tone: "warning" },
          outputLines: ["User rejected approval."],
        });
        dispatch({ type: "focus.changed", focus: { ...centerState, detailOpen: false, shouldExit: false, selectedCommand: undefined } });
        return;
      }
      if (decision.decision === "approve" && props.runAction) {
        const runAction = props.runAction;
        dispatch({ type: "approval.resolved", approvalId: selectedApproval.id });
        void (async () => {
          dispatch({ type: "action.started", actionId: selectedAction.id });
          dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: "Preparing browser auth…" } });
          try {
            const lines = await runAction({
              actionId: selectedAction.id,
              onProgress: (line) => dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: line } }),
            });
            dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: "Finalizing output…" } });
            const refreshedHomeState = props.refreshHomeState ? await props.refreshHomeState() : shellState.homeState;
            dispatch({
              type: "action.completed",
              entry: { id: `${selectedAction.id}-${Date.now()}`, source: selectedAction.id, title: selectedAction.label, timestamp: new Date().toISOString(), lines, tone: "success" },
              outputLines: lines,
              homeState: refreshedHomeState,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            dispatch({
              type: "action.failed",
              entry: { id: `${selectedAction.id}-error-${Date.now()}`, source: selectedAction.id, title: selectedAction.label, timestamp: new Date().toISOString(), lines: [message], tone: "warning" },
              outputLines: [message],
            });
          }
        })();
        return;
      }
    }

    if (centerState.column === "actions" && centerState.detailOpen && (selectedAction?.id === "new-research" || selectedAction?.id === "api-key-login")) {
      if (key.escape) {
        setResearchDraft("");
        dispatch({ type: "focus.changed", focus: { ...centerState, detailOpen: false, shouldExit: false, selectedCommand: undefined } });
        return;
      }

      const draftResult = handleResearchDraftInput(researchDraft, input, { return: key.return, backspace: key.backspace, delete: key.delete });
      const runAction = props.runAction;
      if (draftResult.submitted && runAction) {
        void (async () => {
          dispatch({ type: "action.started", actionId: selectedAction.id });
          dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: selectedAction.id === "new-research" ? "assembling context" : "saving auth" } });
          try {
            const lines = await runAction({
              actionId: selectedAction.id,
              prompt: draftResult.value,
              onProgress: (line) => dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: line } }),
            });
            dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: selectedAction.id === "new-research" ? "writing artifact" : "refreshing auth" } });
            const refreshedHomeState = props.refreshHomeState ? await props.refreshHomeState() : shellState.homeState;
            dispatch({
              type: "action.completed",
              entry: { id: `${selectedAction.id}-${Date.now()}`, source: selectedAction.id, title: selectedAction.id === "new-research" ? `Research: ${draftResult.value}` : selectedAction.label, timestamp: new Date().toISOString(), lines, tone: lines.some((line) => /failed/i.test(line)) ? "warning" : "success" },
              outputLines: lines,
              homeState: refreshedHomeState,
            });
            setResearchDraft("");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            dispatch({
              type: "action.failed",
              entry: { id: `${selectedAction.id}-error-${Date.now()}`, source: selectedAction.id, title: selectedAction.id === "new-research" ? `Research: ${draftResult.value}` : selectedAction.label, timestamp: new Date().toISOString(), lines: [message], tone: "warning" },
              outputLines: [message],
            });
          }
        })();
        return;
      }

      if (!key.return) {
        setResearchDraft(draftResult.value);
      }
      return;
    }

    const result = handleSessionCenterInput(
      input,
      { upArrow: key.upArrow, downArrow: key.downArrow, leftArrow: key.leftArrow, rightArrow: key.rightArrow, return: key.return, escape: key.escape, ctrl: key.ctrl },
      centerState,
      { sessionCount: model.primarySessions.length, actionCount: model.utilityActions.length },
      model.utilityActions.map((action) => action.command),
      sessionCommands,
    );

    if (result.shouldExit) {
      const runAction = props.runAction;
      const runSession = props.runSession;

      if (result.selectedCommand && centerState.column === "actions" && selectedAction && runAction) {
        if (selectedAction.id === "work-session" && props.launchWorkSession) {
          handoffToWorkSession();
          return;
        }
        if (selectedAction.id === "new-research" || selectedAction.id === "api-key-login") {
          dispatch({ type: "focus.changed", focus: { ...result, shouldExit: false, selectedCommand: undefined, detailOpen: true } });
          return;
        }
        const approval = createApprovalRequestForAction(selectedAction.id);
        if (approval) {
          dispatch({ type: "approval.requested", approval });
          dispatch({ type: "focus.changed", focus: { ...result, shouldExit: false, selectedCommand: undefined, detailOpen: true } });
          return;
        }
        void (async () => {
          dispatch({ type: "action.started", actionId: selectedAction.id });
          dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: "loading action output" } });
          try {
            const lines = await runAction({
              actionId: selectedAction.id,
              onProgress: (line) => dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: line } }),
            });
            dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: "finalizing output" } });
            const refreshedHomeState = props.refreshHomeState ? await props.refreshHomeState() : shellState.homeState;
            dispatch({
              type: "action.completed",
              entry: { id: `${selectedAction.id}-${Date.now()}`, source: selectedAction.id, title: selectedAction.label, timestamp: new Date().toISOString(), lines, tone: "success" },
              outputLines: lines,
              homeState: refreshedHomeState,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            dispatch({
              type: "action.failed",
              entry: { id: `${selectedAction.id}-error-${Date.now()}`, source: selectedAction.id, title: selectedAction.label, timestamp: new Date().toISOString(), lines: [message], tone: "warning" },
              outputLines: [message],
            });
          }
        })();
        dispatch({ type: "focus.changed", focus: { ...result, shouldExit: false, selectedCommand: undefined, detailOpen: true } });
        return;
      }

      if (result.selectedCommand && centerState.column === "sessions" && selectedSession) {
        if (selectedSession.sessionId.startsWith("work-") && props.launchWorkSession) {
          handoffToWorkSession(["--session-id", selectedSession.sessionId]);
          return;
        }
        if (runSession) {
          void (async () => {
            dispatch({ type: "action.started", actionId: selectedSession.sessionId });
            dispatch({ type: "worker.progressed", worker: { id: selectedSession.sessionId, label: "resume", status: "running", detail: "loading session context" } });
            try {
              const lines = await runSession(selectedSession.sessionId);
              const refreshedHomeState = props.refreshHomeState ? await props.refreshHomeState() : shellState.homeState;
              dispatch({
                type: "action.completed",
                entry: { id: `${selectedSession.sessionId}-${Date.now()}`, source: selectedSession.sessionId, title: `Resume ${selectedSession.sessionId}`, timestamp: new Date().toISOString(), lines, tone: "info" },
                outputLines: lines,
                homeState: refreshedHomeState,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              dispatch({
                type: "action.failed",
                entry: { id: `${selectedSession.sessionId}-error-${Date.now()}`, source: selectedSession.sessionId, title: `Resume ${selectedSession.sessionId}`, timestamp: new Date().toISOString(), lines: [message], tone: "warning" },
                outputLines: [message],
              });
            }
          })();
          dispatch({ type: "focus.changed", focus: { ...result, shouldExit: false, selectedCommand: undefined, detailOpen: true } });
          return;
        }
      }

      exit();
      if (result.selectedCommand) console.log(`\n  ${result.selectedCommand}\n`);
      return;
    }

    dispatch({ type: "focus.changed", focus: result });
  });

  if (renderFullscreenWorkPane && props.renderWorkPane) {
    return props.renderWorkPane({
      openSessions: openSessionsView,
      syncHomeState,
    });
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <HeaderChrome branch={branch} gitStatus={gitStatus} workspacePath={props.workspaceRoot} />

      <Box marginY={1}><ThinDivider /></Box>
      <ViewTabs activeView={shellState.view} />
      <Box marginTop={1}>
        <Text color={C.textSecondary}>1-4 tabs · W/B/K/L/R/D run · arrows move · Tab switch</Text>
      </Box>
      <Box marginY={1}><ThinDivider /></Box>

      {
        <Box flexDirection="row">
          <Box flexDirection="column" width={38}>
            <Text bold color={centerState.column === "sessions" ? C.accentBright : C.text}>Resume</Text>
            <Box marginTop={1}>
              <SessionList sessions={model.primarySessions} selectedIndex={centerState.sessionIndex} isActive={centerState.column === "sessions"} emptyState={model.emptyState} />
            </Box>
          </Box>

          <Box flexDirection="column" width={16} paddingLeft={2}>
            <Text bold color={centerState.column === "actions" ? C.accentBright : C.text}>Actions</Text>
            <Box marginTop={1}>
              <ActionList actions={model.utilityActions} selectedIndex={centerState.actionIndex} isActive={centerState.column === "actions"} />
            </Box>
          </Box>

          <Box flexDirection="column" paddingLeft={2}>
            <Text bold color={centerState.detailOpen || shellState.view !== "sessions" ? C.accentBright : C.text}>Inspector</Text>
            <Box marginTop={1}>
              <DetailPanel
                selectedSession={selectedSession}
                selectedAction={selectedAction}
                selectedApproval={selectedApproval}
                selectedActionId={selectedAction?.id}
                view={shellState.view}
                shellState={shellState}
                model={model}
                researchDraft={researchDraft}
                contextLines={props.contextLines ?? []}
                bridgeLines={shellState.homeState.bridgeLines ?? props.bridgeLines ?? []}
                memoryLines={shellState.homeState.memoryLines ?? props.memoryLines ?? []}
              />
            </Box>
          </Box>
        </Box>
      }

      <Box marginY={1}><ThinDivider /></Box>
      <StatusBar runtime={runtime} modeLabel={model.modeLabel} authLabel={model.authLabel} approvalCount={shellState.approvals.length} workerCount={activeWorkerCount} />
    </Box>
  );
}

export async function renderTui(options?: {
  readonly workspaceRoot?: string;
  readonly modeLabel?: string;
  readonly authLabel?: string;
  readonly sessionCount?: number;
  readonly mcpServerCount?: number;
  readonly mcpServers?: readonly { name: string; transport: string; scope: string; trustTier: string; originLabel: string }[];
  readonly latestResearchSessionId?: string | null;
  readonly latestResearchSummary?: string | null;
  readonly latestResearchTimestamp?: string | null;
  readonly researchRunCount?: number;
  readonly initialSelectedSessionId?: string | undefined;
  readonly initialView?: TuiShellState["view"] | undefined;
  readonly renderWorkPane?: ((controls: {
    openSessions: () => void;
    syncHomeState: (homeState: Partial<TuiShellHomeState>) => void;
  }) => React.ReactNode) | undefined;
  readonly sessions?: readonly SessionCenterSession[];
  readonly contextLines?: readonly string[];
  readonly bridgeLines?: readonly string[];
  readonly memoryLines?: readonly string[];
  readonly runAction?: ((input: { actionId: string; prompt?: string; onProgress?: ((line: string) => void) | undefined }) => Promise<readonly string[]>) | undefined;
  readonly runSession?: ((sessionId: string) => Promise<readonly string[]>) | undefined;
  readonly launchWorkSession?: ((forwardedArgs?: readonly string[]) => Promise<void>) | undefined;
  readonly refreshHomeState?: (() => Promise<TuiShellHomeState>) | undefined;
}): Promise<void> {
  const instance = render(
    <Dashboard
      workspaceRoot={options?.workspaceRoot ?? process.cwd()}
      {...(options?.modeLabel ? { modeLabel: options.modeLabel } : {})}
      {...(options?.authLabel ? { authLabel: options.authLabel } : {})}
      {...(options?.sessionCount !== undefined ? { sessionCount: options.sessionCount } : {})}
      {...(options?.mcpServerCount !== undefined ? { mcpServerCount: options.mcpServerCount } : {})}
      {...(options?.mcpServers ? { mcpServers: options.mcpServers } : {})}
      {...(options?.latestResearchSessionId !== undefined ? { latestResearchSessionId: options.latestResearchSessionId } : {})}
      {...(options?.latestResearchSummary !== undefined ? { latestResearchSummary: options.latestResearchSummary } : {})}
      {...(options?.latestResearchTimestamp !== undefined ? { latestResearchTimestamp: options.latestResearchTimestamp } : {})}
      {...(options?.researchRunCount !== undefined ? { researchRunCount: options.researchRunCount } : {})}
      {...(options?.initialSelectedSessionId ? { initialSelectedSessionId: options.initialSelectedSessionId } : {})}
      {...(options?.sessions ? { sessions: options.sessions } : {})}
      contextLines={options?.contextLines ?? []}
      bridgeLines={options?.bridgeLines ?? []}
      memoryLines={options?.memoryLines ?? []}
      {...(options?.runAction ? { runAction: options.runAction } : {})}
      {...(options?.runSession ? { runSession: options.runSession } : {})}
      {...(options?.launchWorkSession ? { launchWorkSession: options.launchWorkSession } : {})}
      {...(options?.renderWorkPane ? { renderWorkPane: options.renderWorkPane } : {})}
      {...(options?.initialView ? { initialView: options.initialView } : {})}
      {...(options?.refreshHomeState ? { refreshHomeState: options.refreshHomeState } : {})}
    />,
  );
  await instance.waitUntilExit();
}
