import type { ContextPacketView, ContextPacketViewItem } from "@unclecode/contracts";

import {
  resolveContextInspectorSuggestion,
  type ContextInspectorBudgetState,
  type ContextInspectorSuggestion,
} from "./work-shell-context-inspector-suggestion.js";

export type {
  ContextInspectorBudgetState,
  ContextInspectorSuggestion,
} from "./work-shell-context-inspector-suggestion.js";
export {
  formatContextTokenEstimate,
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

const CONTEXT_SOURCE_META: ReadonlyArray<readonly [RegExp, keyof ContextInspectorPalette, string, string]> = [
  [/^workspace-guidance/i, "assistant", "≡", "guidance"],
  [/^workspace/i, "user", "▣", "workspace"],
  [/^provider-system-prompt/i, "assistant", "▤", "system"],
  [/^bridge/i, "assistant", "↔", "bridge"],
  [/^memory/i, "toolAccent", "✦", "memory"],
  [/^loop-trail/i, "spinner", "⋉", "loop trail"],
  [/^runtime/i, "textMuted", "⚙", "runtime"],
  [/^attachment/i, "warning", "▧", "attachment"],
  [/^live/i, "spinner", "→", "live steps"],
];

export function resolveContextSourceMeta(category: string, palette: ContextInspectorPalette): {
  readonly icon: string;
  readonly color: string;
  readonly label: string;
} {
  const entry = CONTEXT_SOURCE_META.find(([pattern]) => pattern.test(category));
  return {
    color: entry ? palette[entry[1]] : palette.textMuted,
    icon: entry?.[2] ?? "·",
    label: entry?.[3] ?? category,
  };
}

export function buildContextInspectorRows(packet: ContextPacketView): readonly ContextInspectorSourceRow[] {
  return [
    ...packet.included.map((item, index) => ({
      item,
      sourceIndex: index,
      heldBack: item.includedInModel === false,
    })),
    ...packet.excluded.map((item, index) => ({
      item,
      sourceIndex: packet.included.length + index,
      heldBack: true,
    })),
  ];
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
