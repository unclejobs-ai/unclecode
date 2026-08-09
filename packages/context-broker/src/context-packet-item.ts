import type {
  ContextPacketViewItem,
  ContextPacketViewMetadata,
  ContextSourceMetadata,
} from "@unclecode/contracts";

/**
 * Project stored source metadata into its packet-view form. Every field is
 * copied explicitly so the stored-only condensed-history `sourceEventPreviews`
 * (raw trace text) can never reach the view, and so a future stored-only field
 * has to be opted in rather than leaking by default.
 */
export function toContextPacketViewMetadata(
  metadata: ContextSourceMetadata,
): ContextPacketViewMetadata {
  switch (metadata.kind) {
    case "condensed-history":
      return {
        kind: "condensed-history",
        sourceEventIds: [...metadata.sourceEventIds],
        summary: metadata.summary,
        recomputeReason: metadata.recomputeReason,
        compactedEventCount: metadata.compactedEventCount,
        recentEventCount: metadata.recentEventCount,
        compression: { ...metadata.compression },
      };
    case "work-node":
      return {
        kind: "work-node",
        graphId: metadata.graphId,
        nodeId: metadata.nodeId,
        title: metadata.title,
        ...(metadata.goal === undefined ? {} : { goal: metadata.goal }),
        constraints: [...metadata.constraints],
        status: metadata.status,
        acceptanceCriteria: [...metadata.acceptanceCriteria],
        evidenceRefs: [...metadata.evidenceRefs],
      };
  }
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
      : { metadata: toContextPacketViewMetadata(item.metadata) }),
  };
}
