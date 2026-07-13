import type {
  ContextPacketChangeClassification,
  ContextPacketReceipt,
  ContextPacketView,
  ContextPacketViewActionReceipt,
} from "@unclecode/contracts";
import { Box, Text } from "ink";
import React from "react";

import {
  renderContextInspectorBudgetLine,
  renderContextInspectorPacketProof,
} from "./work-shell-context-inspector-header.js";
import {
  buildContextInspectorOverview,
  buildContextInspectorRows,
  computeContextOverlayViewportMaxRows,
  type ContextInspectorPalette,
} from "./work-shell-context-inspector-model.js";
import { renderContextInspectorFocus } from "./work-shell-context-inspector-focus.js";
import { renderContextInspectorGroupedViewport } from "./work-shell-context-inspector-sources.js";
import { renderContextInspectorWarnings } from "./work-shell-context-inspector-warnings.js";

export {
  computeContextMeterFill,
  computeContextOverlaySectionMaxRows,
} from "./work-shell-context-inspector-header.js";
export { computeContextOverlayViewportMaxRows } from "./work-shell-context-inspector-model.js";

const CONTEXT_INSPECTOR_CONTROLS =
  "↑↓ move · Enter details · Space send/hold · P pin · Esc close";
const CONTEXT_INSPECTOR_DETAIL_CONTROLS =
  "↑↓ scroll · Enter back · Space send/hold · P pin · Esc close";

export function renderContextInspectorOverlay(input: {
  readonly packet: ContextPacketView;
  readonly cursorIndex: number;
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
  readonly terminalRows?: number;
}): React.ReactNode {
  void input.actionReceipt;
  const rows = buildContextInspectorRows(input.packet);
  const overview = buildContextInspectorOverview({
    packet: input.packet,
    rows,
    modelWindow: input.modelWindow,
  });
  const selectedRow = rows.find((row) => row.sourceIndex === input.cursorIndex);
  const selectedSection = selectedRow?.heldBack ? "held" : "sent";
  const viewportMaxRows = computeContextOverlayViewportMaxRows({
    ...(input.terminalRows !== undefined ? { terminalRows: input.terminalRows } : {}),
  });
  const { palette } = input;
  const compactSuggestion = overview.suggestion.message;

  return (
    <Box marginTop={1} borderStyle="round" borderColor={input.borderColor} paddingX={1} flexDirection="column">
      <Text>
        <Text color={palette.assistant} bold>{"▤ UncleCode Context Desk"}</Text>
        <Text color={palette.textDim}>{" · inspect and trim context"}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        {renderContextInspectorBudgetLine({
          packet: input.packet,
          palette,
          modelWindow: input.modelWindow,
        })}
        {renderContextInspectorPacketProof({
          packet: input.packet,
          modelWindow: input.modelWindow,
          width: input.width,
          palette,
          ...(input.previewReceipt ? { previewReceipt: input.previewReceipt } : {}),
          ...(input.submittedReceipt ? { submittedReceipt: input.submittedReceipt } : {}),
          ...(input.packetChange ? { packetChange: input.packetChange } : {}),
        })}
        <Text>
          <Text color={overview.suggestion.tone === "warning" ? palette.warning : palette.success} bold>
            {"Summary"}
          </Text>
          <Text color={palette.borderSoft}>{" · "}</Text>
          <Text color={palette.textMuted}>{compactSuggestion}</Text>
        </Text>
        {renderContextInspectorFocus({
          ...(selectedRow ? { row: selectedRow } : {}),
          sectionLabel: selectedSection,
          width: input.width,
          palette,
          ...(selectedRow ? { ordinal: selectedRow.sourceIndex + 1, total: rows.length } : {}),
        })}
        {renderContextInspectorGroupedViewport({
          rows,
          maxRows: viewportMaxRows,
          cursorIndex: input.cursorIndex,
          ...(input.expandedId !== undefined ? { expandedId: input.expandedId } : {}),
          ...(input.detailContent !== undefined ? { detailContent: input.detailContent } : {}),
          ...(input.detailOffset !== undefined ? { detailOffset: input.detailOffset } : {}),
          width: input.width,
          palette,
          actionsEnabled: input.actionsEnabled,
        })}
        {renderContextInspectorWarnings({
          packet: input.packet,
          width: input.width,
          palette,
        })}
        <Text color={palette.textMuted}>
          {input.expandedId ? CONTEXT_INSPECTOR_DETAIL_CONTROLS : CONTEXT_INSPECTOR_CONTROLS}
        </Text>
      </Box>
    </Box>
  );
}
