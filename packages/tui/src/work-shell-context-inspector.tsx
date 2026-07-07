import type { ContextPacketView } from "@unclecode/contracts";
import { Box, Text } from "ink";
import React from "react";

import { truncateForDisplayWidth, wrapDisplayTextFast } from "./text-width.js";
import {
  buildContextInspectorRows,
  getContextInspectorVisibleRows,
  getContextItemPreview,
  resolveContextSourceMeta,
  sanitizeContextPreview,
  type ContextInspectorPalette,
  type ContextInspectorSourceRow,
} from "./work-shell-context-inspector-model.js";

function renderContextInspectorBudgetLine(
  packet: ContextPacketView,
  palette: ContextInspectorPalette,
): React.ReactNode {
  const budgetCells = 10;
  const envWindow = Number.parseInt(process.env.UNCLECODE_CONTEXT_WINDOW ?? "", 10);
  const budgetWindow = Number.isFinite(envWindow) && envWindow > 0 ? envWindow : 200_000;
  const filled = Math.min(budgetCells, Math.max(0, Math.round((packet.tokenEstimate / budgetWindow) * budgetCells)));
  const meter = `${"●".repeat(filled)}${"·".repeat(Math.max(0, budgetCells - filled))}`;
  const windowLabel = budgetWindow >= 1_000_000
    ? `${(budgetWindow / 1_000_000).toFixed(1)}M`
    : `${Math.round(budgetWindow / 1000)}k`;
  return (
    <Text>
      <Text color={palette.success} bold>{"● "}</Text>
      <Text color={palette.text} bold>{"Sources"}</Text>
      <Text color={palette.textMuted}>{` · ${packet.sourceCounts.included} included · ${packet.sourceCounts.excluded} held back · ${packet.sourceCounts.warnings} warnings`}</Text>
      <Text color={palette.textMuted}>{"  budget "}</Text>
      <Text color={filled >= 8 ? palette.warning : palette.success} bold>{meter}</Text>
      <Text color={palette.textMuted}>{` · ~${packet.tokenEstimate} / ${windowLabel}`}</Text>
    </Text>
  );
}

function renderContextInspectorSourceRow(input: {
  readonly row: ContextInspectorSourceRow;
  readonly cursorIndex: number;
  readonly expandedId?: string | null;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const { row, palette } = input;
  const { item } = row;
  const selected = row.sourceIndex === input.cursorIndex;
  const expanded = input.expandedId === item.id;
  const meta = resolveContextSourceMeta(item.category, palette);
  const sourceCount = Math.max(1, Math.trunc(item.sourceCount ?? 1));
  const tokenSuffix = item.tokenEstimate && item.tokenEstimate > 0 ? ` · ~${item.tokenEstimate}t` : "";
  const stateLabel = row.heldBack
    ? "i include"
    : (item.salience ?? 0) >= 1
      ? "◆ pinned"
      : "◇ pin";
  const label = sanitizeContextPreview(item.label);
  const preview = getContextItemPreview(item);
  const previewWidth = Math.max(28, input.width - 18);
  const collapsedPreview = truncateForDisplayWidth(preview, previewWidth);
  const detailLines = expanded ? wrapDisplayTextFast(preview, previewWidth) : [collapsedPreview];
  const stateColor = row.heldBack ? palette.textDim : (item.salience ?? 0) >= 1 ? palette.success : palette.textMuted;

  return (
    <Box key={`context-source-${row.sourceIndex}-${item.id}`} flexDirection="column">
      <Text>
        <Text color={selected ? palette.user : palette.textDim} bold>{selected ? "▶ " : "  "}</Text>
        <Text color={meta.color} bold>{`${meta.icon} ${meta.label}`}</Text>
        <Text color={palette.borderSoft}>{" · "}</Text>
        <Text color={palette.text} bold>{`${sourceCount}`}</Text>
        <Text color={palette.textDim}>{tokenSuffix}</Text>
        <Text color={palette.borderSoft}>{" · "}</Text>
        <Text color={stateColor} bold={selected}>{stateLabel}</Text>
        <Text color={palette.borderSoft}>{" · "}</Text>
        <Text color={selected ? palette.text : palette.textMuted} bold={selected}>{truncateForDisplayWidth(label, Math.max(16, input.width - 36))}</Text>
      </Text>
      {detailLines.map((line, index) => (
        <Text key={`context-source-${row.sourceIndex}-${item.id}-detail-${index}`}>
          <Text color={selected ? palette.user : palette.borderSoft}>{expanded ? "    │ " : "    · "}</Text>
          <Text color={selected ? palette.text : palette.textMuted}>{line}</Text>
        </Text>
      ))}
    </Box>
  );
}

function renderContextInspectorSection(input: {
  readonly title: string;
  readonly hint: string;
  readonly rows: readonly ContextInspectorSourceRow[];
  readonly maxRows: number;
  readonly cursorIndex: number;
  readonly expandedId?: string | null;
  readonly width: number;
  readonly color: string;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const visible = getContextInspectorVisibleRows(input.rows, input.cursorIndex, input.maxRows);
  return (
    <Box key={input.title} marginTop={1} flexDirection="column">
      <Text>
        <Text color={input.color} bold>{input.title}</Text>
        <Text color={input.palette.textDim}>{` · ${input.rows.length}`}</Text>
        <Text color={input.palette.textMuted}>{` · ${input.hint}`}</Text>
      </Text>
      <Text color={input.color}>{"─".repeat(Math.min(64, Math.max(24, input.width - 4)))}</Text>
      {input.rows.length === 0
        ? <Text color={input.palette.textMuted}>{"  none"}</Text>
        : (
            <>
              {visible.hiddenBefore > 0 ? (
                <Text color={input.palette.textDim}>{`  … ${visible.hiddenBefore} more above`}</Text>
              ) : null}
              {visible.rows.map((row) => renderContextInspectorSourceRow({
                row,
                cursorIndex: input.cursorIndex,
                ...(input.expandedId !== undefined ? { expandedId: input.expandedId } : {}),
                width: input.width,
                palette: input.palette,
              }))}
              {visible.hiddenAfter > 0 ? (
                <Text color={input.palette.textDim}>{`  … ${visible.hiddenAfter} more below`}</Text>
              ) : null}
            </>
          )}
    </Box>
  );
}

export function renderContextInspectorOverlay(input: {
  readonly packet: ContextPacketView;
  readonly cursorIndex: number;
  readonly expandedId?: string | null;
  readonly width: number;
  readonly borderColor: string;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const rows = buildContextInspectorRows(input.packet);
  const includedRows = rows.filter((row) => !row.heldBack);
  const heldRows = rows.filter((row) => row.heldBack);
  const { palette } = input;
  return (
    <Box marginTop={1} borderStyle="round" borderColor={input.borderColor} paddingX={1} flexDirection="column">
      <Text>
        <Text color={palette.assistant} bold>{"▤ UncleCode Runbook"}</Text>
        <Text color={palette.textDim}>{" · inspect, pin, and trim the context carried forward"}</Text>
      </Text>
      <Text color={palette.textMuted}>{"  ↑/↓ or j/k move · Enter pin/unpin · e expand · f hold back · i include · Esc close"}</Text>
      <Box marginTop={1} flexDirection="column">
        {renderContextInspectorBudgetLine(input.packet, palette)}
        {renderContextInspectorSection({
          title: "↓ Included in next answer",
          hint: "reaches the model",
          rows: includedRows,
          maxRows: 12,
          cursorIndex: input.cursorIndex,
          ...(input.expandedId !== undefined ? { expandedId: input.expandedId } : {}),
          width: input.width,
          color: palette.success,
          palette,
        })}
        {renderContextInspectorSection({
          title: "⊘ Held back locally",
          hint: "visible here, not sent",
          rows: heldRows,
          maxRows: 7,
          cursorIndex: input.cursorIndex,
          ...(input.expandedId !== undefined ? { expandedId: input.expandedId } : {}),
          width: input.width,
          color: palette.borderSoft,
          palette,
        })}
        {input.packet.warnings.length > 0 ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={palette.warning} bold>{`Warnings · ${input.packet.warnings.length}`}</Text>
            {input.packet.warnings.map((warning) => (
              <Text key={warning.code} color={palette.textMuted}>{`  ${warning.severity} · ${warning.code} · ${warning.message}`}</Text>
            ))}
          </Box>
        ) : (
          <Box marginTop={1}>
            <Text color={palette.success}>{"✓ "}</Text>
            <Text color={palette.textMuted}>{"Warnings · none"}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
