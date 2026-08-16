import type {
  ContextPacketView,
  ContextPacketViewItem,
  ContextPacketViewWarning,
  ContextProviderManifest,
  CreateContextPacketViewInput,
  PersistedPromptManifest,
} from "@unclecode/contracts";

import {
  formatContextPacketTokenEstimateSuffix,
  resolveContextPacketTokenEstimateState,
} from "./context-packet-token-estimate.js";
import { cloneContextPacketViewItem } from "./context-packet-item.js";
import { truncateForDisplayWidth } from "./display-width.js";

function cloneItems(items: readonly ContextPacketViewItem[]): readonly ContextPacketViewItem[] {
  return items.map(cloneContextPacketViewItem);
}

/**
 * Project warnings by name. Callers pass diagnostic records straight out of
 * their own stores, which routinely carry a store handle or project id beside
 * the three public fields; a spread would serialize those into the packet.
 */
function cloneWarnings(warnings: readonly ContextPacketViewWarning[]): readonly ContextPacketViewWarning[] {
  return warnings.map((warning) => ({
    code: warning.code,
    message: warning.message,
    severity: warning.severity,
  }));
}

/**
 * Project a provider manifest onto the packet.
 *
 * Callers hand us whatever object their registry holds — often the live
 * provider itself, carrying a `sync` closure, a store handle and credentials.
 * Only the four public manifest fields are copied out, by name, so provider
 * internals cannot ride along into a serialized packet, and `categories` is
 * copied so a later mutation of the caller's registry cannot rewrite history.
 */
function cloneContextProviderManifest(manifest: ContextProviderManifest): ContextProviderManifest {
  return {
    providerId: manifest.providerId,
    categories: [...manifest.categories],
    refresh: manifest.refresh,
    trustTier: manifest.trustTier,
  };
}
function clonePersistedPromptManifest(manifest: PersistedPromptManifest): PersistedPromptManifest {
  return {
    id: manifest.id,
    profileId: manifest.profileId,
    createdAt: manifest.createdAt,
    packetId: manifest.packetId,
    policy: manifest.policy.map((source) => ({
      id: source.id,
      label: source.label,
      authority: source.authority,
      digest: source.digest,
    })),
    includedSourceCount: manifest.includedSourceCount,
    excludedSourceCount: manifest.excludedSourceCount,
    tokenEstimate: manifest.tokenEstimate,
  };
}


function getItemSourceCount(item: ContextPacketViewItem): number {
  return Math.max(1, Math.trunc(item.sourceCount ?? 1));
}

export function createContextPacketView(input: CreateContextPacketViewInput): ContextPacketView {
  const included = cloneItems(input.included);
  const excluded = cloneItems(input.excluded);
  const warnings = cloneWarnings(input.warnings);
  const packetWithoutPreview: ContextPacketView = {
    id: input.id,
    version: 1,
    generatedAt: input.generatedAt,
    title: input.title ?? "Next answer context",
    included,
    excluded,
    warnings,
    preview: [...input.preview],
    sourceCounts: {
      included: included.reduce((total, item) => total + getItemSourceCount(item), 0),
      excluded: excluded.reduce((total, item) => total + getItemSourceCount(item), 0),
      warnings: warnings.length,
    },
    tokenEstimate: included.reduce((total, item) => total + Math.max(0, item.tokenEstimate ?? 0), 0),
    tokenEstimateState: resolveContextPacketTokenEstimateState(input, included),
    ...(input.manifest ? { manifest: clonePersistedPromptManifest(input.manifest) } : {}),
    // Absent, not `undefined`: a packet built without providers must have no
    // own `registry` property so existing consumers stay byte-compatible.
    ...(input.registry === undefined
      ? {}
      : { registry: { providers: input.registry.providers.map(cloneContextProviderManifest) } }),
  };
  return {
    ...packetWithoutPreview,
    preview: formatContextPacketPromptPrefix(packetWithoutPreview).split("\n"),
  };
}

type PacketSourceSummary = {
  readonly category: string;
  count: number;
  readonly order: number;
  readonly sample: ContextPacketViewItem;
};

function formatPacketItemBody(item: ContextPacketViewItem): string {
  const preview = item.preview?.trim();
  const previewSuffix = preview && preview !== item.label ? ` - ${preview}` : "";
  return `${item.label} (${item.reason})${previewSuffix}`;
}

function formatPacketCategory(category: ContextPacketViewItem["category"]): string {
  if (category === "provider-system-prompt") {
    return "system guidance";
  }
  if (category === "workspace-guidance") {
    return "workspace guidance";
  }
  return category;
}

function formatPacketItem(item: ContextPacketViewItem): string {
  return `- ${formatPacketCategory(item.category)}: ${formatPacketItemBody(item)}`;
}

// Context Inspector: preview width was 64 — too short to be meaningful on
// an 80+ column terminal. Widened to 110 so the user sees the actual
// summary content, not a cryptic fragment. The overlay wraps long lines
// if needed.
const WORK_SHELL_GROUP_SUMMARY_MAX_WIDTH = 110;

function truncatePacketText(value: string, maxWidth = 112): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return truncateForDisplayWidth(normalized, maxWidth);
}

function formatCompactGroupSummary(
  item: ContextPacketViewItem,
  maxWidth = WORK_SHELL_GROUP_SUMMARY_MAX_WIDTH,
): string {
  const preview = item.preview?.trim();
  const label = item.label.trim();
  if (preview && preview.length > 0 && preview !== label) {
    return truncatePacketText(preview, maxWidth);
  }
  const reason = item.reason.trim();
  return truncatePacketText(reason.length > 0 ? `${label} — ${reason}` : label, maxWidth);
}

function formatWorkShellCategorySummaryLines(input: {
  readonly items: readonly ContextPacketViewItem[];
  readonly visibleLimit: number;
  readonly includeHiddenGroupsLine?: boolean;
}): readonly string[] {
  const summaries = summarizeItemsByCategory(input.items);
  if (summaries.length === 0) {
    return ["  none"];
  }
  const visible = summaries
    .slice(0, input.visibleLimit)
    .map((summary) =>
      `  ${formatPacketCategory(summary.sample.category)} · ${summary.count} · ${formatCompactGroupSummary(summary.sample)}`);
  const hiddenCount = Math.max(0, summaries.length - input.visibleLimit);
  return hiddenCount > 0 && input.includeHiddenGroupsLine
    ? [...visible, `  +${hiddenCount} more source groups hidden; counts still tracked.`]
    : visible;
}

function summarizeItemsByCategory(items: readonly ContextPacketViewItem[]): readonly PacketSourceSummary[] {
  const summaries = new Map<string, PacketSourceSummary>();
  for (const item of items) {
    const sourceCount = getItemSourceCount(item);
    const existing = summaries.get(item.category);
    if (existing) {
      existing.count += sourceCount;
      continue;
    }
    summaries.set(item.category, { category: item.category, count: sourceCount, order: summaries.size, sample: item });
  }
  return [...summaries.values()].sort((left, right) => right.count - left.count || left.order - right.order);
}

function formatCategorySummaryLines(input: {
  readonly items: readonly ContextPacketViewItem[];
  readonly marker: "+" | "-";
  readonly visibleLimit: number;
  readonly includeHiddenGroupsLine?: boolean;
}): readonly string[] {
  const summaries = summarizeItemsByCategory(input.items);
  if (summaries.length === 0) {
    return ["- none"];
  }
  const visible = summaries
    .slice(0, input.visibleLimit)
    .map((summary) => `${input.marker} ${formatPacketCategory(summary.sample.category)} · ${summary.count} · ${truncatePacketText(formatPacketItemBody(summary.sample))}`);
  const hiddenCount = Math.max(0, summaries.length - input.visibleLimit);
  return hiddenCount > 0 && input.includeHiddenGroupsLine
    ? [...visible, `${input.marker} ${hiddenCount} more source groups hidden; counts still tracked.`]
    : visible;
}

export function buildWorkShellCompactContextPacketPreviewLines(packet: ContextPacketView): readonly string[] {
  return [
    formatSourceCountLine(packet),
    "Included in next answer",
    ...formatWorkShellCategorySummaryLines({
      items: packet.included,
      visibleLimit: 8,
      includeHiddenGroupsLine: true,
    }),
    "Held back locally",
    ...formatWorkShellCategorySummaryLines({ items: packet.excluded, visibleLimit: 4 }),
    formatWarningsLine(packet.warnings, 110),
    formatPreviewLine(packet),
    "Provider prompt prefix",
    ...formatContextPacketPromptPrefix(packet).split("\n"),
  ];
}

function formatWarningCount(count: number): string {
  return count === 1 ? "1 warning" : `${count} warnings`;
}

function formatSourceCountLine(packet: ContextPacketView): string {
  const tokenSuffix = formatContextPacketTokenEstimateSuffix(packet);
  return `Sources · ${packet.sourceCounts.included} included · ${packet.sourceCounts.excluded} held back · ${formatWarningCount(packet.sourceCounts.warnings)}${tokenSuffix}`;
}

function formatWarningsLine(
  warnings: readonly ContextPacketViewWarning[],
  maxWidth = 96,
): string {
  const first = warnings[0];
  if (first === undefined) {
    return "Warnings · none";
  }
  const hiddenSuffix = warnings.length > 1 ? ` · ${warnings.length - 1} more` : "";
  return `Warnings · ${warnings.length} · ${truncatePacketText(`${first.code}: ${first.message}`, maxWidth)}${hiddenSuffix}`;
}

function formatPreviewLine(packet: ContextPacketView): string {
  const first = formatContextPacketPromptPrefix(packet).split("\n")[0]?.trim();
  return `Next answer · ${truncatePacketText(first && first.length > 0 ? first : "No model-ready context preview available.")}`;
}

export function buildContextPacketPreviewLines(packet: ContextPacketView): readonly string[] {
  return [
    `Context · ${packet.title}`,
    formatSourceCountLine(packet),
    "UncleCode · included summaries go to the model; raw audit artifacts stay local.",
    "Included in next answer",
    ...formatCategorySummaryLines({ items: packet.included, marker: "+", visibleLimit: 3, includeHiddenGroupsLine: true }),
    "Held back locally",
    ...formatCategorySummaryLines({ items: packet.excluded, marker: "-", visibleLimit: 1 }),
    formatWarningsLine(packet.warnings),
    formatPreviewLine(packet),
    "Controls · Esc close · /context refresh",
  ];
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatPromptPacketItem(item: ContextPacketViewItem): string {
  return escapeXmlText(formatPacketItem(item));
}

function formatProviderWithheldSummary(count: number, noun: string): readonly string[] {
  if (count === 0) {
    return ["- none"];
  }
  const plural = count === 1 ? noun : `${noun}s`;
  return [
    escapeXmlText(`- ${count} ${plural} withheld from model-ready context; inspect /context for local-only details.`),
  ];
}

export function formatContextPacketPromptPrefix(packet: ContextPacketView): string {
  return [
    `<unclecode_context_packet id="${escapeXmlAttribute(packet.id)}" version="${packet.version}">`,
    "Included:",
    ...(packet.included.length > 0 ? packet.included.map(formatPromptPacketItem) : ["- none"]),
    "Excluded raw artifacts:",
    ...formatProviderWithheldSummary(packet.sourceCounts.excluded, "raw artifact"),
    "Warnings:",
    ...formatProviderWithheldSummary(packet.sourceCounts.warnings, "context issue"),
    "</unclecode_context_packet>",
  ].join("\n");
}

export function formatContextPacketIndicator(packet: ContextPacketView): string {
  const included = packet.sourceCounts.included;
  const held = packet.sourceCounts.excluded;
  const tokenSuffix = packet.tokenEstimate >= 1000
    ? ` · ~${Math.round(packet.tokenEstimate / 1000)}k`
    : packet.tokenEstimate > 0
      ? ` · ~${packet.tokenEstimate}t`
      : "";
  const pinnedCount = packet.included.reduce(
    (count, item) => count + ((item.salience ?? 0) >= 1 ? 1 : 0),
    0,
  );
  const pinnedSuffix = pinnedCount > 0 ? ` · 📌 ${pinnedCount} pinned` : "";
  const base = `▤ ${included} ctx${tokenSuffix} · ${held} held${pinnedSuffix}`;
  return packet.sourceCounts.warnings > 0 ? `${base} · ${packet.sourceCounts.warnings}⚠` : base;
}

export function composeWorkShellTurnPromptFromPacket(input: {
  readonly packet: ContextPacketView;
  readonly userPrompt: string;
}): string {
  return `${formatContextPacketPromptPrefix(input.packet)}\n\nUser request:\n${input.userPrompt}`;
}
