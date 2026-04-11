import { Box, Text } from "ink";
import React from "react";

import { UNCLECODE_COMMAND_NAME } from "@unclecode/contracts";

import {
  createApprovalRequestForAction,
  formatSessionCenterDraftValue,
  formatSessionHeadline,
  type SessionCenterAction,
  type SessionCenterModel,
  type SessionCenterSession,
  getWorkspaceDisplayName,
} from "./dashboard-actions.js";
import {
  B,
  C,
  KeyPill,
  StatusBadge,
  STATUS_DOT,
  StatusDot,
} from "./dashboard-primitives.js";
import { truncateForDisplayWidth } from "./text-width.js";
import {
  type TuiActivityEntry as TuiShellActivityEntry,
  type TuiApprovalRequest,
  type TuiShellFocusState,
  type TuiShellState,
  type TuiStepTraceEntry as TuiShellStepTraceEntry,
  type TuiWorkerStatus,
} from "./shell-state.js";

function truncateForPane(value: string, maxLength: number): string {
  return truncateForDisplayWidth(value, maxLength);
}

export type SessionCenterResolvedState = TuiShellFocusState;

export function HeaderChrome(props: { readonly branch: string; readonly gitStatus: string; readonly workspacePath: string }) {
  const dirName = getWorkspaceDisplayName(props.workspacePath);
  const statusColor = props.gitStatus === "clean" ? C.accentDim : C.warning;
  const showDir = dirName !== UNCLECODE_COMMAND_NAME;

  return (
    <Box>
      <Text backgroundColor={C.headerBg} color={C.headerFg} bold>{" "}{UNCLECODE_COMMAND_NAME}{" "}</Text>
      {showDir ? (
        <>
          <Text color={C.textMuted}> </Text>
          <Text color={C.textSecondary}>{dirName}</Text>
        </>
      ) : (
        <Text> </Text>
      )}
      <Text color={C.textMuted}>·</Text>
      <Text color={C.accentBright}> {props.branch}</Text>
      <Text color={C.textMuted}>·</Text>
      <Text color={statusColor}> {props.gitStatus}</Text>
    </Box>
  );
}

export function StatusBar(props: {
  readonly runtime: { readonly node: string; readonly platform: string; readonly arch: string };
  readonly modeLabel: string;
  readonly authLabel: string;
  readonly approvalCount: number;
  readonly workerCount: number;
  readonly workflowStatus: string;
}) {
  return (
    <Box gap={2}>
      <Box>
        <Text backgroundColor={C.pillBg} color={C.pillFg} bold>{" "}{props.modeLabel}{" "}</Text>
      </Box>
      <Box>
        <Text color={props.authLabel === "none" ? C.textMuted : C.accentBright}>{props.authLabel}</Text>
      </Box>
      {props.approvalCount > 0 ? (
        <Box>
          <Text backgroundColor={C.statusBgWarning} color={C.warning} bold>{" "}{props.approvalCount} approval{(props.approvalCount > 1 ? "s" : "")}{" "}</Text>
        </Box>
      ) : null}
      {props.workerCount > 0 ? (
        <Box gap={1}>
          <StatusDot status="running" />
          <Text color={C.accentBright} bold>{props.workerCount}</Text>
          <Text color={C.textSecondary}>worker{props.workerCount > 1 ? "s" : ""}</Text>
        </Box>
      ) : null}
      <Box>
        <Text color={C.textMuted}>{props.workflowStatus}</Text>
      </Box>
    </Box>
  );
}

export const VIEW_TABS = [
  { key: "1", label: "Work", view: "work" as const },
  { key: "2", label: "Sessions", view: "sessions" as const },
  { key: "3", label: "MCP", view: "mcp" as const },
  { key: "4", label: "Research", view: "research" as const },
] as const;

export function ViewTabs(props: { activeView: TuiShellState["view"] }) {
  return (
    <Box gap={2}>
      {VIEW_TABS.map((tab) => {
        const isActive = props.activeView === tab.view;
        return (
          <Box key={tab.view}>
            {isActive ? (
              <>
                <Text backgroundColor={C.accent} color={C.pillFg} bold>{" "}{tab.key}{" "}</Text>
                <Text color={C.text} bold>{" "}{tab.label}</Text>
              </>
            ) : (
              <>
                <Text backgroundColor={C.tagBg} color={C.textMuted}>{" "}{tab.key}{" "}</Text>
                <Text color={C.textMuted}>{" "}{tab.label}</Text>
              </>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

export function SessionList(props: {
  readonly sessions: readonly SessionCenterSession[];
  readonly selectedIndex: number;
  readonly isActive: boolean;
  readonly emptyState: string;
}) {
  if (props.sessions.length === 0) return <Text color={C.textMuted}>{props.emptyState}</Text>;
  return (
    <Box flexDirection="column" gap={0}>
      {props.sessions.map((session, index) => {
        const isSelected = props.isActive && props.selectedIndex === index;
        const dot = STATUS_DOT[session.state] ?? { char: "○", color: C.textMuted };
        return (
          <Box key={session.sessionId} flexDirection="column">
            <Box gap={1}>
              <Text color={isSelected ? C.accentBright : C.bg}>{isSelected ? "❯" : " "}</Text>
              <Text color={dot.color}>{dot.char}</Text>
              <Text color={isSelected ? C.text : C.textSecondary} bold={isSelected}>{truncateForPane(formatSessionHeadline(session), 22)}</Text>
            </Box>
            <Box paddingLeft={3}>
              <Text color={C.textFaint}>{truncateForPane(session.model ?? "·", 10)}</Text>
              <Text color={C.textFaint}> </Text>
              <Text color={C.textFaint}>{truncateForPane(session.sessionId, 16)}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

export function stripSessionCenterShortcutLabel(label: string): string {
  return label.replace(/^[A-Z]\s+/, "").trim();
}

export function prettifyWorkerDetail(detail: string): string {
  const trimmed = detail.trim();
  if (trimmed.length === 0) {
    return "working";
  }
  const normalized = trimmed
    .replace(/^oauth\b/i, "OAuth")
    .replace(/^mcp\b/i, "MCP")
    .replace(/^api key\b/i, "API key");
  return normalized[0]?.toUpperCase() === normalized[0]
    ? normalized
    : `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`;
}

export function formatWorkerDisplayLabel(worker: TuiWorkerStatus): string {
  return stripSessionCenterShortcutLabel(worker.label)
    .replace(/^browser$/i, "Browser login")
    .replace(/^key$/i, "API key login")
    .replace(/^logout$/i, "Sign out")
    .replace(/^research$/i, "Research")
    .replace(/^doctor$/i, "Doctor")
    .replace(/^resume$/i, "Resume session");
}

export function formatWorkerStatusSummary(worker: TuiWorkerStatus): string {
  return `${formatWorkerDisplayLabel(worker)} · ${prettifyWorkerDetail(worker.detail)}`;
}

export function buildWorkflowStatusSummary(input: {
  readonly approvals: readonly TuiApprovalRequest[];
  readonly workers: readonly TuiWorkerStatus[];
  readonly outputLines: readonly string[];
  readonly isRunning?: boolean;
}): string {
  if (input.approvals[0]) {
    return `waiting approval · ${input.approvals[0].title}`;
  }
  const runningWorker = input.workers.find((worker) => worker.status === "running") ?? input.workers[0];
  if (runningWorker) {
    return `running · ${formatWorkerStatusSummary(runningWorker)}`;
  }
  if (input.isRunning) {
    return "running · preparing next step";
  }
  if (input.outputLines[0]) {
    return "ready · last result available";
  }
  return "ready · W work · B auth · R research";
}

export function ActionList(props: {
  readonly actions: readonly SessionCenterAction[];
  readonly selectedIndex: number;
  readonly isActive: boolean;
}) {
  return (
    <Box flexDirection="column" gap={0}>
      {props.actions.map((action, index) => {
        const isSelected = props.isActive && props.selectedIndex === index;
        const keyLabel = stripSessionCenterShortcutLabel(action.label);
        const shortcutKey = action.label.match(/^[A-Z]/)?.[0];
        return (
          <Box key={action.id} gap={1}>
            <Text color={isSelected ? C.accentBright : C.bg}>{isSelected ? "❯" : " "}</Text>
            {shortcutKey ? (
              <Text backgroundColor={isSelected ? C.accent : C.pillBg} color={isSelected ? C.pillFg : C.pillFg}>{" "}{shortcutKey}{" "}</Text>
            ) : (
              <Text color={C.textFaint}>·</Text>
            )}
            <Text color={isSelected ? C.text : C.textMuted} bold={isSelected}>{truncateForPane(keyLabel, 12)}</Text>
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
  readonly isRunning?: boolean;
}): {
  readonly currentLines: readonly string[];
  readonly traceLines: readonly { message: string; timestamp: string; color: string }[];
  readonly historyLines: readonly string[];
} {
  const currentLines = [
    `Workflow: ${buildWorkflowStatusSummary(input)}`,
    ...(input.approvals[0] ? [`Approval: ${input.approvals[0].title}`] : []),
    ...input.workers.slice(0, 2).map((worker) => `Worker: ${formatWorkerStatusSummary(worker)}`),
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

export function InspectorContext(props: {
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

export function DetailPanel(props: {
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
        <Box gap={1}>
          <Text color={props.selectedApproval.severity === "warning" ? C.warning : C.info}>●</Text>
          <Text color={props.selectedApproval.severity === "warning" ? C.warning : C.info}>{props.selectedApproval.title}</Text>
        </Box>
        <Box paddingLeft={2}>
          <Text color={C.textMuted}>{truncateForPane(props.selectedApproval.detail, 38)}</Text>
        </Box>
        <Box marginTop={1} gap={2}>
          <Box gap={1}>
            <KeyPill char="Enter" />
            <Text color={C.textMuted}>approve</Text>
          </Box>
          <Box gap={1}>
            <KeyPill char="Esc" />
            <Text color={C.textMuted}>cancel</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (props.view === "work") {
    const { approvals, workers, traceEntries, activityEntries, isRunning, outputLines } = props.shellState;
    const runningWorkers = workers.filter((w) => w.status === "running");
    const idleWorkers = workers.filter((w) => w.status === "idle");
    const hasActivity = approvals.length > 0 || workers.length > 0 || isRunning;

    return (
      <Box flexDirection="column">
        {/* Approvals */}
        {approvals.length > 0 ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color={C.warning}>Waiting approval</Text>
            {approvals.slice(0, 3).map((approval) => (
              <Box key={approval.id} flexDirection="column" marginTop={1}>
                <Box gap={1}>
                  <Text color={approval.severity === "warning" ? C.warning : C.info}>▲</Text>
                  <Text color={C.text} bold>{truncateForPane(approval.title, 34)}</Text>
                </Box>
                {approval.detail ? (
                  <Box paddingLeft={2}>
                    <Text color={C.textMuted}>{truncateForPane(approval.detail, 34)}</Text>
                  </Box>
                ) : null}
                <Box paddingLeft={2} gap={2} marginTop={1}>
                  <Box gap={1}><KeyPill char="Enter" /><Text color={C.textMuted}>approve</Text></Box>
                  <Box gap={1}><KeyPill char="Esc" /><Text color={C.textMuted}>cancel</Text></Box>
                </Box>
              </Box>
            ))}
          </Box>
        ) : null}

        {/* Active workers */}
        {runningWorkers.length > 0 ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color={C.text}>Workers</Text>
            {runningWorkers.slice(0, 4).map((worker) => (
              <Box key={worker.id} gap={1} marginTop={1}>
                <StatusBadge label={worker.status} status="running" />
                <Box flexDirection="column">
                  <Text color={C.text}>{truncateForPane(formatWorkerDisplayLabel(worker), 28)}</Text>
                  {worker.detail ? (
                    <Text color={C.textMuted}>{truncateForPane(prettifyWorkerDetail(worker.detail), 30)}</Text>
                  ) : null}
                </Box>
              </Box>
            ))}
            {idleWorkers.length > 0 ? (
              <Box gap={1} marginTop={1}>
                <StatusBadge label="idle" status="idle" />
                <Text color={C.textMuted}>{String(idleWorkers.length)} idle</Text>
              </Box>
            ) : null}
          </Box>
        ) : !hasActivity ? (
          <Box marginBottom={1}>
            <Text color={C.textMuted}>No active workers.</Text>
            {outputLines[0] ? (
              <Box marginTop={1}>
                <Text color={C.textMuted}>Last: {truncateForPane(outputLines[0], 34)}</Text>
              </Box>
            ) : null}
          </Box>
        ) : null}

        {/* Live trace */}
        {traceEntries.length > 0 ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color={C.text}>Steps</Text>
            {traceEntries.slice(0, 4).map((entry) => {
              const color = entry.kind === "approval" ? C.warning : entry.kind === "result" ? C.success : entry.level === "low-signal" ? C.textMuted : C.info;
              return (
                <Box key={`${entry.timestamp}-${entry.message}`} gap={1} marginTop={1}>
                  <Text color={color}>›</Text>
                  <Box flexDirection="column">
                    <Text color={color}>{truncateForPane(entry.message, 36)}</Text>
                    <Text color={C.textFaint}>{entry.timestamp}</Text>
                  </Box>
                </Box>
              );
            })}
          </Box>
        ) : null}

        {/* Recent activity */}
        {activityEntries.length > 0 ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color={C.text}>Recent</Text>
            {activityEntries.slice(0, 4).map((entry, index) => (
              <Box key={`${String(index)}-${entry.title}`} gap={1} marginTop={1}>
                <Text color={C.textFaint}>·</Text>
                <Text color={C.textMuted}>{truncateForPane(entry.title, 36)}</Text>
              </Box>
            ))}
          </Box>
        ) : null}

        <Box gap={1} marginTop={1}>
          <KeyPill char="W" /><Text color={C.textMuted}>work</Text>
          <Text color={C.textFaint}>·</Text>
          <KeyPill char="B" /><Text color={C.textMuted}>auth</Text>
          <Text color={C.textFaint}>·</Text>
          <KeyPill char="R" /><Text color={C.textMuted}>research</Text>
        </Box>
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
