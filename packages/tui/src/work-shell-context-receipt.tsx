import type { ContextPacketReceipt, ContextPacketTokenEstimateState } from "@unclecode/contracts";
import { Box, Text } from "ink";
import React from "react";

import { truncateForDisplayWidth } from "./text-width.js";

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
  const memoryCount = receipt.sourceRefs.filter((source) => source.category === "memory").length;
  return [
    `ctx ${receipt.packetId}`,
    `${receipt.sourceCount} ${receipt.sourceCount === 1 ? "source" : "sources"}`,
    formatContextReceiptTokenEstimate(receipt),
    `${memoryCount} ${memoryCount === 1 ? "memory" : "memories"}`,
  ].join(" · ");
}

export function renderContextTurnReceipt(input: {
  readonly receipt: ContextPacketReceipt;
  readonly width: number;
  readonly expanded: boolean;
  readonly showPrimary?: boolean;
}): React.ReactNode {
  const width = Math.max(0, Math.trunc(input.width));
  const summary = truncateForDisplayWidth(formatContextTurnReceiptLine(input.receipt), width);
  const primary = truncateForDisplayWidth(
    `${input.receipt.state.toUpperCase()} ${input.receipt.packetId} ${input.receipt.turnId ?? "turn unknown"}`,
    width,
  );
  if (!input.expanded) {
    return input.showPrimary ? (
      <Box flexDirection="column">
        <Text color="gray" bold>{primary}</Text>
        <Text color="gray">{summary}</Text>
      </Box>
    ) : <Text color="gray">{summary}</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text color="gray">{summary}</Text>
      <Text color="gray">
        {truncateForDisplayWidth(
          `receipt ${input.receipt.id} · ${input.receipt.state} · ${input.receipt.tokenEstimateState}`,
          width,
        )}
      </Text>
      {input.receipt.sourceRefs.map((source) => (
        <Text key={`${input.receipt.id}:${source.sourceId}`} color="gray">
          {truncateForDisplayWidth([
            source.sourceId,
            source.category,
            source.sha256 ? "sha" : "sha missing",
            source.trustTier ?? "trust unknown",
            source.includedInModel ? "sent" : "held",
          ].join(" · "), width)}
        </Text>
      ))}
    </Box>
  );
}
