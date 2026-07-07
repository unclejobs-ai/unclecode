import type { BackgroundTaskType } from "./engine.js";
import type { McpConfigScope, McpTransport } from "./mcp.js";
export declare const TRUST_ZONES: readonly ["workspace", "session", "local", "project", "user", "enterprise", "managed", "dynamic", "claudeai"];
export type TrustZone = (typeof TRUST_ZONES)[number];
export declare const POLICY_PERMISSION_MODES: readonly ["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"];
export type PolicyPermissionMode = (typeof POLICY_PERMISSION_MODES)[number];
export declare const APPROVAL_INTENT_TYPES: readonly ["tool_execution", "plan", "mcp_server", "background_task"];
export type ApprovalIntentType = (typeof APPROVAL_INTENT_TYPES)[number];
export type ApprovalIntentMetadata = {
    readonly type: ApprovalIntentType;
    readonly label: string;
    readonly trustZone: TrustZone;
    readonly requiresRequestId: boolean;
    readonly supportsMode: boolean;
};
export declare const APPROVAL_INTENTS: {
    readonly tool_execution: {
        readonly type: "tool_execution";
        readonly label: "Tool execution approval";
        readonly trustZone: "workspace";
        readonly requiresRequestId: true;
        readonly supportsMode: true;
    };
    readonly plan: {
        readonly type: "plan";
        readonly label: "Plan approval";
        readonly trustZone: "session";
        readonly requiresRequestId: true;
        readonly supportsMode: true;
    };
    readonly mcp_server: {
        readonly type: "mcp_server";
        readonly label: "MCP server approval";
        readonly trustZone: "project";
        readonly requiresRequestId: true;
        readonly supportsMode: false;
    };
    readonly background_task: {
        readonly type: "background_task";
        readonly label: "Background task approval";
        readonly trustZone: "session";
        readonly requiresRequestId: true;
        readonly supportsMode: false;
    };
};
export type ToolExecutionApprovalIntent = {
    readonly type: "tool_execution";
    readonly requestId: string;
    readonly trustZone: typeof APPROVAL_INTENTS.tool_execution.trustZone;
    readonly permissionMode?: PolicyPermissionMode;
    readonly toolName: string;
    readonly actionDescription?: string;
    readonly toolUseId?: string;
    readonly reason?: string;
};
export type PlanApprovalIntent = {
    readonly type: "plan";
    readonly requestId: string;
    readonly trustZone: "session";
    readonly permissionMode?: Extract<PolicyPermissionMode, "plan" | "default">;
    readonly agentId?: string;
    readonly agentName?: string;
    readonly teamName?: string;
    readonly planModeRequired?: boolean;
};
export type McpServerApprovalIntent = {
    readonly type: "mcp_server";
    readonly requestId: string;
    readonly trustZone: typeof APPROVAL_INTENTS.mcp_server.trustZone;
    readonly serverName: string;
    readonly scope: McpConfigScope;
    readonly transport: McpTransport;
};
export type BackgroundTaskApprovalIntent = {
    readonly type: "background_task";
    readonly requestId: string;
    readonly trustZone: "session";
    readonly taskId: string;
    readonly taskType: BackgroundTaskType;
    readonly action: "kill" | "resume" | "attach";
};
export type ApprovalIntent = ToolExecutionApprovalIntent | PlanApprovalIntent | McpServerApprovalIntent | BackgroundTaskApprovalIntent;
export declare const POLICY_DECISION_EFFECTS: readonly ["allow", "prompt", "deny"];
export type PolicyDecisionEffect = (typeof POLICY_DECISION_EFFECTS)[number];
export declare const POLICY_DECISION_SOURCES: readonly ["base", "mode", "runtime", "userOverride", "sessionOverride", "delegation"];
export type PolicyDecisionSource = (typeof POLICY_DECISION_SOURCES)[number];
export type PolicyDecision = {
    readonly effect: PolicyDecisionEffect;
    readonly source: PolicyDecisionSource;
    readonly reason: string;
    readonly matchedRule: string;
};
export declare const EXECUTION_POLICY_DOMAINS: readonly ["filesystem", "shell", "network", "secrets", "inference"];
export type ExecutionPolicyDomain = (typeof EXECUTION_POLICY_DOMAINS)[number];
export declare const EXECUTION_POLICY_CAPABILITIES: readonly ["filesystem.read", "filesystem.write", "shell.run", "network.egress", "secret.read", "inference.request"];
export type ExecutionPolicyCapability = (typeof EXECUTION_POLICY_CAPABILITIES)[number];
export declare const EXECUTION_POLICY_MODES: readonly ["audit", "prompt", "enforce"];
export type ExecutionPolicyMode = (typeof EXECUTION_POLICY_MODES)[number];
export type ExecutionPolicyRuleMatch = {
    readonly pathPrefix?: string;
    readonly commandPrefix?: string;
    readonly host?: string;
    readonly provider?: string;
    readonly runtimeMode?: string;
};
export type ExecutionPolicyRule = {
    readonly id: string;
    readonly capability: ExecutionPolicyCapability;
    readonly effect: PolicyDecisionEffect;
    readonly reason: string;
    readonly match?: ExecutionPolicyRuleMatch;
};
export type ExecutionPolicyProfile = {
    readonly id: string;
    readonly mode: ExecutionPolicyMode;
    readonly defaultEffect: PolicyDecisionEffect;
    readonly rules: readonly ExecutionPolicyRule[];
};
export type ExecutionPolicyEvaluation = {
    readonly capability: ExecutionPolicyCapability;
    readonly effect: PolicyDecisionEffect;
    readonly source: PolicyDecisionSource;
    readonly reason: string;
    readonly matchedRule: string;
    readonly auditOnly: boolean;
};
//# sourceMappingURL=policy.d.ts.map