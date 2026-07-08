import type { ContextPacketView } from "@unclecode/contracts";

import { truncateForDisplayWidth } from "./display-width.js";

function truncateIndicatorText(value: string, maxWidth = 18): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return truncateForDisplayWidth(normalized, maxWidth);
}

export function formatContextPacketIndicator(packet: ContextPacketView): string {
  const included = packet.sourceCounts.included;
  const held = packet.sourceCounts.excluded;
  const tokenSuffix = formatIndicatorTokenSuffix(packet);
  const pinnedCount = packet.included.reduce(
    (count, item) => count + ((item.salience ?? 0) >= 1 ? 1 : 0),
    0,
  );
  const staleCount = [...packet.included, ...packet.excluded].reduce(
    (count, item) => count + (item.freshness?.state === "stale" || item.freshness?.state === "expired" ? 1 : 0),
    0,
  );
  const headlineSource = packet.included[0];
  const headline = headlineSource
    ? `${truncateIndicatorText(headlineSource.label)}${included > 1 ? ` +${included - 1}` : ""}`
    : "no included sources";
  const heldSuffix = held > 0 ? ` · ${held} held` : "";
  const warningSuffix = packet.sourceCounts.warnings > 0 ? ` · ${packet.sourceCounts.warnings} warn` : "";
  const staleSuffix = staleCount > 0 ? ` · ${staleCount} stale` : "";
  const pinnedSuffix = pinnedCount > 0 ? ` · ${pinnedCount} pinned` : "";
  return `ctx: ${headline}${tokenSuffix}${heldSuffix}${warningSuffix}${staleSuffix}${pinnedSuffix}`;
}

function formatIndicatorTokenSuffix(packet: ContextPacketView): string {
  if (packet.tokenEstimateState === "unknown") {
    return " · tokens unknown";
  }
  if (packet.tokenEstimate >= 1000) {
    return packet.tokenEstimateState === "exact"
      ? ` · ${Math.round(packet.tokenEstimate / 1000)}k exact`
      : ` · ~${Math.round(packet.tokenEstimate / 1000)}k`;
  }
  if (packet.tokenEstimate > 0) {
    return packet.tokenEstimateState === "exact"
      ? ` · ${packet.tokenEstimate}t exact`
      : ` · ~${packet.tokenEstimate}t`;
  }
  return "";
}
