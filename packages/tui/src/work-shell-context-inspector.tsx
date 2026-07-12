import type { ContextPacketView, ContextPacketViewActionReceipt } from "@unclecode/contracts";
import { Box, Text } from "ink";
import React from "react";

import {
  computeContextOverlaySectionMaxRows,
  renderContextInspectorBudgetLine,
  renderContextInspectorManifestLine,
  renderContextInspectorReceipt,
} from "./work-shell-context-inspector-header.js";
import {
  buildContextInspectorOverview,
  buildContextInspectorRows,
  type ContextInspectorPalette,
} from "./work-shell-context-inspector-model.js";
import { renderContextInspectorFocus } from "./work-shell-context-inspector-focus.js";
import { renderContextInspectorSection } from "./work-shell-context-inspector-sources.js";
import { renderContextInspectorWarnings } from "./work-shell-context-inspector-warnings.js";
import { renderContextInspectorWorkbench } from "./work-shell-context-workbench.js";

export {
  computeContextMeterFill,
  computeContextOverlaySectionMaxRows,
} from "./work-shell-context-inspector-header.js";

export function renderContextInspectorOverlay(input: {
  readonly packet: ContextPacketView;
  readonly cursorIndex: number;
  readonly expandedId?: string | null;
  readonly width: number;
  readonly borderColor: string;
  readonly palette: ContextInspectorPalette;
  readonly modelWindow: number;
  readonly actionsEnabled: boolean;
  readonly actionReceipt?: ContextPacketViewActionReceipt | undefined;
}): React.ReactNode {
  const rows = buildContextInspectorRows(input.packet);
  const includedRows = rows.filter((row) => !row.heldBack);
  const heldRows = rows.filter((row) => row.heldBack);
  const overview = buildContextInspectorOverview({
    packet: input.packet,
    rows,
    modelWindow: input.modelWindow,
  });
  const selectedRow = rows.find((row) => row.sourceIndex === input.cursorIndex);
  const selectedSection = selectedRow?.heldBack ? "Held back locally" : "Included in next answer";
  const expandAction = input.expandedId !== undefined && input.expandedId !== null ? "e collapse" : "e expand";
  const mutationActionLabel = input.actionsEnabled
    ? "Enter pin/unpin · f hold back · i include"
    : "source actions unavailable";
  const actionLabel = input.actionsEnabled
    ? `${mutationActionLabel} · ${expandAction}`
    : `${expandAction} · ${mutationActionLabel}`;
  const includedCaps = computeContextOverlaySectionMaxRows({ sourceCount: includedRows.length });
  const heldCaps = computeContextOverlaySectionMaxRows({ sourceCount: heldRows.length });
  const { palette } = input;

  return (
    <Box marginTop={1} borderStyle="round" borderColor={input.borderColor} paddingX={1} flexDirection="column">
      <Text>
        <Text color={palette.assistant} bold>{"▤ UncleCode Context Desk"}</Text>
        <Text color={palette.textDim}>{" · inspect, pin, and trim the context carried forward"}</Text>
      </Text>
      <Text color={palette.textMuted}>{`  Keys · ↑/↓/j/k move · ${expandAction} · Esc close`}</Text>
      <Text color={palette.textMuted}>{`  Actions · ${mutationActionLabel}`}</Text>
      <Box marginTop={1} flexDirection="column">
        {renderContextInspectorBudgetLine({
          packet: input.packet,
          palette,
          modelWindow: input.modelWindow,
        })}
        {renderContextInspectorManifestLine({
          packet: input.packet,
          palette,
          width: input.width,
        })}
        {renderContextInspectorReceipt({
          ...(input.actionReceipt ? { receipt: input.actionReceipt } : {}),
          width: input.width,
          palette,
        })}
        {renderContextInspectorFocus({
          ...(selectedRow ? { row: selectedRow } : {}),
          sectionLabel: selectedSection,
          actionLabel,
          width: input.width,
          palette,
        })}
        {renderContextInspectorWorkbench({
          packet: input.packet,
          rows,
          suggestion: overview.suggestion,
          width: input.width,
          palette,
        })}
        {renderContextInspectorSection({
          title: "↓ Included in next answer",
          hint: "reaches the model",
          rows: includedRows,
          maxRows: includedCaps.included,
          cursorIndex: input.cursorIndex,
          ...(input.expandedId !== undefined ? { expandedId: input.expandedId } : {}),
          width: input.width,
          color: palette.success,
          palette,
          actionsEnabled: input.actionsEnabled,
        })}
        {renderContextInspectorSection({
          title: "- Held back locally",
          hint: "visible here, not sent",
          rows: heldRows,
          maxRows: heldCaps.held,
          cursorIndex: input.cursorIndex,
          ...(input.expandedId !== undefined ? { expandedId: input.expandedId } : {}),
          width: input.width,
          color: palette.borderSoft,
          palette,
          actionsEnabled: input.actionsEnabled,
        })}
        {renderContextInspectorWarnings({
          packet: input.packet,
          width: input.width,
          palette,
        })}
      </Box>
    </Box>
  );
}
