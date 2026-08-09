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
    const dropped = input.packetChange.removedSourceIds.length;
    const added = input.packetChange.addedSourceIds.length;
    return [
      truncateForDisplayWidth("Context changed · review before sending", input.width),
      truncateForDisplayWidth(
        `${dropped} ${dropped === 1 ? "source" : "sources"} dropped · ${added} added · ${input.packetChange.reason}`,
        input.width,
      ),
    ];
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
