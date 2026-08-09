import type {
  ContextPacketChangeClassification,
  ContextPacketReceipt,
  ContextPacketReceiptState,
  ContextPacketSourceCategory,
  ContextPacketTokenEstimateState,
} from "@unclecode/contracts";
import { Box, Text } from "ink";
import React from "react";

import { truncateForDisplayWidth } from "./text-width.js";
import type { ContextInspectorPalette } from "./work-shell-context-inspector-model.js";

function formatCompactCount(value: number): string {
  if (value < 1_000) {
    return String(Math.max(0, Math.trunc(value)));
  }
  const thousands = (value / 1_000).toFixed(1).replace(/\.0$/, "");
  return `${thousands}k`;
}

export function formatContextReceiptTokenEstimate(input: {
  readonly tokenEstimate?: number | undefined;
  readonly tokenEstimateState: ContextPacketTokenEstimateState;
}): string {
  if (input.tokenEstimateState === "unknown" || input.tokenEstimate === undefined) {
    return "unknown";
  }
  const estimate = formatCompactCount(input.tokenEstimate);
  return input.tokenEstimateState === "exact" ? estimate : `~${estimate}`;
}

export function formatContextTurnReceiptLine(receipt: ContextPacketReceipt): string {
  const heldCount = receipt.sourceRefs.filter((source) => !source.includedInModel).length;
  const sentCount = receipt.sourceRefs.length - heldCount;
  const tokenEstimate = formatContextReceiptTokenEstimate(receipt);
  return [
    "▤ Context proof",
    `${sentCount} sent`,
    `${heldCount} held`,
    tokenEstimate === "unknown" ? "tokens unknown" : `${tokenEstimate} tok`,
  ].join(" · ");
}

export function formatContextReceiptCategoryLine(receipt: ContextPacketReceipt): string {
  const categoryCounts: Record<string, number> = {};
  for (const source of receipt.sourceRefs) {
    if (!source.includedInModel) {
      continue;
    }
    const label = formatContextReceiptCategory(source.category);
    categoryCounts[label] = (categoryCounts[label] ?? 0) + 1;
  }
  return Object.entries(categoryCounts)
    .map(([label, count]) => `${label} ${count}`)
    .join(" · ");
}
function formatContextReceiptCategory(category: ContextPacketSourceCategory): string {
  switch (category) {
    case "workspace-guidance":
    case "provider-system-prompt":
    case "system":
      return "Guidance";
    case "workspace":
      return "Workspace";
    case "loop-trail":
    case "condensed-history":
    case "bridge":
      return "History";
    case "runtime":
      return "Runtime";
    case "memory":
      return "Memory";
    case "attachment":
      return "Files";
    case "user":
      return "Request";
  }
}

function formatContextReceiptAlertLine(
  receipt: ContextPacketReceipt,
  change: ContextPacketChangeClassification | undefined,
): string | null {
  const alerts: string[] = [];
  const heldCount = receipt.sourceRefs.filter((source) => !source.includedInModel).length;
  if (heldCount > 0) {
    alerts.push(`! ${heldCount} held · /context to inspect`);
  }
  if (receipt.state === "invalidated") {
    alerts.push("! receipt invalidated");
  }
  if (change && change.kind !== "unchanged") {
    const changedCount = change.addedSourceIds.length + change.removedSourceIds.length;
    const changeKind = change.kind.replaceAll("-", " ");
    alerts.push(changedCount > 0
      ? `Δ ${changedCount} ${changedCount === 1 ? "source" : "sources"} changed · ${changeKind}`
      : `Δ ${changeKind}`);
  }
  return alerts.length > 0 ? alerts.join(" · ") : null;
}

const RECEIPT_STATE_LABELS: Readonly<Record<ContextPacketReceiptState, string>> = {
  previewed: "Previewed",
  submitted: "Sent",
  invalidated: "Invalidated",
};

/**
 * Expanded receipt proof, stated in what a reader can act on: lifecycle state,
 * budget, and how much of the packet is hash-verified. The receipt id, packet
 * id and per-source ids used to be printed here; none of them meant anything
 * to the person reading the screen.
 */
export function formatContextReceiptStateLine(receipt: ContextPacketReceipt): string {
  const verified = receipt.sourceRefs.filter((source) => source.sha256).length;
  const estimate = formatContextReceiptTokenEstimate(receipt);
  const budget = estimate === "unknown"
    ? "tokens unknown"
    : `${estimate} ${receipt.tokenEstimateState}`;
  return [
    RECEIPT_STATE_LABELS[receipt.state],
    budget,
    `${verified}/${receipt.sourceRefs.length} verified`,
  ].join(" · ");
}

export function formatContextReceiptCategoryDetailLines(
  receipt: ContextPacketReceipt,
): readonly string[] {
  const groups = new Map<string, { sent: number; held: number; verified: number }>();
  for (const source of receipt.sourceRefs) {
    const label = formatContextReceiptCategory(source.category);
    const group = groups.get(label) ?? { sent: 0, held: 0, verified: 0 };
    if (source.includedInModel) {
      group.sent += 1;
    } else {
      group.held += 1;
    }
    if (source.sha256) {
      group.verified += 1;
    }
    groups.set(label, group);
  }
  return [...groups].map(([label, group]) => [
    label,
    `${group.sent} sent`,
    ...(group.held > 0 ? [`${group.held} held`] : []),
    `${group.verified}/${group.sent + group.held} verified`,
  ].join(" · "));
}

/**
 * Terminal-default fallbacks, used only when a caller renders the receipt
 * outside the work shell. Inside the shell the active palette is passed in:
 * this block used to hardcode cyan/gray/yellow and was the one element on the
 * screen that ignored dark/light detection entirely.
 */
const FALLBACK_RECEIPT_PALETTE = {
  heading: "cyan",
  muted: "gray",
  alert: "yellow",
} as const;

function resolveReceiptColors(palette: ContextInspectorPalette | undefined): {
  readonly heading: string;
  readonly muted: string;
  readonly alert: string;
} {
  if (!palette) return FALLBACK_RECEIPT_PALETTE;
  return { heading: palette.toolAccent, muted: palette.textMuted, alert: palette.warning };
}

export function renderContextTurnReceipt(input: {
  readonly receipt: ContextPacketReceipt;
  readonly change?: ContextPacketChangeClassification | undefined;
  readonly width: number;
  readonly expanded: boolean;
  readonly showPrimary?: boolean;
  readonly palette?: ContextInspectorPalette | undefined;
}): React.ReactNode {
  const width = Math.max(0, Math.trunc(input.width));
  const colors = resolveReceiptColors(input.palette);
  const summary = truncateForDisplayWidth(formatContextTurnReceiptLine(input.receipt), width);
  const categories = truncateForDisplayWidth(formatContextReceiptCategoryLine(input.receipt), width);
  const alert = formatContextReceiptAlertLine(input.receipt, input.change);
  if (!input.expanded) {
    return input.showPrimary ? (
      <Box flexDirection="column">
        <Text color={colors.heading} bold>{summary}</Text>
        {categories ? <Text color={colors.muted}>{categories}</Text> : null}
        {alert ? <Text color={colors.alert}>{truncateForDisplayWidth(alert, width)}</Text> : null}
      </Box>
    ) : <Text color={colors.muted}>{summary}</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text color={colors.muted}>{summary}</Text>
      <Text color={colors.muted}>
        {truncateForDisplayWidth(formatContextReceiptStateLine(input.receipt), width)}
      </Text>
      {formatContextReceiptCategoryDetailLines(input.receipt).map((line) => (
        <Text key={line} color={colors.muted}>
          {truncateForDisplayWidth(line, width)}
        </Text>
      ))}
    </Box>
  );
}
