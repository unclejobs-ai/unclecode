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

export type ContextSourceMetadata = ContextSourceCondensedHistoryMetadata;
