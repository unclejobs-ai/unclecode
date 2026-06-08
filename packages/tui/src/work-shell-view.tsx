import { Box, Text } from "ink";
import React from "react";
import {
  runRustCommandSync,
  sanitizeWorkShellAssistantText,
} from "@unclecode/orchestrator";

import { getDisplayWidth, truncateForDisplayWidth } from "./text-width.js";

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
  text: "#e5eef7",
  textMuted: "#94a3b8",
  textDim: "#64748b",
  border: "#334155",
  borderStrong: "#475569",
  user: "#7dd3fc",
  userBody: "#e2e8f0",
  userBadgeText: "#082f49",
  userBadgeBg: "#bae6fd",
  assistant: "#5eead4",
  assistantBody: "#f8fafc",
  assistantBadgeText: "#042f2e",
  assistantBadgeBg: "#99f6e4",
  assistantMuted: "#99f6e4",
  tool: "#bef264",
  toolSurface: "#13231a",
  toolAccent: "#bef264",
  toolMuted: "#8ea38a",
  warning: "#facc15",
} as const;

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
      <Text color={props.accentColor ?? W.textMuted}>{labelContent}</Text>
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

export function getWorkShellAttachmentLineColor(index: number): string {
  const role = resolveWorkShellAttachmentLayout(index).attachmentLineColorRole;
  if (role === "user") return W.user;
  if (role === "text") return W.text;
  return W.textMuted;
}

export function getWorkShellComposerHint(inputValue: string, slashSuggestionCount: number): string | undefined {
  const raw = runRustCommandSync(
    ["rust", "ux", "text", "composer-hint"],
    process.cwd(),
    JSON.stringify({ inputValue, slashSuggestionCount }),
  );
  const parsed = JSON.parse(raw) as { hint?: string | null };
  return parsed.hint ?? undefined;
}

const WORK_SHELL_BUSY_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const rustBusyStatusCache = new Map<string, string>();
const rustMarkdownDisplayCache = new Map<string, string>();
const rustThinkingLineCache = new Map<string, string>();
const rustStatusLineCache = new Map<string, string>();
const rustFooterLineCache = new Map<string, string>();
const rustWrapDisplayCache = new Map<string, readonly string[]>();
const rustPanelLineClassCache = new Map<string, WorkShellPanelLineClass>();
const rustPanelLayoutCache = new Map<string, WorkShellPanelLayout>();
const rustEntryPresentationCache = new Map<WorkShellEntryRole, WorkShellEntryRolePresentationContract>();
const rustAttachmentLayoutCache = new Map<number, WorkShellAttachmentLayout>();
const rustViewportLayoutCache = new Map<string, WorkShellViewportLayout>();
const rustComposerDockLayoutCache = new Map<string, WorkShellComposerDockLayout>();

type WorkShellPanelDisplayMode = "hidden" | "overlay" | "side" | "bottom";
type WorkShellPanelPlacement = "side" | "bottom";
type WorkShellPanelAnchor = "with-conversation" | "after-composer";

type WorkShellPanelLayout = {
  readonly borderColorRole: "user" | "assistant" | "borderStrong" | "border";
  readonly displayMode: WorkShellPanelDisplayMode;
  readonly placement: WorkShellPanelPlacement;
  readonly anchor: WorkShellPanelAnchor;
  readonly bottomDrawerMinHeight: number;
};

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
  readonly accentColorRole: "user" | "borderStrong";
  readonly attachmentBadgeColorRole: "warning" | "textDim";
  readonly topDivider: string;
  readonly bottomDivider: string;
  readonly footerLine: string;
};

type WorkShellPanelLineClass =
  | { readonly kind: "blank"; readonly trimmed: string }
  | { readonly kind: "section"; readonly trimmed: string }
  | { readonly kind: "tree"; readonly branch: string; readonly label: string; readonly spacing: string; readonly value: string }
  | {
    readonly kind: "suggestion";
    readonly marker: string;
    readonly command: string;
    readonly spacing: string;
    readonly description: string;
    readonly isSelected: boolean;
    readonly isWarning: boolean;
  }
  | { readonly kind: "selected-command" | "command" | "signed-in" | "not-signed-in" | "warning" | "tip" | "hint-warning" | "match-summary"; readonly trimmed: string }
  | { readonly kind: "fact"; readonly label: string; readonly value: string; readonly isWarning: boolean }
  | { readonly kind: "indent"; readonly line: string; readonly trimmed: string }
  | { readonly kind: "text"; readonly line: string; readonly trimmed: string };

function runRustUxText(operation: "busy-status" | "normalize-markdown", value: string): string {
  return runRustCommandSync(["rust", "ux", "text", operation], process.cwd(), value).trimEnd();
}

export function formatWorkShellBusyStatusLine(status?: string, frame = 0): string {
  const spinner = WORK_SHELL_BUSY_SPINNER_FRAMES[((frame % WORK_SHELL_BUSY_SPINNER_FRAMES.length) + WORK_SHELL_BUSY_SPINNER_FRAMES.length) % WORK_SHELL_BUSY_SPINNER_FRAMES.length];
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
  rustMarkdownDisplayCache.set(value, normalized);
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
  const spinner = WORK_SHELL_BUSY_SPINNER_FRAMES[(((input.spinnerFrame ?? 0) % WORK_SHELL_BUSY_SPINNER_FRAMES.length) + WORK_SHELL_BUSY_SPINNER_FRAMES.length) % WORK_SHELL_BUSY_SPINNER_FRAMES.length];
  const activity = input.isBusy ? `${spinner} Working now` : "Ready";
  const usage = input.isBusy
    ? input.currentTurnStartedAt === undefined
      ? "elapsed now"
      : `elapsed ${formatCompactDuration(Math.max(0, (input.nowMs ?? input.currentTurnStartedAt) - input.currentTurnStartedAt))}`
    : input.lastTurnDurationMs === undefined
      ? "no reply yet"
      : `last reply ${formatCompactDuration(input.lastTurnDurationMs)}`;
  const controls = input.isBusy ? "Ctrl+C/Esc interrupt · Enter queues" : "";
  const detail = input.isBusy ? normalizeBusyDetail(input.busyStatus ?? "") : "";
  return [activity, usage, controls, detail].filter((part) => part.length > 0).join(" · ");
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
  return value.replace(/^[·→★✓✖↔\s]+/u, "").trim();
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
  const cached = rustPanelLineClassCache.get(line);
  if (cached !== undefined) {
    return cached;
  }
  const raw = runRustCommandSync(["rust", "ux", "text", "panel-line-class"], process.cwd(), line);
  const parsed = JSON.parse(raw) as WorkShellPanelLineClass;
  rustPanelLineClassCache.set(line, parsed);
  return parsed;
}

function resolveWorkShellPanelLayout(input: {
  readonly panelTitle: string;
  readonly inputValue: string;
  readonly terminalColumns?: number;
  readonly displayMode?: WorkShellPanelDisplayMode;
}): WorkShellPanelLayout {
  const key = JSON.stringify(input);
  const cached = rustPanelLayoutCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const raw = runRustCommandSync(["rust", "ux", "text", "panel-layout"], process.cwd(), key);
  const parsed = JSON.parse(raw) as WorkShellPanelLayout;
  rustPanelLayoutCache.set(key, parsed);
  return parsed;
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
        <Text bold color={W.textMuted}>{classified.trimmed}</Text>
      </Box>
    );
  }
  if (classified.kind === "tree") {
    return (
      <Text key={`${index}-${line}`} color={W.textMuted}>
        {classified.branch} <Text color={W.user}>{classified.label}</Text>
        {classified.spacing}
        <Text color={W.text}>{classified.value}</Text>
      </Text>
    );
  }
  if (classified.kind === "suggestion") {
    return (
      <Text key={`${index}-${line}`}>
      <Text color={classified.isSelected ? W.user : W.textMuted}>{classified.marker}</Text>
      <Text color={classified.isSelected ? W.user : W.user}> {classified.command}</Text>
      <Text color={classified.isWarning ? W.warning : classified.isSelected ? W.text : W.textMuted}>{classified.spacing}{classified.description}</Text>
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
    const labelColor = classified.label === "Warning" ? W.warning : W.textMuted;
    const valueColor = classified.isWarning ? W.warning : W.text;
    return (
      <Text key={`${index}-${line}`}>
        <Text color={labelColor}>{classified.label}</Text>
        <Text color={W.textMuted}> · </Text>
        <Text color={valueColor}>{classified.value}</Text>
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
    return <Text key={`${index}-${line}`} color={W.textDim}>{classified.trimmed}</Text>;
  }
  if (classified.kind === "hint-warning") {
    return <Text key={`${index}-${line}`} color={W.warning}>{classified.trimmed}</Text>;
  }
  if (classified.kind === "match-summary") {
    return <Text key={`${index}-${line}`} color={W.textDim}>{classified.trimmed}</Text>;
  }
  if (classified.kind === "indent") {
    return <Text key={`${index}-${line}`} color={W.textMuted}>{classified.line}</Text>;
  }
  if (classified.kind === "text") {
    return <Text key={`${index}-${line}`} color={W.text}>{classified.line}</Text>;
  }
  return <Text key={`${index}-${line}`} color={W.text}>{line}</Text>;
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

function padDisplayLine(value: string, width: number): string {
  const padding = Math.max(0, width - getDisplayWidth(value));
  return `${value}${" ".repeat(padding)}`;
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
    return [`${presentation.badge} ${presentation.label}`, ...bodyLines.map((line) => `  ${line}`)];
  }

  if (input.role === "tool") {
    const bodyLines = formatWorkShellToolEntryLines(bodyText, input.width);
    return [`${presentation.badge} ${presentation.label}`, ...bodyLines.map((line) => `  ${line}`)];
  }

  return prefixWrappedDisplayText(`${presentation.badge} ${presentation.label} · `, bodyText, input.width);
}

export function shouldShowWorkShellConversationEntry(entry: WorkShellEntry): boolean {
  return entry.role !== "tool" && (
    entry.role !== "assistant" ||
    formatWorkShellAssistantDisplayText(entry.text).trim().length > 0
  );
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
  const payload = {
    ...input,
    home: process.env.HOME,
  };
  const key = JSON.stringify(payload);
  const cached = rustFooterLineCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const line = runRustCommandSync(["rust", "ux", "text", "footer-line"], process.cwd(), key).trimEnd();
  rustFooterLineCache.set(key, line);
  return line;
}

function wrapDisplayText(value: string, width: number): string[] {
  const key = JSON.stringify({ text: value, width });
  const cached = rustWrapDisplayCache.get(key);
  if (cached !== undefined) {
    return [...cached];
  }
  const raw = runRustCommandSync(["rust", "ux", "text", "wrap-display"], process.cwd(), key);
  const parsed = JSON.parse(raw) as string[];
  rustWrapDisplayCache.set(key, parsed);
  return parsed;
}

function resolveWorkShellComposerDockLayout(input: {
  readonly inputValue: string;
  readonly dockWidth: number;
  readonly footerLine: string;
  readonly attachmentCount?: number;
}): WorkShellComposerDockLayout {
  const key = JSON.stringify(input);
  const cached = rustComposerDockLayoutCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const raw = runRustCommandSync(["rust", "ux", "text", "composer-dock-layout"], process.cwd(), key);
  const parsed = JSON.parse(raw) as WorkShellComposerDockLayout;
  rustComposerDockLayoutCache.set(key, parsed);
  return parsed;
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
    const lines = wrapDisplayText(bodyText, Math.max(20, input.width - 8));
    const renderedLines = lines.length > 0 ? lines : [""];
    const labelBackgroundColor = presentation.labelBackgroundColor ?? W.userBadgeBg;
    const labelTextColor = presentation.labelTextColor ?? W.userBadgeText;
    return (
      <Box
        key={`${input.entry.role}-${input.index}`}
        marginBottom={1}
        paddingLeft={1}
        flexDirection="column"
      >
        <Text>
          <Text backgroundColor={labelBackgroundColor} color={labelTextColor} bold>
            {" "}{presentation.badge} {presentation.label}{" "}
          </Text>
          <Text color={W.textDim}>  message</Text>
        </Text>
        {renderedLines.map((line, lineIndex) => (
          <Text key={`user-${String(input.index)}-${String(lineIndex)}`}>
            <Text color={lineIndex === 0 ? presentation.railColor : W.textDim}>▌ </Text>
            <Text color={presentation.bodyColor}>{line}</Text>
          </Text>
        ))}
      </Box>
    );
  }

  if (input.entry.role === "assistant") {
    const labelBackgroundColor = presentation.labelBackgroundColor ?? W.assistantBadgeBg;
    const labelTextColor = presentation.labelTextColor ?? W.assistantBadgeText;
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
            {" "}{presentation.badge} {presentation.label}{" "}
          </Text>
          <Text color={W.textDim}>  reply</Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          {wrapDisplayText(bodyText, Math.max(20, input.width - 4)).map((line, lineIndex) => (
            <Text key={`assistant-${String(input.index)}-${String(lineIndex)}`} color={presentation.bodyColor}>
              <Text color={lineIndex === 0 ? presentation.railColor : W.textDim}>▌ </Text>
              {line}
            </Text>
          ))}
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
            <Text key={`tool-${String(input.index)}-${String(lineIndex)}`} color={W.text}>
              {line}
            </Text>
          ))}
        </Box>
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
      <Text color={presentation.bodyColor}>{bodyText}</Text>
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
        { role: "assistant", text: `${props.streamingAssistantText}▌` } as const,
      ]
    : props.entries.filter(shouldShowWorkShellConversationEntry);

  return (
    <Box flexDirection="column" width={props.panelPlacement === "side" ? "68%" : undefined} paddingRight={props.panelPlacement === "side" ? 1 : 0}>
      <Box flexDirection="column">
        {entries.length === 0 ? (
          <Text color={W.textMuted}>{getWorkShellEmptyConversationHint()}</Text>
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
  const frames = WORK_SHELL_BUSY_SPINNER_FRAMES;
  const spinner = frames[(((input.spinnerFrame ?? 0) % frames.length) + frames.length) % frames.length];
  const detail = normalizeBusyDetail(input.busyStatus ?? "");
  return `${spinner} ${detail.length > 0 ? detail : "Working…"}`;
}

// Inline "what I'm doing now" line rendered between the conversation and the
// composer so mid-turn progress is visible where the user is looking, not only
// in the top session-state panel.
const WorkShellLiveActivity = React.memo(function WorkShellLiveActivity(props: {
  readonly isBusy: boolean;
  readonly busyStatus?: string;
}) {
  const [spinnerFrame, setSpinnerFrame] = React.useState(0);
  React.useEffect(() => {
    if (!props.isBusy) {
      return;
    }
    const timer = setInterval(() => setSpinnerFrame((value) => value + 1), 90);
    return () => clearInterval(timer);
  }, [props.isBusy]);
  const line = formatWorkShellLiveActivityLine({
    isBusy: props.isBusy,
    spinnerFrame,
    ...(props.busyStatus ? { busyStatus: props.busyStatus } : {}),
  });
  if (line === null) {
    return null;
  }
  const [spinner, ...rest] = line.split(" ");
  return (
    <Box marginTop={1}>
      <Text color={W.assistant}>{spinner} </Text>
      <Text color={W.textMuted}>{rest.join(" ")}</Text>
    </Box>
  );
});

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
        {props.lines.map((line, index) => renderWorkShellPanelLine(line, index))}
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
          <Text key={`${index}-${line}`} color={getWorkShellAttachmentLineColor(index)}>{line}</Text>
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
  const line = formatWorkShellHeaderLine({
    providerTitle: formatWorkShellProviderTitle(props.provider),
    headerHint: props.headerHint ?? "work context · Ctrl+O sessions · / commands",
    ...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {}),
  });

  return (
    <Box flexDirection="column">
      <Text color={W.text}>{line}</Text>
      <Text color={W.border}>{"▔".repeat(Math.max(24, Math.min(72, (props.terminalColumns ?? process.stdout.columns ?? 96) - 4)))}</Text>
    </Box>
  );
});

const WorkShellStatusBlock = React.memo(function WorkShellStatusBlock(props: {
  readonly model: string;
  readonly reasoningLabel: string;
  readonly reasoningSupported: boolean;
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
  const thinkingLine = formatWorkShellThinkingLine(props.reasoningLabel);
  const statusLine = formatWorkShellStatusLine({
    model: props.model,
    reasoningLabel: props.reasoningLabel,
    mode: props.mode,
    authLabel: props.authLabel,
  });
  const usageLine = formatWorkShellUsageLine({
    isBusy: props.isBusy,
    ...(props.busyStatus ? { busyStatus: props.busyStatus } : {}),
    ...(props.currentTurnStartedAt !== undefined ? { currentTurnStartedAt: props.currentTurnStartedAt } : {}),
    ...(props.lastTurnDurationMs !== undefined ? { lastTurnDurationMs: props.lastTurnDurationMs } : {}),
    nowMs,
    spinnerFrame,
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
    }, 120);

    return () => {
      clearInterval(interval);
    };
  }, [props.isBusy, props.currentTurnStartedAt]);

  return (
    <Box marginTop={1} borderStyle="round" borderColor={props.isBusy ? W.assistant : W.border} paddingX={1} flexDirection="column">
      <Text>
        <Text color={W.assistant} bold>Work context</Text>
        <Text color={W.textDim}> · session state</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold color={props.reasoningSupported ? W.user : W.warning}>◇ {thinkingLine}</Text>
        <Text color={W.text}>◇ {statusLine}</Text>
        <Text color={props.isBusy ? W.assistant : W.textMuted}>◈ {usageLine}</Text>
      </Box>
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
}) {
  const dockWidth = getWorkShellDockWidth(props.terminalColumns);
  const footerLine = formatWorkShellFooterLine({
    ...(props.cwd ? { cwd: props.cwd } : {}),
    model: props.model,
    reasoningLabel: props.reasoningLabel,
    mode: props.mode,
    authLabel: props.authLabel,
    ...(props.contextIndicator ? { contextIndicator: props.contextIndicator } : {}),
    ...(props.composerHint ? { composerHint: props.composerHint } : {}),
    width: dockWidth,
  });
  const dockLayout = resolveWorkShellComposerDockLayout({
    inputValue: props.inputValue,
    dockWidth,
    footerLine,
    ...(props.attachmentCount !== undefined ? { attachmentCount: props.attachmentCount } : {}),
  });
  const accent = dockLayout.accentColorRole === "user" ? W.assistant : W.borderStrong;
  const badgeColor = dockLayout.attachmentBadgeColorRole === "warning" ? W.warning : W.textDim;

  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={accent}>▌ prompt deck <Text color={W.border}>{dockLayout.topDivider.slice(Math.min(14, dockLayout.topDivider.length))}</Text></Text>
      <Box minHeight={1} paddingLeft={1}>
        <Text backgroundColor={accent} color={W.text}>{" "}</Text>
        <Text color={W.textMuted}>{" "}</Text>
        {props.composer}
        {props.attachmentCount !== undefined ? (
          <Text color={badgeColor}> [{props.attachmentCount}/5]</Text>
        ) : null}
      </Box>
      <Text color={W.border}>▔{dockLayout.bottomDivider.slice(1)}</Text>
      <Text color={W.textDim}>{dockLayout.footerLine}</Text>
    </Box>
  );
});

export function formatWorkShellQueueIndicator(queuedCount: number): string | null {
  if (queuedCount <= 0) {
    return null;
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
  readonly headerHint?: string;
  readonly composerHintOverride?: string;
  readonly terminalColumns?: number;
  readonly cwd?: string;
  readonly queuedCount?: number;
}) {
  const composerHint = props.composerHintOverride ?? (props.isBusy
    ? "Enter queues follow-up · Ctrl+C/Esc interrupt · /queue"
    : getWorkShellComposerHint(props.inputValue, props.slashSuggestionCount));
  const panelBorderColor = getWorkShellPanelBorderColor(props.inputValue, props.activePanel.title);
  const panelDisplayMode = getWorkShellPanelDisplayMode({
    panelTitle: props.activePanel.title,
    inputValue: props.inputValue,
    ...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {}),
  });
  const panelPlacement = panelDisplayMode === "side" ? "side" : "bottom";
  const hasComposerInput = props.inputValue.trim().length > 0;
  const overlayLines = formatWorkShellOverlayPanelLines({
    panelTitle: props.activePanel.title,
    lines: props.activePanel.lines,
  });
  const shouldSuppressOverlayForInput = shouldHideWorkShellOverlayForInput({
    panelTitle: props.activePanel.title,
    inputValue: props.inputValue,
  });
  const shouldSuppressPassivePanel =
    panelDisplayMode === "bottom" &&
    props.activePanel.title === "Session status" &&
    (hasComposerInput || !props.isBusy);

  const conversation = (
    <WorkShellConversationBlock
      entries={props.entries}
      {...(props.streamingAssistantText ? { streamingAssistantText: props.streamingAssistantText } : {})}
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
        reasoningSupported={props.reasoningSupported}
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
      <WorkShellLiveActivity
        isBusy={props.isBusy}
        {...(props.busyStatus ? { busyStatus: props.busyStatus } : {})}
      />
      {formatWorkShellQueueIndicator(props.queuedCount ?? 0) !== null ? (
        <Box marginTop={1}>
          <Text color={W.textMuted}>{formatWorkShellQueueIndicator(props.queuedCount ?? 0)}</Text>
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
          <Text color={W.textMuted}>Esc closes · /context refreshes</Text>
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
