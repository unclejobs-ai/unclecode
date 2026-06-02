import {
  APPROVAL_INTENTS,
  POLICY_DECISION_EFFECTS,
  type ApprovalIntentType,
  type ModeProfileId,
  type PolicyDecision,
  type PolicyDecisionEffect,
  type PolicyDecisionSource,
  type TrustZone,
} from "@unclecode/contracts";

export { POLICY_DECISION_EFFECTS };
export type { PolicyDecision, PolicyDecisionEffect, PolicyDecisionSource } from "@unclecode/contracts";

export const POLICY_RUNTIME_MODES = ["local", "sandbox", "remote", "openshell"] as const;

export type PolicyRuntimeMode = (typeof POLICY_RUNTIME_MODES)[number];

export const POLICY_ACTORS = ["primary", "subagent"] as const;

export type PolicyActor = (typeof POLICY_ACTORS)[number];

export type PolicyOverrides = {
  readonly user?: Partial<Record<ApprovalIntentType, PolicyDecisionEffect>>;
  readonly session?: Partial<Record<ApprovalIntentType, PolicyDecisionEffect>>;
};

export type PolicyDelegation = {
  readonly allowedIntents: readonly ApprovalIntentType[];
};

type PolicyRequestBase<TIntent extends ApprovalIntentType, TTrustZone extends TrustZone> = {
  readonly trustZone: TTrustZone;
  readonly intent: TIntent;
  readonly runtimeMode: PolicyRuntimeMode;
  readonly actor: PolicyActor;
  readonly overrides?: PolicyOverrides;
  readonly delegation?: PolicyDelegation;
};

export type ToolExecutionPolicyRequest = PolicyRequestBase<
  "tool_execution",
  typeof APPROVAL_INTENTS.tool_execution.trustZone
> & {
  readonly mode: ModeProfileId;
};

export type PlanPolicyRequest = PolicyRequestBase<"plan", typeof APPROVAL_INTENTS.plan.trustZone> & {
  readonly mode: ModeProfileId;
};

export type McpServerPolicyRequest = PolicyRequestBase<
  "mcp_server",
  typeof APPROVAL_INTENTS.mcp_server.trustZone
> & {
  readonly mode?: undefined;
};

export type BackgroundTaskPolicyRequest = PolicyRequestBase<
  "background_task",
  typeof APPROVAL_INTENTS.background_task.trustZone
> & {
  readonly mode?: undefined;
};

export type PolicyRequest =
  | ToolExecutionPolicyRequest
  | PlanPolicyRequest
  | McpServerPolicyRequest
  | BackgroundTaskPolicyRequest;

export interface PolicyEngine {
  decide(request: PolicyRequest): PolicyDecision;
}
