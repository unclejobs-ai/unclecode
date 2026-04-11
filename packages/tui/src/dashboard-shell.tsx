import {
  parseSelectedSessionIdFromArgs,
  UNCLECODE_COMMAND_NAME,
} from "@unclecode/contracts";
import { Box, Text, useApp, useInput } from "ink";
import React, { useCallback, useEffect, useReducer, useState } from "react";

import { type TuiRenderOptions } from "./dashboard-model.js";
import {
  B,
  C,
  KeyPill,
  SectionDivider,
  StatusDot,
  ThinDivider,
} from "./dashboard-primitives.js";

import { getGitBranch, getGitStatus, getRuntimeFacts } from "./facts.js";
import {
  DASHBOARD_ACTIONS,
  createApprovalRequestForAction,
  createSessionCenterModel,
  formatSessionCenterDraftValue,
  formatSessionHeadline,
  getWorkspaceDisplayName,
  type SessionCenterAction,
  type SessionCenterModel,
  type SessionCenterSession,
} from "./dashboard-actions.js";
import {
  getImmediateActionShortcut,
  getSessionCenterActionShortcut,
  getSessionCenterViewShortcut,
  handleApprovalInput,
  handleDashboardInput,
  handleResearchDraftInput,
  handleSessionCenterInput,
  resolveWorkPaneNavigationMode,
  shouldCaptureDashboardInput,
  shouldRenderEmbeddedWorkPaneFullscreen,
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
  buildWorkflowStatusSummary,
  DetailPanel,
  HeaderChrome,
  prettifyWorkerDetail,
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

export type DashboardProps = TuiRenderOptions<TuiShellHomeState> & {
  readonly workspaceRoot: string;
};

export function Dashboard(props: DashboardProps) {
  const { exit } = useApp();
  const [branch, setBranch] = useState("...");
  const [gitStatus, setGitStatus] = useState("...");
  const [runtime, setRuntime] = useState({ node: "", platform: "", arch: "" });
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
  const activeWorkerCount = shellState.workers.filter((worker) => worker.status === "running").length;
  const workflowStatus = buildWorkflowStatusSummary({
    approvals: shellState.approvals,
    workers: shellState.workers,
    outputLines: shellState.outputLines,
    isRunning: shellState.isRunning,
  });
  const syncHomeState = useCallback((homeState: Partial<TuiShellHomeState>) => {
    dispatch({ type: "home.updated", homeState });
  }, []);
  const openSessionsView = () => {
    void (async () => {
      const refreshedHomeState = props.refreshHomeState ? await props.refreshHomeState() : shellState.homeState;
      dispatch({ type: "home.updated", homeState: refreshedHomeState });
      dispatch({ type: "view.changed", view: "sessions" });
    })().catch(() => undefined);
  };
  const renderFullscreenWorkPane = shouldRenderEmbeddedWorkPaneFullscreen(shellState.view, Boolean(props.renderWorkPane));

  const runUtilityAction = (action: SessionCenterAction, detail: string) => {
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
          dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: prettifyWorkerDetail(selectedAction.id === "new-research" ? "assembling context" : "saving auth") } });
          try {
            const lines = await runAction({
              actionId: selectedAction.id,
              prompt: draftResult.value,
              onProgress: (line) => dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: prettifyWorkerDetail(line) } }),
            });
            dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: prettifyWorkerDetail(selectedAction.id === "new-research" ? "writing artifact" : "refreshing auth") } });
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
      { sessionCount: model.primarySessions.length, actionCount: model.utilityActions.length },
      model.utilityActions.map((action) => action.command),
      sessionCommands,
    );

    if (result.shouldExit) {
      const runAction = props.runAction;
      const runSession = props.runSession;

      if (result.selectedCommand && centerState.column === "actions" && selectedAction && runAction) {
        if (selectedAction.id === "work-session") {
          openWorkPane();
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
          dispatch({ type: "worker.progressed", worker: { id: selectedAction.id, label: selectedAction.label, status: "running", detail: prettifyWorkerDetail("loading action output") } });
          try {
            const lines = await runAction({
              actionId: selectedAction.id,
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
        dispatch({ type: "focus.changed", focus: { ...result, shouldExit: false, selectedCommand: undefined, detailOpen: true } });
        return;
      }

      if (result.selectedCommand && centerState.column === "sessions" && selectedSession) {
        if (selectedSession.sessionId.startsWith("work-")) {
          openWorkPane(["--session-id", selectedSession.sessionId]);
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

      <Box marginY={1}><SectionDivider /></Box>
      <ViewTabs activeView={shellState.view} />
      <Box marginTop={1}>
        <Text color={C.textSecondary}>{workflowStatus}</Text>
      </Box>
      <Box marginY={1}><SectionDivider label={shellState.view === "work" ? "work" : shellState.view === "sessions" ? "sessions" : shellState.view === "mcp" ? "mcp" : "research"} /></Box>

      {
        <Box flexDirection="row">
          <Box flexDirection="column" width={38}>
            <Box gap={1}>
              <StatusDot status={centerState.column === "sessions" ? "running" : "idle"} />
              <Text bold color={centerState.column === "sessions" ? C.text : C.textMuted}>Resume</Text>
            </Box>
            <Box marginTop={1}>
              <SessionList sessions={model.primarySessions} selectedIndex={centerState.sessionIndex} isActive={centerState.column === "sessions"} emptyState={model.emptyState} />
            </Box>
          </Box>

          <Box flexDirection="column" width={16} paddingLeft={2}>
            <Box gap={1}>
              <StatusDot status={centerState.column === "actions" ? "running" : "idle"} />
              <Text bold color={centerState.column === "actions" ? C.text : C.textMuted}>Actions</Text>
            </Box>
            <Box marginTop={1}>
              <ActionList actions={model.utilityActions} selectedIndex={centerState.actionIndex} isActive={centerState.column === "actions"} />
            </Box>
          </Box>

          <Box flexDirection="column" paddingLeft={2}>
            <Box gap={1}>
              <StatusDot status={centerState.detailOpen || shellState.view !== "sessions" ? "running" : "idle"} />
              <Text bold color={centerState.detailOpen || shellState.view !== "sessions" ? C.text : C.textMuted}>Inspector</Text>
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
                contextLines={contextLines}
                bridgeLines={shellState.homeState.bridgeLines ?? props.bridgeLines ?? []}
                memoryLines={shellState.homeState.memoryLines ?? props.memoryLines ?? []}
              />
            </Box>
          </Box>
        </Box>
      }

      <Box marginY={1}><ThinDivider dashed /></Box>
      <StatusBar runtime={runtime} modeLabel={model.modeLabel} authLabel={model.authLabel} approvalCount={shellState.approvals.length} workerCount={activeWorkerCount} workflowStatus={workflowStatus} />
    </Box>
  );
}

