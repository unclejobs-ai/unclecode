import type {
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
  formatContextTokenEstimate,
  resolveContextSourceGroup,
  sanitizeContextPreview,
  type ContextInspectorPalette,
  type ContextInspectorSuggestion,
  type ContextInspectorSourceRow,
} from "./work-shell-context-inspector-model.js";
import { renderContextInspectorReceipt } from "./work-shell-context-inspector-header.js";
import { renderContextInspectorGroupedViewport } from "./work-shell-context-inspector-sources.js";
import { formatContextReceiptTokenEstimate } from "./work-shell-context-receipt.js";
import { truncateForDisplayWidth, wrapDisplayTextFast } from "./text-width.js";
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
  readonly unavailable?: string | undefined;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const issue = input.packet.warnings[0]?.message ?? input.unavailable;
  const message = issue
    ? `Review · ${issue}`
    : `Ready · ${input.suggestion.message}`;
  const color = issue
    ? input.palette.warning
    : input.suggestion.tone === "success"
      ? input.palette.success
      : input.palette.user;
  return (
    <Text color={color} bold>
      {truncateForDisplayWidth(message, Math.max(18, input.width))}
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
        Math.max(18, input.width - 16),
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
  const bodyWidth = Math.max(12, input.width - input.heading.length - 4);
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
          text: `    · … ${hidden} more ${input.noun}${hidden === 1 ? "" : "s"}`,
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
        Math.max(12, input.width - 8),
      ),
      tone: "muted",
    },
    ...(goal
      ? [{
          key: "runbook-task",
          text: `  Doing · ${truncateForDisplayWidth(sanitizeContextPreview(node.title), Math.max(12, input.width - 12))}`,
          tone: "text",
        } as const]
      : []),
    { key: "runbook-status", text: `  ${statusPrefix} · ${statusText}`, tone: "accent" },
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
    { key: "runbook-evidence", text: `  Evidence · ${evidence}`, tone: "muted" },
    ...(input.nodes.length > 1
      ? [{
          key: "runbook-more",
          text: `  … ${input.nodes.length - 1} more work items`,
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
}): React.ReactNode {
  const marginTop = input.compact ? 0 : 1;
  if (!input.row) {
    return (
      <Box marginTop={marginTop} flexDirection="column">
        <Text color={input.palette.textMuted}>{"Selected · choose a source"}</Text>
      </Box>
    );
  }
  const preview = sanitizeContextPreview(input.row.item.preview ?? input.row.item.reason);
  const lines = wrapDisplayTextFast(preview, Math.max(18, input.width)).slice(0, input.maxLines);
  return (
    <Box marginTop={marginTop} flexDirection="column">
      <Text>
        <Text color={input.palette.user} bold>{"Selected"}</Text>
        <Text color={input.palette.textMuted}>
          {truncateForDisplayWidth(
            ` · ${sanitizeContextPreview(input.row.item.label)}`,
            Math.max(18, input.width - 9),
          )}
        </Text>
      </Text>
      {lines.map((line, index) => (
        <Text key={`context-preview-${input.row?.item.id}-${index}`} color={input.palette.text}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

export function renderContextInspectorWorkbench(input: {
  readonly packet: ContextPacketView;
  readonly rows: readonly ContextInspectorSourceRow[];
  readonly suggestion: ContextInspectorSuggestion;
  readonly cursorIndex: number;
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
  const selectedRow = input.rows.find((row) => row.sourceIndex === input.cursorIndex);
  const isWide = input.width >= 116 && !input.expandedId;
  const isMedium = input.width >= 76 && !input.expandedId;
  const isStacked = !isMedium;
  const previewWidth = isWide
    ? Math.max(42, Math.floor(input.width * 0.38))
    : Math.max(30, Math.min(Math.floor(input.width * 0.46), input.width - 38));
  const sourceWidth = isMedium
    ? Math.max(36, input.width - previewWidth - 2)
    : input.width;
  const asideWidth = isMedium ? Math.max(28, previewWidth - 2) : input.width;
  const receiptRows = input.actionReceipt ? 1 : 0;
  const contentRows = Math.max(
    1,
    input.maxRows - (input.expandedId ? 0 : WORKBENCH_MARGIN_ROWS) - receiptRows,
  );
  const overviewRows = 1;
  let denseAdvice = false;
  let adviceRows = computeWorkShellContextAdviceRows({
    suggestions: input.policySuggestions,
    ...(input.adviceUnavailable ? { unavailable: input.adviceUnavailable } : {}),
    ...(selectedRow ? { selectedSourceId: selectedRow.item.id } : {}),
    actionsEnabled: input.adviceActionsEnabled,
    compact: isStacked,
  });
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
  let previewLines = isWide ? 4 : isMedium ? 3 : 2;
  let sourceRows: number;

  if (input.expandedId) {
    sourceRows = contentRows;
  } else if (isStacked) {
    if (
      overviewRows + runbook.length + compare.length + adviceRows
      + previewLines + 2 + MIN_SOURCE_ROWS > contentRows
    ) {
      denseAdvice = true;
      adviceRows = computeWorkShellContextAdviceRows({
        suggestions: input.policySuggestions,
        ...(input.adviceUnavailable ? { unavailable: input.adviceUnavailable } : {}),
        ...(selectedRow ? { selectedSourceId: selectedRow.item.id } : {}),
        actionsEnabled: input.adviceActionsEnabled,
        compact: true,
        dense: true,
      });
      runbook = runbook.slice(0, 2);
    }
    while (
      overviewRows + runbook.length + compare.length + adviceRows
      + previewLines + 2 + MIN_SOURCE_ROWS > contentRows
      && compare.length > 0
    ) {
      compare = compare.slice(0, -1);
    }
    while (
      overviewRows + runbook.length + adviceRows
      + previewLines + 2 + MIN_SOURCE_ROWS > contentRows
      && runbook.length > 0
    ) {
      runbook = runbook.slice(0, -1);
    }
    if (
      overviewRows + adviceRows + previewLines + 2 + MIN_SOURCE_ROWS > contentRows
    ) {
      previewLines = 0;
    }
    const fixedRows = overviewRows + runbook.length + compare.length + adviceRows + previewLines + 2;
    sourceRows = Math.max(1, contentRows - fixedRows);
  } else {
    const columnRows = Math.max(
      MIN_SOURCE_ROWS,
      contentRows - overviewRows - 1,
    );
    sourceRows = Math.max(1, columnRows - 1);
    if (compare.length + adviceRows + runbook.length + previewLines + 2 > columnRows) {
      denseAdvice = true;
      adviceRows = computeWorkShellContextAdviceRows({
        suggestions: input.policySuggestions,
        ...(input.adviceUnavailable ? { unavailable: input.adviceUnavailable } : {}),
        ...(selectedRow ? { selectedSourceId: selectedRow.item.id } : {}),
        actionsEnabled: input.adviceActionsEnabled,
        dense: true,
      });
      runbook = runbook.slice(0, 3);
      previewLines = Math.min(previewLines, 2);
    }
    while (
      compare.length + adviceRows + runbook.length + previewLines + 2 > columnRows
      && runbook.length > 0
    ) {
      runbook = runbook.slice(0, -1);
    }
    while (
      compare.length + adviceRows + previewLines + 2 > columnRows
      && compare.length > 0
    ) {
      compare = compare.slice(0, -1);
    }
    if (adviceRows + previewLines + 2 > columnRows) {
      previewLines = 0;
    }
  }

  const sourceRegion = renderContextInspectorGroupedViewport({
    rows: input.rows,
    maxRows: sourceRows,
    cursorIndex: input.cursorIndex,
    sourceCounts: input.packet.sourceCounts,
    ...(input.expandedId !== undefined ? { expandedId: input.expandedId } : {}),
    ...(input.detailContent !== undefined ? { detailContent: input.detailContent } : {}),
    ...(input.detailOffset !== undefined ? { detailOffset: input.detailOffset } : {}),
    width: sourceWidth,
    palette: input.palette,
    actionsEnabled: input.actionsEnabled,
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
    ...(input.adviceUnavailable ? { unavailable: input.adviceUnavailable } : {}),
    width: input.width,
    palette: input.palette,
  });
  const runbookBlock = renderWorkbenchRows({ rows: runbook, palette: input.palette });
  const compareBlock = renderWorkbenchRows({ rows: compare, palette: input.palette });
  const preview = renderSelectedPreview({
    ...(selectedRow ? { row: selectedRow } : {}),
    maxLines: previewLines,
    compact: isStacked,
    width: asideWidth,
    palette: input.palette,
  });
  return (
    <Box marginTop={input.expandedId ? 0 : 1} flexDirection="column">
      {input.expandedId ? sourceRegion : (
        <>
          {overview}
          {isMedium ? (
            <Box flexDirection="row">
              <Box width={sourceWidth} flexDirection="column">
                {sourceRegion}
              </Box>
              <Box width={previewWidth} paddingLeft={2} flexDirection="column">
                {preview}
                {advice}
                {runbookBlock}
                {compareBlock}
              </Box>
            </Box>
          ) : (
            <>
              {preview}
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
        width: input.width,
        palette: input.palette,
      })}
    </Box>
  );
}
