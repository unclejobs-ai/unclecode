import type {
  ContextDeskCollection,
  ContextDeskPane,
  ContextPacketChangeClassification,
  ContextPacketReceipt,
  ContextPacketView,
  ContextPacketViewActionReceipt,
  ContextPacketViewItem,
  ContextPolicySuggestion,
} from "@unclecode/contracts";
import { Box, Text } from "ink";
import React from "react";

import { getDisplayWidth, truncateForDisplayWidth } from "./text-width.js";
import {
  renderContextInspectorBudgetLine,
  renderContextInspectorPacketProof,
} from "./work-shell-context-inspector-header.js";
import {
  buildContextInspectorOverview,
  buildContextInspectorRows,
  computeContextOverlayViewportMaxRows,
  filterContextDeskRows,
  resolveContextDeskSelectedRow,
  type ContextInspectorPalette,
} from "./work-shell-context-inspector-model.js";

import { renderContextInspectorWorkbench } from "./work-shell-context-workbench.js";
export {
  computeContextMeterFill,
  computeContextOverlaySectionMaxRows,
} from "./work-shell-context-inspector-header.js";
export { computeContextOverlayViewportMaxRows } from "./work-shell-context-inspector-model.js";

const CONTEXT_INSPECTOR_CONTROL_ROWS = 1;

export type ContextInspectorSourceCapabilities = {
  readonly pin: boolean;
  readonly unpin: boolean;
  readonly delivery: "hold-back" | "include" | undefined;
  readonly preview: boolean;
};

/**
 * What the selected source can actually do. The desk used to advertise a fixed
 * `Space send/hold · P pin` on every row, including provider-owned sources that
 * refuse both, so the control line promised keys that did nothing. Packets that
 * predate per-item `actions` fall back to the source's own state.
 */
export function resolveContextInspectorSourceCapabilities(
  item?: ContextPacketViewItem | undefined,
): ContextInspectorSourceCapabilities {
  if (!item) {
    return { pin: false, unpin: false, delivery: undefined, preview: false };
  }
  if (item.actions === undefined) {
    const held = item.includedInModel === false;
    const pinned = (item.salience ?? 0) >= 1;
    return {
      pin: !pinned,
      unpin: pinned,
      delivery: held ? "include" : "hold-back",
      preview: true,
    };
  }
  return {
    pin: item.actions.includes("pin"),
    unpin: item.actions.includes("unpin"),
    delivery: item.actions.includes("include")
      ? "include"
      : item.actions.includes("hold-back")
        ? "hold-back"
        : undefined,
    preview: item.actions.includes("preview"),
  };
}

type ContextInspectorControlSegment = {
  readonly text: string;
  /** Copy the pane cannot be navigated without; never dropped to fit. */
  readonly required?: boolean;
};

/**
 * Fit the control copy onto one physical row. Optional segments drop from the
 * tail inward — a narrow desk advertises fewer keys rather than half a key
 * name — and the closing truncation guarantees the row even when the required
 * copy alone outgrows the pane. Callers that pass no width get the full copy.
 */
function joinContextInspectorControls(
  segments: readonly ContextInspectorControlSegment[],
  width: number | undefined,
): string {
  const render = (list: readonly ContextInspectorControlSegment[]) =>
    list.map((segment) => segment.text).join(" · ");
  if (width === undefined) {
    return render(segments);
  }
  const kept = segments.slice();
  for (let index = kept.length - 1; index >= 0 && getDisplayWidth(render(kept)) > width; index -= 1) {
    if (kept[index]?.required !== true) {
      kept.splice(index, 1);
    }
  }
  return truncateForDisplayWidth(render(kept), width);
}

export function buildContextInspectorControls(input: {
  readonly capabilities: ContextInspectorSourceCapabilities;
  readonly actionsEnabled: boolean;
  readonly expanded: boolean;
  readonly undoAvailable: boolean;
  readonly pane?: ContextDeskPane | undefined;
  /** Painted pane width in cells; omit for the unabridged copy. */
  readonly width?: number | undefined;
  readonly uiLocale?: "en" | "ko";
}): string {
  const ko = input.uiLocale === "ko";
  if (!input.expanded && input.pane === "groups") {
    return joinContextInspectorControls([
      { text: ko ? "↑↓ 모음" : "↑↓ collection", required: true },
      { text: ko ? "←→ 창" : "←→ pane", required: true },
      { text: ko ? "Esc 닫기" : "Esc close", required: true },
    ], input.width);
  }
  if (!input.expanded && input.pane === "preview") {
    return joinContextInspectorControls([
      { text: ko ? "↑↓ 스크롤" : "↑↓ scroll", required: true },
      { text: ko ? "←→ 창" : "←→ pane", required: true },
      { text: ko ? "Esc 닫기" : "Esc close", required: true },
    ], input.width);
  }
  const { capabilities } = input;
  const actionable = input.actionsEnabled;
  const firstSegment: ContextInspectorControlSegment = {
    text: input.expanded
      ? (ko ? "↑↓ 스크롤 · Enter 돌아가기" : "↑↓ scroll · Enter back")
      : capabilities.preview
        ? (ko ? "↑↓ 이동 · Enter 상세" : "↑↓ move · Enter details")
        : (ko ? "↑↓ 이동" : "↑↓ move"),
    required: true,
  };
  const optionalSegments: readonly ContextInspectorControlSegment[] = [
    ...(actionable && capabilities.delivery !== undefined
      ? [{ text: capabilities.delivery === "include" ? (ko ? "Space 포함" : "Space include") : (ko ? "Space 보류" : "Space hold back") }]
      : []),
    ...(actionable && capabilities.unpin
      ? [{ text: ko ? "P 고정 해제" : "P unpin" }]
      : actionable && capabilities.pin
        ? [{ text: ko ? "P 고정" : "P pin" }]
        : []),
    ...(actionable && input.undoAvailable ? [{ text: ko ? "U 실행 취소" : "U undo" }] : []),
  ];
  const exitSegment: ContextInspectorControlSegment = { text: ko ? "Esc 닫기" : "Esc close", required: true };
  if (input.expanded) {
    return joinContextInspectorControls([firstSegment, exitSegment], input.width);
  }
  const paneSegment: ContextInspectorControlSegment = { text: ko ? "←→ 창" : "←→ pane", required: true };
  const legacy = [firstSegment, ...optionalSegments, exitSegment, paneSegment];
  if (
    input.width === undefined
    || getDisplayWidth(legacy.map((segment) => segment.text).join(" · ")) <= input.width
  ) {
    return joinContextInspectorControls(legacy, input.width);
  }
  // Once the full legacy copy cannot fit, keep exit and pane discovery ahead
  // of mutation keys so the two navigation paths survive narrow frames.
  return joinContextInspectorControls(
    [firstSegment, paneSegment, exitSegment, ...optionalSegments],
    input.width,
  );
}

export function renderContextInspectorOverlay(input: {
  readonly packet: ContextPacketView;
  readonly cursorIndex: number;
  readonly activePane?: ContextDeskPane | undefined;
  readonly activeCollection?: ContextDeskCollection | undefined;
  readonly expandedId?: string | null;
  readonly detailContent?: string | undefined;
  readonly detailOffset?: number | undefined;
  readonly width: number;
  readonly borderColor: string;
  readonly palette: ContextInspectorPalette;
  readonly modelWindow: number;
  readonly actionsEnabled: boolean;
  readonly actionReceipt?: ContextPacketViewActionReceipt | undefined;
  readonly previewReceipt?: ContextPacketReceipt | undefined;
  readonly submittedReceipt?: ContextPacketReceipt | undefined;
  readonly packetChange?: ContextPacketChangeClassification | undefined;
  readonly contextPolicySuggestions?: readonly ContextPolicySuggestion[] | undefined;
  readonly contextAdviceUnavailable?: string | undefined;
  readonly contextAdviceActionsEnabled?: boolean | undefined;
  readonly terminalRows?: number;
  readonly uiLocale?: "en" | "ko";
}): React.ReactNode {
  const activePane = input.activePane ?? "sources";
  const ko = input.uiLocale === "ko";
  const activeCollection = input.activeCollection ?? "all";
  const rows = buildContextInspectorRows(input.packet);
  const overview = buildContextInspectorOverview({
    packet: input.packet,
    rows,
    modelWindow: input.modelWindow,
    uiLocale: input.uiLocale ?? "en",
  });
  const contextPolicySuggestions = input.contextPolicySuggestions ?? [];
  const viewportMaxRows = computeContextOverlayViewportMaxRows({
    ...(input.terminalRows !== undefined ? { terminalRows: input.terminalRows } : {}),
    reservedRows: 0,
  });
  const { palette } = input;
  // The cursor is an offset into the active collection's filtered rows; with
  // the default "all" collection that is the canonical grouped row order.
  const filteredRows = filterContextDeskRows(rows, activeCollection);
  const selectedRow = resolveContextDeskSelectedRow(filteredRows, input.cursorIndex);
  // The overlay box spends 4 cells on its border and padding, so the copy the
  // panes actually paint into is narrower than the width handed to the desk.
  const contentWidth = Math.max(24, input.width - 4);
  const controls = buildContextInspectorControls({
    capabilities: resolveContextInspectorSourceCapabilities(selectedRow?.item),
    actionsEnabled: input.actionsEnabled,
    expanded: Boolean(input.expandedId),
    undoAvailable: input.actionReceipt?.canUndo ?? false,
    pane: activePane,
    width: contentWidth,
    uiLocale: input.uiLocale ?? "en",
  });

  return (
    <Box marginTop={1} borderStyle="round" borderColor={input.borderColor} paddingX={1} flexDirection="column">
      <Text>
        <Text color={palette.assistant} bold>{ko ? "컨텍스트 작업대" : "Context Desk"}</Text>
        <Text color={palette.textDim}>
          {truncateForDisplayWidth(
            input.width < 76
              ? (ko ? " · 다음 응답" : " · next answer")
              : (ko ? " · 다음 응답에 포함되는 내용" : " · what reaches the next answer"),
            Math.max(4, contentWidth - getDisplayWidth(ko ? "컨텍스트 작업대" : "Context Desk")),
          )}
        </Text>
      </Text>
      <Box marginTop={input.expandedId ? 0 : 1} flexDirection="column">
        {renderContextInspectorBudgetLine({
          packet: input.packet,
          palette,
          modelWindow: input.modelWindow,
          contentWidth,
          uiLocale: input.uiLocale ?? "en",
        })}
        {renderContextInspectorPacketProof({
          modelWindow: input.modelWindow,
          width: contentWidth,
          palette,
          uiLocale: input.uiLocale ?? "en",
          ...(input.previewReceipt ? { previewReceipt: input.previewReceipt } : {}),
          ...(input.submittedReceipt ? { submittedReceipt: input.submittedReceipt } : {}),
          ...(input.packetChange ? { packetChange: input.packetChange } : {}),
        })}
        {renderContextInspectorWorkbench({
          packet: input.packet,
          rows,
          suggestion: overview.suggestion,
          cursorIndex: input.cursorIndex,
          activePane,
          activeCollection,
          ...(input.expandedId !== undefined ? { expandedId: input.expandedId } : {}),
          ...(input.detailContent !== undefined ? { detailContent: input.detailContent } : {}),
          ...(input.detailOffset !== undefined ? { detailOffset: input.detailOffset } : {}),
          width: input.width,
          maxRows: Math.max(1, viewportMaxRows - CONTEXT_INSPECTOR_CONTROL_ROWS),
          palette,
          actionsEnabled: input.actionsEnabled,
          ...(input.actionReceipt ? { actionReceipt: input.actionReceipt } : {}),
          ...(input.previewReceipt ? { previewReceipt: input.previewReceipt } : {}),
          ...(input.submittedReceipt ? { submittedReceipt: input.submittedReceipt } : {}),
          ...(input.packetChange ? { packetChange: input.packetChange } : {}),
          policySuggestions: contextPolicySuggestions,
          ...(input.contextAdviceUnavailable
            ? { adviceUnavailable: input.contextAdviceUnavailable }
            : {}),
          adviceActionsEnabled: input.contextAdviceActionsEnabled ?? false,
          uiLocale: input.uiLocale ?? "en",
        })}
        <Text color={palette.textMuted}>{controls}</Text>
      </Box>
    </Box>
  );
}
