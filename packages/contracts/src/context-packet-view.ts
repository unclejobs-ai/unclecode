import type { PersistedPromptManifest } from "./agent-console.js";
import type { ContextProviderManifest } from "./context-source.js";
import type {
  ContextSourceCompressionMetadata,
  ContextSourceWorkNodeMetadata,
} from "./context-source-metadata.js";

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

/**
 * Context Desk — the canonical object model behind the three-pane
 * Groups → Sources → Preview surface.
 *
 * Every string the desk navigates lives here exactly once: the engine and the
 * TUI read these constants instead of carrying their own category maps, so a
 * new packet category cannot silently land in two different buckets.
 */
export const CONTEXT_DESK_PANES = ["groups", "sources", "preview"] as const;
export type ContextDeskPane = (typeof CONTEXT_DESK_PANES)[number];

/**
 * Shape guard for the descriptor table below. It exists only so the table can
 * be checked without depending on `ContextDeskGroupId`, which is derived *from*
 * the table — the descriptor type consumers use is
 * `ContextDeskGroupDescriptor`, declared right after.
 */
type ContextDeskGroupEntry = {
  readonly id: string;
  readonly label: string;
  readonly categories: readonly ContextPacketSourceCategory[];
};

/**
 * The one source of truth for desk grouping: ids, labels, order and category
 * ownership. `other` is the unknown-category fallback only, so it deliberately
 * claims no category; every canonical category is claimed exactly once above it.
 */
export const CONTEXT_DESK_GROUPS = [
  {
    id: "guidance",
    label: "Guidance",
    categories: ["workspace", "workspace-guidance", "provider-system-prompt", "system"],
  },
  {
    id: "conversation",
    label: "Conversation",
    categories: ["bridge", "condensed-history", "user"],
  },
  { id: "memory", label: "Memory", categories: ["memory"] },
  { id: "tools", label: "Tools", categories: ["loop-trail", "runtime"] },
  { id: "attachments", label: "Attachments", categories: ["attachment"] },
  { id: "other", label: "Other", categories: [] },
] as const satisfies readonly ContextDeskGroupEntry[];

export type ContextDeskGroupId = (typeof CONTEXT_DESK_GROUPS)[number]["id"];

export type ContextDeskGroupDescriptor = {
  readonly id: ContextDeskGroupId;
  readonly label: string;
  readonly categories: readonly ContextPacketSourceCategory[];
};

export type ContextDeskCollection = ContextDeskGroupId | "all" | "sent" | "held";

/**
 * The Sources pane filters by collection: the whole packet, then every group
 * in canonical order, then the two delivery buckets. The middle segment is
 * spread from the descriptor table so the two orders cannot drift apart.
 */
export const CONTEXT_DESK_COLLECTIONS: readonly ContextDeskCollection[] = [
  "all",
  ...CONTEXT_DESK_GROUPS.map((group) => group.id),
  "sent",
  "held",
];

/**
 * A `Map`, not an object literal: the keys are derived from the descriptor
 * table above rather than written out a second time, and the lookup key is an
 * arbitrary runtime string — an object index would resolve `"constructor"` or
 * `"toString"` to something off `Object.prototype` instead of falling back.
 */
const CONTEXT_DESK_GROUP_BY_CATEGORY: ReadonlyMap<string, ContextDeskGroupId> = new Map(
  // The callback parameter is annotated so `categories` widens to a single
  // array type: without it, `group` is a union of six literal entry types and
  // `.map` over a union of tuple types has no callable signature.
  CONTEXT_DESK_GROUPS.flatMap((group: ContextDeskGroupDescriptor) =>
    group.categories.map((category): readonly [string, ContextDeskGroupId] => [category, group.id]),
  ),
);

/**
 * Resolve any category string to its desk group. This takes `string` rather
 * than `ContextPacketSourceCategory` on purpose: a packet can carry a category
 * from an older schema or a third-party provider, and those must land in
 * `other` instead of leaving a source unreachable from the Groups pane.
 */
export function resolveContextDeskGroup(category: string): ContextDeskGroupId {
  return CONTEXT_DESK_GROUP_BY_CATEGORY.get(category) ?? "other";
}

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
  readonly succeeded: boolean;
  readonly canUndo: boolean;
  readonly beforePacketId?: string | undefined;
  readonly afterPacketId?: string | undefined;
  readonly before?: ContextPacketViewSourceState | undefined;
  readonly after?: ContextPacketViewSourceState | undefined;
};

export type ContextPacketViewPreviewKind = "summary" | "excerpt" | "full" | "redacted";

export type ContextPacketViewCondensedHistoryMetadata = {
  readonly kind: "condensed-history";
  readonly sourceEventIds: readonly string[];
  readonly summary: string;
  readonly recomputeReason: string;
  readonly compactedEventCount: number;
  readonly recentEventCount: number;
  readonly compression: ContextSourceCompressionMetadata;
};

/**
 * Work-node metadata is identical on both sides of the projection. Unlike
 * condensed history — which keeps raw `sourceEventPreviews` out of the view —
 * a work node has no stored-only field to strip, so the shape is shared
 * instead of duplicated and cannot drift.
 */
export type ContextPacketViewWorkNodeMetadata = ContextSourceWorkNodeMetadata;

export type ContextPacketViewMetadata =
  | ContextPacketViewCondensedHistoryMetadata
  | ContextPacketViewWorkNodeMetadata;

export type ContextPacketViewItem = {
  readonly id: string;
  readonly category: ContextPacketSourceCategory;
  readonly label: string;
  readonly reason: string;
  /**
   * The desk group this item belongs to. Derived from `category` at the packet
   * source boundary and carried on the item so the Groups pane never has to
   * re-derive it per render. Optional because hand-built items (tests, synthetic
   * summaries) may omit it; use `resolveContextDeskGroup(item.category)` then.
   */
  readonly group?: ContextDeskGroupId | undefined;
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
  readonly metadata?: ContextPacketViewMetadata | undefined;
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

/**
 * The provider registry as projected onto a packet. Manifest fields only —
 * never the live provider objects — so the packet stays serializable and no
 * provider internals reach the view.
 */
export type ContextPacketViewRegistry = {
  readonly providers: readonly ContextProviderManifest[];
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
  readonly manifest?: PersistedPromptManifest | undefined;
  readonly registry?: ContextPacketViewRegistry | undefined;
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
  readonly manifest?: PersistedPromptManifest | undefined;
  readonly registry?: ContextPacketViewRegistry | undefined;
};
