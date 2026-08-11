import type {
  ContextPacketChangeClassification,
  ContextPacketReceipt,
  ContextPacketView,
  ContextPacketViewActionReceipt,
  ContextPolicySuggestion,
} from "@unclecode/contracts";
import { Box, Text } from "ink";
import React from "react";

import type { ContextDeskPane, ContextDeskPaneAllocation } from "./work-shell-context-inspector-model.js";
import {
  buildContextInspectorGroupedRows,
  buildContextInspectorOverview,
  buildContextInspectorRows,
  computeContextDeskLayout,
  formatContextTokenEstimate,
  getContextItemDetailLines,
  getContextItemPreview,
  resolveContextSourceGroup,
  type ContextInspectorPalette,
  type ContextInspectorSourceRow,
} from "./work-shell-context-inspector-model.js";
import {
  formatContextInspectorActionReceiptLine,
  formatContextInspectorPacketProofLines,
} from "./work-shell-context-inspector-header.js";
import { renderContextInspectorGroupedViewport } from "./work-shell-context-inspector-sources.js";
import { formatContextInspectorWarningLines } from "./work-shell-context-inspector-warnings.js";
import { formatWorkShellContextAdviceLines } from "./work-shell-context-advice.js";
import {
  truncateForDisplayWidth,
  wrapDisplayTextFast,
} from "./text-width.js";

export {
  computeContextMeterFill,
  computeContextOverlaySectionMaxRows,
} from "./work-shell-context-inspector-header.js";

const CONTEXT_INSPECTOR_CONTROLS =
  "↑↓ scroll · Enter back · Space send/hold · p pin · Esc close";

type ContextDeskSharedInput = {
  readonly packet: ContextPacketView;
  readonly rows: readonly ContextInspectorSourceRow[];
  readonly selectedRow: ContextInspectorSourceRow | undefined;
  readonly cursorIndex: number;
  readonly expandedId: string | null | undefined;
  readonly detailContent?: string | undefined;
  readonly detailOffset?: number | undefined;
  readonly previewOffset?: number | undefined;
  readonly actionReceipt?: ContextPacketViewActionReceipt | undefined;
  readonly previewReceipt?: ContextPacketReceipt | undefined;
  readonly submittedReceipt?: ContextPacketReceipt | undefined;
  readonly packetChange?: ContextPacketChangeClassification | undefined;
  readonly modelWindow?: number | undefined;
  readonly contextPolicySuggestions: readonly ContextPolicySuggestion[];
  readonly contextAdviceUnavailable?: string | undefined;
  readonly contextAdviceActionsEnabled: boolean;
  readonly sourceActionsEnabled: boolean;
  readonly activityLines: readonly string[];
  readonly palette: ContextInspectorPalette;
};

export function windowContextDeskLines(
  lines: readonly string[],
  requestedOffset: number,
  maxRows: number,
): readonly string[] {
  if (maxRows <= 0 || lines.length === 0) {
    return [];
  }
  if (lines.length <= maxRows) {
    return lines;
  }
  const lastPageStart = Math.max(0, lines.length - Math.max(1, maxRows - 1));
  const offset = Math.min(
    lastPageStart,
    Math.max(0, Math.trunc(requestedOffset)),
  );
  if (maxRows === 1) {
    return lines.slice(offset, offset + 1);
  }
  const hasAbove = offset > 0;
  let visibleCapacity = Math.max(0, maxRows - (hasAbove ? 1 : 0));
  let visible = lines.slice(offset, offset + visibleCapacity);
  let hiddenAfter = lines.length - offset - visible.length;
  if (hiddenAfter > 0 && visibleCapacity > 1) {
    visibleCapacity -= 1;
    visible = lines.slice(offset, offset + visibleCapacity);
    hiddenAfter = lines.length - offset - visible.length;
  }
  return [
    ...(hasAbove ? [`… ${offset} lines above`] : []),
    ...visible,
    ...(hiddenAfter > 0 ? [`… ${hiddenAfter} lines below`] : []),
  ].slice(0, maxRows);
}

function formatContextDeskControlLines(input: {
  readonly pane: ContextDeskPane;
  readonly width: number;
  readonly sourceActionsEnabled: boolean;
}): readonly string[] {
  const navigation = input.pane === "details"
    ? "↑↓ scroll · Enter back"
    : input.pane === "preview"
      ? "↑↓ scroll · Enter details"
      : "↑↓ move · Enter details";
  const mutations = input.sourceActionsEnabled ? " · Space send/hold · p pin" : "";
  const full = `${navigation}${mutations} · Esc close`;
  if (input.width >= 32) {
    return wrapDisplayTextFast(full, input.width);
  }
  return input.sourceActionsEnabled
    ? [
        truncateForDisplayWidth(
          input.pane === "details" ? "↑↓ · Enter back" : "↑↓ · Enter",
          input.width,
        ),
        truncateForDisplayWidth("Spc · p pin · Esc", input.width),
      ]
    : [truncateForDisplayWidth("↑↓ · Enter · Esc", input.width)];
}

function renderContextDeskPaneFrame(input: {
  readonly title: string;
  readonly focused: boolean;
  readonly allocation: ContextDeskPaneAllocation;
  readonly palette: ContextInspectorPalette;
  readonly children: React.ReactNode;
}): React.ReactNode {
  return (
    <Box
      borderStyle="single"
      borderColor={input.focused ? input.palette.user : input.palette.borderSoft}
      width={input.allocation.width}
      height={input.allocation.rows}
      paddingX={1}
      flexDirection="column"
      overflow="hidden"
      flexShrink={0}
    >
      <Text
        color={input.focused ? input.palette.text : input.palette.textMuted}
        bold={input.focused}
      >
        {truncateForDisplayWidth(input.title, input.allocation.contentWidth)}
      </Text>
      {input.children}
    </Box>
  );
}

function renderContextDeskControls(
  pane: ContextDeskPane,
  allocation: ContextDeskPaneAllocation,
  input: ContextDeskSharedInput,
): React.ReactNode {
  return formatContextDeskControlLines({
    pane,
    width: allocation.contentWidth,
    sourceActionsEnabled: input.sourceActionsEnabled,
  }).map((line, index) => (
    <Text key={`${pane}-control-${index}`} color={input.palette.textMuted}>
      {line}
    </Text>
  ));
}

function renderContextDeskSources(
  allocation: ContextDeskPaneAllocation,
  focused: boolean,
  title: string,
  input: ContextDeskSharedInput,
): React.ReactNode {
  const controls = formatContextDeskControlLines({
    pane: "sources",
    width: allocation.contentWidth,
    sourceActionsEnabled: input.sourceActionsEnabled,
  });
  const grouped = buildContextInspectorGroupedRows(input.rows);
  const heldBackCount = input.rows.filter((row) => row.heldBack).length;
  const summaryRows = input.rows.length > 0 ? 1 : 0;
  const sourceRows = Math.max(
    0,
    allocation.contentRows - controls.length - summaryRows - 1,
  );
  return renderContextDeskPaneFrame({
    title,
    focused,
    allocation,
    palette: input.palette,
    children: (
      <>
        {input.rows.length > 0 ? (
          <Text color={input.palette.textMuted}>
            {truncateForDisplayWidth(
              `${grouped.length} groups · ${input.rows.length - heldBackCount} in · ${heldBackCount} held`,
              allocation.contentWidth,
            )}
          </Text>
        ) : null}
        {sourceRows > 0 ? renderContextInspectorGroupedViewport({
          rows: input.rows,
          cursorIndex: input.cursorIndex,
          expandedId: null,
          maxRows: sourceRows,
          width: allocation.contentWidth,
          palette: input.palette,
          actionsEnabled: input.sourceActionsEnabled,
          compact: true,
        }) : null}
        {renderContextDeskControls("sources", allocation, input)}
      </>
    ),
  });
}

function buildContextDeskPreviewLines(
  width: number,
  input: ContextDeskSharedInput,
): readonly string[] {
  const row = input.selectedRow;
  const sourceLines = row
    ? [
        truncateForDisplayWidth(row.item.label, width),
        truncateForDisplayWidth(
          `${resolveContextSourceGroup(row.item.category)} · ${row.heldBack ? "held back" : "sent"} · ${formatContextTokenEstimate(row.item.tokenEstimate)}`,
          width,
        ),
        ...wrapDisplayTextFast(getContextItemPreview(row.item), width),
      ]
    : ["No source selected"];
  const proofLines = formatContextInspectorPacketProofLines({
    packet: input.packet,
    ...(input.previewReceipt ? { previewReceipt: input.previewReceipt } : {}),
    ...(input.submittedReceipt ? { submittedReceipt: input.submittedReceipt } : {}),
    ...(input.packetChange ? { packetChange: input.packetChange } : {}),
    modelWindow: input.modelWindow ?? 200000,
    width: Math.max(80, width),
  }).flatMap((line) => wrapDisplayTextFast(line, width));
  return [
    ...sourceLines,
    ...proofLines,
  ];
}

function renderContextDeskPreview(
  allocation: ContextDeskPaneAllocation,
  focused: boolean,
  title: string,
  input: ContextDeskSharedInput,
): React.ReactNode {
  const controls = formatContextDeskControlLines({
    pane: "preview",
    width: allocation.contentWidth,
    sourceActionsEnabled: input.sourceActionsEnabled,
  });
  const maxRows = Math.max(0, allocation.contentRows - controls.length);
  const lines = windowContextDeskLines(
    buildContextDeskPreviewLines(allocation.contentWidth, input),
    input.previewOffset ?? 0,
    maxRows,
  );
  return renderContextDeskPaneFrame({
    title,
    focused,
    allocation,
    palette: input.palette,
    children: (
      <>
        {lines.map((line, index) => (
          <Text key={`preview-${index}`} color={input.palette.textMuted}>{line}</Text>
        ))}
        {renderContextDeskControls("preview", allocation, input)}
      </>
    ),
  });
}

function buildContextDeskDetailsLines(
  width: number,
  input: ContextDeskSharedInput,
): readonly string[] {
  const selected = input.selectedRow;
  const expanded = selected !== undefined && input.expandedId === selected.item.id;
  const detailLines = expanded
    ? [
        ...wrapDisplayTextFast(`Detail · ${selected.item.label}`, width),
        ...getContextItemDetailLines(selected.item)
          .flatMap((line) => wrapDisplayTextFast(line, width)),
        ...(input.detailContent?.trim()
          ? input.detailContent
            .split(/\r?\n/u)
            .flatMap((line) => wrapDisplayTextFast(line.length > 0 ? line : " ", width))
          : []),
      ]
    : selected
      ? wrapDisplayTextFast(`Selected · ${selected.item.label}`, width)
      : ["No source selected"];
  const actionReceiptLines = input.actionReceipt
    ? wrapDisplayTextFast(
        formatContextInspectorActionReceiptLine(input.actionReceipt, 4096) ?? "",
        width,
      )
    : [];
  const warningLines = formatContextInspectorWarningLines({
    packet: input.packet,
    width,
  });
  const adviceLines = formatWorkShellContextAdviceLines({
    packet: input.packet,
    suggestions: input.contextPolicySuggestions,
    ...(input.contextAdviceUnavailable
      ? { unavailable: input.contextAdviceUnavailable }
      : {}),
    ...(selected ? { selectedSourceId: selected.item.id } : {}),
    actionsEnabled: input.contextAdviceActionsEnabled,
    width,
  });
  return [
    ...detailLines,
    ...actionReceiptLines,
    ...(input.packetChange
      ? wrapDisplayTextFast(`Packet change · ${input.packetChange.reason}`, width)
      : []),
    ...warningLines,
    ...adviceLines,
    ...(input.activityLines.length > 0
      ? [
          "Agent activity",
          ...input.activityLines.flatMap((line) => wrapDisplayTextFast(line, width)),
        ]
      : []),
  ];
}

function renderContextDeskDetails(
  allocation: ContextDeskPaneAllocation,
  focused: boolean,
  title: string,
  input: ContextDeskSharedInput,
): React.ReactNode {
  const controls = formatContextDeskControlLines({
    pane: "details",
    width: allocation.contentWidth,
    sourceActionsEnabled: input.sourceActionsEnabled,
  });
  const maxRows = Math.max(0, allocation.contentRows - controls.length);
  const lines = windowContextDeskLines(
    buildContextDeskDetailsLines(allocation.contentWidth, input),
    input.detailOffset ?? 0,
    maxRows,
  );
  return renderContextDeskPaneFrame({
    title,
    focused,
    allocation,
    palette: input.palette,
    children: (
      <>
        {lines.map((line, index) => (
          <Text key={`details-${index}`} color={input.palette.textMuted}>{line}</Text>
        ))}
        {renderContextDeskControls("details", allocation, input)}
      </>
    ),
  });
}

function renderEmergencyContextDeskPane(
  pane: ContextDeskPane,
  allocation: ContextDeskPaneAllocation,
  input: ContextDeskSharedInput,
): React.ReactNode {
  switch (pane) {
    case "sources":
      return renderContextDeskSources(allocation, true, "Sources · 1/3", input);
    case "preview":
      return renderContextDeskPreview(allocation, true, "Preview · 2/3", input);
    case "details":
      return renderContextDeskDetails(allocation, true, "Details / Actions · 3/3", input);
  }
}

export function renderContextInspectorOverlay(input: {
  readonly packet: ContextPacketView;
  readonly cursorIndex: number;
  readonly expandedId?: string | null | undefined;
  readonly detailContent?: string | undefined;
  readonly detailOffset?: number | undefined;
  readonly previewOffset?: number | undefined;
  readonly pane?: ContextDeskPane | undefined;
  readonly maxRows: number;
  readonly width: number;
  readonly palette: ContextInspectorPalette;
  readonly actionsEnabled: boolean;
  readonly actionReceipt?: ContextPacketViewActionReceipt | undefined;
  readonly previewReceipt?: ContextPacketReceipt | undefined;
  readonly submittedReceipt?: ContextPacketReceipt | undefined;
  readonly packetChange?: ContextPacketChangeClassification | undefined;
  readonly modelWindow?: number | undefined;
  readonly contextPolicySuggestions?: readonly ContextPolicySuggestion[] | undefined;
  readonly contextAdviceUnavailable?: string | undefined;
  readonly contextAdviceActionsEnabled?: boolean | undefined;
  readonly activityLines?: readonly string[] | undefined;
}): React.ReactNode {
  const rows = buildContextInspectorRows(input.packet);
  const selectedRow = rows[input.cursorIndex];
  const pane = input.pane ?? "sources";
  const layout = computeContextDeskLayout({
    bodyWidth: input.width,
    bodyRows: input.maxRows,
    pane,
  });
  const shared: ContextDeskSharedInput = {
    packet: input.packet,
    rows,
    selectedRow,
    cursorIndex: input.cursorIndex,
    expandedId: input.expandedId,
    ...(input.detailContent !== undefined ? { detailContent: input.detailContent } : {}),
    ...(input.detailOffset !== undefined ? { detailOffset: input.detailOffset } : {}),
    ...(input.previewOffset !== undefined ? { previewOffset: input.previewOffset } : {}),
    ...(input.actionReceipt ? { actionReceipt: input.actionReceipt } : {}),
    ...(input.previewReceipt ? { previewReceipt: input.previewReceipt } : {}),
    ...(input.submittedReceipt ? { submittedReceipt: input.submittedReceipt } : {}),
    ...(input.packetChange ? { packetChange: input.packetChange } : {}),
    ...(input.modelWindow !== undefined ? { modelWindow: input.modelWindow } : {}),
    contextPolicySuggestions: input.contextPolicySuggestions ?? [],
    ...(input.contextAdviceUnavailable
      ? { contextAdviceUnavailable: input.contextAdviceUnavailable }
      : {}),
    contextAdviceActionsEnabled: input.contextAdviceActionsEnabled ?? false,
    sourceActionsEnabled: input.actionsEnabled,
    activityLines: input.activityLines ?? [],
    palette: input.palette,
  };

  if (layout.mode === "too-small") {
    return (
      <Box width={layout.bodyWidth} height={layout.bodyRows}>
        <Text color={input.palette.warning}>
          {truncateForDisplayWidth("Terminal too small · Esc close", layout.bodyWidth)}
        </Text>
      </Box>
    );
  }
  if (layout.mode === "emergency") {
    return renderEmergencyContextDeskPane(layout.pane, layout.focused, shared);
  }
  return (
    <Box width={input.width} height={input.maxRows} flexDirection="row">
      {renderContextDeskSources(
        layout.sources,
        pane === "sources",
        "Sources",
        shared,
      )}
      <Box width={layout.gutter} flexShrink={0} />
      <Box
        width={layout.preview.width}
        height={input.maxRows}
        flexDirection="column"
        flexShrink={0}
      >
        {renderContextDeskPreview(
          layout.preview,
          pane === "preview",
          "Preview",
          shared,
        )}
        {renderContextDeskDetails(
          layout.details,
          pane === "details",
          "Details / Actions",
          shared,
        )}
      </Box>
    </Box>
  );
}

export { CONTEXT_INSPECTOR_CONTROLS, buildContextInspectorOverview };
