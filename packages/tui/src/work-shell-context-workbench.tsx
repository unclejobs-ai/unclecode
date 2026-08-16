import type {
  ContextDeskCollection,
  ContextDeskPane,
  ContextPacketChangeClassification,
  ContextPacketReceipt,
  ContextPacketView,
  ContextPacketViewActionReceipt,
  ContextPacketViewWorkNodeMetadata,
  ContextPolicySuggestion,
  WorkNodeStatus,
} from "@unclecode/contracts";
import { Box, Text } from "ink";
import React from "react";

import {
  buildContextDeskCollectionRows,
  countContextDeskSources,
  filterContextDeskRows,
  resolveContextDeskCollectionLabel,
  resolveContextDeskSelectedRow,
  resolveContextSourceGroup,
  sanitizeContextPreview,
  type ContextDeskCollectionRow,
  type ContextInspectorPalette,
  type ContextInspectorSuggestion,
  type ContextInspectorSourceRow,
} from "./work-shell-context-inspector-model.js";
import { renderContextInspectorReceipt } from "./work-shell-context-inspector-header.js";
import { renderContextInspectorGroupedViewport } from "./work-shell-context-inspector-sources.js";
import { formatContextReceiptTokenEstimate } from "./work-shell-context-receipt.js";
import { getDisplayWidth, truncateForDisplayWidth, wrapDisplayTextFast } from "./text-width.js";
import {
  computeWorkShellContextAdviceRows,
  renderWorkShellContextAdvice,
} from "./work-shell-context-advice.js";

/** Never starve the source inventory: one group row plus the selected source. */
const MIN_SOURCE_ROWS = 2;
/** Separation above the workbench is part of its physical row budget. */
const WORKBENCH_MARGIN_ROWS = 1;

type WorkbenchRowTone = "text" | "muted" | "dim" | "success" | "warning" | "accent";

/**
 * Blocks are built as row lists rather than straight JSX so the workbench can
 * pay for them out of the same row budget it gives the source viewport. A
 * block that cannot be counted cannot be afforded.
 */
type WorkbenchRow = {
  readonly key: string;
  readonly label?: string;
  readonly text: string;
  readonly tone: WorkbenchRowTone;
};

function resolveRowColor(tone: WorkbenchRowTone, palette: ContextInspectorPalette): string {
  switch (tone) {
    case "text":
      return palette.text;
    case "muted":
      return palette.textMuted;
    case "dim":
      return palette.textDim;
    case "success":
      return palette.success;
    case "warning":
      return palette.warning;
    case "accent":
      return palette.user;
  }
}

function renderWorkbenchRows(input: {
  readonly rows: readonly WorkbenchRow[];
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  if (input.rows.length === 0) {
    return null;
  }
  return (
    <Box flexDirection="column">
      {input.rows.map((row) => (
        <Text key={row.key}>
          {row.label === undefined ? null : (
            <Text color={input.palette.assistant} bold>{row.label}</Text>
          )}
          <Text color={resolveRowColor(row.tone, input.palette)}>{row.text}</Text>
        </Text>
      ))}
    </Box>
  );
}


function renderPreflightOverview(input: {
  readonly packet: ContextPacketView;
  readonly suggestion: ContextInspectorSuggestion;
  readonly packetChange?: ContextPacketChangeClassification | undefined;
  readonly unavailable?: string | undefined;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const issue = input.packet.warnings[0]?.message ?? input.unavailable;
  const meaningChanged = input.packetChange?.kind === "meaning-change";
  const review = meaningChanged || issue !== undefined || input.suggestion.tone !== "success";
  const message = issue
    ?? (meaningChanged ? "Context changed; review before sending." : input.suggestion.message);
  const prefix = review ? "Review" : "Ready";
  return (
    <Text color={review ? input.palette.warning : input.palette.success} bold>
      {truncateForDisplayWidth(`${prefix} · ${sanitizeContextPreview(message)}`, input.width)}
    </Text>
  );
}

function resolveSourceLabel(
  packet: ContextPacketView,
  sourceId: string,
  receipt?: ContextPacketReceipt,
): string {
  const item = packet.included.find((candidate) => candidate.id === sourceId)
    ?? packet.excluded.find((candidate) => candidate.id === sourceId);
  if (item) {
    return sanitizeContextPreview(item.label);
  }
  const sourceRef = receipt?.sourceRefs.find((candidate) => candidate.sourceId === sourceId);
  return sourceRef ? resolveContextSourceGroup(sourceRef.category) : "Changed source";
}

function formatCompareTokenDelta(
  next: ContextPacketReceipt,
  last: ContextPacketReceipt,
): string | undefined {
  if (
    next.tokenEstimate === undefined
    || last.tokenEstimate === undefined
    || next.tokenEstimateState === "unknown"
    || last.tokenEstimateState === "unknown"
  ) {
    return undefined;
  }
  const delta = next.tokenEstimate - last.tokenEstimate;
  if (delta === 0) {
    return undefined;
  }
  const magnitude = formatContextReceiptTokenEstimate({
    tokenEstimate: Math.abs(delta),
    tokenEstimateState: "estimated",
  });
  return `${magnitude} ${delta > 0 ? "larger" : "smaller"}`;
}

/**
 * Lifecycle comparison in the reader's terms. This used to headline with
 * `<packetId> vs <packetId>`, naming the two things being compared with the
 * only two labels the reader could not resolve.
 */
function buildContextCompareRows(input: {
  readonly packet: ContextPacketView;
  readonly previewReceipt?: ContextPacketReceipt | undefined;
  readonly submittedReceipt?: ContextPacketReceipt | undefined;
  readonly packetChange?: ContextPacketChangeClassification | undefined;
  readonly width: number;
}): readonly WorkbenchRow[] {
  const { previewReceipt, submittedReceipt } = input;
  if (!previewReceipt || !submittedReceipt) {
    return [];
  }
  const added = input.packetChange?.addedSourceIds ?? [];
  const removed = input.packetChange?.removedSourceIds ?? [];
  const delta = formatCompareTokenDelta(previewReceipt, submittedReceipt);
  if (added.length === 0 && removed.length === 0 && delta === undefined) {
    return [];
  }
  const visibleAdded = added.slice(0, 2);
  const visibleRemoved = removed.slice(0, 2);
  const hiddenCount = added.length + removed.length - visibleAdded.length - visibleRemoved.length;
  const changes = [
    ...visibleAdded.map((sourceId) => `+ ${resolveSourceLabel(input.packet, sourceId, previewReceipt)}`),
    ...visibleRemoved.map((sourceId) => `− ${resolveSourceLabel(input.packet, sourceId, submittedReceipt)}`),
    ...(hiddenCount > 0 ? [`${hiddenCount} more`] : []),
    ...(delta ? [delta] : []),
  ];
  const tone = removed.length > 0 ? "warning" : "success";
  return [
    {
      key: "compare-head",
      label: "Since last send",
      text: truncateForDisplayWidth(
        ` · ${changes[0] ?? "context changed"}`,
        Math.max(4, input.width - 16),
      ),
      tone,
    },
    ...(changes.length > 1
      ? [{
          key: "compare-rest",
          text: truncateForDisplayWidth(changes.slice(1).join(" · "), input.width),
          tone,
        } as const]
      : []),
  ];
}

/**
 * A work node is not "tool activity". Every status maps to the thing the
 * reader would do next, so the runbook reads as a plan rather than a log.
 */
const WORK_NODE_STATUS_LINES: Readonly<Record<WorkNodeStatus, readonly [string, string]>> = {
  proposed: ["Next", "Approve this plan to start"],
  approved: ["Next", "Queued to start"],
  ready: ["Next", "Ready to start"],
  running: ["Status", "Running now"],
  blocked: ["Next", "Blocked on another work item"],
  requires_action: ["Next", "Needs your input"],
  completed: ["Status", "Completed"],
  failed: ["Next", "Failed · needs a retry"],
  cancelled: ["Status", "Cancelled"],
};

function findContextWorkNodes(
  packet: ContextPacketView,
): readonly ContextPacketViewWorkNodeMetadata[] {
  const nodes: ContextPacketViewWorkNodeMetadata[] = [];
  for (const item of [...packet.included, ...packet.excluded]) {
    if (item.metadata?.kind === "work-node") {
      nodes.push(item.metadata);
    }
  }
  return nodes;
}

function buildRunbookListRows(input: {
  readonly key: string;
  readonly heading: string;
  readonly items: readonly string[];
  readonly max: number;
  readonly noun: string;
  readonly tone: WorkbenchRowTone;
  readonly width: number;
}): readonly WorkbenchRow[] {
  if (input.items.length === 0) {
    return [];
  }
  // `  <heading> · ` is the widest prefix a row in this list can carry.
  const bodyWidth = Math.max(4, input.width - input.heading.length - 5);
  const visible = input.items.slice(0, Math.max(1, input.max));
  const hidden = input.items.length - visible.length;
  return [
    ...visible.map((item, index): WorkbenchRow => ({
      key: `${input.key}-${index}`,
      text: index === 0
        ? `  ${input.heading} · ${truncateForDisplayWidth(sanitizeContextPreview(item), bodyWidth)}`
        : `    · ${truncateForDisplayWidth(sanitizeContextPreview(item), bodyWidth)}`,
      tone: input.tone,
    })),
    ...(hidden > 0
      ? [{
          key: `${input.key}-more`,
          text: truncateForDisplayWidth(
            `    · … ${hidden} more ${input.noun}${hidden === 1 ? "" : "s"}`,
            input.width,
          ),
          tone: "dim",
        } as const]
      : []),
  ];
}

function buildContextRunbookRows(input: {
  readonly nodes: readonly ContextPacketViewWorkNodeMetadata[];
  readonly compact: boolean;
  readonly width: number;
}): readonly WorkbenchRow[] {
  const node = input.nodes[0];
  if (!node) {
    return [];
  }
  const goal = node.goal?.trim();
  const [statusPrefix, statusText] = WORK_NODE_STATUS_LINES[node.status];
  const collected = node.evidenceRefs.length;
  const required = node.acceptanceCriteria.length;
  const evidence = required > 0
    ? `${collected} of ${required} collected`
    : collected > 0
      ? `${collected} collected`
      : "none collected yet";
  const listMax = input.compact ? 1 : 2;
  return [
    {
      key: "runbook-head",
      label: "Runbook",
      text: truncateForDisplayWidth(
        ` · ${sanitizeContextPreview(goal ? goal : node.title)}`,
        Math.max(4, input.width - 8),
      ),
      tone: "muted",
    },
    ...(goal
      ? [{
          key: "runbook-task",
          text: `  Doing · ${truncateForDisplayWidth(sanitizeContextPreview(node.title), Math.max(4, input.width - 12))}`,
          tone: "text",
        } as const]
      : []),
    {
      key: "runbook-status",
      text: truncateForDisplayWidth(`  ${statusPrefix} · ${statusText}`, input.width),
      tone: "accent",
    },
    ...buildRunbookListRows({
      key: "runbook-constraint",
      heading: "Must hold",
      items: input.compact && node.constraints.length > 1
        ? [`${node.constraints[0]} (+${node.constraints.length - 1} more)`]
        : node.constraints,
      max: listMax,
      noun: "constraint",
      tone: "muted",
      width: input.width,
    }),
    ...buildRunbookListRows({
      key: "runbook-criterion",
      heading: "Accepted when",
      items: input.compact && node.acceptanceCriteria.length > 1
        ? [`${node.acceptanceCriteria[0]} (+${node.acceptanceCriteria.length - 1} more)`]
        : node.acceptanceCriteria,
      max: listMax,
      noun: "check",
      tone: "text",
      width: input.width,
    }),
    {
      key: "runbook-evidence",
      text: truncateForDisplayWidth(`  Evidence · ${evidence}`, input.width),
      tone: "muted",
    },
    ...(input.nodes.length > 1
      ? [{
          key: "runbook-more",
          text: truncateForDisplayWidth(
            `  … ${input.nodes.length - 1} more work items`,
            input.width,
          ),
          tone: "dim",
        } as const]
      : []),
  ];
}

function renderSelectedPreview(input: {
  readonly row?: ContextInspectorSourceRow | undefined;
  readonly maxLines: number;
  readonly compact: boolean;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
  /** Line offset into the wrapped preview; only honored when scrollable. */
  readonly scrollOffset?: number | undefined;
  /** Preview-pane focus: the body scrolls and proves overflow with markers. */
  readonly scrollable?: boolean | undefined;
}): React.ReactNode {
  const marginTop = input.compact ? 0 : 1;
  if (!input.row) {
    return (
      <Box marginTop={marginTop} flexDirection="column">
        <Text color={input.palette.textMuted}>
          {truncateForDisplayWidth("Selected · choose a source", input.width)}
        </Text>
      </Box>
    );
  }
  const preview = sanitizeContextPreview(input.row.item.preview ?? input.row.item.reason);
  const wrapped = wrapDisplayTextFast(preview, input.width);
  const maxLines = Math.max(0, input.maxLines);
  const scrollable = input.scrollable === true && maxLines > 0;
  const maxOffset = scrollable ? Math.max(0, wrapped.length - maxLines) : 0;
  const offset = Math.min(Math.max(0, input.scrollOffset ?? 0), maxOffset);
  const lines = wrapped.slice(offset, offset + maxLines);
  const hiddenAfter = wrapped.length - offset - lines.length;
  return (
    <Box marginTop={marginTop} flexDirection="column">
      <Text>
        <Text color={input.palette.user} bold>{"Selected"}</Text>
        <Text color={input.palette.textMuted}>
          {truncateForDisplayWidth(
            ` · ${sanitizeContextPreview(input.row.item.label)}`,
            Math.max(4, input.width - 9),
          )}
        </Text>
      </Text>
      {scrollable && offset > 0 ? (
        <Text color={input.palette.textDim}>{`  … ${offset} more above`}</Text>
      ) : null}
      {lines.map((line, index) => (
        <Text key={`context-preview-${input.row?.item.id}-${offset + index}`} color={input.palette.text}>
          {line}
        </Text>
      ))}
      {scrollable && hiddenAfter > 0 ? (
        <Text color={input.palette.textDim}>{`  … ${hiddenAfter} more below`}</Text>
      ) : null}
    </Box>
  );
}
/**
 * Count exactly what the selected-preview renderer paints, excluding its
 * optional top margin. In particular, scrolled previews can spend rows on
 * either overflow marker, and a zero-line budget still paints its heading.
 */
function countSelectedPreviewRows(input: {
  readonly row?: ContextInspectorSourceRow | undefined;
  readonly maxLines: number;
  readonly width: number;
  readonly scrollOffset?: number | undefined;
  readonly scrollable?: boolean | undefined;
}): number {
  if (!input.row) {
    return 1;
  }
  const preview = sanitizeContextPreview(input.row.item.preview ?? input.row.item.reason);
  const wrapped = wrapDisplayTextFast(preview, input.width);
  const maxLines = Math.max(0, input.maxLines);
  const scrollable = input.scrollable === true && maxLines > 0;
  const maxOffset = scrollable ? Math.max(0, wrapped.length - maxLines) : 0;
  const offset = Math.min(Math.max(0, input.scrollOffset ?? 0), maxOffset);
  const visibleLines = wrapped.slice(offset, offset + maxLines);
  const hiddenAfter = wrapped.length - offset - visibleLines.length;
  return 1
    + visibleLines.length
    + (scrollable && offset > 0 ? 1 : 0)
    + (scrollable && hiddenAfter > 0 ? 1 : 0);
}

/** Uppercase pane name in the desk's own voice; sub-blocks dim one step. */
function renderDeskPaneHeading(input: {
  readonly label: string;
  readonly suffix?: string | undefined;
  readonly dim?: boolean | undefined;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  return (
    <Text>
      <Text color={input.dim === true ? input.palette.textDim : input.palette.assistant} bold>
        {truncateForDisplayWidth(input.label, input.width)}
      </Text>
      {input.suffix === undefined ? null : (
        <Text color={input.palette.textDim}>
          {truncateForDisplayWidth(
            ` · ${input.suffix}`,
            Math.max(0, input.width - getDisplayWidth(input.label)),
          )}
        </Text>
      )}
    </Text>
  );
}

function renderDeskCollectionRow(input: {
  readonly row: ContextDeskCollectionRow;
  readonly active: boolean;
  readonly focused: boolean;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const { row, palette } = input;
  // Yazi-style right-aligned count: the label yields cells to the count, never
  // the other way around, so a narrow Groups pane keeps counts readable.
  const countLabel = String(row.count);
  const deliveryMarker = row.lane === "delivery"
    ? row.id === "sent" ? "● " : "○ "
    : "";
  const prefix = deliveryMarker.length > 0
    ? `${input.active && input.focused ? "› " : ""}${deliveryMarker}`
    : input.active
      ? input.focused ? "› " : "● "
      : "  ";
  // The label owns whatever the actual prefix and right-aligned count leave.
  const labelWidth = Math.max(1, input.width - getDisplayWidth(prefix) - 1 - countLabel.length);
  const label = truncateForDisplayWidth(row.label, labelWidth).padEnd(labelWidth);
  const prefixColor = input.active
    ? palette.user
    : row.lane === "delivery" && row.id === "sent"
      ? palette.success
      : palette.textDim;
  return (
    <Text>
      <Text color={prefixColor} bold={input.active && input.focused}>{prefix}</Text>
      <Text
        color={input.active ? (input.focused ? palette.text : palette.user) : palette.textMuted}
        bold={input.active && input.focused}
      >
        {label}
      </Text>
      <Text color={input.active ? palette.text : palette.textDim}>{` ${countLabel}`}</Text>
    </Text>
  );
}

/**
 * The Groups pane: every collection in canonical walk order, then the two
 * delivery lanes. When the row budget cannot pay for the whole block, the
 * DELIVERY heading is the first thing to go, then the collection list windows
 * around the active row — a heading is never left orphaned from its rows.
 */
function renderDeskGroupsPane(input: {
  readonly collections: readonly ContextDeskCollectionRow[];
  readonly activeCollection: ContextDeskCollection;
  readonly focused: boolean;
  readonly maxRows: number;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const { palette } = input;
  const allRows = input.collections;
  const deliveryIndex = allRows.findIndex((row) => row.lane === "delivery");
  const deliveryRowCount = allRows.filter((row) => row.lane === "delivery").length;
  const naturalRows = 1 + allRows.length + (deliveryIndex >= 0 ? 1 : 0);
  const fitsFull = naturalRows <= input.maxRows;
  const fitsWithoutDeliveryHeading = 1 + allRows.length <= input.maxRows;
  const rowBudget = Math.max(1, input.maxRows - 1);
  let visible = allRows;
  let hiddenBefore = 0;
  let hiddenAfter = 0;
  let showHiddenBefore = false;
  let showHiddenAfter = false;
  let constrainedGroupRows: readonly ContextDeskCollectionRow[] | undefined;
  let constrainedDeliveryRows: readonly ContextDeskCollectionRow[] | undefined;
  let constrainedHiddenCount = 0;
  if (
    !fitsFull
    && !fitsWithoutDeliveryHeading
    && allRows.length > rowBudget
    && rowBudget >= deliveryRowCount + 2
  ) {
    const groupRows = allRows.filter((row) => row.lane === "groups");
    const deliveryRows = allRows.filter((row) => row.lane === "delivery");
    const groupBudget = Math.max(1, rowBudget - deliveryRows.length);
    const visibleGroupCount = groupRows.length > groupBudget
      ? Math.max(1, groupBudget - 1)
      : groupRows.length;
    const activeGroupIndex = groupRows.findIndex((row) => row.id === input.activeCollection);
    const maxStart = Math.max(0, groupRows.length - visibleGroupCount);
    const centeredStart = activeGroupIndex >= 0
      ? activeGroupIndex - Math.floor(visibleGroupCount / 2)
      : 0;
    const groupStart = Math.min(maxStart, Math.max(0, centeredStart));
    constrainedGroupRows = groupRows.slice(groupStart, groupStart + visibleGroupCount);
    constrainedDeliveryRows = deliveryRows;
    constrainedHiddenCount = groupRows.length - constrainedGroupRows.length;
  } else if (!fitsFull && allRows.length > rowBudget) {
    const activeIndex = Math.max(
      0,
      allRows.findIndex((row) => row.id === input.activeCollection),
    );
    let bestStart = activeIndex;
    let bestEnd = activeIndex + 1;
    let bestCount = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let start = 0; start <= activeIndex; start += 1) {
      for (let end = start + 1; end <= allRows.length; end += 1) {
        if (end <= activeIndex) {
          continue;
        }
        const markers = (start > 0 ? 1 : 0) + (end < allRows.length ? 1 : 0);
        if (end - start + markers > rowBudget) {
          continue;
        }
        const count = end - start;
        const distance = Math.abs((start + end - 1) / 2 - activeIndex);
        if (count > bestCount || (count === bestCount && distance < bestDistance)) {
          bestStart = start;
          bestEnd = end;
          bestCount = count;
          bestDistance = distance;
          showHiddenBefore = start > 0;
          showHiddenAfter = end < allRows.length;
        }
      }
    }
    visible = allRows.slice(bestStart, bestEnd);
    hiddenBefore = bestStart;
    hiddenAfter = allRows.length - bestEnd;
  }
  const showDeliveryHeading = fitsFull && deliveryIndex >= 0;
  return (
    <Box flexDirection="column">
      {renderDeskPaneHeading({ label: "GROUPS", width: input.width, palette })}
      {constrainedGroupRows !== undefined ? (
        <>
          {constrainedGroupRows.map((row) => (
            <React.Fragment key={`context-collection-${row.id}`}>
              {renderDeskCollectionRow({
                row,
                active: row.id === input.activeCollection,
                focused: input.focused,
                width: input.width,
                palette,
              })}
            </React.Fragment>
          ))}
          {constrainedHiddenCount > 0 ? (
            <Text color={palette.textDim}>
              {truncateForDisplayWidth(
                `  … ${constrainedHiddenCount} more collections`,
                input.width,
              )}
            </Text>
          ) : null}
          {constrainedDeliveryRows?.map((row) => (
            <React.Fragment key={`context-collection-${row.id}`}>
              {renderDeskCollectionRow({
                row,
                active: row.id === input.activeCollection,
                focused: input.focused,
                width: input.width,
                palette,
              })}
            </React.Fragment>
          ))}
        </>
      ) : (
        <>
          {showHiddenBefore ? (
            <Text color={palette.textDim}>{`  … ${hiddenBefore} more above`}</Text>
          ) : null}
          {visible.map((row, index) => (
            <React.Fragment key={`context-collection-${row.id}`}>
              {showDeliveryHeading && hiddenBefore + index === deliveryIndex
                ? renderDeskPaneHeading({ label: "DELIVERY", dim: true, width: input.width, palette })
                : null}
              {renderDeskCollectionRow({
                row,
                active: row.id === input.activeCollection,
                focused: input.focused,
                width: input.width,
                palette,
              })}
            </React.Fragment>
          ))}
          {showHiddenAfter ? (
            <Text color={palette.textDim}>{`  … ${hiddenAfter} more below`}</Text>
          ) : null}
        </>
      )}
    </Box>
  );
}

/** Full overlay width at which all three panes stand side by side. */
const DESK_THREE_PANE_MIN_WIDTH = 96;
/** Below this the desk stacks and lets the focused pane lead. */
const DESK_MEDIUM_MIN_WIDTH = 76;

export function renderContextInspectorWorkbench(input: {
  readonly packet: ContextPacketView;
  readonly rows: readonly ContextInspectorSourceRow[];
  readonly suggestion: ContextInspectorSuggestion;
  readonly cursorIndex: number;
  readonly activePane: ContextDeskPane;
  readonly activeCollection: ContextDeskCollection;
  readonly expandedId?: string | null | undefined;
  readonly detailContent?: string | undefined;
  readonly detailOffset?: number | undefined;
  readonly width: number;
  readonly maxRows: number;
  readonly palette: ContextInspectorPalette;
  readonly actionsEnabled: boolean;
  readonly actionReceipt?: ContextPacketViewActionReceipt | undefined;
  readonly previewReceipt?: ContextPacketReceipt | undefined;
  readonly submittedReceipt?: ContextPacketReceipt | undefined;
  readonly packetChange?: ContextPacketChangeClassification | undefined;
  readonly policySuggestions: readonly ContextPolicySuggestion[];
  readonly adviceUnavailable?: string | undefined;
  readonly adviceActionsEnabled: boolean;
}): React.ReactNode {
  const { activePane, activeCollection } = input;
  const filteredRows = filterContextDeskRows(input.rows, activeCollection);
  const selectedRow = resolveContextDeskSelectedRow(filteredRows, input.cursorIndex);
  const collectionRows = buildContextDeskCollectionRows(input.rows);
  const collectionLabel = resolveContextDeskCollectionLabel(activeCollection);
  const expanded = Boolean(input.expandedId);

  const isThreePane = !expanded && input.width >= DESK_THREE_PANE_MIN_WIDTH;
  const isMedium = !expanded && input.width >= DESK_MEDIUM_MIN_WIDTH;
  const isStacked = !isThreePane && !isMedium && !expanded;

  // Column geometry. The overlay box spends 4 cells on its border and padding,
  // so every pane is allocated out of width − 4 and the panes on one row add
  // up to it exactly. A pane wider than its share does not overflow the frame
  // — ink wraps it — so a hard minimum here costs a wrapped row on every line
  // the pane paints.
  const contentWidth = Math.max(24, input.width - 4);
  const groupsWidth = isThreePane
    ? Math.min(24, Math.max(16, Math.floor(input.width * 0.17)))
    : 0;
  const previewPaneWidth = isThreePane
    ? Math.min(58, Math.max(44, Math.floor(input.width * 0.4) + 2))
    : 0;
  // Sources takes what Groups and Preview leave, which keeps exact-fit rows
  // off the wrap boundary at the 100-column breakpoint. The three-pane
  // breakpoint guarantees this is at least 32 cells.
  const sourcesPaneWidth = isThreePane ? contentWidth - groupsWidth - previewPaneWidth : 0;
  // The medium frame is one row of two columns; its breakpoint guarantees at
  // least 72 content cells, so Preview keeps 33+ and Sources 39+.
  const previewWidth = isThreePane
    ? previewPaneWidth
    : isMedium
      ? Math.floor(contentWidth * 0.46)
      : 0;
  const sourceWidth = isThreePane
    ? sourcesPaneWidth
    : isMedium
      ? contentWidth - previewWidth
      : contentWidth;
  const asideWidth = isThreePane || isMedium ? previewWidth - 2 : contentWidth;
  const sourcesInnerWidth = isThreePane ? sourcesPaneWidth - 2 : sourceWidth;

  const receiptRows = input.actionReceipt ? 1 : 0;
  const contentRows = Math.max(
    1,
    input.maxRows - (expanded ? 0 : WORKBENCH_MARGIN_ROWS) - receiptRows,
  );
  const overviewRows = expanded ? 0 : 1;
  // The collection context line names the active filter wherever neither the
  // Groups pane nor a SOURCES heading suffix is on screen to explain it.
  const collectionLineRows = !isThreePane && activeCollection !== "all" && activePane !== "groups" ? 1 : 0;
  const scrollablePreview = activePane === "preview";
  const previewScrollOffset = scrollablePreview ? (input.detailOffset ?? 0) : 0;
  const sourceMarginRows = isThreePane ? 0 : 1;
  const previewMarginRows = isMedium ? 1 : 0;

  let denseAdvice = false;
  let adviceRows = computeWorkShellContextAdviceRows({
    suggestions: input.policySuggestions,
    packet: input.packet,
    ...(input.adviceUnavailable ? { unavailable: input.adviceUnavailable } : {}),
    ...(selectedRow ? { selectedSourceId: selectedRow.item.id } : {}),
    actionsEnabled: input.adviceActionsEnabled,
    compact: isStacked,
  });
  const adviceMarginRows = () => !isStacked && adviceRows > 0 ? 1 : 0;
  let runbook = buildContextRunbookRows({
    nodes: findContextWorkNodes(input.packet),
    compact: isStacked,
    width: asideWidth,
  });
  let compare = buildContextCompareRows({
    packet: input.packet,
    ...(input.previewReceipt ? { previewReceipt: input.previewReceipt } : {}),
    ...(input.submittedReceipt ? { submittedReceipt: input.submittedReceipt } : {}),
    ...(input.packetChange ? { packetChange: input.packetChange } : {}),
    width: asideWidth,
  });
  let previewLines = isThreePane
    ? (scrollablePreview ? 6 : 4)
    : isMedium
      ? (scrollablePreview ? 5 : 3)
      : (scrollablePreview ? 4 : 2);
  const previewRenderedRows = () => countSelectedPreviewRows({
    ...(selectedRow ? { row: selectedRow } : {}),
    maxLines: previewLines,
    width: asideWidth,
    ...(scrollablePreview ? { scrollOffset: previewScrollOffset, scrollable: true } : {}),
  });
  let sourceRows: number;
  let columnRows = 0;
  let groupsRows = 0;

  if (expanded) {
    sourceRows = contentRows;
  } else if (isThreePane) {
    columnRows = Math.max(MIN_SOURCE_ROWS + 1, contentRows - overviewRows);
    sourceRows = Math.max(1, columnRows - 1);
    // The Preview pane carries the selected preview plus the aside blocks;
    // trim decorations before evidence, exactly like the legacy wide layout.
    const asideBudget = Math.max(1, columnRows - 1);
    const asideRows = () =>
      previewRenderedRows()
      + previewMarginRows
      + adviceRows
      + adviceMarginRows()
      + runbook.length
      + compare.length;
    if (asideRows() > asideBudget) {
      denseAdvice = true;
      adviceRows = computeWorkShellContextAdviceRows({
        suggestions: input.policySuggestions,
        packet: input.packet,
        ...(input.adviceUnavailable ? { unavailable: input.adviceUnavailable } : {}),
        ...(selectedRow ? { selectedSourceId: selectedRow.item.id } : {}),
        actionsEnabled: input.adviceActionsEnabled,
        dense: true,
      });
      runbook = runbook.slice(0, 3);
      previewLines = Math.min(previewLines, 2);
    }
    while (asideRows() > asideBudget && runbook.length > 0) {
      runbook = runbook.slice(0, -1);
    }
    while (asideRows() > asideBudget && compare.length > 0) {
      compare = compare.slice(0, -1);
    }
    if (
      previewRenderedRows()
      + previewMarginRows
      + adviceRows
      + adviceMarginRows() > asideBudget
    ) {
      previewLines = 0;
    }
  } else if (isMedium) {
    columnRows = Math.max(MIN_SOURCE_ROWS, contentRows - overviewRows);
    sourceRows = Math.max(1, columnRows - sourceMarginRows - collectionLineRows);
    const previewColumnRows = () =>
      previewRenderedRows()
      + previewMarginRows
      + adviceRows
      + adviceMarginRows()
      + runbook.length
      + compare.length;
    if (previewColumnRows() > columnRows) {
      denseAdvice = true;
      adviceRows = computeWorkShellContextAdviceRows({
        suggestions: input.policySuggestions,
        packet: input.packet,
        ...(input.adviceUnavailable ? { unavailable: input.adviceUnavailable } : {}),
        ...(selectedRow ? { selectedSourceId: selectedRow.item.id } : {}),
        actionsEnabled: input.adviceActionsEnabled,
        dense: true,
      });
      runbook = runbook.slice(0, 3);
      previewLines = Math.min(previewLines, 2);
    }
    while (previewColumnRows() > columnRows && runbook.length > 0) {
      runbook = runbook.slice(0, -1);
    }
    while (previewColumnRows() > columnRows && compare.length > 0) {
      compare = compare.slice(0, -1);
    }
    if (
      previewRenderedRows()
      + previewMarginRows
      + adviceRows
      + adviceMarginRows() > columnRows
    ) {
      previewLines = 0;
    }
  } else if (activePane === "groups") {
    // Narrow Groups focus: collections lead, the filtered sources prove the
    // active collection, and the preview yields rows first.
    groupsRows = Math.min(
      1 + collectionRows.length + 1,
      Math.max(2, contentRows - overviewRows - MIN_SOURCE_ROWS - sourceMarginRows),
    );
    const previewSpace = contentRows - overviewRows - groupsRows - sourceMarginRows - MIN_SOURCE_ROWS;
    previewLines = Math.min(previewLines, 2);
    if (previewRenderedRows() > Math.max(0, previewSpace)) {
      previewLines = 0;
    }
    sourceRows = Math.max(
      1,
      contentRows - overviewRows - groupsRows - sourceMarginRows - previewRenderedRows(),
    );
    adviceRows = 0;
    runbook = [];
    compare = [];
  } else {
    const narrowRows = () =>
      overviewRows
      + collectionLineRows
      + runbook.length
      + compare.length
      + adviceRows
      + adviceMarginRows()
      + previewRenderedRows()
      + previewMarginRows
      + sourceMarginRows
      + MIN_SOURCE_ROWS;
    if (narrowRows() > contentRows) {
      denseAdvice = true;
      adviceRows = computeWorkShellContextAdviceRows({
        suggestions: input.policySuggestions,
        packet: input.packet,
        ...(input.adviceUnavailable ? { unavailable: input.adviceUnavailable } : {}),
        ...(selectedRow ? { selectedSourceId: selectedRow.item.id } : {}),
        actionsEnabled: input.adviceActionsEnabled,
        compact: true,
        dense: true,
      });
      runbook = runbook.slice(0, 2);
    }
    while (narrowRows() > contentRows && compare.length > 0) {
      compare = compare.slice(0, -1);
    }
    while (narrowRows() > contentRows && runbook.length > 0) {
      runbook = runbook.slice(0, -1);
    }
    if (
      overviewRows
      + collectionLineRows
      + adviceRows
      + adviceMarginRows()
      + previewRenderedRows()
      + previewMarginRows
      + sourceMarginRows
      + MIN_SOURCE_ROWS > contentRows
    ) {
      previewLines = 0;
    }
    const fixedRows = overviewRows + collectionLineRows + runbook.length + compare.length
      + adviceRows + adviceMarginRows() + previewRenderedRows() + previewMarginRows + sourceMarginRows;
    sourceRows = Math.max(1, contentRows - fixedRows);
  }

  const sourceRegion = renderContextInspectorGroupedViewport({
    rows: expanded ? input.rows : filteredRows,
    maxRows: sourceRows,
    cursorIndex: input.cursorIndex,
    focused: activePane === "sources",
    sourceCounts: input.packet.sourceCounts,
    ...(input.expandedId !== undefined ? { expandedId: input.expandedId } : {}),
    ...(input.detailContent !== undefined ? { detailContent: input.detailContent } : {}),
    ...(input.detailOffset !== undefined ? { detailOffset: input.detailOffset } : {}),
    width: sourcesInnerWidth,
    palette: input.palette,
    actionsEnabled: input.actionsEnabled,
    ...(isThreePane ? { marginTop: 0 } : {}),
    ...(activeCollection !== "all" ? { emptyMessage: "No sources in this collection." } : {}),
  });
  const advice = renderWorkShellContextAdvice({
    packet: input.packet,
    suggestions: input.policySuggestions,
    ...(input.adviceUnavailable ? { unavailable: input.adviceUnavailable } : {}),
    ...(selectedRow ? { selectedSourceId: selectedRow.item.id } : {}),
    actionsEnabled: input.adviceActionsEnabled,
    palette: input.palette,
    width: asideWidth,
    compact: isStacked,
    dense: denseAdvice,
  });
  const overview = renderPreflightOverview({
    packet: input.packet,
    suggestion: input.suggestion,
    ...(input.packetChange ? { packetChange: input.packetChange } : {}),
    ...(input.adviceUnavailable ? { unavailable: input.adviceUnavailable } : {}),
    width: contentWidth,
    palette: input.palette,
  });
  const runbookBlock = renderWorkbenchRows({ rows: runbook, palette: input.palette });
  const compareBlock = renderWorkbenchRows({ rows: compare, palette: input.palette });
  const preview = renderSelectedPreview({
    ...(selectedRow ? { row: selectedRow } : {}),
    maxLines: previewLines,
    compact: isStacked || isThreePane,
    width: asideWidth,
    palette: input.palette,
    ...(scrollablePreview ? { scrollOffset: previewScrollOffset, scrollable: true } : {}),
  });
  const groupsPane = renderDeskGroupsPane({
    collections: collectionRows,
    activeCollection,
    focused: activePane === "groups",
    maxRows: Math.max(2, isThreePane || isMedium ? columnRows : groupsRows),
    // Collection rows are padded to the pane's inner width, so hand the pane
    // the real inner width; a padded row that wraps would paint two lines.
    width: isThreePane ? groupsWidth : isMedium ? sourceWidth : contentWidth,
    palette: input.palette,
  });
  // Compact frames hide the Groups pane, so this line carries the only count
  // on screen; it reduces with the desk's one source-count rule so the same
  // collection never reads as two sizes in one session.
  const collectionSourceCount = countContextDeskSources(filteredRows);
  const collectionContextLine = collectionLineRows > 0 ? (
    <Text color={input.palette.textDim}>
      {truncateForDisplayWidth(
        `Collection · ${collectionLabel} · ${collectionSourceCount} ${collectionSourceCount === 1 ? "source" : "sources"}`,
        isMedium ? sourceWidth : contentWidth,
      )}
    </Text>
  ) : null;
  return (
    <Box marginTop={expanded ? 0 : 1} flexDirection="column">
      {expanded ? sourceRegion : (
        <>
          {overview}
          {isThreePane ? (
            <Box flexDirection="row">
              <Box width={groupsWidth} flexDirection="column">
                {groupsPane}
              </Box>
              <Box width={sourcesPaneWidth} paddingLeft={2} flexDirection="column">
                {renderDeskPaneHeading({
                  label: "SOURCES",
                  ...(activeCollection !== "all" ? { suffix: collectionLabel } : {}),
                  width: sourcesInnerWidth,
                  palette: input.palette,
                })}
                {sourceRegion}
              </Box>
              <Box width={previewPaneWidth} paddingLeft={2} flexDirection="column">
                {renderDeskPaneHeading({
                  label: "PREVIEW",
                  width: asideWidth,
                  palette: input.palette,
                })}
                {preview}
                {advice}
                {runbookBlock}
                {compareBlock}
              </Box>
            </Box>
          ) : isMedium ? (
            <Box flexDirection="row">
              <Box width={sourceWidth} flexDirection="column">
                {activePane === "groups" ? groupsPane : (
                  <>
                    {collectionContextLine}
                    {sourceRegion}
                  </>
                )}
              </Box>
              <Box width={previewWidth} paddingLeft={2} flexDirection="column">
                {preview}
                {advice}
                {runbookBlock}
                {compareBlock}
              </Box>
            </Box>
          ) : activePane === "groups" ? (
            <>
              {groupsPane}
              {sourceRegion}
              {preview}
            </>
          ) : (
            <>
              {preview}
              {collectionContextLine}
              {sourceRegion}
              {advice}
              {runbookBlock}
              {compareBlock}
            </>
          )}
        </>
      )}
      {renderContextInspectorReceipt({
        ...(input.actionReceipt ? { receipt: input.actionReceipt } : {}),
        width: contentWidth,
        palette: input.palette,
      })}
    </Box>
  );
}
