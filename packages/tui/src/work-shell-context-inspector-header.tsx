import type { ContextPacketView, ContextPacketViewActionReceipt } from "@unclecode/contracts";
import { Text } from "ink";
import React from "react";

import { truncateForDisplayWidth } from "./text-width.js";
import type {
  ContextInspectorPalette,
} from "./work-shell-context-inspector-model.js";
import { formatContextTokenEstimate } from "./work-shell-context-inspector-model.js";

export function computeContextMeterFill(tokenEstimate: number, modelWindow: number): number {
  const budgetCells = 10;
  const window = modelWindow > 0 ? modelWindow : 200_000;
  return Math.min(budgetCells, Math.max(0, Math.round((tokenEstimate / window) * budgetCells)));
}

export function computeContextOverlaySectionMaxRows(input: {
  readonly terminalRows?: number;
  readonly sourceCount?: number;
}): { readonly included: number; readonly held: number } {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  if (input.terminalRows !== undefined) {
    return {
      included: clamp(Math.round(input.terminalRows * 0.4), 4, 20),
      held: clamp(Math.round(input.terminalRows * 0.25), 3, 12),
    };
  }
  if (input.sourceCount !== undefined) {
    return {
      included: clamp(input.sourceCount, 4, 20),
      held: clamp(Math.round(input.sourceCount * 0.5), 3, 12),
    };
  }
  return { included: 12, held: 7 };
}

export function renderContextInspectorBudgetLine(input: {
  readonly packet: ContextPacketView;
  readonly palette: ContextInspectorPalette;
  readonly modelWindow: number;
}): React.ReactNode {
  const budgetCells = 10;
  const budgetWindow = input.modelWindow > 0 ? input.modelWindow : 200_000;
  const tokenEstimateState = input.packet.tokenEstimateState ?? "estimated";
  const filled = tokenEstimateState === "unknown" ? 0 : computeContextMeterFill(input.packet.tokenEstimate, budgetWindow);
  const meter = `${"●".repeat(filled)}${"·".repeat(Math.max(0, budgetCells - filled))}`;
  const windowLabel = budgetWindow >= 1_000_000
    ? `${(budgetWindow / 1_000_000).toFixed(1)}M`
    : `${Math.round(budgetWindow / 1000)}k`;
  const tokenLabel = formatContextTokenEstimate(input.packet.tokenEstimate, tokenEstimateState);
  return (
    <Text>
      <Text color={input.palette.success} bold>{"● "}</Text>
      <Text color={input.palette.text} bold>{"Sources"}</Text>
      <Text color={input.palette.textMuted}>{` · ${input.packet.sourceCounts.included} included · ${input.packet.sourceCounts.excluded} held back · ${input.packet.sourceCounts.warnings} warnings`}</Text>
      <Text color={input.palette.textMuted}>{"  budget "}</Text>
      <Text color={filled >= 8 ? input.palette.warning : input.palette.success} bold>{meter}</Text>
      <Text color={input.palette.textMuted}>{` · ${tokenLabel} / ${windowLabel}`}</Text>
    </Text>
  );
}

function formatReceiptPacketTransition(receipt: ContextPacketViewActionReceipt): string {
  if (receipt.beforePacketId && receipt.afterPacketId) {
    return `${receipt.beforePacketId} -> ${receipt.afterPacketId}`;
  }
  if (receipt.afterPacketId) {
    return `next ${receipt.afterPacketId}`;
  }
  return "packet proof pending";
}

export function renderContextInspectorReceipt(input: {
  readonly receipt?: ContextPacketViewActionReceipt | undefined;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  if (!input.receipt) {
    return null;
  }
  const transition = formatReceiptPacketTransition(input.receipt);
  const undo = input.receipt.canUndo ? "undo ready" : "undo unavailable";
  const body = truncateForDisplayWidth(
    `${transition} · ${undo} · ${input.receipt.message}`,
    Math.max(32, input.width - 12),
  );
  return (
    <Text>
      <Text color={input.palette.success} bold>{"Proof"}</Text>
      <Text color={input.palette.borderSoft}>{" · "}</Text>
      <Text color={input.palette.text}>{body}</Text>
    </Text>
  );
}
