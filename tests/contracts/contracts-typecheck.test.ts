import type { APPROVAL_INTENTS } from "@unclecode/contracts";
import type {
  AgentControlPort,
  AgentControlReceipt,
  AgentRunSettledTraceEvent,
  AgentRunStartedTraceEvent,
  ApprovalIntent,
  PolicyDecision as CanonicalPolicyDecision,
  ProviderId as CanonicalProviderId,
  ExecutionTraceEvent,
  JobQueuedTraceEvent,
  JobSettledTraceEvent,
  JsonObject,
  JsonValue,
  OpenEmbeddedWorkSession,
  SessionMetadata,
  SessionPendingAction,
  TerminalAgentRunStatus,
  TerminalAsyncJobStatus,
  ToolCompletedTraceEvent,
  ToolStartedTraceEvent,
  UsageRecordedTraceEvent,
} from "@unclecode/contracts";
import type { PolicyDecision as PolicyEngineDecision } from "@unclecode/policy-engine";
import type { ProviderId as PackageProviderId } from "@unclecode/providers";
import type {
  DashboardProps,
  EmbeddedWorkPaneRenderOptions,
  TuiRenderOptions,
  TuiShellHomeState,
} from "@unclecode/tui";
import { createSessionCenterDashboardRenderOptions } from "@unclecode/tui";

type Assert<T extends true> = T;
type IsExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type ExtendsJsonValue<T extends JsonValue> = true;

type ToolExecutionIntent = Extract<ApprovalIntent, { type: "tool_execution" }>;
type McpServerIntent = Extract<ApprovalIntent, { type: "mcp_server" }>;

type ProviderAliasIsCanonical = Assert<
  IsExact<PackageProviderId, CanonicalProviderId>
>;
type PolicyDecisionAliasIsCanonical = Assert<
  IsExact<PolicyEngineDecision, CanonicalPolicyDecision>
>;
type ToolTrustZoneMatchesMetadata = Assert<
  IsExact<
    ToolExecutionIntent["trustZone"],
    typeof APPROVAL_INTENTS.tool_execution.trustZone
  >
>;
type McpTrustZoneMatchesMetadata = Assert<
  IsExact<
    McpServerIntent["trustZone"],
    typeof APPROVAL_INTENTS.mcp_server.trustZone
  >
>;
type PendingActionInputIsJsonObject = Assert<
  IsExact<NonNullable<SessionPendingAction["input"]>, JsonObject>
>;
type PostTurnSummaryIsJsonValue = ExtendsJsonValue<
  NonNullable<SessionMetadata["postTurnSummary"]>
>;
type TuiEmbeddedControllerMatchesSharedContract = Assert<
  IsExact<
    NonNullable<TuiRenderOptions<TuiShellHomeState>["openEmbeddedWorkSession"]>,
    OpenEmbeddedWorkSession<TuiShellHomeState>
  >
>;
type DashboardPropsDeriveFromSharedRenderOptions = Assert<
  IsExact<DashboardProps["workspaceRoot"], string>
>;
type DashboardOptionalAuthMatchesRenderOptions = Assert<
  IsExact<
    DashboardProps["authLabel"],
    TuiRenderOptions<TuiShellHomeState>["authLabel"]
  >
>;
type EmbeddedWorkPaneOptionsCarrySharedControllerType = Assert<
  IsExact<
    EmbeddedWorkPaneRenderOptions<TuiShellHomeState>["openEmbeddedWorkSession"],
    TuiRenderOptions<TuiShellHomeState>["openEmbeddedWorkSession"]
  >
>;

const pendingActionInput: JsonObject = {
  nested: ["ok", 1, true, null, { safe: "yes" }],
};

const pendingAction: SessionPendingAction = {
  toolName: "bash",
  actionDescription: "Run tests",
  toolUseId: "tool-1",
  requestId: "request-1",
  input: pendingActionInput,
};

const metadata: SessionMetadata = {
  pendingAction,
  postTurnSummary: {
    status: "ok",
    counts: [1, 2, 3],
    nested: { safe: true },
  },
};

const pendingActionInputRoundTrip: JsonValue = pendingAction.input ?? null;
const postTurnSummaryRoundTrip: JsonValue = metadata.postTurnSummary ?? null;

void pendingActionInputRoundTrip;
void postTurnSummaryRoundTrip;
void (null as unknown as ProviderAliasIsCanonical);
void (null as unknown as PolicyDecisionAliasIsCanonical);
void (null as unknown as ToolTrustZoneMatchesMetadata);
void (null as unknown as McpTrustZoneMatchesMetadata);
void (null as unknown as PendingActionInputIsJsonObject);
void (null as unknown as PostTurnSummaryIsJsonValue);
void (null as unknown as TuiEmbeddedControllerMatchesSharedContract);
void (null as unknown as DashboardPropsDeriveFromSharedRenderOptions);
void (null as unknown as DashboardOptionalAuthMatchesRenderOptions);
void (null as unknown as EmbeddedWorkPaneOptionsCarrySharedControllerType);

const sessionCenterRenderOptions = createSessionCenterDashboardRenderOptions({
  workspaceRoot: "/tmp/typecheck",
  homeState: {
    modeLabel: "default",
    authLabel: "none",
    sessionCount: 0,
    mcpServerCount: 0,
    mcpServers: [],
    sessions: [],
    bridgeLines: [],
    memoryLines: [],
  } satisfies TuiShellHomeState,
  contextLines: [],
});

const sessionCenterRenderOptionsWorkspaceRoot: string =
  sessionCenterRenderOptions.workspaceRoot ?? "";
void sessionCenterRenderOptionsWorkspaceRoot;

// --- Agent console lifecycle, usage, and control contracts ---

/** Keys that a value of `T` must supply; optional keys collapse to `never`. */
type RequiredKeys<T> = {
  [K in keyof T]-?: Pick<T, K> extends Required<Pick<T, K>> ? K : never;
}[keyof T];

// Every lifecycle payload must actually be reachable through the union that
// producers and reducers switch on.
type JobQueuedIsTraceEventMember = Assert<
  IsExact<
    Extract<ExecutionTraceEvent, { type: "job.queued" }>,
    JobQueuedTraceEvent
  >
>;
type JobSettledIsTraceEventMember = Assert<
  IsExact<
    Extract<ExecutionTraceEvent, { type: "job.settled" }>,
    JobSettledTraceEvent
  >
>;
type AgentRunStartedIsTraceEventMember = Assert<
  IsExact<
    Extract<ExecutionTraceEvent, { type: "agent.run.started" }>,
    AgentRunStartedTraceEvent
  >
>;
type AgentRunSettledIsTraceEventMember = Assert<
  IsExact<
    Extract<ExecutionTraceEvent, { type: "agent.run.settled" }>,
    AgentRunSettledTraceEvent
  >
>;
type UsageRecordedIsTraceEventMember = Assert<
  IsExact<
    Extract<ExecutionTraceEvent, { type: "usage.recorded" }>,
    UsageRecordedTraceEvent
  >
>;

// Exact required-key sets: this fails both when a brief-required field turns
// optional and when an optional field silently becomes mandatory.
type JobQueuedRequiredFields = Assert<
  IsExact<
    RequiredKeys<JobQueuedTraceEvent>,
    "type" | "level" | "eventId" | "jobId" | "jobType" | "label" | "queuedAt"
  >
>;
type JobSettledRequiredFields = Assert<
  IsExact<
    RequiredKeys<JobSettledTraceEvent>,
    "type" | "level" | "eventId" | "jobId" | "status" | "completedAt"
  >
>;
type AgentRunStartedRequiredFields = Assert<
  IsExact<
    RequiredKeys<AgentRunStartedTraceEvent>,
    | "type"
    | "level"
    | "eventId"
    | "runId"
    | "jobId"
    | "displayName"
    | "agentType"
    | "startedAt"
  >
>;
type AgentRunSettledRequiredFields = Assert<
  IsExact<
    RequiredKeys<AgentRunSettledTraceEvent>,
    "type" | "level" | "eventId" | "runId" | "jobId" | "status" | "completedAt"
  >
>;
type UsageRecordedRequiredFields = Assert<
  IsExact<
    RequiredKeys<UsageRecordedTraceEvent>,
    "type" | "level" | "eventId" | "provider" | "model" | "startedAt"
  >
>;

void (null as unknown as JobQueuedIsTraceEventMember);
void (null as unknown as JobSettledIsTraceEventMember);
void (null as unknown as AgentRunStartedIsTraceEventMember);
void (null as unknown as AgentRunSettledIsTraceEventMember);
void (null as unknown as UsageRecordedIsTraceEventMember);
void (null as unknown as JobQueuedRequiredFields);
void (null as unknown as JobSettledRequiredFields);
void (null as unknown as AgentRunStartedRequiredFields);
void (null as unknown as AgentRunSettledRequiredFields);
void (null as unknown as UsageRecordedRequiredFields);

type AgentRunStartedRequiresJobId = Assert<
  IsExact<AgentRunStartedTraceEvent["jobId"], string>
>;
type AgentRunSettledRequiresJobId = Assert<
  IsExact<AgentRunSettledTraceEvent["jobId"], string>
>;
type AgentRunStartedLineageIsOptional = Assert<
  IsExact<AgentRunStartedTraceEvent["parentRunId"], string | undefined>
>;
type AgentRunStartedContinuationIsOptional = Assert<
  IsExact<AgentRunStartedTraceEvent["continuationOf"], string | undefined>
>;
type AgentRunSettledStatusIsTerminal = Assert<
  IsExact<AgentRunSettledTraceEvent["status"], TerminalAgentRunStatus>
>;
type JobSettledStatusIsTerminal = Assert<
  IsExact<JobSettledTraceEvent["status"], TerminalAsyncJobStatus>
>;
type JobQueuedRequiresTypeAndLabel = Assert<
  IsExact<
    [JobQueuedTraceEvent["jobType"], JobQueuedTraceEvent["label"]],
    [string, string]
  >
>;
type ToolStartedScopeIsOptional = Assert<
  IsExact<
    [ToolStartedTraceEvent["agentRunId"], ToolStartedTraceEvent["asyncJobId"]],
    [string | undefined, string | undefined]
  >
>;
type ToolCompletedScopeIsOptional = Assert<
  IsExact<
    [
      ToolCompletedTraceEvent["agentRunId"],
      ToolCompletedTraceEvent["asyncJobId"],
    ],
    [string | undefined, string | undefined]
  >
>;
type UsageCountersAreOptional = Assert<
  IsExact<
    [
      UsageRecordedTraceEvent["inputTokens"],
      UsageRecordedTraceEvent["outputTokens"],
      UsageRecordedTraceEvent["cacheReadTokens"],
      UsageRecordedTraceEvent["costUsd"],
    ],
    [
      number | undefined,
      number | undefined,
      number | undefined,
      number | undefined,
    ]
  >
>;
type UsageEventIdIsRequired = Assert<
  IsExact<UsageRecordedTraceEvent["eventId"], string>
>;
type ControlPortSteerSignature = Assert<
  IsExact<
    AgentControlPort["steer"],
    (agentRunId: string, message: string) => Promise<AgentControlReceipt>
  >
>;
type ControlPortCancelSignature = Assert<
  IsExact<
    AgentControlPort["cancel"],
    (agentRunId: string) => Promise<AgentControlReceipt>
  >
>;
type ControlPortContinueSignature = Assert<
  IsExact<
    AgentControlPort["continue"],
    (agentRunId: string, message?: string) => Promise<AgentControlReceipt>
  >
>;

void (null as unknown as AgentRunStartedRequiresJobId);
void (null as unknown as AgentRunSettledRequiresJobId);
void (null as unknown as AgentRunStartedLineageIsOptional);
void (null as unknown as AgentRunStartedContinuationIsOptional);
void (null as unknown as AgentRunSettledStatusIsTerminal);
void (null as unknown as JobSettledStatusIsTerminal);
void (null as unknown as JobQueuedRequiresTypeAndLabel);
void (null as unknown as ToolStartedScopeIsOptional);
void (null as unknown as ToolCompletedScopeIsOptional);
void (null as unknown as UsageCountersAreOptional);
void (null as unknown as UsageEventIdIsRequired);
void (null as unknown as ControlPortSteerSignature);
void (null as unknown as ControlPortCancelSignature);
void (null as unknown as ControlPortContinueSignature);

const agentRunStarted: AgentRunStartedTraceEvent = {
  type: "agent.run.started",
  level: "high-signal",
  eventId: "evt-run-started-1",
  runId: "run-1",
  jobId: "job-1",
  displayName: "ExecutionMap",
  agentType: "executor",
  startedAt: 10,
};

// @ts-expect-error agent.run.started must carry the owning jobId
const agentRunStartedWithoutJobId: AgentRunStartedTraceEvent = {
  type: "agent.run.started",
  level: "high-signal",
  eventId: "evt-run-started-2",
  runId: "run-2",
  displayName: "ExecutionMap",
  agentType: "executor",
  startedAt: 10,
};

const agentRunSettled: AgentRunSettledTraceEvent = {
  type: "agent.run.settled",
  level: "high-signal",
  eventId: "evt-run-settled-1",
  runId: "run-1",
  jobId: "job-1",
  status: "completed",
  startedAt: 10,
  completedAt: 20,
  summary: "Mapped the execution path",
};

// @ts-expect-error agent.run.settled must carry the owning jobId
const agentRunSettledWithoutJobId: AgentRunSettledTraceEvent = {
  type: "agent.run.settled",
  level: "high-signal",
  eventId: "evt-run-settled-2",
  runId: "run-2",
  status: "completed",
  completedAt: 20,
};

// `AgentRunSettled/JobSettled` status is pinned to the terminal aliases above,
// so an active status is rejected at the alias itself.
// @ts-expect-error a settled run cannot report a still-active status
const settledRunStatusMustBeTerminal: TerminalAgentRunStatus = "running";
// @ts-expect-error a settled job cannot report a still-active status
const settledJobStatusMustBeTerminal: TerminalAsyncJobStatus = "queued";

/** Main-agent tool calls stay unscoped; subagent calls carry both scopes. */
const mainAgentToolStarted: ToolStartedTraceEvent = {
  type: "tool.started",
  level: "default",
  provider: "unknown",
  toolName: "read_file",
  toolCallId: "call-1",
  input: {},
  startedAt: 10,
};

const scopedToolCompleted: ToolCompletedTraceEvent = {
  type: "tool.completed",
  level: "default",
  provider: "unknown",
  toolName: "read_file",
  toolCallId: "call-2",
  isError: false,
  output: "ok",
  startedAt: 10,
  completedAt: 20,
  durationMs: 10,
  agentRunId: "run-1",
  asyncJobId: "job-1",
};

const jobQueued: JobQueuedTraceEvent = {
  type: "job.queued",
  level: "default",
  eventId: "evt-job-queued-1",
  jobId: "job-1",
  jobType: "work-node",
  label: "Map execution",
  agentRunId: "run-1",
  queuedAt: 9,
};

const usageRecorded: UsageRecordedTraceEvent = {
  type: "usage.recorded",
  level: "low-signal",
  eventId: "usage-1",
  provider: "openai",
  model: "gpt-5.6-sol",
  startedAt: 10,
};

void agentRunStarted;
void agentRunStartedWithoutJobId;
void agentRunSettled;
void agentRunSettledWithoutJobId;
void settledRunStatusMustBeTerminal;
void settledJobStatusMustBeTerminal;
void mainAgentToolStarted;
void scopedToolCompleted;
void jobQueued;
void usageRecorded;
