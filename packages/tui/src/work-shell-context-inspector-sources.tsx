import { Box, Text } from "ink";
import React from "react";

import { truncateForDisplayWidth, wrapDisplayTextFast } from "./text-width.js";
import {
  getContextInspectorVisibleRows,
  getContextItemPreview,
  formatContextTokenEstimate,
  resolveContextSourceMeta,
  sanitizeContextPreview,
  type ContextInspectorPalette,
  type ContextInspectorSourceRow,
} from "./work-shell-context-inspector-model.js";

function renderContextInspectorSourceRow(input: {
  readonly row: ContextInspectorSourceRow;
  readonly cursorIndex: number;
  readonly expandedId?: string | null | undefined;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
  readonly actionsEnabled: boolean;
}): React.ReactNode {
  const { row, palette } = input;
  const { item } = row;
  const selected = row.sourceIndex === input.cursorIndex;
  const expanded = input.expandedId === item.id;
  const meta = resolveContextSourceMeta(item.category, palette);
  const sourceCount = Math.max(1, Math.trunc(item.sourceCount ?? 1));
  const tokenSuffix = ` · ${formatContextTokenEstimate(item.tokenEstimate)}`;
  const stateLabel = input.actionsEnabled
    ? row.heldBack
      ? "i include"
      : (item.salience ?? 0) >= 1
        ? "Enter unpin"
        : "Enter pin"
    : row.heldBack
      ? "held back"
      : (item.salience ?? 0) >= 1
        ? "pinned"
        : "included";
  const label = sanitizeContextPreview(item.label);
  const preview = getContextItemPreview(item);
  const previewWidth = Math.max(28, input.width - 18);
  const collapsedPreview = truncateForDisplayWidth(preview, previewWidth);
  const detailLines = expanded ? wrapDisplayTextFast(preview, previewWidth) : [collapsedPreview];
  const stateColor = row.heldBack
    ? palette.textDim
    : (item.salience ?? 0) >= 1
      ? palette.success
      : palette.textMuted;

  return (
    <Box key={`context-source-${row.sourceIndex}-${item.id}`} flexDirection="column">
      <Text>
        <Text color={selected ? palette.user : palette.textDim} bold>{selected ? "> " : "  "}</Text>
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

export function renderContextInspectorSection(input: {
  readonly title: string;
  readonly hint: string;
  readonly rows: readonly ContextInspectorSourceRow[];
  readonly maxRows: number;
  readonly cursorIndex: number;
  readonly expandedId?: string | null | undefined;
  readonly width: number;
  readonly color: string;
  readonly palette: ContextInspectorPalette;
  readonly actionsEnabled: boolean;
}): React.ReactNode {
  const visible = getContextInspectorVisibleRows(input.rows, input.cursorIndex, input.maxRows);
  return (
    <Box key={input.title} marginTop={1} flexDirection="column">
      <Text>
        <Text color={input.color} bold>{input.title}</Text>
        <Text color={input.palette.textDim}>{` · ${input.rows.length}`}</Text>
        <Text color={input.palette.textMuted}>{` · ${input.hint}`}</Text>
      </Text>
      <Text color={input.palette.borderDefault}>{"─".repeat(Math.min(64, Math.max(24, input.width - 4)))}</Text>
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
                actionsEnabled: input.actionsEnabled,
              }))}
              {visible.hiddenAfter > 0 ? (
                <Text color={input.palette.textDim}>{`  … ${visible.hiddenAfter} more below`}</Text>
              ) : null}
            </>
          )}
    </Box>
  );
}
