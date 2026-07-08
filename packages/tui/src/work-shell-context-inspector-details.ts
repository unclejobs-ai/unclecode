import type { ContextPacketViewItem, ContextSourceMetadata } from "@unclecode/contracts";

export function sanitizeContextPreview(value: string): string {
  return value
    .replace(/\.omo\/[^\s)]+/g, "session loop trail")
    .replace(/\.omo\b/g, "session storage")
    .replace(/\s+/gu, " ")
    .trim();
}

export function formatContextItemBadgeSummary(item: ContextPacketViewItem): string {
  const badges = item.badges ?? [];
  return badges.map((badge) => `[${badge.label}]`).join(" ");
}

export function getContextItemPreview(item: ContextPacketViewItem): string {
  const preview = item.preview?.trim();
  const badgeSummary = formatContextItemBadgeSummary(item);
  const badgeSuffix = badgeSummary.length > 0 ? ` · ${badgeSummary}` : "";
  if (preview && preview.length > 0) {
    return sanitizeContextPreview(`${preview}${badgeSuffix}`);
  }
  const reason = item.reason.trim();
  return sanitizeContextPreview(`${reason.length > 0 ? reason : item.label}${badgeSuffix}`);
}

function formatTraceIdPreview(sourceEventIds: readonly string[]): string {
  const visible = sourceEventIds.slice(0, 4).join(", ");
  const hiddenCount = sourceEventIds.length - Math.min(sourceEventIds.length, 4);
  return hiddenCount > 0 ? `${visible}, +${hiddenCount} more` : visible;
}

function getCondensedHistoryWarningLine(item: ContextPacketViewItem): string | undefined {
  const state = item.freshness?.state;
  if (state !== "stale" && state !== "expired") {
    return undefined;
  }
  const turnLastSeen = item.freshness?.turnLastSeen;
  const turnSuffix = typeof turnLastSeen === "number" ? ` · last seen turn ${turnLastSeen}` : "";
  return `Warning · compressed summary is ${state}; refresh before relying on it${turnSuffix}`;
}

function getCondensedHistoryRawPreviewLines(
  metadata: Extract<ContextSourceMetadata, { readonly kind: "condensed-history" }>,
): readonly string[] {
  const previews = metadata.sourceEventPreviews ?? [];
  const lines: string[] = [];
  for (let index = 0; index < previews.length; index += 1) {
    const preview = previews[index];
    if (preview === undefined) continue;
    const sanitized = sanitizeContextPreview(preview);
    lines.push(
      index === 0
        ? `Raw preview · ${previews.length} compacted trace lines · ${sanitized}`
        : `  ${index + 1}. ${sanitized}`,
    );
  }
  return lines;
}

function getCondensedHistoryDetailLines(
  item: ContextPacketViewItem,
  metadata: Extract<ContextSourceMetadata, { readonly kind: "condensed-history" }>,
): readonly string[] {
  const modelSuffix = metadata.compression.model === undefined ? "" : ` · ${metadata.compression.model}`;
  const warningLine = getCondensedHistoryWarningLine(item);
  return [
    ...(warningLine === undefined ? [] : [warningLine]),
    `Compression · ${metadata.compression.method}${modelSuffix} · ${metadata.compactedEventCount} compacted · ${metadata.recentEventCount} recent kept · ~${metadata.compression.inputTokensEstimate}t in / ~${metadata.compression.outputTokensEstimate}t out`,
    `Summary · ${metadata.summary}`,
    `Reason · ${metadata.recomputeReason}`,
    `Provenance · ${metadata.sourceEventIds.length} trace ids · ${formatTraceIdPreview(metadata.sourceEventIds)}`,
    ...getCondensedHistoryRawPreviewLines(metadata),
  ];
}

function getMetadataDetailLines(item: ContextPacketViewItem, metadata: ContextSourceMetadata): readonly string[] {
  return getCondensedHistoryDetailLines(item, metadata);
}

export function getContextItemDetailLines(item: ContextPacketViewItem): readonly string[] {
  return [
    getContextItemPreview(item),
    ...(item.metadata === undefined ? [] : getMetadataDetailLines(item, item.metadata)),
  ];
}
