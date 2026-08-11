import type { TuiShellFocusState, TuiShellState } from "./shell-state.js";
import {
  DASHBOARD_ACTIONS,
  SESSION_CENTER_ACTIONS,
  type DashboardInputResult,
  type DashboardView,
  type ResearchDraftResult,
  type SessionCenterFocusState,
} from "./dashboard-actions.js";

type SessionCenterResolvedState = TuiShellFocusState;

function getPreferredActionIndexForView(view: TuiShellState["view"]): number | undefined {
  const preferredActionId =
    view === "work"
      ? "work-session"
      : view === "mcp"
        ? "mcp-add"
        : undefined;
  if (!preferredActionId) {
    return undefined;
  }

  const actionIndex = SESSION_CENTER_ACTIONS.findIndex((action) => action.id === preferredActionId);
  return actionIndex >= 0 ? actionIndex : undefined;
}

export function createSessionCenterFocusForView(
  view: TuiShellState["view"],
  state: SessionCenterFocusState,
): SessionCenterResolvedState {
  const preferredActionIndex = getPreferredActionIndexForView(view);
  return {
    column: view === "sessions" ? "sessions" : "actions",
    sessionIndex: state.sessionIndex,
    actionIndex: preferredActionIndex ?? state.actionIndex,
    detailOpen: false,
    shouldExit: false,
    selectedCommand: undefined,
  };
}

export function isSessionDeskToggleInput(
  input: string,
  key: { readonly ctrl?: boolean | undefined },
): boolean {
  return input.includes("\u000f") || (key.ctrl === true && input.toLowerCase() === "o");
}

export function handleDashboardInput(
  input: string,
  key: {
    readonly upArrow?: boolean;
    readonly downArrow?: boolean;
    readonly return?: boolean;
    readonly escape?: boolean;
    readonly ctrl?: boolean;
  },
  view: DashboardView,
  selectedIndex: number,
  actionCount: number,
): DashboardInputResult {
  const stay = {
    view,
    selectedIndex,
    shouldExit: false,
    exitCommand: undefined,
  } as const;
  if (view === "browse") {
    if (input === "q" || (key.ctrl && input === "c")) {
      return {
        view: "browse",
        selectedIndex,
        shouldExit: true,
        exitCommand: undefined,
      };
    }
    if (key.upArrow) {
      return {
        view: "browse",
        selectedIndex: Math.max(0, selectedIndex - 1),
        shouldExit: false,
        exitCommand: undefined,
      };
    }
    if (key.downArrow) {
      return {
        view: "browse",
        selectedIndex: Math.min(actionCount - 1, selectedIndex + 1),
        shouldExit: false,
        exitCommand: undefined,
      };
    }
    if (key.return) {
      return {
        view: "detail",
        selectedIndex,
        shouldExit: false,
        exitCommand: undefined,
      };
    }
    return stay;
  }
  if (key.escape) {
    return {
      view: "browse",
      selectedIndex,
      shouldExit: false,
      exitCommand: undefined,
    };
  }
  if (key.return) {
    return {
      view: "detail",
      selectedIndex,
      shouldExit: true,
      exitCommand: DASHBOARD_ACTIONS[selectedIndex]?.command,
    };
  }
  if (key.ctrl && input === "c") {
    return {
      view: "detail",
      selectedIndex,
      shouldExit: true,
      exitCommand: undefined,
    };
  }
  return stay;
}

export function handleSessionCenterInput(
  input: string,
  key: {
    readonly upArrow?: boolean;
    readonly downArrow?: boolean;
    readonly leftArrow?: boolean;
    readonly rightArrow?: boolean;
    readonly return?: boolean;
    readonly escape?: boolean;
    readonly ctrl?: boolean;
  },
  state: SessionCenterFocusState,
  counts: { readonly sessionCount: number; readonly actionCount: number },
  actionCommands: readonly string[] = SESSION_CENTER_ACTIONS.map(
    (action) => action.command,
  ),
  sessionCommands?: readonly string[],
  options?: {
    readonly visibleActionIndexes?: readonly number[];
    readonly allowActionColumn?: boolean;
  },
): SessionCenterResolvedState {
  const allowActionColumn = options?.allowActionColumn ?? true;
  const visibleActionIndexes = options?.visibleActionIndexes;
  const hasVisibleActionIndexes = Boolean(visibleActionIndexes?.length);
  const actionPosition = hasVisibleActionIndexes
    ? Math.max(0, visibleActionIndexes!.indexOf(state.actionIndex))
    : state.actionIndex;
  const actionCount = hasVisibleActionIndexes
    ? visibleActionIndexes!.length
    : counts.actionCount;
  const resolveActionIndex = (position: number): number =>
    hasVisibleActionIndexes
      ? visibleActionIndexes![position] ?? state.actionIndex
      : position;
  const normalizedActionIndex =
    hasVisibleActionIndexes && !visibleActionIndexes!.includes(state.actionIndex)
      ? visibleActionIndexes![0] ?? state.actionIndex
      : state.actionIndex;
  const isSubmitInput =
    input === "\r" ||
    input === "\n" ||
    isSessionCenterImplicitSubmitInput(input, key);
  const base: SessionCenterResolvedState = {
    column: state.column,
    sessionIndex: state.sessionIndex,
    actionIndex: state.actionIndex,
    detailOpen: state.detailOpen,
    shouldExit: false,
    selectedCommand: undefined,
  };
  if (input === "q" || (key.ctrl && input === "c")) {
    return { ...base, shouldExit: true };
  }
  if (state.detailOpen) {
    if (key.escape) {
      return { ...base, detailOpen: false };
    }
    if (key.leftArrow || input === "h") {
      return { ...base, column: "sessions", detailOpen: false };
    }
    if ((key.rightArrow || input === "l") && allowActionColumn) {
      return { ...base, column: "actions", actionIndex: normalizedActionIndex, detailOpen: false };
    }
    if (input === "\t" && allowActionColumn) {
      return {
        ...base,
        column: state.column === "sessions" ? "actions" : "sessions",
        actionIndex: state.column === "sessions" ? normalizedActionIndex : base.actionIndex,
        detailOpen: false,
      };
    }
    if (key.upArrow || input === "k") {
      return state.column === "sessions"
        ? {
            ...base,
            sessionIndex: Math.max(0, state.sessionIndex - 1),
            detailOpen: false,
          }
        : {
            ...base,
            actionIndex: resolveActionIndex(Math.max(0, actionPosition - 1)),
            detailOpen: false,
          };
    }
    if (key.downArrow || input === "j") {
      return state.column === "sessions"
        ? {
            ...base,
            sessionIndex: Math.min(
              Math.max(0, counts.sessionCount - 1),
              state.sessionIndex + 1,
            ),
            detailOpen: false,
          }
        : {
            ...base,
            actionIndex: resolveActionIndex(Math.min(
              Math.max(0, actionCount - 1),
              actionPosition + 1,
            )),
            detailOpen: false,
          };
    }
    if (key.return || isSubmitInput) {
      const selectedCommand =
        state.column === "actions"
          ? actionCommands[state.actionIndex]
          : sessionCommands?.[state.sessionIndex];
      return selectedCommand
        ? { ...base, shouldExit: true, selectedCommand }
        : base;
    }
    return base;
  }
  if (key.leftArrow || input === "h") {
    return { ...base, column: "sessions" };
  }
  if ((key.rightArrow || input === "l") && allowActionColumn) {
    return { ...base, column: "actions", actionIndex: normalizedActionIndex };
  }
  if (input === "\t" && allowActionColumn) {
    return {
      ...base,
      column: state.column === "sessions" ? "actions" : "sessions",
      actionIndex: state.column === "sessions" ? normalizedActionIndex : base.actionIndex,
    };
  }
  if (key.upArrow || input === "k") {
    return state.column === "sessions"
      ? { ...base, sessionIndex: Math.max(0, state.sessionIndex - 1) }
      : { ...base, actionIndex: resolveActionIndex(Math.max(0, actionPosition - 1)) };
  }
  if (key.downArrow || input === "j") {
    return state.column === "sessions"
      ? {
          ...base,
          sessionIndex: Math.min(
            Math.max(0, counts.sessionCount - 1),
            state.sessionIndex + 1,
          ),
        }
      : {
          ...base,
          actionIndex: resolveActionIndex(Math.min(
            Math.max(0, actionCount - 1),
            actionPosition + 1,
          )),
        };
  }
  if (key.return || isSubmitInput) {
    if (state.column === "actions") {
      return {
        ...base,
        shouldExit: true,
        selectedCommand: actionCommands[state.actionIndex],
      };
    }
    const selectedCommand = sessionCommands?.[state.sessionIndex];
    return selectedCommand
      ? { ...base, shouldExit: true, selectedCommand }
      : { ...base, detailOpen: true };
  }
  return base;
}

export function isSessionCenterImplicitSubmitInput(
  input: string,
  key: {
    readonly upArrow?: boolean;
    readonly downArrow?: boolean;
    readonly leftArrow?: boolean;
    readonly rightArrow?: boolean;
    readonly tab?: boolean;
    readonly escape?: boolean;
    readonly ctrl?: boolean;
    readonly backspace?: boolean;
    readonly delete?: boolean;
  },
): boolean {
  return (
    input === "" &&
    !key.upArrow &&
    !key.downArrow &&
    !key.leftArrow &&
    !key.rightArrow &&
    !key.tab &&
    !key.escape &&
    !key.ctrl &&
    !key.backspace &&
    !key.delete
  );
}

export function handleResearchDraftInput(
  currentValue: string,
  input: string,
  key: {
    readonly return?: boolean;
    readonly backspace?: boolean;
    readonly delete?: boolean;
  },
): ResearchDraftResult {
  if (key.backspace || key.delete) {
    return { value: currentValue.slice(0, -1), submitted: false };
  }
  if (key.return || input === "\r" || input === "\n") {
    const nextValue = currentValue.trim();
    return { value: nextValue, submitted: nextValue.length > 0 };
  }
  return { value: `${currentValue}${input}`, submitted: false };
}

export function getSessionCenterActionShortcut(
  input: string,
): string | undefined {
  switch (input.toLowerCase()) {
    case "w":
      return "work-session";
    case "b":
      return "browser-login";
    case "k":
      return "api-key-login";
    case "l":
      return "auth-logout";
    case "a":
      return "mcp-add";
    case "x":
      return "mcp-remove";
    case "m":
      return "mcp-list";
    case "i":
      return "mcp-inspect";
    case "d":
      return "doctor";
    default:
      return undefined;
  }
}

export function getImmediateActionShortcut(input: string): string | undefined {
  switch (input) {
    case "W":
      return "work-session";
    case "B":
      return "browser-login";
    case "K":
      return "api-key-login";
    case "L":
      return "auth-logout";
    case "A":
      return "mcp-add";
    case "X":
      return "mcp-remove";
    case "M":
      return "mcp-list";
    case "I":
      return "mcp-inspect";
    case "D":
      return "doctor";
    default:
      return undefined;
  }
}

export function getSessionCenterViewShortcut(
  input: string,
): TuiShellState["view"] | undefined {
  switch (input) {
    case "1":
      return "work";
    case "2":
      return "sessions";
    case "3":
      return "mcp";
    default:
      return undefined;
  }
}

export function shouldRenderEmbeddedWorkPaneFullscreen(
  view: TuiShellState["view"],
  hasEmbeddedWorkPane: boolean,
): boolean {
  return view === "work" && hasEmbeddedWorkPane;
}

export function shouldReturnToWorkOnEscape(
  view: TuiShellState["view"],
  key: { readonly escape?: boolean },
  state: SessionCenterFocusState,
  hasSelectedApproval: boolean,
): boolean {
  return view !== "work" && Boolean(key.escape) && !state.detailOpen && !hasSelectedApproval;
}

export function getSessionCenterEscapeHint(input: {
  readonly view: TuiShellState["view"];
  readonly detailOpen: boolean;
  readonly hasSelectedApproval: boolean;
  readonly hasEmbeddedWorkPane: boolean;
}): "Esc cancel" | "Esc close" | "Ctrl+O context" | "Esc work" {
  if (input.hasSelectedApproval) {
    return "Esc cancel";
  }
  if (input.detailOpen) {
    return "Esc close";
  }
  if (input.view === "work" && input.hasEmbeddedWorkPane) {
    return "Ctrl+O context";
  }
  return "Esc work";
}

export function buildSessionCenterStatusLine(input: {
  readonly view: TuiShellState["view"];
  readonly savedSessionCount: number;
  readonly mcpServerCount: number;
  readonly detailOpen: boolean;
  readonly hasSelectedApproval: boolean;
  readonly hasEmbeddedWorkPane: boolean;
}): string {
  const escapeHint = getSessionCenterEscapeHint(input);
  if (input.view === "work") {
    return `Work · live session · ${escapeHint} · Shift+Tab mode · / commands`;
  }
  if (input.view === "mcp") {
    return `MCP · ${String(input.mcpServerCount)} server(s) · A add · X remove · ${escapeHint}`;
  }
  return `History · ${String(input.savedSessionCount)} saved · ↑↓ select · Enter resume · ${escapeHint}`;
}

export function resolveWorkPaneNavigationMode(input: {
  readonly forwardedArgs: readonly string[];
  readonly hasEmbeddedWorkPane: boolean;
  readonly hasEmbeddedWorkController: boolean;
  readonly hasLaunchWorkSession: boolean;
}): "embedded-view" | "embedded-update" | "launch-handoff" | "unavailable" {
  if (input.forwardedArgs.length === 0 && input.hasEmbeddedWorkPane) {
    return "embedded-view";
  }
  if (input.hasEmbeddedWorkPane && input.hasEmbeddedWorkController) {
    return "embedded-update";
  }
  if (input.hasLaunchWorkSession) {
    return "launch-handoff";
  }
  return "unavailable";
}

export function shouldCaptureDashboardInput(
  view: TuiShellState["view"],
  hasEmbeddedWorkPane: boolean,
): boolean {
  return !shouldRenderEmbeddedWorkPaneFullscreen(view, hasEmbeddedWorkPane);
}

export function handleApprovalInput(
  input: string,
  key: { readonly return?: boolean; readonly escape?: boolean },
): { decision: "approve" | "reject" | "noop" } {
  if (input === "x" || key.escape) {
    return { decision: "reject" };
  }
  if (input === "a" || input === "\r" || input === "\n" || key.return) {
    return { decision: "approve" };
  }
  return { decision: "noop" };
}
