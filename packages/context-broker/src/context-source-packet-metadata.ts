import type {
  ContextPacketViewAction,
  ContextPacketViewBadge,
  ContextPacketViewConfidence,
  ContextPacketViewFreshness,
  ContextPacketViewItem,
  ContextPacketViewProvenance,
  ContextPacketViewProvenanceKind,
  ContextPacketViewProvenanceScope,
  ContextPacketViewRank,
  ContextPacketViewTrustTier,
  ContextSourceCategory,
  ContextSourceRecord,
} from "@unclecode/contracts";

export type ContextSourcePacketMetadata = Pick<
  ContextPacketViewItem,
  "actions" | "badges" | "confidence" | "freshness" | "previewKind" | "provenance" | "rank" | "trustTier"
>;

function contextSourceProvenanceKind(category: ContextSourceCategory): ContextPacketViewProvenanceKind {
  switch (category) {
    case "workspace":
      return "workspace";
    case "workspace-guidance":
      return "guidance";
    case "bridge":
      return "bridge";
    case "loop-trail":
      return "loop-trail";
    case "condensed-history":
      return "condensed-history";
    case "memory":
      return "memory";
    case "runtime":
      return "runtime";
    case "attachment":
      return "attachment";
    case "system":
      return "system";
  }
}

function contextSourceProvenanceScope(category: ContextSourceCategory): ContextPacketViewProvenanceScope {
  switch (category) {
    case "workspace":
    case "workspace-guidance":
    case "bridge":
      return "project";
    case "memory":
      return "user";
    case "loop-trail":
    case "condensed-history":
    case "runtime":
    case "attachment":
      return "runtime";
    case "system":
      return "system";
  }
}

function contextSourceTrustTier(category: ContextSourceCategory): ContextPacketViewTrustTier {
  switch (category) {
    case "workspace":
    case "workspace-guidance":
    case "bridge":
      return "project";
    case "memory":
      return "user";
    case "loop-trail":
    case "condensed-history":
    case "runtime":
    case "attachment":
      return "runtime";
    case "system":
      return "builtin";
  }
}

function contextSourceConfidence(src: ContextSourceRecord): ContextPacketViewConfidence {
  if (src.sha256 !== null || src.salience >= 1) {
    return "high";
  }
  if (src.turnLastSeen !== null || src.salience >= 0.5) {
    return "medium";
  }
  return "unknown";
}

function contextSourceFreshness(
  src: ContextSourceRecord,
  input: { readonly turnIndex?: number } = {},
): ContextPacketViewFreshness {
  const expiresAt = src.expiresAt !== null ? { expiresAt: src.expiresAt } : {};
  const expired = src.expiresAt !== null && Date.parse(src.expiresAt) <= Date.now();
  if (expired) {
    return {
      state: "expired",
      updatedAt: src.updatedAt,
      turnLastSeen: src.turnLastSeen,
      ...expiresAt,
    };
  }
  if (input.turnIndex === undefined || src.turnLastSeen === null) {
    return {
      state: "unknown",
      updatedAt: src.updatedAt,
      turnLastSeen: src.turnLastSeen,
      ...expiresAt,
    };
  }
  return {
    state: input.turnIndex - src.turnLastSeen <= 2 ? "fresh" : "stale",
    updatedAt: src.updatedAt,
    turnLastSeen: src.turnLastSeen,
    ...expiresAt,
  };
}

function contextSourceRank(src: ContextSourceRecord): ContextPacketViewRank {
  const factors = [
    { label: "salience", value: src.salience.toFixed(2) },
    ...(src.turnLastSeen !== null ? [{ label: "last seen", value: `turn ${src.turnLastSeen}` }] : []),
    ...(src.salience >= 1 ? [{ label: "pinned", value: "yes" }] : []),
  ];
  return { score: src.salience, factors };
}

function contextSourceProvenance(src: ContextSourceRecord): ContextPacketViewProvenance {
  return {
    kind: contextSourceProvenanceKind(src.category),
    sourceId: src.id,
    uri: `context://${src.projectId}/${src.id}`,
    scope: contextSourceProvenanceScope(src.category),
    providerId: `crp:${src.category}`,
    ...(src.sha256 !== null ? { sha256: src.sha256 } : {}),
  };
}

function badgeToneForFreshness(state: ContextPacketViewFreshness["state"]): ContextPacketViewBadge["tone"] {
  switch (state) {
    case "fresh":
      return "success";
    case "stale":
    case "expired":
      return "warning";
    case "unknown":
      return "muted";
  }
}

function badgeToneForRank(score: number): ContextPacketViewBadge["tone"] {
  if (score >= 1) {
    return "success";
  }
  if (score >= 0.7) {
    return "info";
  }
  return "muted";
}

function uniqueContextSourceBadges(badges: readonly ContextPacketViewBadge[]): readonly ContextPacketViewBadge[] {
  const seen = new Set<string>();
  return badges.filter((badge) => {
    const key = `${badge.label}\0${badge.tone}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function contextSourceBadges(input: {
  readonly src: ContextSourceRecord;
  readonly freshness: ContextPacketViewFreshness;
  readonly trustTier: ContextPacketViewTrustTier;
  readonly rank: ContextPacketViewRank;
}): readonly ContextPacketViewBadge[] {
  const hashBadges: readonly ContextPacketViewBadge[] = input.src.sha256 !== null
    ? [{ label: "hashed", tone: "muted" }]
    : [];
  return uniqueContextSourceBadges([
    ...(input.src.badges ?? []),
    { label: input.trustTier, tone: "info" },
    { label: input.freshness.state, tone: badgeToneForFreshness(input.freshness.state) },
    { label: `rank ${input.rank.score.toFixed(2)}`, tone: badgeToneForRank(input.rank.score) },
    ...hashBadges,
  ]);
}

function contextSourceActions(input: {
  readonly src: ContextSourceRecord;
  readonly freshness: ContextPacketViewFreshness;
}): readonly ContextPacketViewAction[] {
  const previewAction: ContextPacketViewAction = "preview";
  const primary: ContextPacketViewAction[] = [];
  if (!input.src.includedInModel) {
    const includeAction: ContextPacketViewAction = "include";
    primary.push(includeAction, previewAction);
  } else if (input.src.salience >= 1) {
    const unpinAction: ContextPacketViewAction = "unpin";
    const holdBackAction: ContextPacketViewAction = "hold-back";
    primary.push(unpinAction, holdBackAction, previewAction);
  } else {
    const pinAction: ContextPacketViewAction = "pin";
    const holdBackAction: ContextPacketViewAction = "hold-back";
    primary.push(pinAction, holdBackAction, previewAction);
  }
  const refreshAction: ContextPacketViewAction = "refresh";
  return input.freshness.state === "stale" || input.freshness.state === "expired"
    ? [...primary, refreshAction]
    : primary;
}

export function buildContextSourcePacketMetadata(
  src: ContextSourceRecord,
  input: { readonly turnIndex?: number } = {},
): ContextSourcePacketMetadata {
  const freshness = contextSourceFreshness(src, input);
  const rank = contextSourceRank(src);
  const trustTier = contextSourceTrustTier(src.category);
  return {
    provenance: contextSourceProvenance(src),
    freshness,
    confidence: contextSourceConfidence(src),
    trustTier,
    rank,
    actions: contextSourceActions({ src, freshness }),
    previewKind: src.content !== null ? "excerpt" : "summary",
    badges: contextSourceBadges({ src, freshness, trustTier, rank }),
  };
}
