import type {
  ContextPacketChangeClassification,
  ContextPacketReceipt,
  ContextPacketView,
  ContextPacketViewActionReceipt,
} from "@unclecode/contracts";
import { Text } from "ink";
import React from "react";

import { truncateForDisplayWidth } from "./text-width.js";
import type {
  ContextInspectorPalette,
} from "./work-shell-context-inspector-model.js";
import { formatContextTokenEstimate } from "./work-shell-context-inspector-model.js";
import { formatContextReceiptTokenEstimate } from "./work-shell-context-receipt.js";

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

function formatContextWindow(modelWindow: number): string {
  const safeWindow = Math.max(0, Math.trunc(modelWindow));
  if (safeWindow < 1_000) {
    return String(safeWindow);
  }
  const thousands = safeWindow / 1_000;
  return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1)}k`;
}

export function formatContextInspectorPacketProofLines(input: {
  readonly packet: ContextPacketView;
  readonly previewReceipt?: ContextPacketReceipt | undefined;
  readonly submittedReceipt?: ContextPacketReceipt | undefined;
  readonly packetChange?: ContextPacketChangeClassification | undefined;
  readonly modelWindow: number;
  readonly width: number;
}): readonly string[] {
  if (input.packetChange?.kind === "meaning-change") {
    const beforePacketId = input.previewReceipt?.packetId
      ?? input.submittedReceipt?.packetId
      ?? "unknown";
    return [
      truncateForDisplayWidth(
        `PACKET CHANGED ${beforePacketId} -> ${input.packet.id}`,
        input.width,
      ),
      truncateForDisplayWidth(
        `Review required · ${input.packetChange.reason}`,
        input.width,
      ),
    ];
  }

  if (input.previewReceipt?.state === "previewed") {
    const estimate = formatContextReceiptTokenEstimate(input.previewReceipt);
    return [truncateForDisplayWidth(
      `NEXT REQUEST ${input.previewReceipt.packetId} previewed ${estimate} / ${formatContextWindow(input.modelWindow)}`,
      input.width,
    )];
  }

  if (input.submittedReceipt?.state === "submitted") {
    return [truncateForDisplayWidth(
      `SUBMITTED ${input.submittedReceipt.packetId} ${input.submittedReceipt.turnId ?? "turn unknown"}`,
      input.width,
    )];
  }

  return [];
}

export function renderContextInspectorPacketProof(input: {
  readonly packet: ContextPacketView;
  readonly previewReceipt?: ContextPacketReceipt | undefined;
  readonly submittedReceipt?: ContextPacketReceipt | undefined;
  readonly packetChange?: ContextPacketChangeClassification | undefined;
  readonly modelWindow: number;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const lines = formatContextInspectorPacketProofLines(input);
  if (lines.length === 0) {
    return null;
  }
  return (
    <>
      {lines.map((line, index) => (
        <Text
          key={`${index}:${line}`}
          color={input.packetChange?.kind === "meaning-change" ? input.palette.warning : input.palette.textMuted}
          bold={index === 0}
        >
          {line}
        </Text>
      ))}
    </>
  );
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

export function renderContextInspectorManifestLine(input: {
  readonly packet: ContextPacketView;
  readonly palette: ContextInspectorPalette;
  readonly width: number;
}): React.ReactNode {
  const manifest = input.packet.manifest;
  if (!manifest) {
    return null;
  }
  const policyLabel = `${manifest.policy.length} policy ${manifest.policy.length === 1 ? "source" : "sources"}`;
  const body = truncateForDisplayWidth(
    `${manifest.profileId} · ${policyLabel} · ${manifest.id}`,
    Math.max(24, input.width - 10),
  );
  return (
    <Text>
      <Text color={input.palette.assistant} bold>{"Prompt"}</Text>
      <Text color={input.palette.borderSoft}>{" · "}</Text>
      <Text color={input.palette.textMuted}>{body}</Text>
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

export function formatContextInspectorActionReceiptLine(
  receipt: ContextPacketViewActionReceipt | undefined,
  width: number,
): string | undefined {
  if (!receipt) {
    return undefined;
  }
  const transition = formatReceiptPacketTransition(receipt);
  const undo = receipt.canUndo ? "undo ready" : "undo unavailable";
  return truncateForDisplayWidth(
    `Proof · ${transition} · ${undo} · ${receipt.message}`,
    Math.max(1, width),
  );
}

export function renderContextInspectorReceipt(input: {
  readonly receipt?: ContextPacketViewActionReceipt | undefined;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const line = formatContextInspectorActionReceiptLine(input.receipt, input.width);
  return line ? <Text color={input.palette.success} bold>{line}</Text> : null;
}
