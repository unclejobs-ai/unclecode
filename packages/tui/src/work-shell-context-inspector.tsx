import type {
  ContextPacketChangeClassification,
  ContextPacketReceipt,
  ContextPacketView,
  ContextPacketViewActionReceipt,
  ContextPacketViewItem,
  ContextPolicySuggestion,
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

import { renderContextInspectorWorkbench } from "./work-shell-context-workbench.js";
export {
  computeContextMeterFill,
  computeContextOverlaySectionMaxRows,
} from "./work-shell-context-inspector-header.js";
export { computeContextOverlayViewportMaxRows } from "./work-shell-context-inspector-model.js";

const CONTEXT_INSPECTOR_CONTROL_ROWS = 1;

export type ContextInspectorSourceCapabilities = {
  readonly pin: boolean;
  readonly unpin: boolean;
  readonly delivery: "hold-back" | "include" | undefined;
};

/**
 * What the selected source can actually do. The desk used to advertise a fixed
 * `Space send/hold · P pin` on every row, including provider-owned sources that
 * refuse both, so the control line promised keys that did nothing. Packets that
 * predate per-item `actions` fall back to the source's own state.
 */
export function resolveContextInspectorSourceCapabilities(
  item?: ContextPacketViewItem | undefined,
): ContextInspectorSourceCapabilities {
  if (!item) {
    return { pin: false, unpin: false, delivery: undefined };
  }
  if (item.actions === undefined) {
    const held = item.includedInModel === false;
    const pinned = (item.salience ?? 0) >= 1;
    return {
      pin: !pinned,
      unpin: pinned,
      delivery: held ? "include" : "hold-back",
    };
  }
  return {
    pin: item.actions.includes("pin"),
    unpin: item.actions.includes("unpin"),
    delivery: item.actions.includes("include")
      ? "include"
      : item.actions.includes("hold-back")
        ? "hold-back"
        : undefined,
  };
}

export function buildContextInspectorControls(input: {
  readonly capabilities: ContextInspectorSourceCapabilities;
  readonly actionsEnabled: boolean;
  readonly expanded: boolean;
  readonly undoAvailable: boolean;
}): string {
  const navigation = input.expanded
    ? "↑↓ scroll · Enter back"
    : "↑↓ move · Enter details";
  if (!input.actionsEnabled) {
    return `${navigation} · Esc close`;
  }
  const { capabilities } = input;
  return [
    navigation,
    ...(capabilities.delivery === undefined
      ? []
      : [capabilities.delivery === "include" ? "Space include" : "Space hold back"]),
    ...(capabilities.unpin ? ["P unpin"] : capabilities.pin ? ["P pin"] : []),
    ...(input.undoAvailable ? ["U undo"] : []),
    "Esc close",
  ].join(" · ");
}

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
  readonly contextPolicySuggestions?: readonly ContextPolicySuggestion[] | undefined;
  readonly contextAdviceUnavailable?: string | undefined;
  readonly contextAdviceActionsEnabled?: boolean | undefined;
  readonly terminalRows?: number;
}): React.ReactNode {
  const rows = buildContextInspectorRows(input.packet);
  const overview = buildContextInspectorOverview({
    packet: input.packet,
    rows,
    modelWindow: input.modelWindow,
  });
  const contextPolicySuggestions = input.contextPolicySuggestions ?? [];
  const viewportMaxRows = computeContextOverlayViewportMaxRows({
    ...(input.terminalRows !== undefined ? { terminalRows: input.terminalRows } : {}),
    reservedRows: 0,
  });
  const { palette } = input;
  const selectedItem = rows.find((row) => row.sourceIndex === input.cursorIndex)?.item;
  const controls = buildContextInspectorControls({
    capabilities: resolveContextInspectorSourceCapabilities(selectedItem),
    actionsEnabled: input.actionsEnabled,
    expanded: Boolean(input.expandedId),
    undoAvailable: input.actionReceipt?.canUndo ?? false,
  });

  return (
    <Box marginTop={1} borderStyle="round" borderColor={input.borderColor} paddingX={1} flexDirection="column">
      <Text>
        <Text color={palette.assistant} bold>{"Context Desk"}</Text>
        <Text color={palette.textDim}>
          {input.width < 76
            ? " · next answer"
            : " · what reaches the next answer"}
        </Text>
      </Text>
      <Box marginTop={input.expandedId ? 0 : 1} flexDirection="column">
        {renderContextInspectorBudgetLine({
          packet: input.packet,
          palette,
          modelWindow: input.modelWindow,
        })}
        {renderContextInspectorPacketProof({
          modelWindow: input.modelWindow,
          width: input.width,
          palette,
          ...(input.previewReceipt ? { previewReceipt: input.previewReceipt } : {}),
          ...(input.submittedReceipt ? { submittedReceipt: input.submittedReceipt } : {}),
          ...(input.packetChange ? { packetChange: input.packetChange } : {}),
        })}
        {renderContextInspectorWorkbench({
          packet: input.packet,
          rows,
          suggestion: overview.suggestion,
          cursorIndex: input.cursorIndex,
          ...(input.expandedId !== undefined ? { expandedId: input.expandedId } : {}),
          ...(input.detailContent !== undefined ? { detailContent: input.detailContent } : {}),
          ...(input.detailOffset !== undefined ? { detailOffset: input.detailOffset } : {}),
          width: input.width,
          maxRows: Math.max(1, viewportMaxRows - CONTEXT_INSPECTOR_CONTROL_ROWS),
          palette,
          actionsEnabled: input.actionsEnabled,
          ...(input.actionReceipt ? { actionReceipt: input.actionReceipt } : {}),
          ...(input.previewReceipt ? { previewReceipt: input.previewReceipt } : {}),
          ...(input.submittedReceipt ? { submittedReceipt: input.submittedReceipt } : {}),
          ...(input.packetChange ? { packetChange: input.packetChange } : {}),
          policySuggestions: contextPolicySuggestions,
          ...(input.contextAdviceUnavailable
            ? { adviceUnavailable: input.contextAdviceUnavailable }
            : {}),
          adviceActionsEnabled: input.contextAdviceActionsEnabled ?? false,
        })}
        <Text color={palette.textMuted}>{controls}</Text>
      </Box>
    </Box>
  );
}
