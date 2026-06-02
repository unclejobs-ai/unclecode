import type {
  ExecutionPolicyCapability,
  ExecutionPolicyEvaluation,
  ExecutionPolicyProfile,
  ExecutionPolicyRule,
  PolicyDecisionEffect,
  PolicyDecisionSource,
} from "@unclecode/contracts";

export type ExecutionPolicyRequest = {
  readonly capability: ExecutionPolicyCapability;
  readonly runtimeMode: string;
  readonly path?: string;
  readonly command?: string;
  readonly host?: string;
  readonly provider?: string;
};

export const LOCAL_AUDIT_EXECUTION_POLICY_PROFILE: ExecutionPolicyProfile = {
  id: "local.audit",
  mode: "audit",
  defaultEffect: "allow",
  rules: [],
};

export function evaluateExecutionPolicy(
  profile: ExecutionPolicyProfile,
  request: ExecutionPolicyRequest,
): ExecutionPolicyEvaluation {
  const matchedRule = profile.rules.find((rule) => ruleMatchesRequest(rule, request));
  const rawEffect = matchedRule?.effect ?? profile.defaultEffect;
  const auditOnly = profile.mode === "audit" && rawEffect !== "allow";
  const effect = profile.mode === "audit" ? "allow" : rawEffect;

  return {
    capability: request.capability,
    effect,
    source: resolveEvaluationSource(matchedRule),
    reason: resolveEvaluationReason(profile, request.capability, rawEffect, matchedRule, auditOnly),
    matchedRule: matchedRule?.id ?? `${profile.id}.${request.capability}.default`,
    auditOnly,
  };
}

function resolveEvaluationSource(rule: ExecutionPolicyRule | undefined): PolicyDecisionSource {
  return rule?.match?.runtimeMode ? "runtime" : "base";
}

function resolveEvaluationReason(
  profile: ExecutionPolicyProfile,
  capability: ExecutionPolicyCapability,
  effect: PolicyDecisionEffect,
  rule: ExecutionPolicyRule | undefined,
  auditOnly: boolean,
): string {
  const reason = rule?.reason ?? `Default ${effect} for ${capability} in ${profile.id}.`;
  return auditOnly ? `Audit only: ${reason}` : reason;
}

function ruleMatchesRequest(
  rule: ExecutionPolicyRule,
  request: ExecutionPolicyRequest,
): boolean {
  if (rule.capability !== request.capability) {
    return false;
  }
  const match = rule.match;
  if (!match) {
    return true;
  }
  if (match.runtimeMode !== undefined && match.runtimeMode !== request.runtimeMode) {
    return false;
  }
  if (match.pathPrefix !== undefined && !pathMatchesPrefix(request.path, match.pathPrefix)) {
    return false;
  }
  if (match.commandPrefix !== undefined && !commandMatchesPrefix(request.command, match.commandPrefix)) {
    return false;
  }
  if (match.host !== undefined && match.host !== request.host) {
    return false;
  }
  if (match.provider !== undefined && match.provider !== request.provider) {
    return false;
  }
  return true;
}

function pathMatchesPrefix(path: string | undefined, prefix: string): boolean {
  if (path === undefined) {
    return false;
  }
  const normalizedPath = normalizePolicyPath(path);
  const normalizedPrefix = normalizePolicyPath(prefix);
  if (normalizedPath === undefined || normalizedPrefix === undefined) {
    return false;
  }
  if (normalizedPrefix === "" || normalizedPrefix === ".") {
    return true;
  }
  return normalizedPath === normalizedPrefix
    || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

function commandMatchesPrefix(command: string | undefined, prefix: string): boolean {
  if (command === undefined) {
    return false;
  }
  const normalizedCommand = command.trimStart();
  const normalizedPrefix = prefix.trim();
  if (normalizedPrefix === "") {
    return true;
  }
  if (normalizedCommand === normalizedPrefix) {
    return true;
  }
  return normalizedCommand.startsWith(`${normalizedPrefix} `)
    || normalizedCommand.startsWith(`${normalizedPrefix}\t`);
}

function normalizePolicyPath(value: string): string | undefined {
  const parts: string[] = [];
  for (const segment of value.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (parts.length === 0) {
        return undefined;
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}
