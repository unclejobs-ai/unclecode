import { APPROVAL_INTENT_TYPES } from "@unclecode/contracts";

import { applyDelegationDecision, getPolicyEffectRank } from "./delegation.js";
import {
  applyModeDecision,
  applyRuntimeDecision,
  resolveBaseDecision,
  validateRequestShape,
} from "./decision-table.js";
import { applyOverrideDecision } from "./overrides.js";
import type { PolicyDecision, PolicyEngine, PolicyRequest } from "./types.js";

export type {
  PolicyActor,
  PolicyDecision,
  PolicyDecisionEffect,
  PolicyDecisionSource,
  PolicyDelegation,
  PolicyEngine,
  PolicyOverrides,
  PolicyRequest,
  PolicyRuntimeMode,
} from "./types.js";
export { POLICY_ACTORS, POLICY_DECISION_EFFECTS, POLICY_RUNTIME_MODES } from "./types.js";

export const POLICY_ENGINE_APPROVAL_INTENT_TYPES = APPROVAL_INTENT_TYPES;

export function createPolicyEngine(): PolicyEngine {
  return {
    decide(request: PolicyRequest): PolicyDecision {
      const invalidDecision = validateRequestShape(request);

      if (invalidDecision !== undefined) {
        return invalidDecision;
      }

      const baseDecision = resolveBaseDecision(request);
      const modeDecision = applyModeDecision(request, baseDecision);
      const runtimeDecision = applyRuntimeDecision(request, modeDecision);
      const overrideDecision = applyOverrideDecision(request, runtimeDecision);

      return applyDelegationDecision(request, overrideDecision);
    },
  };
}

export function resolvePolicyDecision(request: PolicyRequest): PolicyDecision {
  return createPolicyEngine().decide(request);
}

export function formatApprovalMessage(decision: PolicyDecision): string {
  return `[${decision.effect.toUpperCase()}] ${decision.reason} (${decision.matchedRule})`;
}

export {
  LOCAL_AUDIT_EXECUTION_POLICY_PROFILE,
  evaluateExecutionPolicy,
} from "./execution-policy.js";
export type { ExecutionPolicyRequest } from "./execution-policy.js";
export { getPolicyEffectRank } from "./delegation.js";
