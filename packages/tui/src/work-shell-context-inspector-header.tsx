import type {
  ContextPacketChangeClassification,
  ContextPacketReceipt,
  ContextPacketView,
  ContextPacketViewAction,
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

/**
 * The lifecycle headline for the packet. Packet ids, receipt ids and turn ids
 * used to be the whole message here; they proved nothing to a reader and hid
 * the only two facts that matter — what state the next request is in, and how
 * much of the window it will take.
 */
export function formatContextInspectorPacketProofLines(input: {
  readonly previewReceipt?: ContextPacketReceipt | undefined;
  readonly submittedReceipt?: ContextPacketReceipt | undefined;
  readonly packetChange?: ContextPacketChangeClassification | undefined;
  readonly modelWindow: number;
  readonly width: number;
}): readonly string[] {
  if (input.packetChange?.kind === "meaning-change") {
    return [truncateForDisplayWidth(
      "Review before sending · context changed",
      input.width,
    )];
  }

  if (input.previewReceipt?.state === "previewed") {
    const estimate = formatContextReceiptTokenEstimate(input.previewReceipt);
    return [truncateForDisplayWidth(
      `Next request · ready to send · ${estimate} / ${formatContextWindow(input.modelWindow)}`,
      input.width,
    )];
  }

  if (input.submittedReceipt?.state === "submitted") {
    const sent = input.submittedReceipt.sourceRefs.filter((source) => source.includedInModel).length;
    return [truncateForDisplayWidth(
      `Last request · sent · ${sent} ${sent === 1 ? "source" : "sources"} · ${formatContextReceiptTokenEstimate(input.submittedReceipt)}`,
      input.width,
    )];
  }

  return [];
}

export function renderContextInspectorPacketProof(input: {
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
  /** Painted row width; omit for the unabridged helper output. */
  readonly contentWidth?: number | undefined;
}): React.ReactNode {
  const budgetWindow = input.modelWindow > 0 ? input.modelWindow : 200_000;
  const tokenEstimateState = input.packet.tokenEstimateState ?? "estimated";
  const windowLabel = formatContextWindow(budgetWindow);
  const tokenLabel = formatContextTokenEstimate(input.packet.tokenEstimate, tokenEstimateState);
  const warnings = input.packet.sourceCounts.warnings;
  const fullLine = [
    "Sources",
    `${input.packet.sourceCounts.included} sent`,
    `${input.packet.sourceCounts.excluded} held`,
    ...(warnings > 0 ? [`${warnings} ${warnings === 1 ? "warning" : "warnings"}`] : []),
    `${tokenLabel} / ${windowLabel}`,
  ].join(" · ");
  const paintedLine = input.contentWidth === undefined
    ? fullLine
    : truncateForDisplayWidth(fullLine, Math.max(1, Math.trunc(input.contentWidth)));
  const sourceLabel = input.contentWidth === undefined
    ? "Sources"
    : truncateForDisplayWidth("Sources", Math.max(1, Math.trunc(input.contentWidth)));
  const remainder = paintedLine.startsWith("Sources")
    ? paintedLine.slice("Sources".length)
    : "";
  return (
    <Text>
      <Text color={input.palette.assistant} bold>{sourceLabel}</Text>
      <Text color={input.palette.textMuted}>{remainder}</Text>
    </Text>
  );
}

const CONTEXT_ACTION_LABELS: Readonly<Record<ContextPacketViewAction, string>> = {
  pin: "Pinned",
  unpin: "Unpinned",
  "hold-back": "Held back",
  include: "Included",
  preview: "Previewed",
  refresh: "Refreshed",
  compare: "Compared",
  undo: "Undone",
};

/**
 * What the action actually did to the packet, in tokens. The before/after
 * packet ids this used to print told the reader nothing about the effect.
 */
function formatContextActionEffect(receipt: ContextPacketViewActionReceipt): string | undefined {
  const { before, after } = receipt;
  if (!before || !after) {
    return undefined;
  }
  if (before.includedInModel !== after.includedInModel) {
    const tokens = formatContextTokenEstimate(after.tokenEstimate);
    return after.includedInModel ? `${tokens} now sent` : `${tokens} no longer sent`;
  }
  const delta = after.tokenEstimate - before.tokenEstimate;
  if (delta === 0) {
    return undefined;
  }
  return `${delta > 0 ? "+" : "−"}${formatContextTokenEstimate(Math.abs(delta))}`;
}

export function renderContextInspectorReceipt(input: {
  readonly receipt?: ContextPacketViewActionReceipt | undefined;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  if (!input.receipt) {
    return null;
  }
  if (!input.receipt.succeeded) {
    const maxWidth = Math.max(32, input.width - 12);
    const status = input.receipt.canUndo ? "undo still ready" : "undo unavailable";
    const separatorsWidth = 6;
    const messageWidth = Math.max(
      8,
      maxWidth - "Not changed".length - status.length - separatorsWidth,
    );
    const body = [
      "Not changed",
      truncateForDisplayWidth(input.receipt.message, messageWidth),
      status,
    ].join(" · ");
    return (
      <Text>
        <Text color={input.palette.warning} bold>{"Proof"}</Text>
        <Text color={input.palette.borderSoft}>{" · "}</Text>
        <Text color={input.palette.text}>{body}</Text>
      </Text>
    );
  }
  const effect = formatContextActionEffect(input.receipt);
  const body = truncateForDisplayWidth(
    [
      CONTEXT_ACTION_LABELS[input.receipt.action],
      input.receipt.sourceLabel,
      ...(effect ? [effect] : []),
      input.receipt.canUndo ? "undo ready" : "undo unavailable",
    ].join(" · "),
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
