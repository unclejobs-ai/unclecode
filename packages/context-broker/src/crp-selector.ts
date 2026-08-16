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
  resolveContextDeskGroup,
  type ContextPacketViewItem,
  type ContextPacketSourceCategory,
  type ContextPacketView,
  type ContextPacketViewWarning,
  type ContextProviderManifest,
  type ContextSourceCategory,
  type ContextSourceRecord,
} from "@unclecode/contracts";

import { createContextPacketView } from "./context-packet-view.js";
import { toContextPacketViewMetadata } from "./context-packet-item.js";
import { buildContextSourcePacketMetadata } from "./context-source-packet-metadata.js";

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
export function contextSourceToPacketItem(
  src: ContextSourceRecord,
  input: { readonly turnIndex?: number } = {},
): ContextPacketViewItem {
  const category = toPacketCategory(src);
  return {
    id: src.id,
    category,
    label: src.label,
    reason: src.reason,
    // The desk group is derived once here, at the packet source boundary, so
    // every consumer reads the same grouping instead of re-deriving it.
    group: resolveContextDeskGroup(category),
    ...(src.content !== null ? { preview: src.content } : {}),
    tokenEstimate: src.tokenEstimate,
    salience: src.salience,
    includedInModel: src.includedInModel,
    ...buildContextSourcePacketMetadata(src, input),
    ...(src.metadata === undefined
      ? {}
      : { metadata: toContextPacketViewMetadata(src.metadata) }),
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
      group: resolveContextDeskGroup("loop-trail"),
      label: formatCountLabel(additionalCount, "additional loop trail artifact", "additional loop trail artifacts"),
      reason: "loop trail artifacts stay local",
      sourceCount: additionalCount,
    });
  }

  if (evidenceItems.length > 0) {
    visible.push({
      id: "loop-trail-excluded-evidence-summary",
      category: "loop-trail",
      group: resolveContextDeskGroup("loop-trail"),
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

function buildCondensedHistoryWarnings(items: readonly ContextPacketViewItem[]): readonly ContextPacketViewWarning[] {
  return items
    .filter((item) =>
      item.category === "condensed-history" &&
      (item.freshness?.state === "stale" || item.freshness?.state === "expired"))
    .map((item) => ({
      code: "context.condensed-history.stale",
      message: `Compressed history summary is stale: ${item.label}. Refresh /context before relying on it.`,
      severity: "warning",
    }));
}

/**
 * Index the registry by the packet category each provider declares, so an item
 * can be attributed to the provider that produced it.
 *
 * The lookup is keyed on the *packet* category rather than the stored one:
 * that is the category the item itself carries, which keeps the registry
 * self-consistent — a linked item's category is always one its provider
 * declares. First registration wins when two providers claim a category, so
 * registry order is the tiebreak.
 */
function indexProvidersByCategory(
  providers: readonly ContextProviderManifest[],
): ReadonlyMap<string, string> {
  // A Map because the keys come from caller-supplied manifests: an object
  // index would let a provider declaring `"constructor"` resolve to something
  // off `Object.prototype` instead of leaving the category unregistered.
  const index = new Map<string, string>();
  for (const provider of providers) {
    for (const category of provider.categories) {
      if (!index.has(category)) {
        index.set(category, provider.providerId);
      }
    }
  }
  return index;
}

/**
 * Repoint an item's provenance at its registered provider.
 *
 * Items whose category no provider declares keep the legacy `crp:<category>`
 * provider id, which is exactly what a caller that supplies no registry gets.
 */
function linkItemsToProviders(
  items: readonly ContextPacketViewItem[],
  index: ReadonlyMap<string, string>,
): readonly ContextPacketViewItem[] {
  return items.map((item) => {
    const providerId = index.get(item.category);
    if (providerId === undefined || item.provenance === undefined) {
      return item;
    }
    return { ...item, provenance: { ...item.provenance, providerId } };
  });
}

export type SelectContextPacketOptions = {
  readonly store: AgentOpsStore;
  readonly projectId: string;
  readonly tokenBudget: number;
  readonly turnIndex: number;
  readonly warnings?: readonly ContextPacketViewWarning[];
  readonly preview?: readonly string[];
  readonly title?: string;
  /**
   * Provider registry for this turn. When supplied, the packet carries a
   * sanitized clone of these manifests and every item's provenance points at
   * the provider that declares its category. When omitted, the packet has no
   * `registry` property at all and items keep their legacy provider ids.
   */
  readonly providers?: readonly ContextProviderManifest[] | undefined;
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

  const packetInput = { turnIndex: options.turnIndex };
  const providerIndex =
    options.providers === undefined ? undefined : indexProvidersByCategory(options.providers);
  const selected = selection.selected.map((source) => contextSourceToPacketItem(source, packetInput));
  const heldBack = compactHeldBackItems(
    selection.heldBack.map((source) => contextSourceToPacketItem(source, packetInput)),
  );
  const included = providerIndex === undefined ? selected : linkItemsToProviders(selected, providerIndex);
  const excluded = providerIndex === undefined ? heldBack : linkItemsToProviders(heldBack, providerIndex);
  const warnings = [
    ...(options.warnings ?? []),
    ...buildCondensedHistoryWarnings(included),
    ...(selection.omittedCount > 0
      ? [{
          code: "context.sources.bounded",
          message: `${selection.omittedCount} lower-ranked context sources were omitted from this packet.`,
          severity: "warning" as const,
        }]
      : []),
  ];

  // Mark selected sources as seen this turn.
  if (included.length > 0) {
    options.store.markContextSourceTurnSeen(
      options.projectId,
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
    ...(options.providers === undefined ? {} : { registry: { providers: options.providers } }),
  });
}
