import type { PolicyDecision, ToolMetadata } from "@unclecode/contracts";

export const TOOL_CONFIRMATION_POLICIES = ["always", "never", "risky"] as const;

export type ToolConfirmationPolicy = (typeof TOOL_CONFIRMATION_POLICIES)[number];

export type ToolConfirmationRequest = {
  readonly toolName: string;
  readonly metadata?: ToolMetadata | undefined;
  readonly policy?: ToolConfirmationPolicy | undefined;
};

export function resolveToolConfirmationDecision(
  request: ToolConfirmationRequest,
): PolicyDecision {
  const policy = request.policy ?? "risky";
  if (policy === "always") {
    return promptDecision(request.toolName, "Tool confirmation policy requires every tool to prompt.", "always");
  }
  if (policy === "never") {
    return allowDecision(request.toolName, "Tool confirmation policy allows tools without prompting.", "never");
  }
  if (requiresRiskyToolPrompt(request.metadata)) {
    return promptDecision(request.toolName, explainRiskyToolPrompt(request.metadata), "risky");
  }
  return allowDecision(request.toolName, "Tool metadata is low-risk and read-only.", "risky");
}

function requiresRiskyToolPrompt(metadata: ToolMetadata | undefined): boolean {
  if (metadata === undefined) {
    return true;
  }
  const annotations = metadata.annotations;
  return annotations.requiresConfirmation === true
    || annotations.riskLevel === "high"
    || annotations.riskLevel === "unknown"
    || annotations.destructiveHint === true
    || annotations.openWorldHint === true;
}

function explainRiskyToolPrompt(metadata: ToolMetadata | undefined): string {
  if (metadata === undefined) {
    return "Tool metadata is missing, so confirmation is required.";
  }
  const annotations = metadata.annotations;
  if (annotations.reason) {
    return annotations.reason;
  }
  return `Tool risk is ${annotations.riskLevel}; confirmation is required.`;
}

function allowDecision(toolName: string, reason: string, policy: ToolConfirmationPolicy): PolicyDecision {
  return {
    effect: "allow",
    source: "base",
    reason,
    matchedRule: `tool-confirmation.${policy}.${toolName}.allow`,
  };
}

function promptDecision(toolName: string, reason: string, policy: ToolConfirmationPolicy): PolicyDecision {
  return {
    effect: "prompt",
    source: "base",
    reason,
    matchedRule: `tool-confirmation.${policy}.${toolName}.prompt`,
  };
}

