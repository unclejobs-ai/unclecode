import type {
  ContextPacketChangeClassification,
  ContextPacketReceiptSourceRef,
  ContextPacketView,
  ContextPacketViewItem,
} from "@unclecode/contracts";

function mapItemToSourceRef(item: ContextPacketViewItem): ContextPacketReceiptSourceRef {
  const ref: {
    sourceId: string;
    category: ContextPacketViewItem["category"];
    sha256?: string;
    trustTier?: ContextPacketViewItem["trustTier"];
    salience: number;
    includedInModel: boolean;
  } = {
    sourceId: item.id,
    category: item.category,
    salience: item.salience ?? 0.5,
    includedInModel: item.includedInModel ?? true,
  };

  const sha256 = item.provenance?.sha256;
  if (sha256 !== undefined) {
    ref.sha256 = sha256;
  }
  if (item.trustTier !== undefined) {
    ref.trustTier = item.trustTier;
  }
  return ref;
}

/**
 * Build ordered metadata-only source refs from a packet.
 * Never copies preview, reason, or content fields.
 */
export function buildContextPacketSourceRefs(
  packet: ContextPacketView,
): readonly ContextPacketReceiptSourceRef[] {
  return [...packet.included, ...packet.excluded].map(mapItemToSourceRef);
}

/**
 * Derive mandatory source ids from packet.manifest.policy.
 * Unmatched policy ids are retained so classification can fail closed.
 */
export function buildMandatorySourceIds(packet: ContextPacketView): ReadonlySet<string> {
  const mandatory = new Set<string>();
  for (const entry of packet.manifest?.policy ?? []) {
    if (entry.authority === "mandatory") {
      mandatory.add(entry.id);
    }
  }
  return mandatory;
}

export function classifyContextPacketChange(input: {
  readonly before: readonly ContextPacketReceiptSourceRef[];
  readonly after: readonly ContextPacketReceiptSourceRef[];
  readonly protectedSourceIds: ReadonlySet<string>;
  readonly mandatorySourceIds?: ReadonlySet<string>;
}): ContextPacketChangeClassification {
  const beforeIncluded = input.before.filter((ref) => ref.includedInModel);
  const afterIncluded = input.after.filter((ref) => ref.includedInModel);
  const beforeById = new Map(beforeIncluded.map((ref) => [ref.sourceId, ref]));
  const afterById = new Map(afterIncluded.map((ref) => [ref.sourceId, ref]));
  const removed = [...beforeById.keys()].filter((id) => !afterById.has(id)).sort();
  const added = [...afterById.keys()].filter((id) => !beforeById.has(id)).sort();
  const changedSha = [...beforeById.keys()].filter((id) => {
    const before = beforeById.get(id);
    const after = afterById.get(id);
    return after !== undefined && before?.sha256 !== after.sha256;
  }).sort();
  const protectedRemoved = removed.filter((id) => input.protectedSourceIds.has(id));
  if (protectedRemoved.length > 0) {
    return {
      kind: "meaning-change",
      removedSourceIds: removed,
      addedSourceIds: added,
      protectedSourceIds: protectedRemoved,
      reason: "A pinned or explicitly included source disappeared.",
    };
  }
  if (removed.length === 0 && added.length === 0 && changedSha.length === 0) {
    return {
      kind: "unchanged",
      removedSourceIds: [],
      addedSourceIds: [],
      protectedSourceIds: [],
      reason: "Packet source selection is unchanged.",
    };
  }
  const mandatory = input.mandatorySourceIds ?? new Set<string>();
  const presentIds = new Set([...beforeById.keys(), ...afterById.keys()]);
  const hasUnmatchedMandatoryPolicy = [...mandatory].some((id) => !presentIds.has(id));
  const safetyCandidates = [...added, ...changedSha];
  const safetyOnly = removed.length === 0
    && safetyCandidates.length > 0
    && safetyCandidates.every((id) => mandatory.has(id))
    && !hasUnmatchedMandatoryPolicy;
  return {
    kind: safetyOnly ? "safety-refresh" : "meaning-change",
    removedSourceIds: removed,
    addedSourceIds: added,
    protectedSourceIds: [],
    reason: safetyOnly ? "Mandatory guidance was refreshed." : "The selected source set changed.",
  };
}
