import type { ContextPacketSourceCounts } from "@unclecode/contracts";
import { resolveWorkShellContextDetailLayout } from "@unclecode/orchestrator";
import { Box, Text } from "ink";
import React from "react";

import { truncateForDisplayWidth, wrapDisplayTextFast } from "./text-width.js";
import {
  type ContextInspectorVisibleRows,
  getContextItemDetailLines,
  formatContextTokenEstimate,
  sanitizeContextPreview,
  type ContextInspectorPalette,
  type ContextInspectorSourceRow,
} from "./work-shell-context-inspector-model.js";

function renderContextInspectorSourceRow(input: {
  readonly row: ContextInspectorSourceRow;
  readonly selected: boolean;
  /** Standalone callers default to Sources focus; other panes suppress the cursor. */
  readonly focused?: boolean | undefined;
  readonly expandedId?: string | null | undefined;
  readonly maxDetailLines: number;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const { row, palette } = input;
  const { item } = row;
  const selected = input.selected && input.focused !== false;
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
  // The row prefix ("› " + status glyph) paints 4 cells; one trailing cell of
  // slack keeps an exact-fit row off the wrap boundary.
  const body = truncateForDisplayWidth(
    parts.join(" · "),
    Math.max(18, input.width - 5),
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
}): ContextInspectorVisibleRows & {
  readonly detailLineLimit: number;
  readonly showHiddenBefore: boolean;
  readonly showHiddenAfter: boolean;
} {
  const rowCount = input.rows.length;
  if (rowCount === 0) {
    return {
      rows: [],
      hiddenBefore: 0,
      hiddenAfter: 0,
      detailLineLimit: 0,
      showHiddenBefore: false,
      showHiddenAfter: false,
    };
  }
  // The cursor is an offset into these rows (the active collection's filtered
  // list), never a global source index, so windowing anchors on it directly.
  const anchor = Math.min(Math.max(0, input.cursorIndex), rowCount - 1);
  const detailReserve = input.expandedId ? 3 : 0;
  // Rows left for source lines plus their hidden-count marker lines.
  const budget = input.maxRows - detailReserve;
  let bestStart = anchor;
  let bestEnd = anchor + 1;
  let bestCount = 0;
  let bestCenterDistance = Number.POSITIVE_INFINITY;
  let showHiddenBefore = false;
  let showHiddenAfter = false;

  const consider = (start: number, end: number): void => {
    if (start < 0 || start > anchor || end <= anchor || end > rowCount) {
      return;
    }
    const count = end - start;
    const markerRows = (start > 0 ? 1 : 0) + (end < rowCount ? 1 : 0);
    if (count + markerRows > budget) {
      return;
    }
    const centerDistance = Math.abs((start + end - 1) / 2 - anchor);
    const better = count > bestCount
      || (count === bestCount
        && (centerDistance < bestCenterDistance
          || (centerDistance === bestCenterDistance && start < bestStart)));
    if (!better) {
      return;
    }
    bestStart = start;
    bestEnd = end;
    bestCount = count;
    bestCenterDistance = centerDistance;
    showHiddenBefore = start > 0;
    showHiddenAfter = end < rowCount;
  };

  // A window is fully described by which hidden-count markers it shows, and
  // for each of those four shapes the widest feasible width is closed form --
  // as is the best-centred offset for the one shape that can still slide. So
  // four candidates cover every window the exhaustive scan could have picked,
  // and `consider` re-validates each against the very same rules.
  consider(0, rowCount);
  // One marker: the window is pinned to the head or to the tail of the list.
  const edgeCount = Math.min(rowCount - 1, budget - 1);
  consider(0, edgeCount);
  consider(rowCount - edgeCount, rowCount);
  // Two markers: the window floats, so centre it on the cursor and clamp it
  // into the interior range that still contains the cursor.
  const interiorCount = Math.min(rowCount - 2, budget - 2);
  if (interiorCount >= 1) {
    const lowestStart = Math.max(1, anchor - interiorCount + 1);
    const highestStart = Math.min(anchor, rowCount - 1 - interiorCount);
    const centredStart = anchor - Math.floor(interiorCount / 2);
    const interiorStart = Math.min(Math.max(centredStart, lowestStart), highestStart);
    consider(interiorStart, interiorStart + interiorCount);
  }

  const visibleRows = input.rows.slice(bestStart, bestEnd);
  const hiddenBefore = bestStart;
  const hiddenAfter = rowCount - bestEnd;
  const structuralRows = visibleRows.length
    + (showHiddenBefore ? 1 : 0)
    + (showHiddenAfter ? 1 : 0);
  return {
    rows: visibleRows,
    hiddenBefore,
    hiddenAfter,
    detailLineLimit: input.expandedId
      ? Math.max(0, input.maxRows - structuralRows)
      : 0,
    showHiddenBefore,
    showHiddenAfter,
  };
}

function renderVisibleSourceRows(input: {
  readonly visibleRows: readonly ContextInspectorSourceRow[];
  readonly hiddenBefore: number;
  readonly cursorIndex: number;
  readonly focused?: boolean | undefined;
  readonly expandedId?: string | null | undefined;
  readonly maxDetailLines: number;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  return input.visibleRows.map((row, index) => renderContextInspectorSourceRow({
    row,
    selected: input.hiddenBefore + index === input.cursorIndex,
    focused: input.focused,
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
  const layout = resolveWorkShellContextDetailLayout({
    item: input.row.item,
    ...(input.content === undefined ? {} : { content: input.content }),
    width: input.width,
    maxRows: input.maxRows,
  });
  const { lines, maxOffset } = layout;
  // `maxRows` includes the margin, separator, and detail heading. Overflow
  // markers consume rows too, so reserve them before slicing the content.
  const availableRows = Math.max(1, input.maxRows - 3);
  const offset = Math.min(maxOffset, Math.max(0, input.offset));
  const hasAbove = offset > 0;
  const rowsAfterAboveMarker = Math.max(1, availableRows - (hasAbove ? 1 : 0));
  const hasBelow = offset + rowsAfterAboveMarker < lines.length;
  const visibleCount = Math.max(1, rowsAfterAboveMarker - (hasBelow ? 1 : 0));
  const visibleLines = lines.slice(offset, offset + visibleCount);
  const detailHeading = truncateForDisplayWidth(
    `Detail · ${sanitizeContextPreview(input.row.item.label)}`,
    input.width,
  );
  const detailSuffix = detailHeading.startsWith("Detail")
    ? detailHeading.slice("Detail".length)
    : "";

  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={input.palette.borderDefault}>
        {"─".repeat(Math.min(64, Math.max(24, input.width - 4)))}
      </Text>
      <Text>
        <Text color={input.palette.assistant} bold>{"Detail"}</Text>
        <Text color={input.palette.textDim}>{detailSuffix}</Text>
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
  /** Standalone callers default to Sources focus. */
  readonly focused?: boolean | undefined;
  readonly sourceCounts?: ContextPacketSourceCounts | undefined;
  readonly expandedId?: string | null | undefined;
  readonly detailContent?: string | undefined;
  readonly detailOffset?: number | undefined;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
  readonly actionsEnabled: boolean;
  /** Pane layouts place their own heading; the standalone margin is optional. */
  readonly marginTop?: number | undefined;
  /** Empty-state copy when this collection has no rows of its own. */
  readonly emptyMessage?: string | undefined;
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
    <Box marginTop={input.marginTop ?? 1} flexDirection="column">
      {input.rows.length === 0 ? (
        <Text color={input.palette.textMuted}>{input.emptyMessage ?? "No context sources yet."}</Text>
      ) : (
        <>
          {visible.showHiddenBefore ? (
            <Text color={input.palette.textDim}>{`  … ${visible.hiddenBefore} more above`}</Text>
          ) : null}
          {renderVisibleSourceRows({
            visibleRows: visible.rows,
            hiddenBefore: visible.hiddenBefore,
            cursorIndex: input.cursorIndex,
            focused: input.focused,
            ...(input.expandedId !== undefined ? { expandedId: input.expandedId } : {}),
            maxDetailLines: visible.detailLineLimit,
            width: input.width,
            palette: input.palette,
          })}
          {visible.showHiddenAfter ? (
            <Text color={input.palette.textDim}>{`  … ${visible.hiddenAfter} more below`}</Text>
          ) : null}
        </>
      )}
    </Box>
  );
}
