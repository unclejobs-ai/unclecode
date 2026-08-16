import {
  resolveContextDeskGroup,
  type ContextPacketViewBadge,
  type ContextPacketViewFreshness,
  type ContextPacketViewItem,
  type ContextPacketViewMetadata,
  type ContextPacketViewProvenance,
  type ContextPacketViewRank,
  type ContextPacketViewRankFactor,
  type ContextSourceCompressionMetadata,
  type ContextSourceMetadata,
} from "@unclecode/contracts";

/**
 * Nested projectors for the public packet boundary.
 *
 * Each one copies its contract fields by name. A spread here would carry
 * whatever the caller's stored record happens to hold — store handles, secrets,
 * absolute paths — straight into a serialized packet, so the allowlist is
 * spelled out and a new stored-only field has to be opted in.
 *
 * Optional properties stay *absent* rather than present-and-`undefined`, and
 * explicit `null`s (a cleared `expiresAt`) are preserved as written.
 */
function toPacketCompression(
  compression: ContextSourceCompressionMetadata,
): ContextSourceCompressionMetadata {
  return {
    method: compression.method,
    inputTokensEstimate: compression.inputTokensEstimate,
    outputTokensEstimate: compression.outputTokensEstimate,
    ...(compression.model === undefined ? {} : { model: compression.model }),
  };
}

function toPacketBadge(badge: ContextPacketViewBadge): ContextPacketViewBadge {
  return { label: badge.label, tone: badge.tone };
}

function toPacketProvenance(provenance: ContextPacketViewProvenance): ContextPacketViewProvenance {
  return {
    kind: provenance.kind,
    sourceId: provenance.sourceId,
    ...(provenance.uri === undefined ? {} : { uri: provenance.uri }),
    ...(provenance.scope === undefined ? {} : { scope: provenance.scope }),
    ...(provenance.providerId === undefined ? {} : { providerId: provenance.providerId }),
    ...(provenance.sha256 === undefined ? {} : { sha256: provenance.sha256 }),
  };
}

function toPacketFreshness(freshness: ContextPacketViewFreshness): ContextPacketViewFreshness {
  return {
    state: freshness.state,
    ...(freshness.updatedAt === undefined ? {} : { updatedAt: freshness.updatedAt }),
    ...(freshness.turnLastSeen === undefined ? {} : { turnLastSeen: freshness.turnLastSeen }),
    ...(freshness.expiresAt === undefined ? {} : { expiresAt: freshness.expiresAt }),
  };
}

function toPacketRankFactor(factor: ContextPacketViewRankFactor): ContextPacketViewRankFactor {
  return { label: factor.label, value: factor.value };
}

function toPacketRank(rank: ContextPacketViewRank): ContextPacketViewRank {
  return {
    score: rank.score,
    factors: rank.factors.map(toPacketRankFactor),
  };
}

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
        compression: toPacketCompression(metadata.compression),
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
    group: resolveContextDeskGroup(item.category),
    ...(item.preview === undefined ? {} : { preview: item.preview }),
    ...(item.tokenEstimate === undefined ? {} : { tokenEstimate: item.tokenEstimate }),
    ...(item.sourceCount === undefined ? {} : { sourceCount: item.sourceCount }),
    ...(item.salience === undefined ? {} : { salience: item.salience }),
    ...(item.includedInModel === undefined
      ? {}
      : { includedInModel: item.includedInModel }),
    ...(item.badges === undefined ? {} : { badges: item.badges.map(toPacketBadge) }),
    ...(item.provenance === undefined
      ? {}
      : { provenance: toPacketProvenance(item.provenance) }),
    ...(item.freshness === undefined
      ? {}
      : { freshness: toPacketFreshness(item.freshness) }),
    ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
    ...(item.trustTier === undefined ? {} : { trustTier: item.trustTier }),
    ...(item.rank === undefined ? {} : { rank: toPacketRank(item.rank) }),
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
