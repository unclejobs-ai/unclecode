export const TOOL_RISK_LEVELS = ["low", "medium", "high", "unknown"] as const;
export type ToolRiskLevel = (typeof TOOL_RISK_LEVELS)[number];

export const TOOL_RESOURCE_KINDS = [
  "workspace",
  "file",
  "directory",
  "shell",
  "patch",
  "network",
  "context",
  "unknown",
] as const;
export type ToolResourceKind = (typeof TOOL_RESOURCE_KINDS)[number];

export const TOOL_RESOURCE_MODES = [
  "read",
  "write",
  "delete",
  "execute",
  "unknown",
] as const;
export type ToolResourceMode = (typeof TOOL_RESOURCE_MODES)[number];

export const TOOL_RESOURCE_RESOLVERS = ["apply-patch-files"] as const;
export type ToolResourceResolver = (typeof TOOL_RESOURCE_RESOLVERS)[number];

export const TOOL_OBSERVATION_VISIBILITIES = [
  "model",
  "summary",
  "hidden",
] as const;
export type ToolObservationVisibility = (typeof TOOL_OBSERVATION_VISIBILITIES)[number];

export type ToolAnnotations = {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
  readonly riskLevel: ToolRiskLevel;
  readonly requiresConfirmation?: boolean;
  readonly reason?: string;
};

export type ToolDeclaredResource = {
  readonly kind: ToolResourceKind;
  readonly mode: ToolResourceMode;
  readonly template: string;
  readonly declared: boolean;
  readonly resolver?: ToolResourceResolver;
  readonly reason?: string;
};

export type ToolObservationPolicy = {
  readonly defaultVisibility: ToolObservationVisibility;
  readonly maxInlineBytes?: number;
};

export type ToolMetadata = {
  readonly annotations: ToolAnnotations;
  readonly resources: readonly ToolDeclaredResource[];
  readonly observation?: ToolObservationPolicy;
};
