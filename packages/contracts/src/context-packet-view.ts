import type { ContextSourceMetadata } from "./context-source-metadata.js";

export type ContextPacketSourceCategory =
  | "workspace"
  | "workspace-guidance"
  | "provider-system-prompt"
  | "loop-trail"
  | "condensed-history"
  | "memory"
  | "bridge"
  | "runtime"
  | "attachment"
  | "system"
  | "user";

export const CONTEXT_PACKET_VIEW_BADGE_TONES = ["info", "success", "warning", "danger", "muted"] as const;
export type ContextPacketViewBadgeTone = (typeof CONTEXT_PACKET_VIEW_BADGE_TONES)[number];

export const CONTEXT_WORKBENCH_LANES = ["overview", "sources", "budget", "preview", "rules", "history"] as const;
export type ContextWorkbenchLane = (typeof CONTEXT_WORKBENCH_LANES)[number];

export type ContextPacketViewBadge = {
  readonly label: string;
  readonly tone: ContextPacketViewBadgeTone;
};

export type ContextPacketViewProvenanceKind =
  | "workspace"
  | "guidance"
  | "bridge"
  | "loop-trail"
  | "condensed-history"
  | "memory"
  | "runtime"
  | "attachment"
  | "system";

export type ContextPacketViewProvenanceScope = "project" | "user" | "workspace" | "runtime" | "system";

export type ContextPacketViewProvenance = {
  readonly kind: ContextPacketViewProvenanceKind;
  readonly sourceId: string;
  readonly uri?: string | undefined;
  readonly scope?: ContextPacketViewProvenanceScope | undefined;
  readonly providerId?: string | undefined;
  readonly sha256?: string | undefined;
};

export type ContextPacketViewFreshnessState = "fresh" | "stale" | "expired" | "unknown";

export type ContextPacketViewFreshness = {
  readonly state: ContextPacketViewFreshnessState;
  readonly updatedAt?: string | undefined;
  readonly turnLastSeen?: number | null | undefined;
  readonly expiresAt?: string | null | undefined;
};

export type ContextPacketViewConfidence = "high" | "medium" | "low" | "unknown";
export type ContextPacketViewTrustTier = "builtin" | "project" | "user" | "external" | "runtime";

export type ContextPacketViewRankFactor = {
  readonly label: string;
  readonly value: string;
};

export type ContextPacketViewRank = {
  readonly score: number;
  readonly factors: readonly ContextPacketViewRankFactor[];
};

export type ContextPacketViewAction =
  | "pin"
  | "unpin"
  | "hold-back"
  | "include"
  | "preview"
  | "refresh"
  | "compare"
  | "undo";

export type ContextPacketViewSourceState = {
  readonly category: ContextPacketSourceCategory;
  readonly label: string;
  readonly includedInModel: boolean;
  readonly salience: number;
  readonly tokenEstimate: number;
};

export type ContextPacketViewActionReceipt = {
  readonly id: string;
  readonly action: ContextPacketViewAction;
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly message: string;
  readonly canUndo: boolean;
  readonly beforePacketId?: string | undefined;
  readonly afterPacketId?: string | undefined;
  readonly before?: ContextPacketViewSourceState | undefined;
  readonly after?: ContextPacketViewSourceState | undefined;
};

export type ContextPacketViewPreviewKind = "summary" | "excerpt" | "full" | "redacted";

export type ContextPacketViewItem = {
  readonly id: string;
  readonly category: ContextPacketSourceCategory;
  readonly label: string;
  readonly reason: string;
  readonly preview?: string | undefined;
  readonly tokenEstimate?: number | undefined;
  readonly sourceCount?: number | undefined;
  readonly salience?: number | undefined;
  readonly includedInModel?: boolean | undefined;
  readonly badges?: readonly ContextPacketViewBadge[] | undefined;
  readonly provenance?: ContextPacketViewProvenance | undefined;
  readonly freshness?: ContextPacketViewFreshness | undefined;
  readonly confidence?: ContextPacketViewConfidence | undefined;
  readonly trustTier?: ContextPacketViewTrustTier | undefined;
  readonly rank?: ContextPacketViewRank | undefined;
  readonly conflictGroupId?: string | undefined;
  readonly actions?: readonly ContextPacketViewAction[] | undefined;
  readonly previewKind?: ContextPacketViewPreviewKind | undefined;
  readonly metadata?: ContextSourceMetadata | undefined;
};

export type ContextPacketWarningSeverity = "info" | "warning" | "error";

export type ContextPacketViewWarning = {
  readonly code: string;
  readonly message: string;
  readonly severity: ContextPacketWarningSeverity;
};

export type ContextPacketSourceCounts = {
  readonly included: number;
  readonly excluded: number;
  readonly warnings: number;
};

export type ContextPacketTokenEstimateState = "exact" | "estimated" | "unknown";

export type ContextPacketView = {
  readonly id: string;
  readonly version: 1;
  readonly generatedAt: string;
  readonly title: string;
  readonly included: readonly ContextPacketViewItem[];
  readonly excluded: readonly ContextPacketViewItem[];
  readonly warnings: readonly ContextPacketViewWarning[];
  readonly preview: readonly string[];
  readonly sourceCounts: ContextPacketSourceCounts;
  readonly tokenEstimate: number;
  readonly tokenEstimateState: ContextPacketTokenEstimateState;
};

export type CreateContextPacketViewInput = {
  readonly id: string;
  readonly generatedAt: string;
  readonly title?: string | undefined;
  readonly included: readonly ContextPacketViewItem[];
  readonly excluded: readonly ContextPacketViewItem[];
  readonly warnings: readonly ContextPacketViewWarning[];
  readonly preview: readonly string[];
  readonly tokenEstimateState?: ContextPacketTokenEstimateState | undefined;
};
