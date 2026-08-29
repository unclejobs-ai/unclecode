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
  readonly uiLocale?: "en" | "ko";
}): readonly string[] {
  if (input.packetChange?.kind === "meaning-change") {
    return [truncateForDisplayWidth(
      input.uiLocale === "ko" ? "전송 전 검토 · 컨텍스트 변경됨" : "Review before sending · context changed",
      input.width,
    )];
  }

  if (input.previewReceipt?.state === "previewed") {
    const estimate = formatContextReceiptTokenEstimate(input.previewReceipt);
    return [truncateForDisplayWidth(
      input.uiLocale === "ko" ? `다음 요청 · 전송 준비 · ${estimate} / ${formatContextWindow(input.modelWindow)}` : `Next request · ready to send · ${estimate} / ${formatContextWindow(input.modelWindow)}`,
      input.width,
    )];
  }

  if (input.submittedReceipt?.state === "submitted") {
    const sent = input.submittedReceipt.sourceRefs.filter((source) => source.includedInModel).length;
    return [truncateForDisplayWidth(
      input.uiLocale === "ko" ? `최근 요청 · 전송됨 · 소스 ${sent}개 · ${formatContextReceiptTokenEstimate(input.submittedReceipt)}` : `Last request · sent · ${sent} ${sent === 1 ? "source" : "sources"} · ${formatContextReceiptTokenEstimate(input.submittedReceipt)}`,
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
  readonly uiLocale?: "en" | "ko";
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
  readonly uiLocale?: "en" | "ko";
}): React.ReactNode {
  const budgetWindow = input.modelWindow > 0 ? input.modelWindow : 200_000;
  const tokenEstimateState = input.packet.tokenEstimateState ?? "estimated";
  const windowLabel = formatContextWindow(budgetWindow);
  const tokenLabel = formatContextTokenEstimate(input.packet.tokenEstimate, tokenEstimateState);
  const warnings = input.packet.sourceCounts.warnings;
  const sourceTitle = input.uiLocale === "ko" ? "소스" : "Sources";
  const fullLine = [
    sourceTitle,
    input.uiLocale === "ko" ? `${input.packet.sourceCounts.included}개 전송` : `${input.packet.sourceCounts.included} sent`,
    input.uiLocale === "ko" ? `${input.packet.sourceCounts.excluded}개 보류` : `${input.packet.sourceCounts.excluded} held`,
    ...(warnings > 0 ? [input.uiLocale === "ko" ? `경고 ${warnings}개` : `${warnings} ${warnings === 1 ? "warning" : "warnings"}`] : []),
    `${tokenLabel} / ${windowLabel}`,
  ].join(" · ");
  const paintedLine = input.contentWidth === undefined
    ? fullLine
    : truncateForDisplayWidth(fullLine, Math.max(1, Math.trunc(input.contentWidth)));
  const sourceLabel = input.contentWidth === undefined
    ? sourceTitle
    : truncateForDisplayWidth(sourceTitle, Math.max(1, Math.trunc(input.contentWidth)));
  const remainder = paintedLine.startsWith(sourceTitle)
    ? paintedLine.slice(sourceTitle.length)
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
  readonly uiLocale?: "en" | "ko";
}): React.ReactNode {
  if (!input.receipt) {
    return null;
  }
  if (!input.receipt.succeeded) {
    const maxWidth = Math.max(32, input.width - 12);
    const status = input.uiLocale === "ko"
      ? (input.receipt.canUndo ? "실행 취소 가능" : "실행 취소 불가")
      : (input.receipt.canUndo ? "undo still ready" : "undo unavailable");
    const separatorsWidth = 6;
    const messageWidth = Math.max(
      8,
      maxWidth - (input.uiLocale === "ko" ? "변경 없음" : "Not changed").length - status.length - separatorsWidth,
    );
    const body = [
      input.uiLocale === "ko" ? "변경 없음" : "Not changed",
      truncateForDisplayWidth(input.receipt.message, messageWidth),
      status,
    ].join(" · ");
    return (
      <Text>
        <Text color={input.palette.warning} bold>{input.uiLocale === "ko" ? "증명" : "Proof"}</Text>
        <Text color={input.palette.borderSoft}>{" · "}</Text>
        <Text color={input.palette.text}>{body}</Text>
      </Text>
    );
  }
  const effect = formatContextActionEffect(input.receipt);
  const body = truncateForDisplayWidth(
    [
      input.uiLocale === "ko"
        ? ({ pin: "고정됨", unpin: "고정 해제", "hold-back": "보류됨", include: "포함됨", preview: "미리 봄", refresh: "새로 고침", compare: "비교됨", undo: "실행 취소됨" } as const)[input.receipt.action]
        : CONTEXT_ACTION_LABELS[input.receipt.action],
      input.receipt.sourceLabel,
      ...(effect ? [effect] : []),
      input.uiLocale === "ko" ? (input.receipt.canUndo ? "실행 취소 가능" : "실행 취소 불가") : (input.receipt.canUndo ? "undo ready" : "undo unavailable"),
    ].join(" · "),
    Math.max(32, input.width - 12),
  );
  return (
    <Text>
      <Text color={input.palette.success} bold>{input.uiLocale === "ko" ? "증명" : "Proof"}</Text>
      <Text color={input.palette.borderSoft}>{" · "}</Text>
      <Text color={input.palette.text}>{body}</Text>
    </Text>
  );
}
