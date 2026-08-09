import type { WorkNodeStatus } from "./agent-console.js";

export const CONTEXT_SOURCE_COMPRESSION_METHODS = [
  "llm-summary",
  "recent-window",
  "masking",
] as const;

export type ContextSourceCompressionMethod = (typeof CONTEXT_SOURCE_COMPRESSION_METHODS)[number];

export type ContextSourceCompressionMetadata = {
  readonly method: ContextSourceCompressionMethod;
  readonly inputTokensEstimate: number;
  readonly outputTokensEstimate: number;
  readonly model?: string | undefined;
};

export type ContextSourceCondensedHistoryMetadata = {
  readonly kind: "condensed-history";
  readonly sourceEventIds: readonly string[];
  readonly sourceEventPreviews?: readonly string[] | undefined;
  readonly summary: string;
  readonly recomputeReason: string;
  readonly compactedEventCount: number;
  readonly recentEventCount: number;
  readonly compression: ContextSourceCompressionMetadata;
};

/**
 * Runbook work-node provenance for a context source. Carries the human `title`
 * and the graph `goal` it serves, the graph `constraints` it must respect, the
 * current `status`, and the acceptance/evidence trail — enough for the Context
 * Desk to explain *why* a work node is in the packet without reopening the work
 * graph.
 *
 * The node's raw executor prompt is deliberately absent: it is a private
 * instruction and must never travel into a context packet.
 */
export type ContextSourceWorkNodeMetadata = {
  readonly kind: "work-node";
  readonly graphId: string;
  readonly nodeId: string;
  readonly title: string;
  readonly goal?: string | undefined;
  readonly constraints: readonly string[];
  readonly status: WorkNodeStatus;
  readonly acceptanceCriteria: readonly string[];
  readonly evidenceRefs: readonly string[];
};

export type ContextSourceMetadata =
  | ContextSourceCondensedHistoryMetadata
  | ContextSourceWorkNodeMetadata;
