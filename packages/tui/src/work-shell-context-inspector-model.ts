import type {
  ContextDeskCollection,
  ContextDeskGroupId,
  ContextPacketView,
  ContextPacketViewItem,
} from "@unclecode/contracts";
import { CONTEXT_DESK_GROUPS, resolveContextDeskGroup } from "@unclecode/contracts";

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
  computeContextOverlayViewportMaxRows,
  formatContextItemBadgeSummary,
  getContextItemDetailLines,
  getContextItemPreview,
  sanitizeContextPreview,
} from "@unclecode/orchestrator";

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

/**
 * The desk group a row belongs to. Packet items may carry the group projected
 * at the broker boundary; hand-built packets fall back to the canonical
 * category resolver so no source is ever unreachable from the Groups pane.
 */
export function resolveContextDeskItemGroup(item: ContextPacketViewItem): ContextDeskGroupId {
  return item.group ?? resolveContextDeskGroup(item.category);
}

const CONTEXT_DESK_GROUP_RANK: ReadonlyMap<string, number> = new Map(
  CONTEXT_DESK_GROUPS.map((group, index) => [group.id, index] as const),
);

/**
 * Canonical desk row order: staged rows first (sent before held), then the
 * CONTEXT_DESK_GROUPS descriptor order, then packet index as an explicit
 * tiebreak (the input array is included-then-excluded). The engine's
 * collection-relative cursor is only meaningful if this list and the engine's
 * walk agree row for row.
 */
export function buildContextInspectorRows(packet: ContextPacketView): readonly ContextInspectorSourceRow[] {
  const staged = [
    ...packet.included.map((item, originalIndex) => ({
      item,
      heldBack: item.includedInModel === false,
      originalIndex,
    })),
    ...packet.excluded.map((item, excludedIndex) => ({
      item,
      heldBack: true,
      originalIndex: packet.included.length + excludedIndex,
    })),
  ];
  return staged
    .slice()
    .sort((a, b) => {
      const stageOrder = Number(a.heldBack) - Number(b.heldBack);
      if (stageOrder !== 0) {
        return stageOrder;
      }
      const groupOrder =
        (CONTEXT_DESK_GROUP_RANK.get(resolveContextDeskItemGroup(a.item)) ?? CONTEXT_DESK_GROUPS.length)
        - (CONTEXT_DESK_GROUP_RANK.get(resolveContextDeskItemGroup(b.item)) ?? CONTEXT_DESK_GROUPS.length);
      return groupOrder !== 0 ? groupOrder : a.originalIndex - b.originalIndex;
    })
    .map(({ item, heldBack }, sourceIndex) => ({
      item,
      heldBack,
      sourceIndex,
    }));
}

/** The rows the Sources pane shows for one collection, in canonical order. */
export function filterContextDeskRows(
  rows: readonly ContextInspectorSourceRow[],
  collection: ContextDeskCollection,
): readonly ContextInspectorSourceRow[] {
  if (collection === "all") {
    return rows;
  }
  if (collection === "sent") {
    return rows.filter((row) => !row.heldBack);
  }
  if (collection === "held") {
    return rows.filter((row) => row.heldBack);
  }
  return rows.filter((row) => resolveContextDeskItemGroup(row.item) === collection);
}

/** The cursor is an offset into the active collection's filtered rows. */
export function resolveContextDeskSelectedRow(
  rows: readonly ContextInspectorSourceRow[],
  cursorIndex: number,
): ContextInspectorSourceRow | undefined {
  return cursorIndex >= 0 && cursorIndex < rows.length ? rows[cursorIndex] : undefined;
}

/** One navigable row of the Groups pane: a group collection or a delivery lane. */
export type ContextDeskCollectionRow = {
  readonly id: ContextDeskCollection;
  readonly label: string;
  readonly count: number;
  readonly lane: "groups" | "delivery";
};

/**
 * The desk's one source-count rule: a row stands for however many real
 * sources it declares. The Groups pane and the compact collection line both
 * reduce with this, so the same collection never reads as two sizes.
 */
export function countContextDeskSources(
  rows: readonly ContextInspectorSourceRow[],
): number {
  return rows.reduce(
    (total, row) => total + Math.max(1, Math.trunc(row.item.sourceCount ?? 1)),
    0,
  );
}

/**
 * Collection rows in canonical walk order: everything, the six desk groups in
 * descriptor order, then the two delivery lanes. Counts span included and
 * excluded rows and are weighted by each item's declared source count so the
 * Groups pane never contradicts the budget line's sent/held evidence.
 */
export function buildContextDeskCollectionRows(
  rows: readonly ContextInspectorSourceRow[],
): readonly ContextDeskCollectionRow[] {
  const groupCounts = new Map<ContextDeskGroupId, number>(
    CONTEXT_DESK_GROUPS.map((group) => [group.id, 0] as const),
  );
  let total = 0;
  let sent = 0;
  let held = 0;

  for (const row of rows) {
    const sourceCount = Math.max(1, Math.trunc(row.item.sourceCount ?? 1));
    total += sourceCount;

    const group = resolveContextDeskItemGroup(row.item);
    const groupCount = groupCounts.get(group);
    if (groupCount !== undefined) {
      groupCounts.set(group, groupCount + sourceCount);
    }

    if (row.heldBack) {
      held += sourceCount;
    } else {
      sent += sourceCount;
    }
  }

  const collectionRows: ContextDeskCollectionRow[] = [
    { id: "all", label: "All sources", count: total, lane: "groups" },
  ];
  for (const group of CONTEXT_DESK_GROUPS) {
    collectionRows.push({
      id: group.id,
      label: group.label,
      count: groupCounts.get(group.id) ?? 0,
      lane: "groups",
    });
  }
  collectionRows.push(
    { id: "sent", label: "Sent", count: sent, lane: "delivery" },
    { id: "held", label: "Held", count: held, lane: "delivery" },
  );
  return collectionRows;
}

/** Human label for a collection, reused by pane headings and context lines. */
export function resolveContextDeskCollectionLabel(collection: ContextDeskCollection): string {
  if (collection === "all") {
    return "All sources";
  }
  if (collection === "sent") {
    return "Sent";
  }
  if (collection === "held") {
    return "Held";
  }
  return CONTEXT_DESK_GROUPS.find((group) => group.id === collection)?.label ?? "Other";
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
