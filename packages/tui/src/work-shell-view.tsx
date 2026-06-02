import { Box, Text } from "ink";
import React from "react";
import { runRustCommandSync } from "@unclecode/orchestrator";

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
  text: "#e7e5e4",
  textMuted: "#a8a29e",
  textDim: "#78716c",
  border: "#44403c",
  borderStrong: "#57534e",
  user: "#7dd3fc",
  userBody: "#e0f2fe",
  userBadgeText: "#082f49",
  userBadgeBg: "#38bdf8",
  userSurface: "#2f3342",
  assistant: "#86efac",
  assistantBody: "#dcfce7",
  assistantBadgeText: "#052e16",
  assistantBadgeBg: "#4ade80",
  assistantMuted: "#9ca3af",
  tool: "#fbbf24",
  toolSurface: "#18261d",
  toolAccent: "#bef264",
  toolMuted: "#8b978d",
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
  const leftLength = Math.max(1, Math.floor((width - labelContent.length) / 2));
  const rightLength = Math.max(1, width - labelContent.length - leftLength);
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
  const detail = input.isBusy ? normalizeBusyDetail(input.busyStatus ?? "") : "";
  return [activity, usage, detail].filter((part) => part.length > 0).join(" · ");
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
        <Text color={W.textDim}> · </Text>
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

function renderSurfaceText(input: {
  readonly text: string;
  readonly width: number;
  readonly backgroundColor: string;
  readonly color: string;
  readonly keyPrefix: string;
  readonly paddingX?: number;
}): React.ReactNode {
  const paddingX = input.paddingX ?? 2;
  const innerWidth = Math.max(8, input.width - paddingX * 2);
  const leftPadding = " ".repeat(paddingX);
  const rightPadding = " ".repeat(paddingX);
  const lines = wrapDisplayText(input.text, innerWidth);

  return lines.map((line, index) => (
    <Text
      key={`${input.keyPrefix}-${String(index)}`}
      backgroundColor={input.backgroundColor}
      color={input.color}
    >
      {leftPadding}{padDisplayLine(line, innerWidth)}{rightPadding}
    </Text>
  ));
}

function renderWorkShellEntryBlock(input: {
  readonly entry: WorkShellEntry;
  readonly index: number;
  readonly width: number;
}): React.ReactNode {
  const presentation = getWorkShellEntryPresentation(input.entry.role);
  const bodyText = input.entry.role === "assistant"
    ? normalizeMarkdownDisplayText(input.entry.text)
    : input.entry.text;

  if (input.entry.role === "user") {
    return (
      <Box
        key={`${input.entry.role}-${input.index}`}
        marginBottom={1}
        flexDirection="column"
      >
        {renderSurfaceText({
          text: bodyText,
          width: input.width,
          backgroundColor: W.userSurface,
          color: presentation.bodyColor,
          keyPrefix: `user-${String(input.index)}`,
        })}
      </Box>
    );
  }

  if (input.entry.role === "assistant") {
    return (
      <Box
        key={`${input.entry.role}-${input.index}`}
        marginBottom={1}
        paddingLeft={1}
        flexDirection="column"
      >
        <Text bold color={W.assistantMuted}>{presentation.label}</Text>
        <Box marginTop={1} paddingLeft={1} flexDirection="column">
          {wrapDisplayText(bodyText, Math.max(20, input.width - 4)).map((line, lineIndex) => (
            <Text key={`assistant-${String(input.index)}-${String(lineIndex)}`} color={presentation.bodyColor}>
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
        paddingLeft={1}
        flexDirection="column"
      >
        <Text bold color={W.toolAccent}>{presentation.label}</Text>
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

function renderWorkShellThinkingBlock(input: {
  readonly width: number;
  readonly busyStatus?: string;
  readonly reasoningLabel?: string;
  readonly spinnerFrame: number;
}): React.ReactNode {
  const detailLines = getWorkShellThinkingDetailLines({
    ...(input.busyStatus ? { busyStatus: input.busyStatus } : {}),
    spinnerFrame: input.spinnerFrame,
  });
  if (detailLines.length === 0) {
    return null;
  }

  return (
    <Box marginBottom={1} paddingLeft={1} flexDirection="column">
      <Text bold color={W.assistantMuted}>Thinking</Text>
      <Box marginTop={1} paddingLeft={1} flexDirection="column">
        {detailLines.flatMap((line, lineIndex) =>
          wrapDisplayText(line, Math.max(20, input.width - 4)).map((wrappedLine, wrappedIndex) => (
            <Text key={`thinking-${String(lineIndex)}-${String(wrappedIndex)}`} color={W.assistantMuted}>
              {wrappedLine}
            </Text>
          )),
        )}
      </Box>
    </Box>
  );
}

export function getWorkShellThinkingDetailLines(input: {
  readonly busyStatus?: string;
  readonly spinnerFrame?: number;
}): readonly string[] {
  if (!input.busyStatus || isLowSignalThinkingStatus(input.busyStatus)) {
    return [];
  }

  return [formatWorkShellBusyStatusLine(input.busyStatus, input.spinnerFrame ?? 0)];
}

function isLowSignalThinkingStatus(status: string): boolean {
  const normalized = status.trim().replace(/^·\s*/, "").toLowerCase();
  return normalized === "" || normalized === "thinking" || normalized === "thinking...";
}

const WorkShellConversationBlock = React.memo(function WorkShellConversationBlock(props: {
  readonly entries: readonly WorkShellEntry[];
  readonly streamingAssistantText?: string;
  readonly panelPlacement: WorkShellPanelPlacement;
  readonly isBusy: boolean;
  readonly busyStatus?: string;
  readonly reasoningLabel?: string;
  readonly terminalColumns?: number;
}) {
  const [spinnerFrame, setSpinnerFrame] = React.useState(0);
  React.useEffect(() => {
    if (!props.isBusy) return;
    const interval = setInterval(() => setSpinnerFrame((f) => f + 1), 100);
    return () => clearInterval(interval);
  }, [props.isBusy]);
  const conversationWidth = getWorkShellConversationWidth({
    panelPlacement: props.panelPlacement,
    ...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {}),
  });
  const entries = props.streamingAssistantText
    ? [
        ...props.entries,
        { role: "assistant", text: `${props.streamingAssistantText}▌` } as const,
      ]
    : props.entries;

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
        {props.isBusy ? renderWorkShellThinkingBlock({
          width: conversationWidth,
          ...(props.busyStatus ? { busyStatus: props.busyStatus } : {}),
          ...(props.reasoningLabel ? { reasoningLabel: props.reasoningLabel } : {}),
          spinnerFrame,
        }) : null}
      </Box>
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
    headerHint: props.headerHint ?? "Ctrl+O sessions · Shift+Tab mode · / commands",
    ...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {}),
  });

  return (
    <Text color={W.text}>{line}</Text>
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
  const spinner = WORK_SHELL_BUSY_SPINNER_FRAMES[((spinnerFrame % WORK_SHELL_BUSY_SPINNER_FRAMES.length) + WORK_SHELL_BUSY_SPINNER_FRAMES.length) % WORK_SHELL_BUSY_SPINNER_FRAMES.length];
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
    <Box marginTop={1} flexDirection="column">
      <WorkShellSectionDivider
        label="session"
        accentColor={W.textMuted}
        width={getWorkShellDividerWidth({
          ...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {}),
        })}
      />
      <Box marginTop={1} paddingLeft={1} flexDirection="column">
        <Text bold color={props.reasoningSupported ? W.user : W.warning}>{props.isBusy ? `${spinner} ${thinkingLine}` : thinkingLine}</Text>
        <Text color={W.text}>{statusLine}</Text>
        <Text color={props.isBusy ? W.assistant : W.textMuted}>{usageLine}</Text>
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
    ...(props.composerHint ? { composerHint: props.composerHint } : {}),
    width: dockWidth,
  });
  const dockLayout = resolveWorkShellComposerDockLayout({
    inputValue: props.inputValue,
    dockWidth,
    footerLine,
    ...(props.attachmentCount !== undefined ? { attachmentCount: props.attachmentCount } : {}),
  });
  const accent = dockLayout.accentColorRole === "user" ? W.user : W.borderStrong;
  const badgeColor = dockLayout.attachmentBadgeColorRole === "warning" ? W.warning : W.textDim;

  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={accent}>{dockLayout.topDivider}</Text>
      <Box minHeight={1} paddingLeft={1}>
        <Text backgroundColor={accent} color={W.text}>{" "}</Text>
        <Text color={W.textMuted}>{" "}</Text>
        {props.composer}
        {props.attachmentCount !== undefined ? (
          <Text color={badgeColor}> [{props.attachmentCount}/5]</Text>
        ) : null}
      </Box>
      <Text color={W.border}>{dockLayout.bottomDivider}</Text>
      <Text color={W.textDim}>{dockLayout.footerLine}</Text>
    </Box>
  );
});

export function WorkShellView(props: {
  readonly provider: string;
  readonly model: string;
  readonly reasoningLabel: string;
  readonly reasoningSupported: boolean;
  readonly mode: string;
  readonly authLabel: string;
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
}) {
  const composerHint = props.composerHintOverride ?? getWorkShellComposerHint(props.inputValue, props.slashSuggestionCount);
  const panelBorderColor = getWorkShellPanelBorderColor(props.inputValue, props.activePanel.title);
  const panelDisplayMode = getWorkShellPanelDisplayMode({
    panelTitle: props.activePanel.title,
    inputValue: props.inputValue,
    ...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {}),
  });
  const panelPlacement = panelDisplayMode === "side" ? "side" : "bottom";
  const hasComposerInput = props.inputValue.trim().length > 0;
  const shouldSuppressPassivePanel =
    panelDisplayMode === "bottom" &&
    props.activePanel.title === "Session status" &&
    (hasComposerInput || !props.isBusy);

  const conversation = (
    <WorkShellConversationBlock
      entries={props.entries}
      {...(props.streamingAssistantText ? { streamingAssistantText: props.streamingAssistantText } : {})}
      panelPlacement={panelPlacement}
      isBusy={props.isBusy}
      {...(props.busyStatus ? { busyStatus: props.busyStatus } : {})}
      {...(props.reasoningLabel ? { reasoningLabel: props.reasoningLabel } : {})}
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
      <WorkShellComposerDock
        composer={props.composer}
        {...(composerHint ? { composerHint } : {})}
        inputValue={props.inputValue}
        {...(props.cwd ? { cwd: props.cwd } : {})}
        model={props.model}
        reasoningLabel={props.reasoningLabel}
        mode={props.mode}
        authLabel={props.authLabel}
        {...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {})}
        {...(props.attachmentCount !== undefined ? { attachmentCount: props.attachmentCount } : {})}
      />
      {props.attachmentLines
        ? <WorkShellAttachmentBlock
            attachmentLines={props.attachmentLines}
            {...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {})}
          />
        : null}
      {panelDisplayMode === "overlay" ? (
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
            {props.activePanel.lines.map((line, index) => renderWorkShellPanelLine(line, index))}
          </Box>
        </Box>
      ) : panelDisplayMode === "bottom" && !shouldSuppressPassivePanel ? (
        panel
      ) : null}
    </Box>
  );
}
