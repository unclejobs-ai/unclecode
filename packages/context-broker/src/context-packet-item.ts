import type {
  ContextPacketViewItem,
  ContextPacketViewMetadata,
  ContextSourceMetadata,
} from "@unclecode/contracts";

export function toContextPacketViewMetadata(
  metadata: ContextSourceMetadata,
): ContextPacketViewMetadata {
  return {
    kind: "condensed-history",
    sourceEventIds: [...metadata.sourceEventIds],
    summary: metadata.summary,
    recomputeReason: metadata.recomputeReason,
    compactedEventCount: metadata.compactedEventCount,
    recentEventCount: metadata.recentEventCount,
    compression: { ...metadata.compression },
  };
}

export function cloneContextPacketViewItem(item: ContextPacketViewItem): ContextPacketViewItem {
  return {
    id: item.id,
    category: item.category,
    label: item.label,
    reason: item.reason,
    ...(item.preview === undefined ? {} : { preview: item.preview }),
    ...(item.tokenEstimate === undefined ? {} : { tokenEstimate: item.tokenEstimate }),
    ...(item.sourceCount === undefined ? {} : { sourceCount: item.sourceCount }),
    ...(item.salience === undefined ? {} : { salience: item.salience }),
    ...(item.includedInModel === undefined
      ? {}
      : { includedInModel: item.includedInModel }),
    ...(item.badges === undefined
      ? {}
      : { badges: item.badges.map((badge) => ({ ...badge })) }),
    ...(item.provenance === undefined
      ? {}
      : { provenance: { ...item.provenance } }),
    ...(item.freshness === undefined
      ? {}
      : { freshness: { ...item.freshness } }),
    ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
    ...(item.trustTier === undefined ? {} : { trustTier: item.trustTier }),
    ...(item.rank === undefined
      ? {}
      : {
          rank: {
            ...item.rank,
            factors: item.rank.factors.map((factor) => ({ ...factor })),
          },
        }),
    ...(item.conflictGroupId === undefined
      ? {}
      : { conflictGroupId: item.conflictGroupId }),
    ...(item.actions === undefined ? {} : { actions: [...item.actions] }),
    ...(item.previewKind === undefined ? {} : { previewKind: item.previewKind }),
    ...(item.metadata === undefined
      ? {}
      : {
          metadata: {
            kind: "condensed-history",
            sourceEventIds: [...item.metadata.sourceEventIds],
            summary: item.metadata.summary,
            recomputeReason: item.metadata.recomputeReason,
            compactedEventCount: item.metadata.compactedEventCount,
            recentEventCount: item.metadata.recentEventCount,
            compression: { ...item.metadata.compression },
          },
        }),
  };
}
