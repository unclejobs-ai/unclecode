import {
  APPROVAL_INTENTS,
  MODE_PROFILE_IDS,
  type ApprovalIntentType,
  type ModeProfileId,
  type TrustZone,
} from "@unclecode/contracts";

import {
  POLICY_ACTORS,
  POLICY_RUNTIME_MODES,
  type PolicyDecision,
  type PolicyDecisionEffect,
  type PolicyRequest,
  type PolicyRuntimeMode,
} from "./types.js";

function buildMatchedRule(
  trustZone: TrustZone,
  intent: ApprovalIntentType,
  mode: ModeProfileId | undefined,
  runtimeMode: PolicyRuntimeMode,
): string {
  const metadata = Object.hasOwn(APPROVAL_INTENTS, intent)
    ? APPROVAL_INTENTS[intent as keyof typeof APPROVAL_INTENTS]
    : undefined;
  const normalizedMode = metadata?.supportsMode ? mode : undefined;

  return `${trustZone}.${intent}.${normalizedMode ?? "nomode"}.${runtimeMode}`;
}

function isModeProfileId(value: string | undefined): value is ModeProfileId {
  return value !== undefined && MODE_PROFILE_IDS.includes(value as ModeProfileId);
}

function createDecision(
  effect: PolicyDecisionEffect,
  source: PolicyDecision["source"],
  reason: string,
  request: PolicyRequest,
): PolicyDecision {
  return {
    effect,
    source,
    reason,
    matchedRule: buildMatchedRule(request.trustZone, request.intent, request.mode, request.runtimeMode),
  };
}

export function validateRequestShape(request: PolicyRequest): PolicyDecision | undefined {
  if (!(request.intent in APPROVAL_INTENTS)) {
    return {
      effect: "deny",
      source: "base",
      reason: `Unsupported intent: ${String(request.intent)}.`,
      matchedRule: buildMatchedRule(request.trustZone, request.intent, request.mode, request.runtimeMode),
    };
  }

  if (!POLICY_ACTORS.includes(request.actor)) {
    return {
      effect: "deny",
      source: "base",
      reason: `Unsupported actor: ${String(request.actor)}.`,
      matchedRule: buildMatchedRule(request.trustZone, request.intent, request.mode, request.runtimeMode),
    };
  }

  if (!POLICY_RUNTIME_MODES.includes(request.runtimeMode)) {
    return {
      effect: "deny",
      source: "base",
      reason: `Unsupported runtime mode: ${String(request.runtimeMode)}.`,
      matchedRule: buildMatchedRule(request.trustZone, request.intent, request.mode, request.runtimeMode),
    };
  }

  const metadata = APPROVAL_INTENTS[request.intent];
  const mode = request.mode;

  if (request.trustZone !== metadata.trustZone) {
    return {
      effect: "deny",
      source: "base",
      reason: `Intent ${request.intent} requires trust zone ${metadata.trustZone}.`,
      matchedRule: buildMatchedRule(request.trustZone, request.intent, request.mode, request.runtimeMode),
    };
  }

  if (metadata.supportsMode && mode === undefined) {
    return {
      effect: "deny",
      source: "base",
      reason: `Intent ${request.intent} requires an explicit mode.`,
      matchedRule: buildMatchedRule(request.trustZone, request.intent, mode, request.runtimeMode),
    };
  }

  if (metadata.supportsMode && !isModeProfileId(mode)) {
    return {
      effect: "deny",
      source: "base",
      reason: `Unsupported mode: ${String(mode)}.`,
      matchedRule: buildMatchedRule(request.trustZone, request.intent, mode, request.runtimeMode),
    };
  }

  if (!metadata.supportsMode && mode !== undefined) {
    return {
      effect: "deny",
      source: "base",
      reason: `Intent ${request.intent} does not support mode overrides.`,
      matchedRule: buildMatchedRule(request.trustZone, request.intent, mode, request.runtimeMode),
    };
  }

  return undefined;
}

export function resolveBaseDecision(request: PolicyRequest): PolicyDecision {
  if (request.intent === "mcp_server") {
    return createDecision("prompt", "base", "MCP server actions require explicit review.", request);
  }

  if (request.intent === "background_task") {
    return createDecision("prompt", "base", "Background task actions require explicit review.", request);
  }

  if (request.intent === "plan") {
    return createDecision("allow", "base", "Planning is allowed by default.", request);
  }

  if (request.trustZone === "workspace" && request.runtimeMode === "local") {
    return createDecision("allow", "base", "Workspace tool execution is allowed locally.", request);
  }

  return createDecision("prompt", "base", "Tool execution outside the local workspace requires review.", request);
}

export function applyModeDecision(request: PolicyRequest, baseDecision: PolicyDecision): PolicyDecision {
  if (request.intent === "mcp_server" || request.intent === "background_task") {
    return baseDecision;
  }

  if (request.mode === "yolo" && request.trustZone === "workspace" && request.intent === "tool_execution") {
    return createDecision("allow", "mode", "YOLO mode allows workspace tool execution without review.", request);
  }

  if (request.mode === "search" && request.intent === "tool_execution") {
    return createDecision("deny", "mode", "Search mode forbids tool execution by default.", request);
  }

  if (request.mode === "analyze" && baseDecision.effect === "allow") {
    return createDecision("prompt", "mode", "Analyze mode requires review before acting.", request);
  }

  return baseDecision;
}

export function applyRuntimeDecision(
  request: PolicyRequest,
  currentDecision: PolicyDecision,
): PolicyDecision {
  if (currentDecision.source === "mode" && currentDecision.effect === "allow") {
    return currentDecision;
  }

  if (request.runtimeMode === "remote" && currentDecision.effect === "allow") {
    return createDecision("prompt", "runtime", "Remote runtime actions require review.", request);
  }

  if (
    (request.runtimeMode === "sandbox" || request.runtimeMode === "openshell")
    && currentDecision.effect === "allow"
  ) {
    return createDecision("prompt", "runtime", "Sandbox runtime actions require review.", request);
  }

  return currentDecision;
}
