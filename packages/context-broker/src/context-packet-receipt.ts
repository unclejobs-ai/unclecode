import type { ContextPacketView } from "@unclecode/contracts";

function formatReceiptCount(count: number, singular: string, plural: string): string {
  const safeCount = Math.max(0, Math.trunc(count));
  return `${safeCount} ${safeCount === 1 ? singular : plural}`;
}

function formatTokenReceipt(tokenEstimate: number): string {
  const safeEstimate = Math.max(0, Math.trunc(tokenEstimate));
  return safeEstimate > 0 ? ` · ~${safeEstimate}t` : "";
}

export function formatContextPacketUsedReceipt(packet: ContextPacketView): string {
  return `Context used · packet ${packet.id} · ${formatReceiptCount(
    packet.sourceCounts.included,
    "included",
    "included",
  )}${formatTokenReceipt(packet.tokenEstimate)} · ${formatReceiptCount(
    packet.sourceCounts.excluded,
    "held",
    "held",
  )} · ${formatReceiptCount(packet.sourceCounts.warnings, "warning", "warnings")}`;
}
