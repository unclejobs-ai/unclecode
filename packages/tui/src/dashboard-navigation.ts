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
): SessionCenterResolvedState {
  const isSubmitInput =
    input === "\r" ||
    input === "\n" ||
    (input === "" &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.escape &&
      !key.ctrl);
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
    if (key.rightArrow || input === "l") {
      return { ...base, column: "actions", detailOpen: false };
    }
    if (input === "\t") {
      return {
        ...base,
        column: state.column === "sessions" ? "actions" : "sessions",
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
            actionIndex: Math.max(0, state.actionIndex - 1),
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
            actionIndex: Math.min(
              Math.max(0, counts.actionCount - 1),
              state.actionIndex + 1,
            ),
            detailOpen: false,
          };
    }
    if (key.return || isSubmitInput) {
      const selectedCommand =
        state.column === "actions"
          ? actionCommands[state.actionIndex]
          : sessionCommands?.[state.sessionIndex];
      return { ...base, shouldExit: true, selectedCommand };
    }
    return base;
  }
  if (key.leftArrow || input === "h") {
    return { ...base, column: "sessions" };
  }
  if (key.rightArrow || input === "l") {
    return { ...base, column: "actions" };
  }
  if (input === "\t") {
    return {
      ...base,
      column: state.column === "sessions" ? "actions" : "sessions",
    };
  }
  if (key.upArrow || input === "k") {
    return state.column === "sessions"
      ? { ...base, sessionIndex: Math.max(0, state.sessionIndex - 1) }
      : { ...base, actionIndex: Math.max(0, state.actionIndex - 1) };
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
          actionIndex: Math.min(
            Math.max(0, counts.actionCount - 1),
            state.actionIndex + 1,
          ),
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
    return { ...base, detailOpen: true };
  }
  return base;
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
    case "r":
      return "new-research";
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
    case "R":
      return "new-research";
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
    case "4":
      return "research";
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
