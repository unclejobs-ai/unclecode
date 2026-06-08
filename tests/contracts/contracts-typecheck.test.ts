import type { APPROVAL_INTENTS } from "@unclecode/contracts";
import type {
  ApprovalIntent,
  PolicyDecision as CanonicalPolicyDecision,
  ProviderId as CanonicalProviderId,
  JsonObject,
  JsonValue,
  OpenEmbeddedWorkSession,
  SessionMetadata,
  SessionPendingAction,
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
