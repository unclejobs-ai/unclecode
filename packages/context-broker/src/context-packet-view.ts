import type {
  ContextPacketView,
  ContextPacketViewItem,
  ContextPacketViewWarning,
  CreateContextPacketViewInput,
} from "@unclecode/contracts";

function cloneItems(items: readonly ContextPacketViewItem[]): readonly ContextPacketViewItem[] {
  return items.map((item) => ({ ...item }));
}

function cloneWarnings(warnings: readonly ContextPacketViewWarning[]): readonly ContextPacketViewWarning[] {
  return warnings.map((warning) => ({ ...warning }));
}

function getItemSourceCount(item: ContextPacketViewItem): number {
  return Math.max(1, Math.trunc(item.sourceCount ?? 1));
}

export function createContextPacketView(input: CreateContextPacketViewInput): ContextPacketView {
  const included = cloneItems(input.included);
  const excluded = cloneItems(input.excluded);
  const warnings = cloneWarnings(input.warnings);
  return {
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

function truncatePacketText(value: string, maxLength = 112): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
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

function formatWarningCount(count: number): string {
  return count === 1 ? "1 warning" : `${count} warnings`;
}

function formatSourceCountLine(packet: ContextPacketView): string {
  const tokenSuffix = packet.tokenEstimate > 0 ? ` · ~${packet.tokenEstimate} tokens` : "";
  return `Sources · ${packet.sourceCounts.included} included · ${packet.sourceCounts.excluded} held back · ${formatWarningCount(packet.sourceCounts.warnings)}${tokenSuffix}`;
}

function formatWarningsLine(warnings: readonly ContextPacketViewWarning[]): string {
  const first = warnings[0];
  if (first === undefined) {
    return "Warnings · none";
  }
  const hiddenSuffix = warnings.length > 1 ? ` · ${warnings.length - 1} more` : "";
  return `Warnings · ${warnings.length} · ${truncatePacketText(`${first.code}: ${first.message}`, 96)}${hiddenSuffix}`;
}

function formatPreviewLine(packet: ContextPacketView): string {
  const first = packet.preview[0]?.trim();
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
    "Controls · Esc close · /context refresh · Ctrl+O context",
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
  const base = `context ${packet.sourceCounts.included} ready · ${packet.sourceCounts.excluded} held back`;
  return packet.sourceCounts.warnings > 0 ? `${base} · ${packet.sourceCounts.warnings} issue` : base;
}
