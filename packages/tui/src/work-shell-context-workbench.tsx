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

function findLargestIncludedSource(
  rows: readonly ContextInspectorSourceRow[],
): ContextInspectorSourceRow | undefined {
  let largest: ContextInspectorSourceRow | undefined;
  for (const row of rows) {
    if (
      !row.heldBack
      && (row.item.tokenEstimate ?? -1) > (largest?.item.tokenEstimate ?? -1)
    ) {
      largest = row;
    }
  }
  return largest;
}

function renderPreflightOverview(input: {
  readonly packet: ContextPacketView;
  readonly rows: readonly ContextInspectorSourceRow[];
  readonly suggestion: ContextInspectorSuggestion;
  readonly policySuggestionCount: number;
  readonly showAdviceCount: boolean;
  readonly unavailable?: string | undefined;
  readonly compact?: boolean | undefined;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
}): React.ReactNode {
  const largest = findLargestIncludedSource(input.rows);
  const largestLine = largest
    ? `Largest · ${sanitizeContextPreview(largest.item.label)} · ${formatContextTokenEstimate(largest.item.tokenEstimate)}`
    : "Largest · none";
  const warning = input.packet.warnings[0]?.message ?? input.unavailable;
  const preflightMessage = input.packet.warnings.length > 0
    ? `Review ${input.packet.warnings.length} ${input.packet.warnings.length === 1 ? "warning" : "warnings"} before sending.`
    : input.suggestion.message;
  const tone = input.suggestion.tone === "warning"
    ? input.palette.warning
    : input.suggestion.tone === "success"
      ? input.palette.success
      : input.palette.user;
  return (
    <Box flexDirection="column">
      <Text color={tone} bold>{"Preflight"}</Text>
      <Text color={input.palette.text}>
        {truncateForDisplayWidth(preflightMessage, Math.max(18, input.width))}
      </Text>
      {!input.compact ? (
        <Text color={input.palette.textMuted}>
          {truncateForDisplayWidth(largestLine, Math.max(18, input.width))}
        </Text>
      ) : null}
      {input.showAdviceCount && input.policySuggestionCount > 0 ? (
        <Text color={input.palette.assistant}>
          {`Advice · ${input.policySuggestionCount} ${input.policySuggestionCount === 1 ? "suggestion" : "suggestions"}`}
        </Text>
      ) : null}
      {warning ? (
        <Text color={input.palette.warning}>
          {truncateForDisplayWidth(`Warning · ${warning}`, Math.max(18, input.width))}
        </Text>
      ) : null}
    </Box>
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
    return "Same size as the last request";
  }
  const magnitude = formatContextReceiptTokenEstimate({
    tokenEstimate: Math.abs(delta),
    tokenEstimateState: "estimated",
  });
  return `${magnitude} ${delta > 0 ? "larger" : "smaller"} than the last request`;
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
  const visibleAdded = added.slice(0, 2);
  const visibleRemoved = removed.slice(0, 2);
  const hiddenCount = added.length + removed.length - visibleAdded.length - visibleRemoved.length;
  const delta = formatCompareTokenDelta(previewReceipt, submittedReceipt);
  return [
    {
      key: "compare-head",
      label: "Compare",
      text: truncateForDisplayWidth(
        " · next request vs last sent",
        Math.max(18, input.width - 8),
      ),
      tone: "muted",
    },
    ...visibleAdded.map((sourceId): WorkbenchRow => ({
      key: `compare-added-${sourceId}`,
      text: truncateForDisplayWidth(
        `+ ${resolveSourceLabel(input.packet, sourceId, previewReceipt)}`,
        input.width,
      ),
      tone: "success",
    })),
    ...visibleRemoved.map((sourceId): WorkbenchRow => ({
      key: `compare-removed-${sourceId}`,
      text: truncateForDisplayWidth(
        `- ${resolveSourceLabel(input.packet, sourceId, submittedReceipt)}`,
        input.width,
      ),
      tone: "warning",
    })),
    ...(added.length === 0 && removed.length === 0
      ? [{ key: "compare-none", text: "No source changes", tone: "muted" } as const]
      : []),
    ...(delta === undefined
      ? []
      : [{ key: "compare-delta", text: delta, tone: "muted" } as const]),
    ...(hiddenCount > 0
      ? [{ key: "compare-more", text: `… ${hiddenCount} more changes`, tone: "dim" } as const]
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
        <Text color={input.palette.textMuted}>{"Preview · select a source"}</Text>
      </Box>
    );
  }
  const preview = sanitizeContextPreview(input.row.item.preview ?? input.row.item.reason);
  const lines = wrapDisplayTextFast(preview, Math.max(18, input.width)).slice(0, input.maxLines);
  return (
    <Box marginTop={marginTop} flexDirection="column">
      <Text>
        <Text color={input.palette.user} bold>{"Preview"}</Text>
        <Text color={input.palette.textMuted}>
          {truncateForDisplayWidth(
            ` · ${sanitizeContextPreview(input.row.item.label)}`,
            Math.max(18, input.width - 8),
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
  const overviewWidth = isWide ? 30 : input.width;
  const previewWidth = isWide
    ? Math.max(36, Math.floor(input.width * 0.30))
    : Math.max(30, Math.min(Math.floor(input.width * 0.54), input.width - 38));
  const sourceWidth = isWide
    ? Math.max(36, input.width - overviewWidth - previewWidth - 4)
    : isMedium
      ? Math.max(36, input.width - previewWidth - 2)
      : input.width;
  const asideWidth = isMedium ? previewWidth : input.width;

  const receiptRows = input.actionReceipt ? 1 : 0;
  const contentRows = Math.max(
    1,
    input.maxRows - (input.expandedId ? 0 : WORKBENCH_MARGIN_ROWS) - receiptRows,
  );
  const hasOverviewWarning = Boolean(
    input.packet.warnings[0]?.message ?? input.adviceUnavailable,
  );
  let overviewRows = 3 + (hasOverviewWarning ? 1 : 0);
  let denseOverview = false;
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
    width: sourceWidth,
  });
  let compare = buildContextCompareRows({
    packet: input.packet,
    ...(input.previewReceipt ? { previewReceipt: input.previewReceipt } : {}),
    ...(input.submittedReceipt ? { submittedReceipt: input.submittedReceipt } : {}),
    ...(input.packetChange ? { packetChange: input.packetChange } : {}),
    width: asideWidth,
  });
  let previewLines = isWide ? 4 : isMedium ? 2 : 1;
  let sourceRows: number;

  if (input.expandedId) {
    sourceRows = contentRows;
  } else if (isStacked) {
    let minimumSourceRows = MIN_SOURCE_ROWS;
    const requiredRows = () => (
      overviewRows
      + runbook.length
      + compare.length
      + adviceRows
      + previewLines
      + 1
      + minimumSourceRows
    );
    if (requiredRows() > contentRows) {
      denseOverview = true;
      overviewRows = 2 + (hasOverviewWarning ? 1 : 0);
      denseAdvice = true;
      adviceRows = computeWorkShellContextAdviceRows({
        suggestions: input.policySuggestions,
        ...(input.adviceUnavailable ? { unavailable: input.adviceUnavailable } : {}),
        ...(selectedRow ? { selectedSourceId: selectedRow.item.id } : {}),
        actionsEnabled: input.adviceActionsEnabled,
        compact: true,
        dense: true,
      });
      if (runbook.length > 0 && (adviceRows > 0 || compare.length > 0)) {
        runbook = runbook.filter(
          (row) => row.key === "runbook-head" || row.key === "runbook-evidence",
        );
      }
      compare = compare.slice(0, 2);
    }
    while (requiredRows() > contentRows && compare.length > 0) {
      compare = compare.slice(0, -1);
    }
    if (requiredRows() > contentRows && runbook.length > 1) {
      runbook = runbook.slice(0, 1);
    }
    if (requiredRows() > contentRows && previewLines > 0) {
      previewLines = 0;
    }
    if (requiredRows() > contentRows) {
      minimumSourceRows = 1;
    }
    const fixedRows = requiredRows() - minimumSourceRows;
    sourceRows = Math.max(minimumSourceRows, contentRows - fixedRows);
  } else {
    const columnRows = Math.max(
      MIN_SOURCE_ROWS,
      contentRows - (isMedium && !isWide ? overviewRows + 1 : 0),
    );
    if (runbook.length + MIN_SOURCE_ROWS > columnRows) {
      runbook = runbook.filter(
        (row) =>
          row.key === "runbook-head"
          || row.key === "runbook-status"
          || row.key === "runbook-evidence",
      );
    }
    sourceRows = Math.max(1, columnRows - runbook.length);
    const asideRows = () => compare.length + adviceRows + previewLines + 2;
    if (asideRows() > columnRows) {
      denseAdvice = true;
      adviceRows = computeWorkShellContextAdviceRows({
        suggestions: input.policySuggestions,
        ...(input.adviceUnavailable ? { unavailable: input.adviceUnavailable } : {}),
        ...(selectedRow ? { selectedSourceId: selectedRow.item.id } : {}),
        actionsEnabled: input.adviceActionsEnabled,
        dense: true,
      });
      compare = compare.slice(0, 2);
      previewLines = Math.min(previewLines, 1);
    }
    while (asideRows() > columnRows && compare.length > 0) {
      compare = compare.slice(0, -1);
    }
    if (asideRows() > columnRows) {
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
    rows: input.rows,
    suggestion: input.suggestion,
    policySuggestionCount: input.policySuggestions.length,
    showAdviceCount: advice === null,
    ...(input.adviceUnavailable ? { unavailable: input.adviceUnavailable } : {}),
    compact: denseOverview,
    width: overviewWidth,
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
      {input.expandedId ? sourceRegion : isWide ? (
        <Box flexDirection="row">
          <Box width={overviewWidth} flexDirection="column">{overview}</Box>
          <Box width={sourceWidth} paddingLeft={2} flexDirection="column">
            {runbookBlock}
            {sourceRegion}
          </Box>
          <Box width={previewWidth} paddingLeft={2} flexDirection="column">
            {compareBlock}
            {advice}
            {preview}
          </Box>
        </Box>
      ) : isMedium ? (
        <>
          {overview}
          <Box marginTop={1} flexDirection="row">
            <Box width={sourceWidth} flexDirection="column">
              {runbookBlock}
              {sourceRegion}
            </Box>
            <Box width={previewWidth} paddingLeft={2} flexDirection="column">
              {compareBlock}
              {advice}
              {preview}
            </Box>
          </Box>
        </>
      ) : (
        <>
          {overview}
          {compareBlock}
          {advice}
          {runbookBlock}
          {sourceRegion}
          {preview}
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
