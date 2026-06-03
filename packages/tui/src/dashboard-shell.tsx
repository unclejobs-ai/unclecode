import {
  parseSelectedSessionIdFromArgs,
  UNCLECODE_COMMAND_NAME,
} from "@unclecode/contracts";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import React, { useCallback, useEffect, useReducer, useState } from "react";

import { type TuiRenderOptions } from "./dashboard-model.js";
import {
  C,
  SectionDivider,
  StatusDot,
  ThinDivider,
} from "./dashboard-primitives.js";

import { getGitBranch, getGitStatus, getRuntimeFacts } from "./facts.js";
import {
  createApprovalRequestForAction,
  createSessionCenterModel,
  ensureSelectedSessionCenterActionVisible,
  getVisibleSessionCenterActionsForView,
  type SessionCenterAction,
  type SessionCenterSession,
} from "./dashboard-actions.js";
import {
  getImmediateActionShortcut,
  getSessionCenterActionShortcut,
  getSessionCenterViewShortcut,
  buildSessionCenterStatusLine,
  handleApprovalInput,
  createSessionCenterFocusForView,
  handleResearchDraftInput,
  isSessionCenterImplicitSubmitInput,
  handleSessionCenterInput,
  resolveWorkPaneNavigationMode,
  shouldCaptureDashboardInput,
  shouldOpenResearchPromptLane,
  shouldRenderEmbeddedWorkPaneFullscreen,
  shouldReturnToWorkOnEscape,
} from "./dashboard-navigation.js";
import { truncateForDisplayWidth } from "./text-width.js";
import {
  createInitialShellState,
  reduceShellEvent,
  type TuiShellFocusState,
  type TuiShellHomeState,
  type TuiShellState,
} from "./shell-state.js";

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

export function truncateForPane(value: string, maxLength: number): string {
  return truncateForDisplayWidth(value, maxLength);
}


import {
  ActionList,
  ActionShortcutStrip,
  buildWorkflowStatusSummary,
  DetailPanel,
  HeaderChrome,
  McpServerList,
  prettifyWorkerDetail,
  ResearchRunList,
  type SessionCenterResolvedState,
  SessionList,
  StatusBar,
  VIEW_TABS,
  ViewTabs,
} from "./dashboard-components.js";


// TuiRenderOptions, EmbeddedWorkDashboardSnapshot, EmbeddedWorkPaneRenderOptions,
// extractEmbeddedHomeStatePatch, buildEmbeddedWorkPaneRenderOptions,
// createEmbeddedWorkPaneController, createSessionCenterDashboardRenderOptions
// have been extracted to ./dashboard-model.ts
export type { TuiRenderOptions, EmbeddedWorkDashboardSnapshot, EmbeddedWorkPaneRenderOptions } from "./dashboard-model.js";
export { extractEmbeddedHomeStatePatch, buildEmbeddedWorkPaneRenderOptions, createEmbeddedWorkPaneController, createSessionCenterDashboardRenderOptions } from "./dashboard-model.js";

function printExitCommand(command: string): void {
  process.stdout.write(`\n  ${command}\n`);
}

function getSessionCenterSectionLabel(view: TuiShellState["view"]): string {
  switch (view) {
    case "work":
      return "work";
    case "sessions":
      return "history";
    case "mcp":
      return "mcp config";
    case "research":
      return "local research";
  }
}

function getPrimaryPaneTitle(view: TuiShellState["view"]): string {
  switch (view) {
    case "mcp":
      return "Servers";
    case "research":
      return "Runs";
    case "work":
      return "Sessions";
    case "sessions":
      return "History";
  }
}

function getDetailPaneTitle(view: TuiShellState["view"]): string {
  switch (view) {
    case "mcp":
      return "MCP detail";
    case "research":
      return "Research detail";
    case "work":
      return "Work detail";
    case "sessions":
      return "Conversation";
  }
}

function resolveTerminalColumns(stdout: NodeJS.WriteStream): number {
  return stdout.columns ?? process.stdout.columns ?? 96;
}

function getDashboardLayout(columns: number): {
  readonly dividerWidth: number;
  readonly primaryWidth: number;
  readonly actionWidth: number;
  readonly detailWidth: number;
  readonly historyWidth: number;
  readonly showActionColumn: boolean;
} {
  const usableColumns = Math.max(44, columns - 4);
  const showActionColumn = usableColumns >= 96;
  const primaryWidth = showActionColumn
    ? 36
    : Math.max(20, Math.min(30, Math.floor(usableColumns * 0.4)));
  const actionWidth = showActionColumn ? 24 : 0;
  const middleGap = showActionColumn ? 6 : 2;
  const detailWidth = showActionColumn
    ? Math.max(30, usableColumns - primaryWidth - actionWidth - middleGap)
    : Math.max(18, usableColumns - primaryWidth - middleGap);
  const historyWidth = Math.max(24, Math.min(42, Math.floor(usableColumns * 0.42)));

  return {
    dividerWidth: Math.max(32, Math.min(96, usableColumns)),
    primaryWidth,
    actionWidth,
    detailWidth,
    historyWidth,
    showActionColumn,
  };
}

function isPromptActionId(actionId: string | undefined): boolean {
  return actionId === "new-research" || actionId === "api-key-login" || actionId === "mcp-add";
}

export type DashboardProps = TuiRenderOptions<TuiShellHomeState> & {
  readonly workspaceRoot: string;
};

export function Dashboard(props: DashboardProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [branch, setBranch] = useState("...");
  const [gitStatus, setGitStatus] = useState("...");
  const [runtime, setRuntime] = useState({ node: "", platform: "", arch: "" });
  const [terminalColumns, setTerminalColumns] = useState(() => resolveTerminalColumns(stdout));
  const [researchDraft, setResearchDraft] = useState("");
  const [contextLines, setContextLines] = useState(props.contextLines ?? []);
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
    recentResearchRuns: props.recentResearchRuns ?? [],
    sessions: props.sessions ?? [],
    bridgeLines: props.bridgeLines ?? [],
    memoryLines: props.memoryLines ?? [],
  };
  const initialShellState = createInitialShellState(initialHomeState, {
      ...(props.initialSelectedSessionId ? { selectedSessionId: props.initialSelectedSessionId } : {}),
      ...(props.initialView ? { initialView: props.initialView } : {}),
    });
  const [shellState, dispatch] = useReducer(
    reduceShellEvent,
    props.initialView
      ? {
          ...initialShellState,
          focus: createSessionCenterFocusForView(
            props.initialView,
            initialShellState.focus,
          ),
        }
      : initialShellState,
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
    recentResearchRuns: shellState.homeState.recentResearchRuns ?? [],
    sessions: shellState.homeState.sessions,
  });
  const centerState = shellState.focus as SessionCenterResolvedState;

  useEffect(() => {
    setBranch(getGitBranch(props.workspaceRoot));
    setGitStatus(getGitStatus(props.workspaceRoot));
    setRuntime(getRuntimeFacts());
  }, [props.workspaceRoot]);

  useEffect(() => {
    const updateTerminalColumns = () => {
      setTerminalColumns(resolveTerminalColumns(stdout));
    };
    updateTerminalColumns();
    stdout.on("resize", updateTerminalColumns);
    return () => {
      stdout.off("resize", updateTerminalColumns);
    };
  }, [stdout]);

  const selectedSession = model.primarySessions[centerState.sessionIndex];
  const selectedAction = model.utilityActions[centerState.actionIndex];
  const researchActionIndex = model.utilityActions.findIndex(
    (action) => action.id === "new-research",
  );
  const researchAction =
    researchActionIndex >= 0 ? model.utilityActions[researchActionIndex] : undefined;
  const sessionCommands = model.primarySessions.map((session) => `unclecode resume ${session.sessionId}`);
  const primaryItemCount =
    shellState.view === "mcp"
      ? model.mcpServers.length
      : shellState.view === "research"
        ? model.recentResearchRuns.length
        : model.primarySessions.length;
  const openWorkPane = (forwardedArgs: readonly string[] = []) => {
    const navigationMode = resolveWorkPaneNavigationMode({
      forwardedArgs,
      hasEmbeddedWorkPane: Boolean(props.renderWorkPane),
      hasEmbeddedWorkController: Boolean(props.openEmbeddedWorkSession),
      hasLaunchWorkSession: Boolean(props.launchWorkSession),
    });

    if (navigationMode === "embedded-view") {
      dispatch({ type: "view.changed", view: "work" });
      return;
    }

    if (navigationMode === "embedded-update") {
      dispatch({ type: "view.changed", view: "work" });
      void (async () => {
        const embeddedUpdate = await props.openEmbeddedWorkSession?.(
          forwardedArgs,
        );
        const selectedSessionId =
          embeddedUpdate?.selectedSessionId ??
          parseSelectedSessionIdFromArgs(forwardedArgs);
        if (embeddedUpdate?.contextLines) {
          setContextLines(embeddedUpdate.contextLines);
        }
        if (embeddedUpdate?.homeState) {
          dispatch({
            type: "home.updated",
            homeState: embeddedUpdate.homeState,
            ...(selectedSessionId ? { selectedSessionId } : {}),
          });
        } else if (props.refreshHomeState) {
          const refreshedHomeState = await props.refreshHomeState();
          dispatch({
            type: "home.updated",
            homeState: refreshedHomeState,
            ...(selectedSessionId ? { selectedSessionId } : {}),
          });
        }
        dispatch({ type: "view.changed", view: "work" });
      })().catch(() => undefined);
      return;
    }

    if (navigationMode === "launch-handoff") {
      exit();
      setTimeout(() => {
        props.launchWorkSession?.(forwardedArgs)?.catch((e: unknown) => {
          process.stderr.write(`[unclecode] launchWorkSession error: ${String(e)}\n`);
        });
      }, 0);
    }
  };
  const selectedApproval = selectedAction
    ? shellState.approvals.find((approval) => approval.id === createApprovalRequestForAction(selectedAction.id)?.id)
    : undefined;
  const visibleUtilityActions = ensureSelectedSessionCenterActionVisible(
    getVisibleSessionCenterActionsForView(shellState.view, model.utilityActions),
    selectedAction,
    centerState.column === "actions" || Boolean(selectedApproval),
  );
  const visibleUtilityActionIndexes = visibleUtilityActions
    .map((visibleAction) =>
      model.utilityActions.findIndex((action) => action.id === visibleAction.id),
    )
    .filter((index) => index >= 0);
  const activeWorkerCount = shellState.workers.filter((worker) => worker.status === "running").length;
  const workflowStatus = buildWorkflowStatusSummary({
    approvals: shellState.approvals,
    workers: shellState.workers,
    outputLines: shellState.outputLines,
    isRunning: shellState.isRunning,
  });
  const sessionCenterStatus = buildSessionCenterStatusLine({
    view: shellState.view,
    savedSessionCount: model.primarySessions.length,
    mcpServerCount: model.mcpServerCount,
    researchRunCount: model.researchRunCount,
    detailOpen: centerState.detailOpen,
    hasSelectedApproval: Boolean(selectedApproval),
    hasEmbeddedWorkPane: Boolean(props.renderWorkPane),
  });
  const screenStatus = shellState.view === "work" ? workflowStatus : sessionCenterStatus;
  const footerStatus = shellState.view === "work" ? workflowStatus : sessionCenterStatus;
  const layout = getDashboardLayout(terminalColumns);
  const syncHomeState = useCallback((homeState: Partial<TuiShellHomeState>) => {
    dispatch({ type: "home.updated", homeState });
  }, []);
  const openSessionsView = () => {
    void (async () => {
      const refreshedHomeState = props.refreshHomeState ? await props.refreshHomeState() : shellState.homeState;
      dispatch({ type: "home.updated", homeState: refreshedHomeState });
      dispatch({
        type: "focus.changed",
        focus: createSessionCenterFocusForView("sessions", centerState),
      });
      dispatch({ type: "view.changed", view: "sessions" });
    })().catch(() => undefined);
  };
  const renderFullscreenWorkPane = shouldRenderEmbeddedWorkPaneFullscreen(shellState.view, Boolean(props.renderWorkPane));

  const openResearchPromptLane = () => {
    dispatch({
      type: "focus.changed",
      focus: {
        ...centerState,
        column: "sessions",
        ...(researchActionIndex >= 0 ? { actionIndex: researchActionIndex } : {}),
        detailOpen: true,
        shouldExit: false,
        selectedCommand: undefined,
      },
    });
  };

  const runResearchPrompt = (prompt: string) => {
    const runAction = props.runAction;
    if (!runAction || !researchAction) {
      return;
    }

    void (async () => {
      dispatch({ type: "action.started", actionId: researchAction.id });
      dispatch({
        type: "worker.progressed",
        worker: {
          id: researchAction.id,
          label: researchAction.label,
          status: "running",
          detail: prettifyWorkerDetail("assembling context"),
        },
      });
      try {
        const lines = await runAction({
          actionId: researchAction.id,
          prompt,
          onProgress: (line) =>
            dispatch({
              type: "worker.progressed",
              worker: {
                id: researchAction.id,
                label: researchAction.label,
                status: "running",
                detail: prettifyWorkerDetail(line),
              },
            }),
        });
        dispatch({
          type: "worker.progressed",
          worker: {
            id: researchAction.id,
            label: researchAction.label,
            status: "running",
            detail: prettifyWorkerDetail("writing artifact"),
          },
        });
        const refreshedHomeState = props.refreshHomeState
          ? await props.refreshHomeState()
          : shellState.homeState;
        dispatch({
          type: "action.completed",
          entry: {
            id: `${researchAction.id}-${Date.now()}`,
            source: researchAction.id,
            title: `Research: ${prompt}`,
            timestamp: new Date().toISOString(),
            lines,
            tone: lines.some((line) => /failed/i.test(line)) ? "warning" : "success",
          },
          outputLines: lines,
          homeState: refreshedHomeState,
        });
        setResearchDraft("");
        dispatch({
          type: "focus.changed",
          focus: {
            ...centerState,
            column: "sessions",
            ...(researchActionIndex >= 0 ? { actionIndex: researchActionIndex } : {}),
            detailOpen: false,
            shouldExit: false,
            selectedCommand: undefined,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dispatch({
          type: "action.failed",
          entry: {
            id: `${researchAction.id}-error-${Date.now()}`,
            source: researchAction.id,
            title: `Research: ${prompt}`,
            timestamp: new Date().toISOString(),
            lines: [message],
            tone: "warning",
          },
          outputLines: [message],
        });
      }
    })().catch(() => undefined);
  };

  const getSelectedMcpServerName = () =>
    shellState.view === "mcp" ? model.mcpServers[centerState.sessionIndex]?.name : undefined;

  const runUtilityAction = (action: SessionCenterAction, detail: string, prompt?: string) => {
    const runAction = props.runAction;
    if (!runAction) {
      return;
    }

    void (async () => {
      dispatch({ type: "action.started", actionId: action.id });
      dispatch({ type: "worker.progressed", worker: { id: action.id, label: action.label, status: "running", detail: prettifyWorkerDetail(detail) } });
      try {
        const lines = await runAction({
          actionId: action.id,
          ...(prompt ? { prompt } : {}),
          onProgress: (line) => dispatch({ type: "worker.progressed", worker: { id: action.id, label: action.label, status: "running", detail: prettifyWorkerDetail(line) } }),
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
    })().catch(() => undefined);
  };

  const resumeSessionInWork = (session: SessionCenterSession | undefined) => {
    if (!session) {
      return false;
    }
    openWorkPane(["--session-id", session.sessionId]);
    return true;
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

    if (action.id === "work-session") {
      openWorkPane();
      return true;
    }

    const approval = createApprovalRequestForAction(action.id);
    const hasMatchingApproval = approval ? shellState.approvals.some((item) => item.id === approval.id) : false;
    if (shellState.approvals.length > 0 && !hasMatchingApproval) {
      return true;
    }

    if (isPromptActionId(action.id)) {
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
    runUtilityAction(
      action,
      detail,
      action.id === "mcp-inspect" || action.id === "mcp-remove"
        ? getSelectedMcpServerName()
        : undefined,
    );
    return true;
  };

  useInput((input, key) => {
    if (!shouldCaptureDashboardInput(shellState.view, Boolean(props.renderWorkPane))) {
      return;
    }

    if (
      shellState.view === "sessions" &&
      !selectedApproval &&
      (
        input.toLowerCase() === "r" ||
        input === " " ||
        input === "\r" ||
        input === "\n" ||
        key.return ||
        isSessionCenterImplicitSubmitInput(input, key)
      )
    ) {
      if (resumeSessionInWork(selectedSession)) {
        return;
      }
    }

    if (shellState.view === "mcp" && !selectedApproval) {
      const selectedMcpServerName = getSelectedMcpServerName();
      const runMcpAction = (actionId: string, detail: string) => {
        const action = model.utilityActions.find((item) => item.id === actionId);
        if (!action) {
          return false;
        }
        dispatch({
          type: "focus.changed",
          focus: {
            ...centerState,
            column: "actions",
            actionIndex: model.utilityActions.findIndex((item) => item.id === actionId),
            detailOpen: false,
            shouldExit: false,
            selectedCommand: undefined,
          },
        });
        runUtilityAction(
          action,
          detail,
          actionId === "mcp-inspect" || actionId === "mcp-remove"
            ? selectedMcpServerName
            : undefined,
        );
        return true;
      };
      if (input.toLowerCase() === "i" && runMcpAction("mcp-inspect", "inspecting selected server")) {
        return;
      }
      if (input.toLowerCase() === "m" && runMcpAction("mcp-list", "loading merged MCP config")) {
        return;
      }
      if (input.toLowerCase() === "x" && runMcpAction("mcp-remove", "removing selected workspace server")) {
        return;
      }
      if (input.toLowerCase() === "a") {
        const actionIndex = model.utilityActions.findIndex((item) => item.id === "mcp-add");
        if (actionIndex >= 0) {
          dispatch({
            type: "focus.changed",
            focus: {
              ...centerState,
              column: "actions",
              actionIndex,
              detailOpen: true,
              shouldExit: false,
              selectedCommand: undefined,
            },
          });
          return;
        }
      }
    }

    if (shouldReturnToWorkOnEscape(shellState.view, key, centerState, Boolean(selectedApproval))) {
      dispatch({ type: "view.changed", view: "work" });
      return;
    }

    if (
      shellState.view === "research" &&
      centerState.detailOpen &&
      !selectedApproval &&
      (centerState.column === "sessions" || selectedAction?.id === "new-research")
    ) {
      if (key.escape) {
        setResearchDraft("");
        dispatch({
          type: "focus.changed",
          focus: {
            ...centerState,
            detailOpen: false,
            shouldExit: false,
            selectedCommand: undefined,
          },
        });
        return;
      }
      if ((key.ctrl && input.toLowerCase() === "r") || input === "\u0012") {
        const prompt = researchDraft.trim();
        if (prompt.length > 0) {
          runResearchPrompt(prompt);
        }
        return;
      }

      const draftResult = handleResearchDraftInput(researchDraft, input, {
        return: key.return || isSessionCenterImplicitSubmitInput(input, key),
        backspace: key.backspace,
        delete: key.delete,
      });
      if (draftResult.submitted) {
        runResearchPrompt(draftResult.value);
        return;
      }

      if (!key.return) {
        setResearchDraft(draftResult.value);
      }
      return;
    }

    if (
      centerState.column === "sessions" &&
      shouldOpenResearchPromptLane(shellState.view, input, key, centerState, Boolean(selectedApproval))
    ) {
      openResearchPromptLane();
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
      dispatch({
        type: "focus.changed",
        focus: createSessionCenterFocusForView(viewShortcut, centerState),
      });
      dispatch({ type: "view.changed", view: viewShortcut });
      return;
    }

    if (centerState.column === "actions" && !centerState.detailOpen && isPromptActionId(selectedAction?.id) && key.return) {
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
          dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: prettifyWorkerDetail("Preparing browser auth…") } });
          try {
            const lines = await runAction({
              actionId: selectedAction.id,
              onProgress: (line) => dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: prettifyWorkerDetail(line) } }),
            });
            dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: prettifyWorkerDetail("Finalizing output…") } });
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
        })().catch(() => undefined);
        return;
      }
    }

    if (centerState.column === "actions" && centerState.detailOpen && isPromptActionId(selectedAction?.id)) {
      const promptAction = selectedAction;
      if (!promptAction) {
        return;
      }
      if (key.escape) {
        setResearchDraft("");
        dispatch({ type: "focus.changed", focus: { ...centerState, detailOpen: false, shouldExit: false, selectedCommand: undefined } });
        return;
      }
      if ((key.ctrl && input.toLowerCase() === "r") || input === "\u0012") {
        const prompt = researchDraft.trim();
        if (prompt.length > 0 && props.runAction) {
          const promptAction = selectedAction;
          if (!promptAction) {
            return;
          }
          void (async () => {
            dispatch({ type: "action.started", actionId: promptAction.id });
            dispatch({ type: "worker.progressed", worker: { id: promptAction.id, label: promptAction.label, status: "running", detail: prettifyWorkerDetail(promptAction.id === "new-research" ? "assembling context" : promptAction.id === "mcp-add" ? "writing project MCP config" : "saving auth") } });
            try {
              const lines = await props.runAction?.({
                actionId: promptAction.id,
                prompt,
                onProgress: (line) => dispatch({ type: "worker.progressed", worker: { id: promptAction.id, label: promptAction.label, status: "running", detail: prettifyWorkerDetail(line) } }),
              }) ?? [];
              const refreshedHomeState = props.refreshHomeState ? await props.refreshHomeState() : shellState.homeState;
              dispatch({
                type: "action.completed",
                entry: { id: `${promptAction.id}-${Date.now()}`, source: promptAction.id, title: promptAction.id === "new-research" ? `Research: ${prompt}` : promptAction.label, timestamp: new Date().toISOString(), lines, tone: lines.some((line) => /failed|error/i.test(line)) ? "warning" : "success" },
                outputLines: lines,
                homeState: refreshedHomeState,
              });
              setResearchDraft("");
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              dispatch({
                type: "action.failed",
                entry: { id: `${promptAction.id}-error-${Date.now()}`, source: promptAction.id, title: promptAction.id === "new-research" ? `Research: ${prompt}` : promptAction.label, timestamp: new Date().toISOString(), lines: [message], tone: "warning" },
                outputLines: [message],
              });
            }
          })().catch(() => undefined);
        }
        return;
      }

      const draftResult = handleResearchDraftInput(researchDraft, input, {
        return: key.return || isSessionCenterImplicitSubmitInput(input, key),
        backspace: key.backspace,
        delete: key.delete,
      });
      const runAction = props.runAction;
      if (draftResult.submitted && runAction) {
        void (async () => {
          dispatch({ type: "action.started", actionId: promptAction.id });
          dispatch({ type: "worker.progressed", worker: { id: promptAction.id, label: promptAction.label, status: "running", detail: prettifyWorkerDetail(promptAction.id === "new-research" ? "assembling context" : promptAction.id === "mcp-add" ? "writing project MCP config" : "saving auth") } });
          try {
            const lines = await runAction({
              actionId: promptAction.id,
              prompt: draftResult.value,
              onProgress: (line) => dispatch({ type: "worker.progressed", worker: { id: promptAction.id, label: promptAction.label, status: "running", detail: prettifyWorkerDetail(line) } }),
            });
            dispatch({ type: "worker.progressed", worker: { id: promptAction.id, label: promptAction.label, status: "running", detail: prettifyWorkerDetail(promptAction.id === "new-research" ? "writing artifact" : promptAction.id === "mcp-add" ? "refreshing MCP list" : "refreshing auth") } });
            const refreshedHomeState = props.refreshHomeState ? await props.refreshHomeState() : shellState.homeState;
            dispatch({
              type: "action.completed",
              entry: { id: `${promptAction.id}-${Date.now()}`, source: promptAction.id, title: promptAction.id === "new-research" ? `Research: ${draftResult.value}` : promptAction.label, timestamp: new Date().toISOString(), lines, tone: lines.some((line) => /failed|error/i.test(line)) ? "warning" : "success" },
              outputLines: lines,
              homeState: refreshedHomeState,
            });
            setResearchDraft("");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            dispatch({
              type: "action.failed",
              entry: { id: `${promptAction.id}-error-${Date.now()}`, source: promptAction.id, title: promptAction.id === "new-research" ? `Research: ${draftResult.value}` : promptAction.label, timestamp: new Date().toISOString(), lines: [message], tone: "warning" },
              outputLines: [message],
            });
          }
        })().catch(() => undefined);
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
      { sessionCount: primaryItemCount, actionCount: model.utilityActions.length },
      model.utilityActions.map((action) => action.command),
      shellState.view === "sessions" || shellState.view === "work" ? sessionCommands : undefined,
      {
        visibleActionIndexes: visibleUtilityActionIndexes,
        allowActionColumn: shellState.view !== "sessions",
      },
    );

    if (result.shouldExit) {
      const runAction = props.runAction;
      const runSession = props.runSession;

      if (result.selectedCommand && centerState.column === "actions" && selectedAction && runAction) {
        if (selectedAction.id === "work-session") {
          openWorkPane();
          return;
        }
        if (isPromptActionId(selectedAction.id)) {
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
          dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: prettifyWorkerDetail("loading action output") } });
          try {
            const selectedMcpServerName = getSelectedMcpServerName();
            const lines = await runAction({
              actionId: selectedAction.id,
              ...((selectedAction.id === "mcp-inspect" || selectedAction.id === "mcp-remove") && selectedMcpServerName
                ? { prompt: selectedMcpServerName }
                : {}),
              onProgress: (line) => dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: prettifyWorkerDetail(line) } }),
            });
            dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: prettifyWorkerDetail("finalizing output") } });
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
        })().catch(() => undefined);
        dispatch({ type: "focus.changed", focus: { ...result, shouldExit: false, selectedCommand: undefined, detailOpen: false } });
        return;
      }

      if (result.selectedCommand && centerState.column === "sessions" && selectedSession) {
        if (resumeSessionInWork(selectedSession)) {
          return;
        }
        if (runSession) {
          void (async () => {
            dispatch({ type: "action.started", actionId: selectedSession.sessionId });
            dispatch({ type: "worker.progressed", worker: { id: selectedSession.sessionId, label: "resume", status: "running", detail: prettifyWorkerDetail("loading session context") } });
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
          })().catch(() => undefined);
          dispatch({ type: "focus.changed", focus: { ...result, shouldExit: false, selectedCommand: undefined, detailOpen: true } });
          return;
        }
      }

      if (props.renderWorkPane && result.selectedCommand) {
        dispatch({
          type: "focus.changed",
          focus: {
            ...result,
            shouldExit: false,
            selectedCommand: undefined,
          },
        });
        return;
      }

      exit();
      if (result.selectedCommand) printExitCommand(result.selectedCommand);
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

      <Box marginY={1}><SectionDivider width={layout.dividerWidth} /></Box>
      <ViewTabs activeView={shellState.view} />
      <Box marginTop={1}>
        <Text color={C.textSecondary}>{screenStatus}</Text>
      </Box>
      <Box marginY={1}><SectionDivider label={getSessionCenterSectionLabel(shellState.view)} width={layout.dividerWidth} /></Box>

      {shellState.view === "sessions" ? (
        <Box flexDirection="row">
          <Box flexDirection="column" width={layout.historyWidth}>
            <Box gap={1}>
              <StatusDot status="running" />
              <Text bold color={C.text}>History</Text>
            </Box>
            <Box marginTop={1}>
              <SessionList sessions={model.primarySessions} selectedIndex={centerState.sessionIndex} isActive={true} emptyState={model.emptyState} />
            </Box>
          </Box>

          <Box flexDirection="column" width={layout.detailWidth} paddingLeft={2}>
            <Box gap={1}>
              <StatusDot status="running" />
              <Text bold color={C.text}>Conversation</Text>
            </Box>
            <Box marginTop={1}>
              <DetailPanel
                selectedSession={selectedSession}
                selectedAction={undefined}
                selectedApproval={undefined}
                selectedActionId={undefined}
                view={shellState.view}
                shellState={shellState}
                model={model}
                researchDraft={researchDraft}
                primarySelectionIndex={centerState.sessionIndex}
                contextLines={contextLines}
                bridgeLines={shellState.homeState.bridgeLines ?? props.bridgeLines ?? []}
                memoryLines={shellState.homeState.memoryLines ?? props.memoryLines ?? []}
              />
            </Box>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {!layout.showActionColumn ? (
            <Box marginBottom={1}>
              <ActionShortcutStrip
                actions={visibleUtilityActions}
                selectedActionId={selectedAction?.id}
                isActive={centerState.column === "actions"}
              />
            </Box>
          ) : null}
          <Box flexDirection="row">
            <Box flexDirection="column" width={layout.primaryWidth}>
              <Box gap={1}>
                <StatusDot status={centerState.column === "sessions" ? "running" : "idle"} />
                <Text bold color={centerState.column === "sessions" ? C.text : C.textMuted}>
                  {getPrimaryPaneTitle(shellState.view)}
                </Text>
              </Box>
              <Box marginTop={1}>
                {shellState.view === "mcp" ? (
                  <McpServerList servers={model.mcpServers} selectedIndex={centerState.sessionIndex} isActive={centerState.column === "sessions"} />
                ) : shellState.view === "research" ? (
                  <ResearchRunList runs={model.recentResearchRuns} selectedIndex={centerState.sessionIndex} isActive={centerState.column === "sessions"} />
                ) : (
                  <SessionList sessions={model.primarySessions} selectedIndex={centerState.sessionIndex} isActive={centerState.column === "sessions"} emptyState={model.emptyState} />
                )}
              </Box>
            </Box>

            {layout.showActionColumn ? (
              <Box flexDirection="column" width={layout.actionWidth} paddingLeft={2}>
                <Box gap={1}>
                  <StatusDot status={centerState.column === "actions" ? "running" : "idle"} />
                  <Text bold color={centerState.column === "actions" ? C.text : C.textMuted}>Actions</Text>
                </Box>
                <Box marginTop={1}>
                  <ActionList actions={visibleUtilityActions} selectedActionId={selectedAction?.id} isActive={centerState.column === "actions"} />
                </Box>
              </Box>
            ) : null}

            <Box flexDirection="column" width={layout.detailWidth} paddingLeft={2}>
              <Box gap={1}>
                <StatusDot status="running" />
                <Text bold color={C.text}>{getDetailPaneTitle(shellState.view)}</Text>
              </Box>
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
                  primarySelectionIndex={centerState.sessionIndex}
                  contextLines={contextLines}
                  bridgeLines={shellState.homeState.bridgeLines ?? props.bridgeLines ?? []}
                  memoryLines={shellState.homeState.memoryLines ?? props.memoryLines ?? []}
                />
              </Box>
            </Box>
          </Box>
        </Box>
      )}

      <Box marginY={1}><ThinDivider dashed width={layout.dividerWidth} /></Box>
      <StatusBar runtime={runtime} modeLabel={model.modeLabel} authLabel={model.authLabel} approvalCount={shellState.approvals.length} workerCount={activeWorkerCount} workflowStatus={footerStatus} />
    </Box>
  );
}
