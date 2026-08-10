import type { ContextPacketView, ContextPacketViewItem } from "@unclecode/contracts";

import {
  CONTEXT_INSPECTOR_GROUP_ORDER,
  resolveContextSourceGroup,
  resolveContextInspectorSuggestion,
  type ContextInspectorBudgetState,
  type ContextInspectorHumanGroup,
  type ContextInspectorSuggestion,
} from "./work-shell-context-inspector-suggestion.js";

export type {
  ContextInspectorBudgetState,
  ContextInspectorHumanGroup,
  ContextInspectorSuggestion,
} from "./work-shell-context-inspector-suggestion.js";
export {
  formatContextTokenEstimate,
  CONTEXT_INSPECTOR_GROUP_ORDER,
  resolveContextSourceGroup,
  resolveContextInspectorSuggestion,
} from "./work-shell-context-inspector-suggestion.js";
export {
  formatContextItemBadgeSummary,
  getContextItemDetailLines,
  getContextItemPreview,
  sanitizeContextPreview,
} from "./work-shell-context-inspector-details.js";

export type ContextInspectorPalette = {
  readonly text: string;
  readonly textMuted: string;
  readonly textDim: string;
  readonly borderSoft: string;
  readonly borderDefault: string;
  readonly assistant: string;
  readonly user: string;
  readonly toolAccent: string;
  readonly spinner: string;
  readonly warning: string;
  readonly success: string;
};

export type ContextInspectorSourceRow = {
  readonly item: ContextPacketViewItem;
  readonly sourceIndex: number;
  readonly heldBack: boolean;
};

export type ContextInspectorVisibleRows = {
  readonly rows: readonly ContextInspectorSourceRow[];
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
};

export type ContextInspectorOverview = {
  readonly suggestion: ContextInspectorSuggestion;
};


const CONTEXT_SOURCE_META: ReadonlyArray<
  readonly [RegExp, keyof ContextInspectorPalette, string]
> = [
  [/^workspace-guidance/i, "assistant", "≡"],
  [/^workspace/i, "user", "▣"],
  [/^provider-system-prompt/i, "assistant", "▤"],
  [/^system$/i, "assistant", "▤"],
  [/^bridge/i, "assistant", "↔"],
  [/^condensed-history/i, "assistant", "↔"],
  [/^memory/i, "toolAccent", "✦"],
  [/^attachment/i, "warning", "▧"],
  [/^loop-trail/i, "spinner", "⋉"],
  [/^runtime/i, "textMuted", "⚙"],
  [/^live/i, "spinner", "→"],
];


export function resolveContextSourceMeta(category: string, palette: ContextInspectorPalette): {
  readonly icon: string;
  readonly color: string;
  readonly label: ContextInspectorHumanGroup;
  readonly group: ContextInspectorHumanGroup;
} {
  const entry = CONTEXT_SOURCE_META.find(([pattern]) => pattern.test(category));
  const group = resolveContextSourceGroup(category);
  return {
    color: entry ? palette[entry[1]] : palette.textMuted,
    icon: entry?.[2] ?? "·",
    label: group,
    group,
  };
}

export function computeContextOverlayViewportMaxRows(input: {
  readonly terminalRows?: number;
  readonly reservedRows?: number;
}): number {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  if (input.terminalRows === undefined) {
    // No physical height was supplied, so do not discard user evidence based
    // on an invented small terminal. Known terminals use the hard budget below.
    return 24;
  }
  const reservedRows = Math.max(0, Math.trunc(input.reservedRows ?? 0));
  return clamp(
    Math.trunc(input.terminalRows) - 25 - reservedRows,
    reservedRows > 0 ? 2 : 6,
    24,
  );
}

export function buildContextInspectorGroupedRows(
  rows: readonly ContextInspectorSourceRow[],
): readonly {
  readonly group: ContextInspectorHumanGroup;
  readonly rows: readonly ContextInspectorSourceRow[];
}[] {
  const buckets = new Map<ContextInspectorHumanGroup, ContextInspectorSourceRow[]>(
    CONTEXT_INSPECTOR_GROUP_ORDER.map((group) => [group, []]),
  );
  for (const row of rows) {
    const group = resolveContextSourceGroup(row.item.category);
    buckets.get(group)?.push(row);
  }
  return CONTEXT_INSPECTOR_GROUP_ORDER
    .map((group) => ({ group, rows: buckets.get(group) ?? [] }))
    .filter((section) => section.rows.length > 0);
}

export function buildContextInspectorRows(packet: ContextPacketView): readonly ContextInspectorSourceRow[] {
  return [
    ...packet.included.map((item) => ({
      item,
      heldBack: item.includedInModel === false,
    })),
    ...packet.excluded.map((item) => ({
      item,
      heldBack: true,
    })),
  ].map((row, sourceIndex) => ({
    ...row,
    sourceIndex,
  }));
}

export function isContextInspectorSourceHeldBack(
  packet: ContextPacketView,
  cursorIndex: number,
): boolean {
  return buildContextInspectorRows(packet)
    .find((row) => row.sourceIndex === cursorIndex)
    ?.heldBack ?? false;
}

export function getContextInspectorVisibleRows(
  rows: readonly ContextInspectorSourceRow[],
  cursorIndex: number,
  maxRows: number,
): ContextInspectorVisibleRows {
  if (rows.length <= maxRows) {
    return { rows, hiddenBefore: 0, hiddenAfter: 0 };
  }
  const selectedOffset = rows.findIndex((row) => row.sourceIndex === cursorIndex);
  const anchor = selectedOffset >= 0 ? selectedOffset : 0;
  const halfWindow = Math.floor(maxRows / 2);
  const start = Math.min(
    Math.max(0, anchor - halfWindow),
    Math.max(0, rows.length - maxRows),
  );
  const end = Math.min(rows.length, start + maxRows);
  return {
    rows: rows.slice(start, end),
    hiddenBefore: start,
    hiddenAfter: rows.length - end,
  };
}

function resolveContextInspectorBudgetState(input: {
  readonly packet: ContextPacketView;
  readonly modelWindow: number;
}): ContextInspectorBudgetState {
  if (input.packet.tokenEstimateState === "unknown") {
    return "roomy";
  }
  const window = input.modelWindow > 0 ? input.modelWindow : 200_000;
  const ratio = input.packet.tokenEstimate / window;
  if (ratio > 1) {
    return "over";
  }
  if (ratio >= 0.8) {
    return "tight";
  }
  if (ratio >= 0.45) {
    return "steady";
  }
  return "roomy";
}

export function buildContextInspectorOverview(input: {
  readonly packet: ContextPacketView;
  readonly rows: readonly ContextInspectorSourceRow[];
  readonly modelWindow: number;
}): ContextInspectorOverview {
  const budgetState = resolveContextInspectorBudgetState({
    packet: input.packet,
    modelWindow: input.modelWindow,
  });
  return {
    suggestion: resolveContextInspectorSuggestion({
      packet: input.packet,
      rows: input.rows,
      budgetState,
    }),
  };
}
