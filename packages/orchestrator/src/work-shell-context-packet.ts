import type {
  ContextPacketView,
  ContextPacketViewItem,
} from "@unclecode/contracts";

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

function formatPacketItem(item: ContextPacketViewItem): string {
  return `- ${item.category}: ${formatPacketItemBody(item)}`;
}

function truncatePacketText(value: string, maxLength = 112): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizeItemsByCategory(items: readonly ContextPacketViewItem[]): readonly PacketSourceSummary[] {
  const summaries = new Map<string, PacketSourceSummary>();
  for (const item of items) {
    const existing = summaries.get(item.category);
    if (existing) {
      existing.count += 1;
      continue;
    }
    summaries.set(item.category, { category: item.category, count: 1, order: summaries.size, sample: item });
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
    .map((summary) => `${input.marker} ${summary.category} · ${summary.count} · ${truncatePacketText(formatPacketItemBody(summary.sample))}`);
  const hiddenCount = Math.max(0, summaries.length - input.visibleLimit);
  return hiddenCount > 0 && input.includeHiddenGroupsLine
    ? [...visible, `${input.marker} ${hiddenCount} more source groups hidden; provider packet still tracks full count.`]
    : visible;
}

function formatWarningCount(count: number): string {
  return count === 1 ? "1 warning" : `${count} warnings`;
}

function formatSourceCountLine(packet: ContextPacketView): string {
  const tokenSuffix = packet.tokenEstimate > 0 ? ` · ~${packet.tokenEstimate} tokens` : "";
  return `Sources · ${packet.sourceCounts.included} included · ${packet.sourceCounts.excluded} excluded · ${formatWarningCount(packet.sourceCounts.warnings)}${tokenSuffix}`;
}

function formatWarningsLine(warnings: ContextPacketView["warnings"]): string {
  const first = warnings[0];
  if (first === undefined) {
    return "Warnings · none";
  }
  const hiddenSuffix = warnings.length > 1 ? ` · ${warnings.length - 1} more` : "";
  return `Warnings · ${warnings.length} · ${truncatePacketText(`${first.code}: ${first.message}`, 96)}${hiddenSuffix}`;
}

function formatPreviewLine(packet: ContextPacketView): string {
  const first = packet.preview[0]?.trim();
  return `Preview · ${truncatePacketText(first && first.length > 0 ? first : "No provider-bound preview available.")}`;
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
    escapeXmlText(`- ${count} ${plural} withheld from provider context; inspect /context for local-only details.`),
  ];
}

export function buildWorkShellContextPacketPreviewLines(packet: ContextPacketView): readonly string[] {
  return [
    `Packet ${packet.id} · ${packet.title}`,
    formatSourceCountLine(packet),
    "Provider · next model call receives included summaries; raw audit artifacts stay out.",
    "Included by source",
    ...formatCategorySummaryLines({ items: packet.included, marker: "+", visibleLimit: 3, includeHiddenGroupsLine: true }),
    "Excluded raw artifacts",
    ...formatCategorySummaryLines({ items: packet.excluded, marker: "-", visibleLimit: 1 }),
    formatWarningsLine(packet.warnings),
    formatPreviewLine(packet),
    "Controls · Esc close · /context refresh · Ctrl+O context center",
  ];
}

export function formatWorkShellContextPacketIndicator(packet: ContextPacketView): string {
  const base = `packet ${packet.sourceCounts.included} in · ${packet.sourceCounts.excluded} out`;
  return packet.sourceCounts.warnings > 0 ? `${base} · ${packet.sourceCounts.warnings} warn` : base;
}

export function formatWorkShellContextPacketPromptPrefix(packet: ContextPacketView): string {
  return [
    `<unclecode_context_packet id="${escapeXmlAttribute(packet.id)}" version="${packet.version}">`,
    "Included:",
    ...(packet.included.length > 0 ? packet.included.map(formatPromptPacketItem) : ["- none"]),
    "Excluded raw artifacts:",
    ...formatProviderWithheldSummary(packet.sourceCounts.excluded, "raw artifact"),
    "Warnings:",
    ...formatProviderWithheldSummary(packet.sourceCounts.warnings, "packet warning"),
    "</unclecode_context_packet>",
  ].join("\n");
}

export function composeWorkShellTurnPromptFromPacket(input: {
  readonly packet: ContextPacketView;
  readonly userPrompt: string;
}): string {
  return `${formatWorkShellContextPacketPromptPrefix(input.packet)}\n\nUser request:\n${input.userPrompt}`;
}
