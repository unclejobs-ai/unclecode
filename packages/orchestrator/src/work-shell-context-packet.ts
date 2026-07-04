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

const GROUP_SUMMARY_MAX_LENGTH = 64;

function formatPacketCategory(category: ContextPacketViewItem["category"]): string {
  if (category === "provider-system-prompt") {
    return "system guidance";
  }
  if (category === "workspace-guidance") {
    return "workspace guidance";
  }
  return category;
}

function truncatePacketText(value: string, maxLength = GROUP_SUMMARY_MAX_LENGTH): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatCompactGroupSummary(item: ContextPacketViewItem): string {
  const preview = item.preview?.trim();
  const label = item.label.trim();
  if (preview && preview.length > 0 && preview !== label) {
    return truncatePacketText(preview);
  }
  const reason = item.reason.trim();
  return truncatePacketText(reason.length > 0 ? `${label} — ${reason}` : label);
}

function getItemSourceCount(item: ContextPacketViewItem): number {
  return Math.max(1, Math.trunc(item.sourceCount ?? 1));
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
    ? [...visible, `  +${hiddenCount} more source groups (counts still tracked)`]
    : visible;
}

function formatWarningCount(count: number): string {
  return count === 1 ? "1 warning" : `${count} warnings`;
}

function formatSourceCountLine(packet: ContextPacketView): string {
  const tokenSuffix = packet.tokenEstimate > 0 ? ` · ~${packet.tokenEstimate} tokens` : "";
  return `Sources · ${packet.sourceCounts.included} included · ${packet.sourceCounts.excluded} held back · ${formatWarningCount(packet.sourceCounts.warnings)}${tokenSuffix}`;
}

function formatWarningsLine(warnings: ContextPacketView["warnings"]): string {
  const first = warnings[0];
  if (first === undefined) {
    return "Warnings · none";
  }
  const hiddenSuffix = warnings.length > 1 ? ` · ${warnings.length - 1} more` : "";
  return `Warnings · ${warnings.length} · ${truncatePacketText(`${first.code}: ${first.message}`, 72)}${hiddenSuffix}`;
}

function formatPreviewLine(packet: ContextPacketView): string {
  const first = packet.preview[0]?.trim();
  return `Next answer · ${truncatePacketText(first && first.length > 0 ? first : "No model-ready context preview available.")}`;
}

function formatPacketItem(item: ContextPacketViewItem): string {
  return `- ${formatPacketCategory(item.category)}: ${item.label} (${item.reason})${item.preview?.trim() && item.preview.trim() !== item.label ? ` - ${item.preview.trim()}` : ""}`;
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

export function buildWorkShellContextPacketPreviewLines(packet: ContextPacketView): readonly string[] {
  return [
    formatSourceCountLine(packet),
    "Included in next answer",
    ...formatCategorySummaryLines({ items: packet.included, visibleLimit: 4, includeHiddenGroupsLine: true }),
    "Held back locally",
    ...formatCategorySummaryLines({ items: packet.excluded, visibleLimit: 2 }),
    formatWarningsLine(packet.warnings),
    formatPreviewLine(packet),
  ];
}

export function formatWorkShellContextPacketIndicator(packet: ContextPacketView): string {
  const base = `context ${packet.sourceCounts.included} ready · ${packet.sourceCounts.excluded} held back`;
  return packet.sourceCounts.warnings > 0 ? `${base} · ${packet.sourceCounts.warnings} issue` : base;
}

export function formatWorkShellContextPacketPromptPrefix(packet: ContextPacketView): string {
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

export function composeWorkShellTurnPromptFromPacket(input: {
  readonly packet: ContextPacketView;
  readonly userPrompt: string;
}): string {
  return `${formatWorkShellContextPacketPromptPrefix(input.packet)}\n\nUser request:\n${input.userPrompt}`;
}
