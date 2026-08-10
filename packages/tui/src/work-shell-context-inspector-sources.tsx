import type { ContextPacketSourceCounts } from "@unclecode/contracts";
import { Box, Text } from "ink";
import React from "react";

import { truncateForDisplayWidth, wrapDisplayTextFast } from "./text-width.js";
import {
  type ContextInspectorVisibleRows,
  getContextItemDetailLines,
  formatContextTokenEstimate,
  type ContextInspectorPalette,
  type ContextInspectorSourceRow,
} from "./work-shell-context-inspector-model.js";
import { sanitizeContextPreview } from "./work-shell-context-inspector-details.js";

function renderContextInspectorSourceRow(input: {
  readonly row: ContextInspectorSourceRow;
  readonly cursorIndex: number;
  readonly expandedId?: string | null | undefined;
  readonly maxDetailLines: number;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const { row, palette } = input;
  const { item } = row;
  const selected = row.sourceIndex === input.cursorIndex;
  const expanded = input.expandedId === item.id;
  const sourceCount = Math.max(1, Math.trunc(item.sourceCount ?? 1));
  const label = sanitizeContextPreview(item.label);
  const pinned = !row.heldBack && (item.salience ?? 0) >= 1;
  const tokenLabel = formatContextTokenEstimate(item.tokenEstimate);
  const parts = [
    label,
    ...(sourceCount > 1 ? [`${sourceCount} sources`] : []),
    ...(row.heldBack ? ["held"] : pinned ? ["pinned"] : []),
    tokenLabel,
  ];
  const body = truncateForDisplayWidth(
    parts.join(" · "),
    Math.max(18, input.width - 6),
  );
  const detailLines = expanded
    ? getContextItemDetailLines(item)
      .flatMap((line) => wrapDisplayTextFast(line, Math.max(24, input.width - 8)))
      .slice(0, input.maxDetailLines)
    : [];
  const statusColor = row.heldBack
    ? palette.textDim
    : pinned
      ? palette.success
      : palette.textMuted;

  return (
    <Box key={`context-source-${row.sourceIndex}-${item.id}`} flexDirection="column">
      <Text>
        <Text color={selected ? palette.user : palette.textDim} bold>{selected ? "› " : "  "}</Text>
        <Text color={statusColor} bold>{row.heldBack ? "○ " : "● "}</Text>
        <Text color={selected ? palette.text : statusColor} bold={selected}>{body}</Text>
      </Text>
      {detailLines.map((line, index) => (
        <Text key={`context-source-${row.sourceIndex}-${item.id}-detail-${index}`}>
          <Text color={selected ? palette.user : palette.borderSoft}>{"    │ "}</Text>
          <Text color={selected ? palette.text : palette.textMuted}>{line}</Text>
        </Text>
      ))}
    </Box>
  );
}

function buildContextInspectorViewportPlan(input: {
  readonly rows: readonly ContextInspectorSourceRow[];
  readonly cursorIndex: number;
  readonly maxRows: number;
  readonly expandedId?: string | null | undefined;
}): ContextInspectorVisibleRows & { readonly detailLineLimit: number } {
  if (input.rows.length === 0) {
    return { rows: [], hiddenBefore: 0, hiddenAfter: 0, detailLineLimit: 0 };
  }
  const selectedOffset = input.rows.findIndex((row) => row.sourceIndex === input.cursorIndex);
  const anchor = selectedOffset >= 0 ? selectedOffset : 0;
  const detailReserve = input.expandedId ? 3 : 0;
  let bestStart = anchor;
  let bestEnd = anchor + 1;
  let bestCount = 0;
  let bestCenterDistance = Number.POSITIVE_INFINITY;

  for (let start = 0; start <= anchor; start += 1) {
    for (let end = start + 1; end <= input.rows.length; end += 1) {
      if (end <= anchor) {
        continue;
      }
      const hiddenMarkerCount = (start > 0 ? 1 : 0) + (end < input.rows.length ? 1 : 0);
      const structuralRows = (end - start) + hiddenMarkerCount;
      if (structuralRows + detailReserve > input.maxRows) {
        continue;
      }
      const count = end - start;
      const centerDistance = Math.abs((start + end - 1) / 2 - anchor);
      if (count > bestCount || (count === bestCount && centerDistance < bestCenterDistance)) {
        bestStart = start;
        bestEnd = end;
        bestCount = count;
        bestCenterDistance = centerDistance;
      }
    }
  }

  const visibleRows = input.rows.slice(bestStart, bestEnd);
  const hiddenBefore = bestStart;
  const hiddenAfter = input.rows.length - bestEnd;
  const structuralRows = visibleRows.length
    + (hiddenBefore > 0 ? 1 : 0)
    + (hiddenAfter > 0 ? 1 : 0);
  return {
    rows: visibleRows,
    hiddenBefore,
    hiddenAfter,
    detailLineLimit: input.expandedId
      ? Math.max(0, input.maxRows - structuralRows)
      : 0,
  };
}

function renderVisibleSourceRows(input: {
  readonly visibleRows: readonly ContextInspectorSourceRow[];
  readonly cursorIndex: number;
  readonly expandedId?: string | null | undefined;
  readonly maxDetailLines: number;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  return input.visibleRows.map((row) => renderContextInspectorSourceRow({
    row,
    cursorIndex: input.cursorIndex,
    ...(input.expandedId !== undefined ? { expandedId: input.expandedId } : {}),
    maxDetailLines: input.maxDetailLines,
    width: input.width,
    palette: input.palette,
  }));
}

function renderContextInspectorDetailReader(input: {
  readonly row: ContextInspectorSourceRow;
  readonly content?: string | undefined;
  readonly offset: number;
  readonly maxRows: number;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const summaryLines = getContextItemDetailLines(input.row.item)
    .flatMap((line) => wrapDisplayTextFast(line, Math.max(24, input.width - 8)));
  const contentLines = input.content?.trim()
    ? input.content
      .split(/\r?\n/u)
      .flatMap((line) => wrapDisplayTextFast(line.length > 0 ? line : " ", Math.max(24, input.width - 8)))
    : [];
  const lines = [
    ...summaryLines,
    ...(contentLines.length > 0 ? ["", "Local source content", ...contentLines] : []),
  ];
  // `maxRows` includes the margin, separator, and detail heading. Overflow
  // markers consume rows too, so reserve them before slicing the content.
  const availableRows = Math.max(1, input.maxRows - 3);
  const bottomPageSize = Math.max(1, availableRows - 1);
  const maxOffset = Math.max(0, lines.length - bottomPageSize);
  const offset = Math.min(maxOffset, Math.max(0, input.offset));
  const hasAbove = offset > 0;
  const rowsAfterAboveMarker = Math.max(1, availableRows - (hasAbove ? 1 : 0));
  const hasBelow = offset + rowsAfterAboveMarker < lines.length;
  const visibleCount = Math.max(1, rowsAfterAboveMarker - (hasBelow ? 1 : 0));
  const visibleLines = lines.slice(offset, offset + visibleCount);

  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={input.palette.borderDefault}>
        {"─".repeat(Math.min(64, Math.max(24, input.width - 4)))}
      </Text>
      <Text>
        <Text color={input.palette.assistant} bold>{"Detail"}</Text>
        <Text color={input.palette.textDim}>{` · ${sanitizeContextPreview(input.row.item.label)}`}</Text>
      </Text>
      {offset > 0 ? <Text color={input.palette.textDim}>{`  … ${offset} lines above`}</Text> : null}
      {visibleLines.map((line, index) => (
        <Text key={`context-detail-${offset + index}`} color={input.palette.text}>
          {line.length > 0 ? line : " "}
        </Text>
      ))}
      {offset + visibleLines.length < lines.length ? (
        <Text color={input.palette.textDim}>
          {`  … ${lines.length - offset - visibleLines.length} lines below`}
        </Text>
      ) : null}
    </Box>
  );
}

export function renderContextInspectorGroupedViewport(input: {
  readonly rows: readonly ContextInspectorSourceRow[];
  readonly maxRows: number;
  readonly cursorIndex: number;
  readonly sourceCounts?: ContextPacketSourceCounts | undefined;
  readonly expandedId?: string | null | undefined;
  readonly detailContent?: string | undefined;
  readonly detailOffset?: number | undefined;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
  readonly actionsEnabled: boolean;
}): React.ReactNode {
  const detailRow = input.expandedId
    ? input.rows.find((row) => row.item.id === input.expandedId)
    : undefined;
  if (detailRow) {
    return renderContextInspectorDetailReader({
      row: detailRow,
      ...(input.detailContent !== undefined ? { content: input.detailContent } : {}),
      offset: input.detailOffset ?? 0,
      maxRows: input.maxRows,
      width: input.width,
      palette: input.palette,
    });
  }
  const visible = buildContextInspectorViewportPlan({
    rows: input.rows,
    cursorIndex: input.cursorIndex,
    maxRows: input.maxRows,
    ...(input.expandedId !== undefined ? { expandedId: input.expandedId } : {}),
  });
  return (
    <Box marginTop={1} flexDirection="column">
      {input.rows.length === 0 ? (
        <Text color={input.palette.textMuted}>{"No context sources yet."}</Text>
      ) : (
        <>
          {visible.hiddenBefore > 0 ? (
            <Text color={input.palette.textDim}>{`  … ${visible.hiddenBefore} more above`}</Text>
          ) : null}
          {renderVisibleSourceRows({
            visibleRows: visible.rows,
            cursorIndex: input.cursorIndex,
            ...(input.expandedId !== undefined ? { expandedId: input.expandedId } : {}),
            maxDetailLines: visible.detailLineLimit,
            width: input.width,
            palette: input.palette,
          })}
          {visible.hiddenAfter > 0 ? (
            <Text color={input.palette.textDim}>{`  … ${visible.hiddenAfter} more below`}</Text>
          ) : null}
        </>
      )}
    </Box>
  );
}
