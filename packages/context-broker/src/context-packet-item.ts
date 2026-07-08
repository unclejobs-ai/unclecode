import type { ContextPacketViewItem, ContextSourceMetadata } from "@unclecode/contracts";

function cloneContextSourceMetadata(metadata: ContextSourceMetadata): ContextSourceMetadata {
  switch (metadata.kind) {
    case "condensed-history":
      return {
        kind: "condensed-history",
        sourceEventIds: [...metadata.sourceEventIds],
        ...(metadata.sourceEventPreviews === undefined
          ? {}
          : { sourceEventPreviews: [...metadata.sourceEventPreviews] }),
        summary: metadata.summary,
        recomputeReason: metadata.recomputeReason,
        compactedEventCount: metadata.compactedEventCount,
        recentEventCount: metadata.recentEventCount,
        compression: { ...metadata.compression },
      };
  }
}

export function cloneContextPacketViewItem(item: ContextPacketViewItem): ContextPacketViewItem {
  const badges = item.badges?.map((badge) => ({ ...badge }));
  const provenance = item.provenance ? { ...item.provenance } : undefined;
  const freshness = item.freshness ? { ...item.freshness } : undefined;
  const rank = item.rank
    ? {
        ...item.rank,
        factors: item.rank.factors.map((factor) => ({ ...factor })),
      }
    : undefined;
  const actions = item.actions ? [...item.actions] : undefined;
  const metadata = item.metadata ? cloneContextSourceMetadata(item.metadata) : undefined;
  return {
    ...item,
    ...(badges ? { badges } : {}),
    ...(provenance ? { provenance } : {}),
    ...(freshness ? { freshness } : {}),
    ...(rank ? { rank } : {}),
    ...(actions ? { actions } : {}),
    ...(metadata ? { metadata } : {}),
  };
}
