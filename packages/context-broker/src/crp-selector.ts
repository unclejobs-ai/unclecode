/**
 * Context Runbook Protocol (CRP) — selector.
 *
 * Bridges the SQL-backed context_sources store to the existing
 * ContextPacketView shape so the TUI Runbook and the model prompt
 * composition need no changes.
 *
 * Flow: providers sync → context_sources table → selectContextPacketFromStore
 *       → ContextPacketView → TUI Runbook + composeWorkShellTurnPromptFromPacket
 */
import type { AgentOpsStore } from "@unclecode/agentops-db";
import {
  type ContextPacketViewItem,
  type ContextPacketSourceCategory,
  type ContextPacketView,
  type ContextPacketViewWarning,
  type ContextSourceCategory,
  type ContextSourceRecord,
} from "@unclecode/contracts";

import { createContextPacketView } from "./context-packet-view.js";

const OMO_EXCLUDED_DETAIL_LIMIT = 8;

// ContextSourceCategory → ContextPacketSourceCategory.
// The stored categories are a subset; we cast since every stored category
// is also a valid packet category.
function toPacketCategory(src: ContextSourceRecord): ContextPacketSourceCategory {
  if (src.category === "system" && src.id.startsWith("provider-system-prompt-")) {
    return "provider-system-prompt";
  }
  return sourceCategoryToPacketCategory(src.category);
}

function sourceCategoryToPacketCategory(category: ContextSourceCategory): ContextPacketSourceCategory {
  return category as ContextPacketSourceCategory;
}

/** Convert a stored context source to the model-facing packet item shape. */
export function contextSourceToPacketItem(src: ContextSourceRecord): ContextPacketViewItem {
  return {
    id: src.id,
    category: toPacketCategory(src),
    label: src.label,
    reason: src.reason,
    ...(src.content !== null ? { preview: src.content } : {}),
    tokenEstimate: src.tokenEstimate,
  };
}

function formatCountLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function summarizeLoopTrailHeldBack(items: readonly ContextPacketViewItem[]): readonly ContextPacketViewItem[] {
  if (items.length <= OMO_EXCLUDED_DETAIL_LIMIT) {
    return items;
  }

  const evidenceItems = items.filter((item) => /evidence/i.test(item.reason));
  const otherItems = items.filter((item) => !/evidence/i.test(item.reason));
  const visible: ContextPacketViewItem[] = otherItems.slice(0, OMO_EXCLUDED_DETAIL_LIMIT - 1);

  if (otherItems.length > visible.length) {
    const additionalCount = otherItems.length - visible.length;
    visible.push({
      id: "loop-trail-excluded-other-summary",
      category: "loop-trail",
      label: formatCountLabel(additionalCount, "additional loop trail artifact", "additional loop trail artifacts"),
      reason: "loop trail artifacts stay local",
      sourceCount: additionalCount,
    });
  }

  if (evidenceItems.length > 0) {
    visible.push({
      id: "loop-trail-excluded-evidence-summary",
      category: "loop-trail",
      label: formatCountLabel(evidenceItems.length, "loop trail evidence transcript", "loop trail evidence transcripts"),
      reason: "loop trail evidence transcripts stay local",
      preview: "Detailed evidence paths stay local; use the loop trail session evidence directory for full transcripts.",
      sourceCount: evidenceItems.length,
    });
  }

  return visible;
}

function compactHeldBackItems(items: readonly ContextPacketViewItem[]): readonly ContextPacketViewItem[] {
  const loopTrailItems = items.filter((item) => item.category === "loop-trail");
  if (loopTrailItems.length === 0) {
    return items;
  }

  const nonLoopTrailItems = items.filter((item) => item.category !== "loop-trail");
  return [...nonLoopTrailItems, ...summarizeLoopTrailHeldBack(loopTrailItems)];
}

export type SelectContextPacketOptions = {
  readonly store: AgentOpsStore;
  readonly projectId: string;
  readonly tokenBudget: number;
  readonly turnIndex: number;
  readonly warnings?: readonly ContextPacketViewWarning[];
  readonly preview?: readonly string[];
  readonly title?: string;
};

/**
 * Select context sources for a turn and project them to ContextPacketView.
 *
 * This is the SQL-backed replacement for the in-memory resolver. It:
 *   1. Calls selectContextSources (salience-ranked, budget-fit)
 *   2. Maps selected + heldBack → ContextPacketViewItem[]
 *   3. Builds a ContextPacketView with source counts + token estimate
 *
 * The TUI Runbook and composeWorkShellTurnPromptFromPacket consume this
 * unchanged — the SQL layer slots below the existing boundary.
 */
export function selectContextPacketFromStore(options: SelectContextPacketOptions): ContextPacketView {
  const selection = options.store.selectContextSources({
    projectId: options.projectId,
    tokenBudget: options.tokenBudget,
    turnIndex: options.turnIndex,
  });

  const included = selection.selected.map(contextSourceToPacketItem);
  const excluded = compactHeldBackItems(selection.heldBack.map(contextSourceToPacketItem));
  const warnings = options.warnings ?? [];

  // Mark selected sources as seen this turn.
  if (included.length > 0) {
    options.store.markContextSourceTurnSeen(
      included.map((item) => item.id),
      options.turnIndex,
    );
  }

  return createContextPacketView({
    id: `crp-${options.projectId}-${options.turnIndex}`,
    generatedAt: new Date().toISOString(),
    ...(options.title !== undefined ? { title: options.title } : {}),
    included,
    excluded,
    warnings,
    preview: options.preview ?? [
      "UncleCode will carry these summaries into the next answer.",
    ],
  });
}
