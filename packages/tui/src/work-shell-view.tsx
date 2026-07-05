import { Box, Text } from "ink";
import React from "react";
import {
  resolveWorkShellSlashArgHint,
  runRustCommandSync,
  sanitizeWorkShellAssistantText,
} from "@unclecode/orchestrator";

import { getDisplayWidth, truncateForDisplayWidth, wrapDisplayTextFast } from "./text-width.js";
import {
  classifyWorkShellPanelLineFast,
  formatWorkShellAuthFactsGroup,
  formatWorkShellFooterLineFast,
  formatWorkShellSessionFactsGroup,
  resolveWorkShellPanelLayoutFast,
  type WorkShellPanelAnchor,
  type WorkShellPanelDisplayMode,
  type WorkShellPanelLayout,
  type WorkShellPanelLineClass,
  type WorkShellPanelPlacement,
} from "./work-shell-view-fast-paths.js";

export type { WorkShellPanelDisplayMode } from "./work-shell-view-fast-paths.js";

export type WorkShellEntryRole = "user" | "assistant" | "tool" | "system";

export type WorkShellEntry = {
  readonly role: WorkShellEntryRole;
  readonly text: string;
};

export type WorkShellPanel = {
  readonly title: string;
  readonly lines: readonly string[];
};

export type WorkShellEntryPresentation = {
  readonly label: string;
  readonly badge: string;
  readonly labelColor: string;
  readonly labelTextColor?: string;
  readonly labelBackgroundColor?: string;
  readonly railColor: string;
  readonly borderColor?: string;
  readonly bodyColor: string;
};

const W = {
  text: "#0f172a",
  textMuted: "#334155",
  textDim: "#475569",
  border: "#334155",
  borderStrong: "#1e293b",
  borderSoft: "#94a3b8",
  borderAccent: "#0284c7",
  user: "#075985",
  userBody: "#0f172a",
  userBadgeText: "#082f49",
  userBadgeBg: "#bfdbfe",
  assistant: "#115e59",
  assistantBody: "#0f172a",
  assistantBadgeText: "#042f2e",
  assistantBadgeBg: "#ccfbf1",
  assistantMuted: "#115e59",
  tool: "#365314",
  toolSurface: "#ecfccb",
  toolAccent: "#365314",
  toolMuted: "#334155",
  warning: "#713f12",
} as const;

// Single thin-rule chrome language: one consistent line weight in a muted
// slate tone. Refinement comes from restraint — no mixed line weights, no
// loud rules. Sections breathe through whitespace and a quiet label set into
// the rule, not from decorative weight contrast.
function renderChromeRule(input: {
  readonly width: number;
  readonly color?: string;
}): React.ReactNode {
  const width = Math.max(2, input.width);
  const color = input.color ?? W.borderSoft;
  return <Text {...readableTextColorProps(color)}>{"─".repeat(width)}</Text>;
}

const WORK_SHELL_LEGACY_LIGHT_TEXT_COLORS = new Set([
  "#e2e8f0",
  "#e5eef7",
  "#f4f1ea",
  "#f8fafc",
]);

const WORK_SHELL_LOW_CONTRAST_TEXT_COLORS = new Set([
  "#94a3b8",
]);

export function resolveReadableWorkShellTextColor(color: string | undefined): string | undefined {
  if (!color) {
    return undefined;
  }
  const normalized = color.toLowerCase();
  if (WORK_SHELL_LEGACY_LIGHT_TEXT_COLORS.has(normalized)) {
    return W.text;
  }
  if (WORK_SHELL_LOW_CONTRAST_TEXT_COLORS.has(normalized)) {
    return W.textDim;
  }
  return color;
}

function readableTextColorProps(color: string | undefined): { readonly color?: string } {
  const resolved = resolveReadableWorkShellTextColor(color);
  return resolved ? { color: resolved } : {};
}

/**
 * DESIGN.md "Conversation entry": compact assistant replies avoid heavy
 * cards, and borders are structural, not decorative. Long replies used to
 * flip to a rounded heavy card, which made the transcript surface jump
 * between short and long answers. Every assistant reply now stays on the
 * rail/wrap surface; reply length no longer changes the surface.
 */
export function shouldUseCompactAssistantSurface(input: {
  readonly text: string;
  readonly width: number;
}): boolean {
  void input;
  return true;
}

function WorkShellReadableText(props: {
  readonly color: string | undefined;
  readonly children: React.ReactNode;
}) {
  return <Text {...readableTextColorProps(props.color)}>{props.children}</Text>;
}

function getWorkShellDividerWidth(input: {
  readonly terminalColumns?: number;
  readonly maxWidth?: number;
  readonly reservedColumns?: number;
} = {}): number {
  const terminalColumns = input.terminalColumns ?? process.stdout.columns ?? 96;
  const reservedColumns = input.reservedColumns ?? 4;
  const availableWidth = terminalColumns - reservedColumns;
  return Math.max(24, input.maxWidth === undefined ? availableWidth : Math.min(input.maxWidth, availableWidth));
}

function WorkShellSectionDivider(props: {
  readonly label: string;
  readonly accentColor?: string;
  readonly width?: number;
}) {
  const width = props.width ?? getWorkShellDividerWidth();
  const labelContent = ` ${props.label} `;
  const leftLength = Math.max(1, Math.floor((width - getDisplayWidth(labelContent)) / 2));
  const rightLength = Math.max(1, width - getDisplayWidth(labelContent) - leftLength);
  return (
    <Text color={W.border}>
      {"─".repeat(leftLength)}
      <Text {...readableTextColorProps(props.accentColor ?? W.textMuted)}>{labelContent}</Text>
      {"─".repeat(rightLength)}
    </Text>
  );
}

export function formatWorkShellProviderTitle(provider: string): string {
  return runRustCommandSync(["rust", "ux", "text", "provider-title"], process.cwd(), provider).trimEnd();
}

export function getWorkShellEntryPresentation(role: WorkShellEntryRole): WorkShellEntryPresentation {
  return resolveWorkShellEntryPresentation(role).presentation;
}

export function getWorkShellConversationLayout(role: WorkShellEntryRole): {
  readonly marginBottom: number;
  readonly paddingLeft: number;
  readonly hasBorder: boolean;
} {
  return resolveWorkShellEntryPresentation(role).layout;
}

export function getWorkShellEntryBorderStyle(role: WorkShellEntryRole): "round" | "single" {
  return resolveWorkShellEntryPresentation(role).borderStyle;
}

export function getWorkShellEmptyConversationHint(): string {
  return runRustCommandSync(["rust", "ux", "text", "empty-conversation-hint"], process.cwd()).trimEnd();
}

export function getWorkShellPanelBorderColor(inputValue: string, panelTitle: string): string {
  const role = resolveWorkShellPanelLayout({ panelTitle, inputValue }).borderColorRole;
  return role === "user" ? W.user : role === "assistant" ? W.assistant : role === "borderStrong" ? W.borderStrong : W.border;
}

export function getWorkShellPanelDisplayMode(input: {
  readonly panelTitle: string;
  readonly inputValue: string;
  readonly terminalColumns?: number;
}): WorkShellPanelDisplayMode {
  return resolveWorkShellPanelLayout(input).displayMode;
}

const WORK_SHELL_CONTEXT_OVERLAY_LINE_LIMIT = 12;

export function formatWorkShellOverlayPanelLines(input: {
  readonly panelTitle: string;
  readonly lines: readonly string[];
}): readonly string[] {
  if (
    input.panelTitle !== "Context expanded" ||
    input.lines.length <= WORK_SHELL_CONTEXT_OVERLAY_LINE_LIMIT
  ) {
    return input.lines;
  }
  const visibleLines = input.lines.slice(0, WORK_SHELL_CONTEXT_OVERLAY_LINE_LIMIT);
  return [
    ...visibleLines,
    `- ${input.lines.length - visibleLines.length} more context lines hidden; /context refreshes this view.`,
  ];
}

export function shouldHideWorkShellOverlayForInput(input: {
  readonly panelTitle: string;
  readonly inputValue: string;
}): boolean {
  return input.panelTitle === "Context expanded" && input.inputValue.trim().length > 0;
}

export function shouldSuppressWorkShellPassivePanel(input: {
  readonly panelDisplayMode: WorkShellPanelDisplayMode;
  readonly panelTitle: string;
  readonly inputValue: string;
  readonly isBusy: boolean;
  readonly latestSystemText?: string | undefined;
}): boolean {
  if (input.panelDisplayMode !== "bottom") {
    return false;
  }
  const hasComposerInput = input.inputValue.trim().length > 0;
  if (input.panelTitle === "Session status") {
    return hasComposerInput || !input.isBusy;
  }
  return (
    input.panelTitle === "Reasoning picker" &&
    !input.isBusy &&
    !hasComposerInput &&
    isCompletedReasoningSelectionLine(input.latestSystemText ?? "")
  );
}

function isCompletedReasoningSelectionLine(value: string): boolean {
  return /^Reasoning · .+ (?:selected|mode default restored)\.$/.test(value);
}

export function getWorkShellPanelPlacement(input: {
  readonly panelTitle: string;
  readonly inputValue: string;
  readonly terminalColumns?: number;
}): WorkShellPanelPlacement {
  return resolveWorkShellPanelLayout(input).placement;
}

export function getWorkShellPanelAnchor(displayMode: WorkShellPanelDisplayMode): WorkShellPanelAnchor {
  return resolveWorkShellPanelLayout({ panelTitle: "", inputValue: "", displayMode }).anchor;
}

export function getWorkShellBottomDrawerMinHeight(
  displayMode: WorkShellPanelDisplayMode,
  panelTitle: string,
  inputValue: string,
): number {
  return resolveWorkShellPanelLayout({ panelTitle, inputValue, displayMode }).bottomDrawerMinHeight;
}

export function getWorkShellComposerHintMinHeight(): 1 {
  return resolveWorkShellAttachmentLayout().composerHintMinHeight;
}

export function getWorkShellAttachmentPlacement(): "after-composer" {
  return resolveWorkShellAttachmentLayout().attachmentPlacement;
}

export function getWorkShellAttachmentMinHeight(): 4 {
  return resolveWorkShellAttachmentLayout().attachmentMinHeight;
}

export function getWorkShellAttachmentLineColor(index: number): string | undefined {
  const role = resolveWorkShellAttachmentLayout(index).attachmentLineColorRole;
  if (role === "user") return W.user;
  if (role === "text") return resolveReadableWorkShellTextColor(W.text);
  return resolveReadableWorkShellTextColor(W.textMuted);
}

export function getWorkShellComposerHint(
  inputValue: string,
  slashSuggestionCount: number,
  selectedSlashCommand?: string,
): string | undefined {
  const trimmed = inputValue.trim();
  if (trimmed.startsWith("/")) {
    const argHint = selectedSlashCommand
      ? resolveWorkShellSlashArgHint(selectedSlashCommand)
      : undefined;
    const argSuffix = argHint ? ` · args: ${argHint}` : "";
    if (trimmed.startsWith("/model")) {
      return slashSuggestionCount > 0
        ? `↑↓ choose · Enter switch · type to filter · Esc cancel${argSuffix}`
        : "No exact model match · type to filter";
    }
    return slashSuggestionCount > 0
      ? `↑↓ select · Enter run · Esc cancel${argSuffix}`
      : "No matches · try /model, /auth, /context, /queue";
  }
  if (trimmed.length === 0) {
    return "Enter send · Shift+Enter newline · / commands";
  }
  return "Enter send · Shift+Enter newline";
}

export function resolveWorkShellComposerHint(input: {
  readonly composerHintOverride?: string;
  readonly isBusy: boolean;
  readonly queuePaused?: boolean;
  readonly queuedCount?: number;
  readonly inputValue: string;
  readonly slashSuggestionCount: number;
  readonly selectedSlashCommand?: string;
}): string | undefined {
  if (input.composerHintOverride) {
    return input.composerHintOverride;
  }
  if (input.isBusy) {
    return "Enter queues follow-up · Ctrl+C/Esc interrupt · /queue";
  }
  if (input.queuePaused && (input.queuedCount ?? 0) > 0) {
    return "Queue paused after interrupt · /queue shows · /queue clear drops";
  }
  return getWorkShellComposerHint(
    input.inputValue,
    input.slashSuggestionCount,
    input.selectedSlashCommand,
  );
}

const WORK_SHELL_BUSY_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const WORK_SHELL_SPINNER_INTERVAL_MS = 100;

function pickBusySpinnerFrame(frame = 0): string {
  const count = WORK_SHELL_BUSY_SPINNER_FRAMES.length;
  return WORK_SHELL_BUSY_SPINNER_FRAMES[((frame % count) + count) % count] ?? WORK_SHELL_BUSY_SPINNER_FRAMES[0];
}
const STREAMING_CURSOR = "▌";
const BODY_CONTINUATION_INDENT = "   ";
const WORK_SHELL_STATUS_GROUP_SEPARATOR = " │ ";
const RUST_TEXT_CACHE_MAX_ENTRIES = 512;
const rustBusyStatusCache = new Map<string, string>();
const rustMarkdownDisplayCache = new Map<string, string>();
const rustThinkingLineCache = new Map<string, string>();
const rustStatusLineCache = new Map<string, string>();
const rustWrapDisplayCache = new Map<string, readonly string[]>();
const rustEntryPresentationCache = new Map<WorkShellEntryRole, WorkShellEntryRolePresentationContract>();
const rustAttachmentLayoutCache = new Map<number, WorkShellAttachmentLayout>();
const rustViewportLayoutCache = new Map<string, WorkShellViewportLayout>();

function shouldSkipRustTextCacheStore(text: string): boolean {
  return text.endsWith(STREAMING_CURSOR);
}

function setBoundedCacheValue<K, V>(cache: Map<K, V>, key: K, value: V, skipStore: boolean): void {
  if (skipStore) {
    return;
  }
  if (cache.size >= RUST_TEXT_CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) {
      cache.delete(firstKey);
    }
  }
  cache.set(key, value);
}

type WorkShellEntryRolePresentationContract = {
  readonly presentation: WorkShellEntryPresentation;
  readonly layout: {
    readonly marginBottom: number;
    readonly paddingLeft: number;
    readonly hasBorder: boolean;
  };
  readonly borderStyle: "round" | "single";
};

type WorkShellAttachmentLayout = {
  readonly composerHintMinHeight: 1;
  readonly attachmentPlacement: "after-composer";
  readonly attachmentMinHeight: 4;
  readonly attachmentLineColorRole: "user" | "text" | "textMuted";
};

type WorkShellViewportLayout = {
  readonly conversationWidth: number;
  readonly dockWidth: number;
};

type WorkShellComposerDockLayout = {
  readonly accentColorRole: "user" | "assistant" | "borderStrong" | "warning";
  readonly attachmentBadgeColorRole: "warning" | "textDim";
  readonly topDivider: string;
  readonly bottomDivider: string;
  readonly footerLine: string;
};

function runRustUxText(operation: "busy-status" | "normalize-markdown", value: string): string {
  return runRustCommandSync(["rust", "ux", "text", operation], process.cwd(), value).trimEnd();
}

export function formatWorkShellBusyStatusLine(status?: string, frame = 0): string {
  const spinner = pickBusySpinnerFrame(frame);
  const key = status ?? "";
  const cached = rustBusyStatusCache.get(key);
  const normalizedStatus = cached ?? runRustUxText("busy-status", key);
  if (!cached) {
    rustBusyStatusCache.set(key, normalizedStatus);
  }
  return `${spinner} ${normalizedStatus || "Thinking..."}`;
}

export function formatWorkShellThinkingLine(reasoningLabel: string): string {
  const cached = rustThinkingLineCache.get(reasoningLabel);
  if (cached !== undefined) {
    return cached;
  }
  const line = runRustCommandSync(["rust", "ux", "text", "thinking-line"], process.cwd(), reasoningLabel).trimEnd();
  rustThinkingLineCache.set(reasoningLabel, line);
  return line;
}

export function normalizeMarkdownDisplayText(value: string): string {
  const cached = rustMarkdownDisplayCache.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const normalized = runRustUxText("normalize-markdown", value);
  setBoundedCacheValue(rustMarkdownDisplayCache, value, normalized, shouldSkipRustTextCacheStore(value));
  return normalized;
}

export function formatWorkShellAssistantDisplayText(value: string): string {
  return sanitizeWorkShellAssistantText(value);
}

export function formatWorkShellStatusLine(input: {
  readonly model: string;
  readonly reasoningLabel: string;
  readonly mode: string;
  readonly authLabel: string;
}): string {
  const key = JSON.stringify(input);
  const cached = rustStatusLineCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const line = runRustCommandSync(["rust", "ux", "text", "status-line"], process.cwd(), key).trimEnd();
  rustStatusLineCache.set(key, line);
  return line;
}

export function formatWorkShellUsageLine(input: {
  readonly isBusy: boolean;
  readonly busyStatus?: string;
  readonly currentTurnStartedAt?: number;
  readonly lastTurnDurationMs?: number;
  readonly nowMs?: number;
  readonly spinnerFrame?: number;
}): string {
  const spinner = pickBusySpinnerFrame(input.spinnerFrame ?? 0);
  if (input.isBusy) {
    const elapsed = input.currentTurnStartedAt === undefined
      ? "starting"
      : formatCompactDuration(Math.max(0, (input.nowMs ?? input.currentTurnStartedAt) - input.currentTurnStartedAt));
    const detail = normalizeBusyDetail(input.busyStatus ?? "");
    return [
      `${spinner} ${elapsed}`,
      detail.length > 0 ? detail : undefined,
      "Ctrl+C/Esc · Enter queues",
    ].filter((part) => part !== undefined && part.length > 0).join(" · ");
  }
  const replyTiming = input.lastTurnDurationMs === undefined
    ? "no reply yet"
    : `last reply ${formatCompactDuration(input.lastTurnDurationMs)}`;
  return ["Ready", replyTiming].join(" · ");
}

function formatCompactDuration(durationMs: number): string {
  const duration = Math.max(0, Math.trunc(durationMs));
  if (duration < 1000) {
    return `${duration}ms`;
  }
  if (duration < 10_000) {
    return `${(duration / 1000).toFixed(1)}s`;
  }
  return `${Math.trunc(duration / 1000)}s`;
}

function normalizeBusyDetail(value: string): string {
  const stripped = value.replace(/^[·→★✓✖↔✦\s]+/u, "").trim();
  if (!stripped) {
    return "";
  }
  const lower = stripped.toLowerCase();
  if (lower.includes("planner") || lower.includes("routing complex") || lower.includes("prepared ")) {
    return "Planning parallel work";
  }
  if (lower.includes("synthesis") || lower.includes("synthesiz")) {
    return "Synthesizing answer";
  }
  if (lower.includes("reviewer") || lower.includes("guardian")) {
    return "Reviewing results";
  }
  if (lower.startsWith("read ") || lower.startsWith("write ") || lower.startsWith("search ")) {
    return "Reading files";
  }
  if (lower.startsWith("calling ")) {
    return stripped.replace(/^calling /i, "Model ");
  }
  if (lower.startsWith("model ")) {
    return `Model ${stripped.slice(6).trim()}`;
  }
  if (
    lower === "thinking"
    || lower === "thinking..."
    || lower === "thinking…"
    || lower === "reasoning"
  ) {
    return "Thinking";
  }
  if (lower.startsWith("executor") || lower.includes(" parallel ") || lower.includes("task")) {
    return "Parallel workers";
  }
  if (stripped.includes("/") && stripped.includes(".") && !stripped.includes(" ")) {
    return "Reading files";
  }
  return stripped;
}

export function parseWorkShellPanelFactLine(line: string): { readonly label: string; readonly value: string } | undefined {
  const classified = classifyWorkShellPanelLine(line);
  return classified.kind === "fact" ? { label: classified.label, value: classified.value } : undefined;
}

export function isWorkShellWarningLine(line: string): boolean {
  const classified = classifyWorkShellPanelLine(line);
  if ("isWarning" in classified) {
    return classified.isWarning;
  }
  return classified.kind === "warning" || classified.kind === "hint-warning";
}

function classifyWorkShellPanelLine(line: string): WorkShellPanelLineClass {
  return classifyWorkShellPanelLineFast(line);
}

function resolveWorkShellPanelLayout(input: {
  readonly panelTitle: string;
  readonly inputValue: string;
  readonly terminalColumns?: number;
  readonly displayMode?: WorkShellPanelDisplayMode;
}): WorkShellPanelLayout {
  return resolveWorkShellPanelLayoutFast(input);
}

function resolveWorkShellEntryPresentation(role: WorkShellEntryRole): WorkShellEntryRolePresentationContract {
  const cached = rustEntryPresentationCache.get(role);
  if (cached !== undefined) {
    return cached;
  }
  const raw = runRustCommandSync(["rust", "ux", "text", "entry-presentation"], process.cwd(), role);
  const parsed = JSON.parse(raw) as WorkShellEntryRolePresentationContract;
  rustEntryPresentationCache.set(role, parsed);
  return parsed;
}

function resolveWorkShellAttachmentLayout(lineIndex = 0): WorkShellAttachmentLayout {
  const cached = rustAttachmentLayoutCache.get(lineIndex);
  if (cached) {
    return cached;
  }
  const raw = runRustCommandSync(
    ["rust", "ux", "text", "attachment-layout"],
    process.cwd(),
    JSON.stringify({ lineIndex }),
  );
  const parsed = JSON.parse(raw) as WorkShellAttachmentLayout;
  rustAttachmentLayoutCache.set(lineIndex, parsed);
  return parsed;
}

function resolveWorkShellViewportLayout(input: {
  readonly panelPlacement?: WorkShellPanelPlacement;
  readonly terminalColumns?: number;
}): WorkShellViewportLayout {
  const key = JSON.stringify({
    panelPlacement: input.panelPlacement ?? "bottom",
    terminalColumns: input.terminalColumns ?? process.stdout.columns ?? 96,
  });
  const cached = rustViewportLayoutCache.get(key);
  if (cached) {
    return cached;
  }
  const raw = runRustCommandSync(["rust", "ux", "text", "viewport-layout"], process.cwd(), key);
  const parsed = JSON.parse(raw) as WorkShellViewportLayout;
  rustViewportLayoutCache.set(key, parsed);
  return parsed;
}

function renderWorkShellPanelLine(line: string, index: number): React.ReactNode {
  const classified = classifyWorkShellPanelLine(line);
  if (classified.kind === "blank") {
    return <Text key={`${index}-blank`}> </Text>;
  }
  if (classified.kind === "section") {
    return (
      <Box key={`${index}-${line}`} marginTop={index === 0 ? 0 : 1}>
        <Text bold {...readableTextColorProps(W.textMuted)}>{classified.trimmed}</Text>
      </Box>
    );
  }
  if (classified.kind === "tree") {
    return (
      <Text key={`${index}-${line}`} {...readableTextColorProps(W.textMuted)}>
        {classified.branch} <Text color={W.user}>{classified.label}</Text>
        {classified.spacing}
        <Text {...readableTextColorProps(W.text)}>{classified.value}</Text>
      </Text>
    );
  }
  if (classified.kind === "suggestion") {
    return (
      <Text key={`${index}-${line}`}>
      <Text {...(classified.isSelected ? { color: W.user, bold: true } : readableTextColorProps(W.textMuted))}>{classified.marker}</Text>
      <Text color={W.user} bold={classified.isSelected}> {classified.command}</Text>
      <Text {...(classified.isWarning ? { color: W.warning } : readableTextColorProps(classified.isSelected ? W.text : W.textMuted))}>{classified.spacing}{classified.description}</Text>
</Text>
    );
  }
  if (classified.kind === "selected-command") {
    return <Text key={`${index}-${line}`} color={W.user}>{classified.trimmed}</Text>;
  }
  if (classified.kind === "command") {
    return <Text key={`${index}-${line}`} color={W.user}>{classified.trimmed}</Text>;
  }
  if (classified.kind === "fact") {
    const labelColorProps = classified.label === "Warning" ? { color: W.warning } : readableTextColorProps(W.textMuted);
    const valueColorProps = classified.isWarning ? { color: W.warning } : readableTextColorProps(W.text);
    return (
      <Text key={`${index}-${line}`}>
        <Text {...labelColorProps}>{classified.label}</Text>
        <Text {...readableTextColorProps(W.textMuted)}> · </Text>
        <Text {...valueColorProps}>{classified.value}</Text>
      </Text>
    );
  }
  if (classified.kind === "signed-in") {
    return <Text key={`${index}-${line}`} color={W.assistant}>{classified.trimmed}</Text>;
  }
  if (classified.kind === "not-signed-in") {
    return <Text key={`${index}-${line}`} color={W.warning}>{classified.trimmed}</Text>;
  }
  if (classified.kind === "warning") {
    return <Text key={`${index}-${line}`} color={W.warning}>{classified.trimmed}</Text>;
  }
  if (classified.kind === "tip") {
    return <Text key={`${index}-${line}`} {...readableTextColorProps(W.textDim)}>{classified.trimmed}</Text>;
  }
  if (classified.kind === "hint-warning") {
    return <Text key={`${index}-${line}`} color={W.warning}>{classified.trimmed}</Text>;
  }
  if (classified.kind === "match-summary") {
    return <Text key={`${index}-${line}`} {...readableTextColorProps(W.textDim)}>{classified.trimmed}</Text>;
  }
  if (classified.kind === "indent") {
    return <Text key={`${index}-${line}`} {...readableTextColorProps(W.textMuted)}>{classified.line}</Text>;
  }
  if (classified.kind === "text") {
    return <Text key={`${index}-${line}`} {...readableTextColorProps(W.text)}>{classified.line}</Text>;
  }
  return <Text key={`${index}-${line}`} {...readableTextColorProps(W.text)}>{line}</Text>;
}

export function formatWorkShellPanelEmptyLines(panelTitle: string): readonly string[] {
  const title = panelTitle.trim();
  return [
    title.length > 0 ? `No details in ${title} yet.` : "No panel details yet.",
    "Keep typing, or use / for commands.",
  ];
}

function getWorkShellConversationWidth(input: {
  readonly panelPlacement: WorkShellPanelPlacement;
  readonly terminalColumns?: number;
}): number {
  return resolveWorkShellViewportLayout(input).conversationWidth;
}

function getWorkShellDockWidth(terminalColumns?: number): number {
  return resolveWorkShellViewportLayout(
    terminalColumns === undefined ? {} : { terminalColumns },
  ).dockWidth;
}

function getLatestWorkShellSystemText(entries: readonly WorkShellEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.role === "system") {
      return entry.text;
    }
  }
  return undefined;
}

function padDisplayLine(value: string, width: number): string {
  const padding = Math.max(0, width - getDisplayWidth(value));
  return `${value}${" ".repeat(padding)}`;
}

function renderContinuationBodyLines(input: {
  readonly lines: readonly string[];
  readonly bodyColor: string;
  readonly keyPrefix: string;
}): React.ReactNode {
  return input.lines.map((line, lineIndex) => (
    <Text key={`${input.keyPrefix}-${String(lineIndex)}`}>
      <Text {...readableTextColorProps(W.textDim)}>{BODY_CONTINUATION_INDENT}</Text>
      <WorkShellReadableText color={input.bodyColor}>{line}</WorkShellReadableText>
    </Text>
  ));
}

function formatWorkShellPromptDeckDivider(width: number): string {
  const label = " prompt deck ";
  const labelWidth = getDisplayWidth(label);
  // Consistent thin rule with the label set in flush-left, mirroring the
  // header rule. Width is padded so the rule reaches the right edge.
  const dashCount = Math.max(0, width - labelWidth);
  return `${label}${"─".repeat(dashCount)}`;
}

function prefixWrappedDisplayText(prefix: string, text: string, width: number): readonly string[] {
  const prefixWidth = getDisplayWidth(prefix);
  const contentWidth = Math.max(12, width - prefixWidth);
  const lines = wrapDisplayText(text, contentWidth);
  if (lines.length === 0) {
    return [prefix.trimEnd()];
  }
  return lines.map((line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`);
}

export function formatWorkShellConversationEntryLines(input: {
  readonly role: WorkShellEntryRole;
  readonly text: string;
  readonly width: number;
}): readonly string[] {
  const presentation = getWorkShellEntryPresentation(input.role);
  const bodyText = input.role === "assistant"
    ? normalizeMarkdownDisplayText(formatWorkShellAssistantDisplayText(input.text))
    : input.text;

  if (input.role === "assistant") {
    const bodyLines = wrapDisplayText(bodyText, Math.max(20, input.width - 2));
    return [
      `${presentation.badge} ${presentation.label}`,
      ...bodyLines.map((line) => `${BODY_CONTINUATION_INDENT}${line}`),
    ];
  }

  if (input.role === "tool") {
    const bodyLines = formatWorkShellToolEntryLines(bodyText, input.width);
    return [`${presentation.badge} ${presentation.label}`, ...bodyLines.map((line) => `  ${line}`)];
  }

  return prefixWrappedDisplayText(`${presentation.badge} ${presentation.label} · `, bodyText, input.width);
}

function looksLikeHiddenWorkerMeta(text: string): boolean {
  const trimmed = text.trim();
  if (/^subtask-\d+/i.test(trimmed)) {
    return true;
  }
  if (/^\[[\s\S]*"id"\s*:\s*"subtask-/i.test(trimmed)) {
    return true;
  }
  if (/^\{[\s\S]*"id"\s*:\s*"subtask-/i.test(trimmed)) {
    return true;
  }
  return false;
}

export function shouldShowWorkShellConversationEntry(entry: WorkShellEntry): boolean {
  if (entry.role === "tool" || isInternalTraceConversationText(entry.text)) {
    return false;
  }
  if (entry.role === "system" && (isInternalSystemTraceText(entry.text) || looksLikeHiddenWorkerMeta(entry.text))) {
    return false;
  }
  if (entry.role === "assistant") {
    const sanitized = formatWorkShellAssistantDisplayText(entry.text).trim();
    return sanitized.length > 0 && !looksLikeHiddenWorkerMeta(sanitized);
  }
  return true;
}

function isInternalTraceConversationText(text: string): boolean {
  const trimmed = text.trimStart();
  return /^✦ (?:thinking|reasoning)·/u.test(trimmed)
    || /^→ (?:read|write|search|model|planner|action)/u.test(trimmed)
    || /^[✓✖→·★↔↗📎] /u.test(trimmed);
}

function isInternalSystemTraceText(text: string): boolean {
  const trimmed = text.trim();
  return /^(?:Turn (?:started|completed|interrupted)|calling |route |thinking )/i.test(trimmed);
}

export function resolveWorkShellBusyActivityColor(input: {
  readonly mode: string;
  readonly isBusy: boolean;
  readonly busyStatus?: string;
}): string {
  if (!input.isBusy) {
    return W.textMuted;
  }
  const detail = normalizeBusyDetail(input.busyStatus ?? "").toLowerCase();
  if (
    input.mode === "ultrawork"
    || input.mode === "yolo"
    || detail.includes("parallel")
    || detail.includes("planning")
    || detail.includes("synthesiz")
    || detail.includes("reviewing")
  ) {
    return W.user;
  }
  return W.assistant;
}

export function formatWorkShellHeaderLine(input: {
  readonly providerTitle: string;
  readonly headerHint: string;
  readonly terminalColumns?: number;
}): string {
  const width = Math.max(32, (input.terminalColumns ?? process.stdout.columns ?? 96) - 2);
  const leftWidth = getDisplayWidth(input.providerTitle);
  const rightWidth = getDisplayWidth(input.headerHint);
  const minGap = 2;

  if (leftWidth + minGap + rightWidth <= width) {
    return padDisplayLine(
      `${input.providerTitle}${" ".repeat(width - leftWidth - rightWidth)}${input.headerHint}`,
      width,
    );
  }

  const availableRightWidth = width - leftWidth - minGap;
  if (availableRightWidth >= 12) {
    return padDisplayLine(
      `${input.providerTitle}${" ".repeat(minGap)}${truncateForDisplayWidth(input.headerHint, availableRightWidth)}`,
      width,
    );
  }

  return padDisplayLine(truncateForDisplayWidth(input.providerTitle, width), width);
}

export function formatWorkShellToolEntryLines(text: string, width: number): readonly string[] {
  const normalized = text.trimEnd();
  if (!normalized) {
    return [];
  }
  return wrapDisplayText(normalized, Math.max(20, width - 4));
}

export function formatWorkShellFooterLine(input: {
  readonly cwd?: string;
  readonly model: string;
  readonly reasoningLabel: string;
  readonly mode: string;
  readonly authLabel: string;
  readonly contextIndicator?: string;
  readonly composerHint?: string;
  readonly width?: number;
}): string {
  return formatWorkShellFooterLineFast({
    ...input,
    ...(process.env.HOME ? { home: process.env.HOME } : {}),
  });
}

function wrapDisplayText(value: string, width: number): string[] {
  const key = JSON.stringify({ text: value, width });
  const cached = rustWrapDisplayCache.get(key);
  if (cached !== undefined) {
    return [...cached];
  }
  const raw = runRustCommandSync(["rust", "ux", "text", "wrap-display"], process.cwd(), key);
  const parsed = JSON.parse(raw) as string[];
  setBoundedCacheValue(rustWrapDisplayCache, key, parsed, shouldSkipRustTextCacheStore(value));
  return parsed;
}

function resolveWorkShellComposerDockAccentRole(input: {
  readonly inputValue: string;
  readonly mode?: string;
  readonly isBusy?: boolean;
  readonly queuePaused?: boolean;
  readonly queuedCount?: number;
}): WorkShellComposerDockLayout["accentColorRole"] {
  if (input.inputValue.trimStart().startsWith("/")) {
    return "user";
  }
  if (input.queuePaused && (input.queuedCount ?? 0) > 0) {
    return "warning";
  }
  if (input.isBusy && (input.mode === "ultrawork" || input.mode === "yolo")) {
    return "user";
  }
  if (input.isBusy || (input.queuedCount ?? 0) > 0) {
    return "assistant";
  }
  return "borderStrong";
}

function resolveWorkShellComposerDockLayout(input: {
  readonly inputValue: string;
  readonly dockWidth: number;
  readonly footerLine: string;
  readonly mode?: string;
  readonly attachmentCount?: number;
  readonly isBusy?: boolean;
  readonly queuePaused?: boolean;
  readonly queuedCount?: number;
}): WorkShellComposerDockLayout {
  const divider = "─".repeat(input.dockWidth);
  return {
    accentColorRole: resolveWorkShellComposerDockAccentRole(input),
    attachmentBadgeColorRole: input.attachmentCount !== undefined && input.attachmentCount >= 5
      ? "warning"
      : "textDim",
    topDivider: divider,
    bottomDivider: divider,
    footerLine: padDisplayLine(input.footerLine, input.dockWidth),
  };
}

function renderWorkShellEntryBlock(input: {
  readonly entry: WorkShellEntry;
  readonly index: number;
  readonly width: number;
}): React.ReactNode {
  const presentation = getWorkShellEntryPresentation(input.entry.role);
  const bodyText = input.entry.role === "assistant"
    ? normalizeMarkdownDisplayText(formatWorkShellAssistantDisplayText(input.entry.text))
    : input.entry.text;

  if (input.entry.role === "user") {
    const prefix = `${presentation.badge} ${presentation.label} · `;
    const lines = prefixWrappedDisplayText(prefix, bodyText, input.width);
    const labelBackgroundColor = presentation.labelBackgroundColor ?? W.userBadgeBg;
    const labelTextColor = presentation.labelTextColor ?? W.userBadgeText;
    const prefixWidth = getDisplayWidth(prefix);
    return (
      <Box
        key={`${input.entry.role}-${input.index}`}
        marginBottom={1}
        paddingLeft={1}
        flexDirection="column"
      >
        {lines.map((line, lineIndex) => (
          <Text key={`user-${String(input.index)}-${String(lineIndex)}`}>
            {lineIndex === 0 ? (
              <>
                <Text backgroundColor={labelBackgroundColor} color={labelTextColor} bold>
                  {presentation.badge} {presentation.label}
                </Text>
                <Text {...readableTextColorProps(W.textMuted)}> · </Text>
                <WorkShellReadableText color={presentation.bodyColor}>
                  {line.slice(prefixWidth)}
                </WorkShellReadableText>
              </>
            ) : (
              <>
                <Text {...readableTextColorProps(W.textDim)}>{" ".repeat(prefixWidth)}</Text>
                <WorkShellReadableText color={presentation.bodyColor}>{line.trimStart()}</WorkShellReadableText>
              </>
            )}
          </Text>
        ))}
      </Box>
    );
  }

  if (input.entry.role === "assistant") {
    // Streaming deltas rewrap on every frame; the synchronous Rust wrap
    // spawn per delta starves the render loop and keeps live text off the
    // screen. Route the streaming entry through the pure-TS wrapper so
    // partial text paints immediately (DESIGN.md: streaming cursor only
    // when assistant text is live). Final entries keep the Rust wrap.
    const isStreamingEntry = input.entry.text.endsWith(STREAMING_CURSOR);
    const wrapLines = isStreamingEntry
      ? wrapDisplayTextFast
      : wrapDisplayText;
    const lines = wrapLines(bodyText, Math.max(20, input.width - 8));
    const labelBackgroundColor = presentation.labelBackgroundColor ?? W.assistantBadgeBg;
    const labelTextColor = presentation.labelTextColor ?? W.assistantBadgeText;
    if (shouldUseCompactAssistantSurface({ text: input.entry.text, width: input.width })) {
      return (
        <Box
          key={`${input.entry.role}-${input.index}`}
          marginBottom={1}
          paddingLeft={1}
          flexDirection="column"
        >
          <Text>
            <Text backgroundColor={labelBackgroundColor} color={labelTextColor} bold>
              {presentation.badge} {presentation.label}
            </Text>
          </Text>
          {renderContinuationBodyLines({
            lines,
            bodyColor: presentation.bodyColor,
            keyPrefix: `assistant-${String(input.index)}`,
          })}
        </Box>
      );
    }
    return (
      <Box
        key={`${input.entry.role}-${input.index}`}
        marginBottom={1}
        borderStyle="round"
        borderColor={presentation.borderColor}
        paddingX={1}
        flexDirection="column"
      >
        <Text>
          <Text backgroundColor={labelBackgroundColor} color={labelTextColor} bold>
            {presentation.badge} {presentation.label}
          </Text>
        </Text>
        <Box marginTop={0} flexDirection="column">
          {renderContinuationBodyLines({
            lines: wrapDisplayText(bodyText, Math.max(20, input.width - 4)),
            bodyColor: presentation.bodyColor,
            keyPrefix: `assistant-card-${String(input.index)}`,
          })}
        </Box>
      </Box>
    );
  }

  if (input.entry.role === "tool") {
    const lines = formatWorkShellToolEntryLines(bodyText, input.width);
    return (
      <Box
        key={`${input.entry.role}-${input.index}`}
        marginBottom={1}
        paddingLeft={2}
        flexDirection="column"
      >
        <Text bold color={W.toolAccent}>{presentation.badge} {presentation.label}</Text>
        <Box marginTop={lines.length > 0 ? 1 : 0} paddingLeft={1} flexDirection="column">
          {lines.map((line, lineIndex) => (
            <Text key={`tool-${String(input.index)}-${String(lineIndex)}`} {...readableTextColorProps(W.text)}>
              {line}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  if (input.entry.role === "system") {
    return (
      <Box
        key={`${input.entry.role}-${input.index}`}
        marginBottom={0}
        paddingLeft={2}
        flexDirection="column"
      >
        <Text {...readableTextColorProps(presentation.bodyColor ?? W.textMuted)}>
          <Text color={W.textDim}>{presentation.badge} </Text>
          {bodyText}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      key={`${input.entry.role}-${input.index}`}
      marginBottom={0}
      paddingLeft={3}
      flexDirection="column"
    >
      <WorkShellReadableText color={presentation.bodyColor}>{bodyText}</WorkShellReadableText>
    </Box>
  );
}

function renderWorkShellEmptyConversation(): React.ReactNode {
  const actions = [
    ["Start", "Type the task in plain language."],
    ["Inspect", "Use /context before a risky edit."],
    ["Recover", "Use Ctrl+O for saved sessions."],
  ] as const;
  return (
    <Box borderStyle="round" borderColor={W.borderStrong} paddingX={1} flexDirection="column">
      <Text>
        <Text color={W.assistant}>◇ </Text>
        <Text bold {...readableTextColorProps(W.text)}>Ready for the next move</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text {...readableTextColorProps(W.textMuted)}>{getWorkShellEmptyConversationHint()}</Text>
        <Box marginTop={1} flexDirection="column" gap={0}>
          {actions.map(([label, detail], index) => (
            <Text key={label}>
              <Text {...readableTextColorProps(W.borderSoft)}>{index === actions.length - 1 ? "└─ " : "├─ "}</Text>
              <Text color={W.user} bold>{label}</Text>
              <Text {...readableTextColorProps(W.textMuted)}> · {detail}</Text>
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

export function getWorkShellThinkingDetailLines(input: {
  readonly busyStatus?: string;
  readonly spinnerFrame?: number;
} = {}): readonly string[] {
  void input;
  return [];
}

const WorkShellConversationBlock = React.memo(function WorkShellConversationBlock(props: {
  readonly entries: readonly WorkShellEntry[];
  readonly streamingAssistantText?: string;
  readonly isBusy: boolean;
  readonly panelPlacement: WorkShellPanelPlacement;
  readonly terminalColumns?: number;
}) {
  const conversationWidth = getWorkShellConversationWidth({
    panelPlacement: props.panelPlacement,
    ...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {}),
  });
  const entries = props.streamingAssistantText
    ? [
        ...props.entries.filter(shouldShowWorkShellConversationEntry),
        { role: "assistant", text: `${props.streamingAssistantText}${STREAMING_CURSOR}` } as const,
      ]
    : props.entries.filter(shouldShowWorkShellConversationEntry);

  return (
    <Box flexDirection="column" width={props.panelPlacement === "side" ? "68%" : undefined} paddingRight={props.panelPlacement === "side" ? 1 : 0}>
      <Box flexDirection="column">
        {entries.length === 0 ? (
          props.isBusy ? null : renderWorkShellEmptyConversation()
        ) : entries.slice(-12).map((entry, index) => renderWorkShellEntryBlock({
          entry,
          index,
          width: conversationWidth,
        }))}
      </Box>
    </Box>
  );
});

export function formatWorkShellLiveActivityLine(input: {
  readonly isBusy: boolean;
  readonly busyStatus?: string;
  readonly spinnerFrame?: number;
}): string | null {
  if (!input.isBusy) {
    return null;
  }
  const detail = normalizeBusyDetail(input.busyStatus ?? "");
  return `${pickBusySpinnerFrame(input.spinnerFrame ?? 0)} ${detail.length > 0 ? detail : "Working…"}`;
}

const WorkShellPanelBlock = React.memo(function WorkShellPanelBlock(props: {
  readonly title: string;
  readonly lines: readonly string[];
  readonly panelPlacement: WorkShellPanelPlacement;
  readonly panelBorderColor: string;
  readonly panelDisplayMode: WorkShellPanelDisplayMode;
  readonly inputValue: string;
  readonly terminalColumns?: number;
}) {
  const dividerWidth = props.panelPlacement === "side"
    ? getWorkShellDividerWidth({
        ...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {}),
        maxWidth: 36,
        reservedColumns: Math.max(8, Math.floor((props.terminalColumns ?? 96) * 0.68)),
      })
    : getWorkShellDividerWidth({
        ...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {}),
      });

  return (
    <Box flexDirection="column" width={props.panelPlacement === "side" ? "32%" : undefined} paddingLeft={props.panelPlacement === "side" ? 1 : 0} marginTop={props.panelPlacement === "bottom" ? 1 : 0}>
      <WorkShellSectionDivider label={props.title} accentColor={props.panelBorderColor} width={dividerWidth} />
      <Box
        marginTop={1}
        flexDirection="column"
        paddingLeft={1}
        minHeight={getWorkShellBottomDrawerMinHeight(props.panelDisplayMode, props.title, props.inputValue)}
      >
        {(props.lines.length > 0 ? props.lines : formatWorkShellPanelEmptyLines(props.title))
          .map((line, index) => renderWorkShellPanelLine(line, index))}
      </Box>
    </Box>
  );
});

const WorkShellAttachmentBlock = React.memo(function WorkShellAttachmentBlock(props: {
  readonly attachmentLines: readonly string[];
  readonly terminalColumns?: number;
}) {
  if (props.attachmentLines.length === 0 || getWorkShellAttachmentPlacement() !== "after-composer") {
    return null;
  }

  return (
    <Box marginTop={1} flexDirection="column">
      <WorkShellSectionDivider
        label="attachments"
        accentColor={W.textMuted}
        width={getWorkShellDividerWidth({
          ...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {}),
        })}
      />
      <Box marginTop={1} flexDirection="column" paddingLeft={1} minHeight={getWorkShellAttachmentMinHeight()}>
        {props.attachmentLines.map((line, index) => (
          <Text key={`${index}-${line}`} {...readableTextColorProps(getWorkShellAttachmentLineColor(index))}>{line}</Text>
        ))}
      </Box>
    </Box>
  );
});

const WorkShellHeaderBlock = React.memo(function WorkShellHeaderBlock(props: {
  readonly provider: string;
  readonly headerHint?: string;
  readonly terminalColumns?: number;
}) {
  const providerTitle = formatWorkShellProviderTitle(props.provider);
  const headerHint = props.headerHint ?? "work context · Ctrl+O sessions · / commands";
  const width = Math.max(32, (props.terminalColumns ?? process.stdout.columns ?? 96) - 2);
  const leftWidth = getDisplayWidth(providerTitle);
  const rightWidth = getDisplayWidth(headerHint);
  const minGap = 2;
  const dividerWidth = Math.max(24, Math.min(48, (props.terminalColumns ?? process.stdout.columns ?? 96) - 8));

  if (leftWidth + minGap + rightWidth > width && leftWidth + minGap + 12 > width) {
    return (
      <Box flexDirection="column">
        <Text bold {...readableTextColorProps(W.borderStrong)}>
          {truncateForDisplayWidth(providerTitle, width)}
        </Text>
        {renderChromeRule({ width: dividerWidth })}
      </Box>
    );
  }

  const hintText = leftWidth + minGap + rightWidth <= width
    ? headerHint
    : truncateForDisplayWidth(headerHint, Math.max(12, width - leftWidth - minGap));
  const hintGap = leftWidth + minGap + getDisplayWidth(hintText) <= width
    ? " ".repeat(Math.max(minGap, width - leftWidth - getDisplayWidth(hintText)))
    : " ".repeat(minGap);

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold {...readableTextColorProps(W.borderStrong)}>{providerTitle}</Text>
        <Text>{hintGap}</Text>
        <Text {...readableTextColorProps(W.textDim)}>{hintText}</Text>
      </Text>
      {renderChromeRule({ width: dividerWidth })}
    </Box>
  );
});

const WorkShellStatusBlock = React.memo(function WorkShellStatusBlock(props: {
  readonly model: string;
  readonly reasoningLabel: string;
  readonly mode: string;
  readonly authLabel: string;
  readonly isBusy: boolean;
  readonly busyStatus?: string;
  readonly currentTurnStartedAt?: number;
  readonly lastTurnDurationMs?: number;
  readonly terminalColumns?: number;
}) {
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const [spinnerFrame, setSpinnerFrame] = React.useState(0);
  const sessionGroup = formatWorkShellSessionFactsGroup({
    model: props.model,
    mode: props.mode,
  });
  const authGroup = formatWorkShellAuthFactsGroup(props.authLabel);
  const activityLine = formatWorkShellUsageLine({
    isBusy: props.isBusy,
    ...(props.busyStatus ? { busyStatus: props.busyStatus } : {}),
    ...(props.currentTurnStartedAt !== undefined ? { currentTurnStartedAt: props.currentTurnStartedAt } : {}),
    ...(props.lastTurnDurationMs !== undefined ? { lastTurnDurationMs: props.lastTurnDurationMs } : {}),
    nowMs,
    spinnerFrame,
  });
  const activityColor = resolveWorkShellBusyActivityColor({
    mode: props.mode,
    isBusy: props.isBusy,
    ...(props.busyStatus ? { busyStatus: props.busyStatus } : {}),
  });

  React.useEffect(() => {
    if (!props.isBusy) {
      setNowMs(Date.now());
      setSpinnerFrame(0);
      return;
    }

    setNowMs(Date.now());
    setSpinnerFrame((frame) => frame + 1);
    const interval = setInterval(() => {
      setNowMs(Date.now());
      setSpinnerFrame((frame) => frame + 1);
    }, WORK_SHELL_SPINNER_INTERVAL_MS);

    return () => {
      clearInterval(interval);
    };
  }, [props.isBusy, props.currentTurnStartedAt]);

  const isAuthWarning = /blocked|unavailable|not signed|needs refresh|lacks/i.test(props.authLabel);
  const authColor = isAuthWarning ? W.warning : W.textMuted;
  const elapsedMs = props.isBusy && props.currentTurnStartedAt !== undefined
    ? Math.max(0, nowMs - props.currentTurnStartedAt)
    : undefined;
  const elapsedLabel = elapsedMs !== undefined ? ` · ${formatCompactDuration(elapsedMs)}` : "";
  const busyDetail = normalizeBusyDetail(props.busyStatus ?? "");
  const busyLabel = busyDetail.length > 0 ? busyDetail : "Working";
  const activityDisplay = props.isBusy ? `${busyLabel}${elapsedLabel}` : activityLine;
  const spinnerGlyph = props.isBusy
    ? spinnerFrame % 2 === 0 ? BRAND_SPINNER_GLYPH : "✽"
    : "◇";
  return (
    <Box marginTop={1} paddingLeft={1}>
      <Text>
        <Text color={props.isBusy ? W.spinner : W.user} bold>{spinnerGlyph} </Text>
        <Text bold {...readableTextColorProps(W.borderStrong)}>{sessionGroup}</Text>
        <Text color={W.borderSoft}>{WORK_SHELL_STATUS_GROUP_SEPARATOR}</Text>
        <Text color={authColor} bold={isAuthWarning}>{authGroup}</Text>
        <Text color={W.borderSoft}>{WORK_SHELL_STATUS_GROUP_SEPARATOR}</Text>
        <Text {...(props.isBusy
          ? { color: activityColor, bold: true }
          : readableTextColorProps(W.textMuted))}>{activityDisplay}</Text>
      </Text>
    </Box>
  );
});

const WorkShellComposerDock = React.memo(function WorkShellComposerDock(props: {
  readonly composer: React.ReactNode;
  readonly composerHint?: string;
  readonly inputValue: string;
  readonly cwd?: string;
  readonly model: string;
  readonly reasoningLabel: string;
  readonly mode: string;
  readonly authLabel: string;
  readonly contextIndicator?: string;
  readonly terminalColumns?: number;
  readonly attachmentCount?: number;
  readonly isBusy?: boolean;
  readonly queuePaused?: boolean;
  readonly queuedCount?: number;
}) {
  const dockWidth = getWorkShellDockWidth(props.terminalColumns);
  const footerLine = formatWorkShellFooterLine({
    ...(props.cwd ? { cwd: props.cwd } : {}),
    model: props.model,
    reasoningLabel: props.reasoningLabel,
    mode: props.mode,
    authLabel: props.authLabel,
    ...(props.contextIndicator ? { contextIndicator: props.contextIndicator } : {}),
    width: dockWidth,
  });
  const dockLayout = resolveWorkShellComposerDockLayout({
    inputValue: props.inputValue,
    dockWidth,
    footerLine,
    mode: props.mode,
    ...(props.attachmentCount !== undefined ? { attachmentCount: props.attachmentCount } : {}),
    ...(props.isBusy ? { isBusy: true } : {}),
    ...(props.queuePaused ? { queuePaused: true } : {}),
    ...(props.queuedCount !== undefined ? { queuedCount: props.queuedCount } : {}),
  });
  const accent = dockLayout.accentColorRole === "user"
    ? W.user
    : dockLayout.accentColorRole === "assistant"
      ? W.assistant
      : dockLayout.accentColorRole === "warning"
        ? W.warning
        : W.borderStrong;
  const badgeColorProps = dockLayout.attachmentBadgeColorRole === "warning" ? { color: W.warning } : readableTextColorProps(W.textDim);
  const hintColorProps = dockLayout.accentColorRole === "warning"
    ? { color: W.warning }
    : dockLayout.accentColorRole === "user"
      ? { color: W.user }
      : dockLayout.accentColorRole === "assistant"
        ? { color: W.assistant }
        : readableTextColorProps(W.textMuted);

  return (
    <Box marginTop={1} flexDirection="column">
      {props.composerHint ? (
        <Text {...hintColorProps}>{props.composerHint}</Text>
      ) : null}
      <Text {...readableTextColorProps(W.borderSoft)}>{formatWorkShellPromptDeckDivider(dockWidth)}</Text>
      <Box minHeight={1} paddingLeft={1}>
        <Text color={accent} bold>{"› "}</Text>
        {props.composer}
        {props.attachmentCount !== undefined ? (
          <Text {...badgeColorProps}> [{props.attachmentCount}/5]</Text>
        ) : null}
      </Box>
      <Text {...readableTextColorProps(W.borderSoft)}>{dockLayout.footerLine}</Text>
    </Box>
  );
});

export function formatWorkShellQueueIndicator(queuedCount: number, queuePaused = false): string | null {
  if (queuedCount <= 0) {
    return null;
  }
  if (queuePaused) {
    return `⋯ ${queuedCount} queued · paused · /queue clear`;
  }
  return `⋯ ${queuedCount} queued · /queue`;
}

export function WorkShellView(props: {
  readonly provider: string;
  readonly model: string;
  readonly reasoningLabel: string;
  readonly reasoningSupported: boolean;
  readonly mode: string;
  readonly authLabel: string;
  readonly contextIndicator?: string;
  readonly entries: readonly WorkShellEntry[];
  readonly streamingAssistantText?: string;
  readonly isBusy: boolean;
  readonly busyStatus?: string;
  readonly activePanel: WorkShellPanel;
  readonly currentTurnStartedAt?: number;
  readonly lastTurnDurationMs?: number;
  readonly attachmentLines?: readonly string[];
  readonly attachmentCount?: number;
  readonly composer: React.ReactNode;
  readonly inputValue: string;
  readonly slashSuggestionCount: number;
  readonly selectedSlashCommand?: string;
  readonly headerHint?: string;
  readonly composerHintOverride?: string;
  readonly terminalColumns?: number;
  readonly cwd?: string;
  readonly queuedCount?: number;
  readonly queuePaused?: boolean;
}) {
  const composerHint = resolveWorkShellComposerHint({
    ...(props.composerHintOverride ? { composerHintOverride: props.composerHintOverride } : {}),
    isBusy: props.isBusy,
    ...(props.queuePaused !== undefined ? { queuePaused: props.queuePaused } : {}),
    ...(props.queuedCount !== undefined ? { queuedCount: props.queuedCount } : {}),
    inputValue: props.inputValue,
    slashSuggestionCount: props.slashSuggestionCount,
    ...(props.selectedSlashCommand ? { selectedSlashCommand: props.selectedSlashCommand } : {}),
  });
  const panelBorderColor = getWorkShellPanelBorderColor(props.inputValue, props.activePanel.title);
  const panelDisplayMode = getWorkShellPanelDisplayMode({
    panelTitle: props.activePanel.title,
    inputValue: props.inputValue,
    ...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {}),
  });
  const panelPlacement = panelDisplayMode === "side" ? "side" : "bottom";
  const overlayLines = formatWorkShellOverlayPanelLines({
    panelTitle: props.activePanel.title,
    lines: props.activePanel.lines,
  });
  const shouldSuppressOverlayForInput = shouldHideWorkShellOverlayForInput({
    panelTitle: props.activePanel.title,
    inputValue: props.inputValue,
  });
  const shouldSuppressPassivePanel = shouldSuppressWorkShellPassivePanel({
    panelDisplayMode,
    panelTitle: props.activePanel.title,
    inputValue: props.inputValue,
    isBusy: props.isBusy,
    latestSystemText: getLatestWorkShellSystemText(props.entries),
  });
  const queueIndicator = formatWorkShellQueueIndicator(props.queuedCount ?? 0, props.queuePaused ?? false);

  const conversation = (
    <WorkShellConversationBlock
      entries={props.entries}
      {...(props.streamingAssistantText ? { streamingAssistantText: props.streamingAssistantText } : {})}
      isBusy={props.isBusy}
      {...(props.busyStatus ? { busyStatus: props.busyStatus } : {})}
      {...(props.currentTurnStartedAt !== undefined ? { currentTurnStartedAt: props.currentTurnStartedAt } : {})}
      panelPlacement={panelPlacement}
      {...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {})}
    />
  );

  const panel = (
    <WorkShellPanelBlock
      title={props.activePanel.title}
      lines={props.activePanel.lines}
      panelPlacement={panelPlacement}
      panelBorderColor={panelBorderColor}
      panelDisplayMode={panelDisplayMode}
      inputValue={props.inputValue}
      {...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {})}
    />
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <WorkShellHeaderBlock
        provider={props.provider}
        {...(props.headerHint ? { headerHint: props.headerHint } : {})}
        {...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {})}
      />
      <WorkShellStatusBlock
        model={props.model}
        reasoningLabel={props.reasoningLabel}
        mode={props.mode}
        authLabel={props.authLabel}
        isBusy={props.isBusy}
        {...(props.busyStatus ? { busyStatus: props.busyStatus } : {})}
        {...(props.currentTurnStartedAt !== undefined ? { currentTurnStartedAt: props.currentTurnStartedAt } : {})}
        {...(props.lastTurnDurationMs !== undefined ? { lastTurnDurationMs: props.lastTurnDurationMs } : {})}
        {...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {})}
      />
      {getWorkShellPanelAnchor(panelDisplayMode) === "with-conversation" ? (
        <Box marginTop={1}>
          {conversation}
          {panel}
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {conversation}
        </Box>
      )}
      {queueIndicator !== null ? (
        <Box marginTop={1}>
          <Text {...readableTextColorProps(props.queuePaused ? W.warning : W.textMuted)}>{queueIndicator}</Text>
        </Box>
      ) : null}
      <WorkShellComposerDock
        composer={props.composer}
        {...(composerHint ? { composerHint } : {})}
        inputValue={props.inputValue}
        {...(props.cwd ? { cwd: props.cwd } : {})}
        model={props.model}
        reasoningLabel={props.reasoningLabel}
        mode={props.mode}
        authLabel={props.authLabel}
        {...(props.contextIndicator ? { contextIndicator: props.contextIndicator } : {})}
        {...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {})}
        {...(props.attachmentCount !== undefined ? { attachmentCount: props.attachmentCount } : {})}
        isBusy={props.isBusy}
        {...(props.queuePaused !== undefined ? { queuePaused: props.queuePaused } : {})}
        {...(props.queuedCount !== undefined ? { queuedCount: props.queuedCount } : {})}
      />
      {props.attachmentLines
        ? <WorkShellAttachmentBlock
            attachmentLines={props.attachmentLines}
            {...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {})}
          />
        : null}
      {panelDisplayMode === "overlay" && !shouldSuppressOverlayForInput ? (
        <Box marginTop={1} borderStyle="round" borderColor={panelBorderColor} paddingX={1} flexDirection="column">
          <WorkShellSectionDivider
            label={props.activePanel.title}
            accentColor={panelBorderColor}
            width={getWorkShellDividerWidth({
              ...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {}),
              reservedColumns: 8,
            })}
          />
          <Text {...readableTextColorProps(W.textMuted)}>Esc closes · /context refreshes</Text>
          <Box marginTop={1} flexDirection="column">
            {overlayLines.map((line, index) => renderWorkShellPanelLine(line, index))}
          </Box>
        </Box>
      ) : panelDisplayMode === "bottom" && !shouldSuppressPassivePanel ? (
        panel
      ) : null}
    </Box>
  );
}
