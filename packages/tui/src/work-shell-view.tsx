import { Box, Text } from "ink";
import React from "react";
import type {
  AgentConsoleSnapshot,
  AgentControlReceiptStatus,
  AskUserQuestionRequest,
  ContextDeskCollection,
  ContextDeskPane,
  ContextPacketChangeClassification,
  ContextPacketReceipt,
  ContextPacketView,
  ContextPacketViewActionReceipt,
  ContextPolicySuggestion,
} from "@unclecode/contracts";
import {
  resolveWorkShellSlashArgHint,
  runRustCommandSync,
  sanitizeWorkShellAssistantText,
  type AgentConsoleViewState,
} from "@unclecode/orchestrator";

import type { GitFacts } from "./facts.js";
import { detectTerminalBackground } from "./terminal-theme.js";
import { getDisplayWidth, truncateForDisplayWidth } from "./text-width.js";
import { renderMarkdown, type MarkdownTheme } from "./markdown-render.js";
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

import {
  renderContextInspectorOverlay,
} from "./work-shell-context-inspector.js";
import { renderContextTurnReceipt } from "./work-shell-context-receipt.js";
import { resolveContextSourceMeta } from "./work-shell-context-inspector-model.js";
import {
  renderAgentHistoryOverlay,
  renderCacheTelemetryOverlay,
} from "./work-shell-telemetry.js";
import {
  formatAgentConsoleTotalCost,
  hasActiveAgentConsoleWork,
  selectActiveAgentConsoleCounts,
  type AgentConsoleActiveCounts,
} from "./work-shell-agent-console-model.js";
import { flattenRowText, formatCount } from "./work-shell-agent-console-format.js";
import {
  WorkShellAgentConsoleHud,
  WorkShellAgentConsoleOverlay,
} from "./work-shell-agent-console-view.js";
import { renderOmpAuthProviderPicker } from "./work-shell-auth-provider-picker.js";
import {
  resolveOmpAuthPickerQuery,
  shouldShowOmpAuthPicker,
  type OmpAuthPickerCatalog,
} from "./work-shell-auth-provider-picker-model.js";

function readWorkShellMonotonicMilliseconds(): number {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}
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


/**
 * Palette — ANSI colour names, not hex.
 *
 * The terminal owns the background and the sixteen base colours; a hardcoded
 * hex palette fights whatever theme the user actually runs. Naming the slot
 * ("cyan") instead of the pigment ("#94e2d5") makes UncleCode render in Tokyo
 * Night on a Tokyo Night terminal and in Gruvbox on a Gruvbox one, and it
 * degrades cleanly to sixteen colours and to none at all — chalk (under Ink)
 * strips styling when NO_COLOR is set, and every status here is also carried
 * by a distinct glyph (● ◐ ✕ ○ ▲), so nothing is encoded in colour alone.
 *
 * The previous palette mixed three systems at once — GitHub Dark neutrals,
 * Catppuccin Mocha pastels, Tokyo Night greens — which put two grey
 * temperatures and seven accent hues on one screen.
 *
 * Structure: three text tiers, one line tone, two accents, three status
 * colours. The border* slots resolve to a single tone on purpose; chrome has
 * one line weight, and depth comes from spacing rather than line contrast.
 */

// Light-background palette. Light themes darken the non-bright ANSI colours,
// so the same slot names stay legible without a second set of pigments.
const W_LIGHT = {
  text: "black",
  textMuted: "gray",
  textDim: "gray",
  border: "gray",
  borderStrong: "gray",
  borderSoft: "gray",
  borderDefault: "gray",
  borderAccent: "blue",
  user: "blue",
  userBody: "black",
  userBadgeText: "blue",
  userBadgeBg: "white",
  assistant: "cyan",
  assistantBody: "black",
  assistantBadgeText: "black",
  assistantBadgeBg: "white",
  assistantMuted: "gray",
  tool: "cyan",
  toolSurface: "white",
  toolAccent: "cyan",
  toolMuted: "gray",
  warning: "yellow",
  success: "green",
  error: "red",
  spinner: "cyan",
} as const;

// Dark-background palette. Same slot names; the bright variants carry primary
// text so it separates from the muted tier on a dark ground.
const W_DARK = {
  text: "whiteBright",
  textMuted: "white",
  textDim: "gray",
  border: "gray",
  borderStrong: "gray",
  borderSoft: "gray",
  borderDefault: "gray",
  borderAccent: "cyan",
  user: "blue",
  userBody: "whiteBright",
  userBadgeText: "blue",
  userBadgeBg: "black",
  assistant: "cyan",
  assistantBody: "whiteBright",
  assistantBadgeText: "whiteBright",
  assistantBadgeBg: "black",
  assistantMuted: "white",
  tool: "cyan",
  toolSurface: "black",
  toolAccent: "cyan",
  toolMuted: "white",
  warning: "yellow",
  success: "green",
  error: "red",
  spinner: "cyan",
} as const;

/**
 * Test seam. The contrast contract used to re-declare the dark palette's hex
 * literals inside the test file, so the two could drift and the test would
 * still pass while asserting colours the app no longer used.
 */
export const WORK_SHELL_PALETTES = { light: W_LIGHT, dark: W_DARK } as const;

// Active palette — resolved at call time so tests/env overrides take effect
// without a module reload. Every consumer reads from W (the Proxy), not the
// underlying W_LIGHT/W_DARK objects directly.
const W = new Proxy({} as typeof W_LIGHT, {
  get(_target, prop: keyof typeof W_LIGHT) {
    return (detectTerminalBackground() === "dark" ? W_DARK : W_LIGHT)[prop];
  },
});

// Markdown theme derived from the active palette so headings/code/lists match
// the conversation chrome. Resolved at render time (Proxy) so dark/light
// switching works without a rebuild.
function resolveMarkdownTheme(): MarkdownTheme {
  return {
    heading: W.assistant,
    headingL2: W.assistant,
    headingL3: W.textMuted,
    bold: W.borderStrong,
    inlineCode: W.user,
    inlineCodeBg: W.borderSoft,
    codeBlock: W.textMuted,
    bullet: W.assistant,
    quote: W.textMuted,
    tableHeader: W.assistant,
    diffAdded: W.success,
    diffRemoved: W.error,
    // borderSoft (#21262d on dark) sits near 1:1 against the terminal ground,
    // which erased table rules and diagram strokes entirely. borderStrong is
    // the quietest tone that still resolves as a line.
    tableBorder: W.borderStrong,
    link: W.user,
    text: W.text,
    textMuted: W.textMuted,
  };
}

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

// Hex values the old palette used for de-emphasised text. They are the only
// hexes that must land on the muted tier rather than primary text.
const WORK_SHELL_LOW_CONTRAST_TEXT_COLORS = new Set([
  "#0d9488",
  "#94a3b8",
  "#7d8590",
  "#7f849c",
  "#21262d",
]);

/**
 * Composer text color — the high-contrast foreground from the active palette
 * (W.text). Critical: the Composer renders typed input. Without an explicit
 * color it inherits terminal default fg, which is near-black on dark themes
 * and renders the typed text invisible. Always pass this to <Composer textColor>.
 */
export function getWorkShellComposerTextColor(): string {
  return resolveReadableWorkShellTextColor(W.text) ?? W.text;
}

/**
 * Bridge from hex to the ANSI palette.
 *
 * The Rust entry-presentation still hands back light-theme hex values, and any
 * raw hex on screen defeats the point of naming colours — it would ignore the
 * user's terminal theme and could land unreadable on their background. So no
 * hex reaches the renderer: known-dim values become the muted tier and every
 * other hex becomes primary text. ANSI names pass through untouched.
 */
export function resolveReadableWorkShellTextColor(color: string | undefined): string | undefined {
  if (!color) {
    return undefined;
  }
  const normalized = color.toLowerCase();
  if (!normalized.startsWith("#")) {
    return color;
  }
  if (WORK_SHELL_LOW_CONTRAST_TEXT_COLORS.has(normalized)) {
    return W.textDim;
  }
  return W.text;
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

// Context Inspector: the overlay now shows ALL sources — no line cap.
// The previous 12-line limit silently hid content with no way to see it.
// Scrolling (Sprint 1C) will handle tall lists. For now, removing the cap
// ensures the user sees the full picture even without scroll.
const WORK_SHELL_CONTEXT_OVERLAY_LINE_LIMIT = 999;

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
  // Context Inspector redesign: the overlay cohabits with the composer.
  // Previously any keystroke hid the overlay — now only Esc or /context
  // toggle closes it. See docs/design/context-inspector-redesign.md §F.
  void input;
  return false;
}

export function shouldSuppressWorkShellPassivePanel(input: {
  readonly panelDisplayMode: WorkShellPanelDisplayMode;
  readonly panelTitle: string;
  readonly inputValue: string;
  readonly isBusy: boolean;
  readonly latestSystemText?: string | undefined;
  /**
   * The decision bar is rendering the pending AskUserQuestion above the
   * composer, so the passive "Decision" panel must not repeat its option
   * lines in the same frame.
   */
  readonly decisionBarActive?: boolean | undefined;
}): boolean {
  if (input.panelDisplayMode !== "bottom") {
    return false;
  }
  if (input.decisionBarActive && input.panelTitle === "Decision") {
    return true;
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
  // The empty composer is the only surface that advertises slash discovery.
  // Once a draft exists the operator has already found the composer, so the
  // shorter help keeps the hint row narrow.
  if (trimmed.length === 0) {
    return "Enter send · Shift+Enter newline · / commands · Ctrl+V image";
  }
  return "Enter send · Shift+Enter newline · Ctrl+V image";
}

export function resolveWorkShellComposerHint(input: {
  readonly composerHintOverride?: string;
  /**
   * Decision bar: while a pending AskUserQuestion is promoted above the
   * composer, Esc means "cancel the decision" — not the busy hint's
   * "interrupt". Pass the single question's option count for one-key
   * replies, or `true` when the decision needs typed multi-question
   * answers. Evaluated ahead of `isBusy` because a pending decision only
   * exists mid-turn.
   */
  readonly decisionPending?: boolean | number | undefined;
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
  if (input.decisionPending) {
    if (typeof input.decisionPending === "number") {
      const range = input.decisionPending > 1 ? `1-${input.decisionPending}` : "1";
      return `${range} answer · Esc cancels decision · or type`;
    }
    return "type answers · Esc cancels decision · /cancel";
  }
  if (input.isBusy) {
    return "Enter queues follow-up · Ctrl+C/Esc interrupt · /queue";
  }
  if (input.queuePaused && (input.queuedCount ?? 0) > 0) {
    return "Queue paused after interrupt · check /queue · /queue clear drops";
  }
  return getWorkShellComposerHint(
    input.inputValue,
    input.slashSuggestionCount,
    input.selectedSlashCommand,
  );
}

// Classic braille spinner — smooth rotation that reads as "loading".
// The old single-dot frames (⠁⠂⠄⠠⠐⠈) were too subtle and looked broken.
const WORK_SHELL_BUSY_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const WORK_SHELL_SPINNER_INTERVAL_MS = 100;

function pickBusySpinnerFrame(frame = 0): string {
  const count = WORK_SHELL_BUSY_SPINNER_FRAMES.length;
  return WORK_SHELL_BUSY_SPINNER_FRAMES[((frame % count) + count) % count] ?? WORK_SHELL_BUSY_SPINNER_FRAMES[0];
}
const STREAMING_CURSOR = "▌";
/** Marks the user's turn, matching the composer's own prompt glyph. */
const WORK_SHELL_PROMPT_GLYPH = "›";
const BODY_CONTINUATION_INDENT = "   ";
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

function resolveWorkShellBusyActivityPhrase(detail: string): string {
  const normalized = normalizeBusyDetail(detail);
  if (normalized.length === 0 || normalized === "Thinking") {
    return "Thinking through the next step";
  }
  if (normalized.toLowerCase().startsWith("preparing context")) {
    return "Preparing context";
  }
  if (normalized === "Planning parallel work") {
    return "Planning work";
  }
  if (normalized === "Synthesizing answer") {
    return "Composing answer";
  }
  if (normalized === "Reviewing results") {
    return "Reviewing results";
  }
  if (normalized === "Reading files" || normalized.toLowerCase().startsWith("reading ")) {
    return "Reading context";
  }
  if (normalized === "Parallel workers") {
    return "Coordinating workers";
  }
  return normalized;
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

// Context Runbook line renderer — gives each source category a distinct icon
// and color so the user can scan what context flows into the next answer.
// This is the UncleCode differentiator: every other CLI shows a flat context
// dump; we show a typed, visually-scoped runbook.
// UncleCode Runbook source taxonomy — each context source gets a distinct
// icon + color so the user can scan what knowledge flows into the next answer.
// The "loop trail" category covers the work-loop session artifacts stored
// under .omo/ on disk but surfaced under a user-facing name in the runbook.
function renderRunbookLine(
  line: string,
  index: number,
  cursor?: { readonly cursorIndex: number; readonly modelWindow?: number },
): React.ReactNode {
  const trimmed = line.trim();
  // Compact packet summary
  if (/^Sources · /i.test(trimmed)) {
    const tokenMatch = trimmed.match(/~(\d+)\s*tokens/i);
    const tokenCount = tokenMatch && tokenMatch[1] ? Number.parseInt(tokenMatch[1], 10) : 0;
    const tokenLabel = tokenMatch ? tokenMatch[0] : "";
    // Token budget meter: each cell ≈ budgetWindow/8 tokens.
    // The window is threaded from engine state (modelWindow, default 200k)
    // so the meter is accurate for 128k, 200k, or 1M context models.
    const budgetCells = 8;
    const budgetWindow = cursor?.modelWindow ?? 200_000;
    const windowLabel = budgetWindow >= 1_000_000
      ? `${(budgetWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(budgetWindow / 1000)}k`;
    const filled = Math.min(budgetCells, Math.max(0, Math.round((tokenCount / budgetWindow) * budgetCells)));
    const meterColor = filled >= 7 ? W.warning : filled >= 5 ? W.user : W.success;
    const meter = `${"█".repeat(filled)}${"░".repeat(Math.max(0, budgetCells - filled))}`;
    const summaryWithoutTokens = trimmed.replace(tokenLabel, "").replace(/\s*·\s*$/, "").trimEnd();
    return (
      <Box key={`rb-${index}-${line}`} flexDirection="column">
        <Text>
          <Text color={W.success} bold>{"ok "}</Text>
          <Text color={W.text} bold>{summaryWithoutTokens}</Text>
        </Text>
        {tokenLabel ? (
          <Text>
            <Text color={W.textMuted}>{"  budget "}</Text>
            <Text color={meterColor} bold>{meter}</Text>
            <Text color={W.textMuted}>{" · "}</Text>
            <Text color={W.text} bold>{tokenLabel}</Text>
            <Text color={W.textDim}>{` of ${windowLabel} window`}</Text>
          </Text>
        ) : null}
      </Box>
    );
  }
  // Section headers — Included vs Held.
  // A thin colored rule under the header gives visual containment so
  // sections don't blur together in a long list.
  if (/^Included in next answer/i.test(trimmed)) {
    return (
      <Box key={`rb-${index}-${line}`} marginTop={1} flexDirection="column">
        <Text>
          <Text color={W.success} bold>{"+ "}</Text>
          <Text color={W.success} bold>{trimmed}</Text>
        </Text>
        <Text color={W.success}>{"─".repeat(38)}</Text>
      </Box>
    );
  }
  if (/^Held back locally/i.test(trimmed)) {
    return (
      <Box key={`rb-${index}-${line}`} marginTop={1} flexDirection="column">
        <Text>
          <Text color={W.borderStrong} bold>{"- "}</Text>
          <Text color={W.textMuted} bold>{trimmed}</Text>
        </Text>
        <Text color={W.borderSoft}>{"─".repeat(38)}</Text>
      </Box>
    );
  }
  if (/^Warnings · /i.test(trimmed)) {
    const isNone = /none/i.test(trimmed);
    return (
      <Text key={`rb-${index}-${line}`}>
        <Text color={isNone ? W.success : W.warning} bold>{isNone ? "ok " : "warn "}</Text>
        <Text color={W.textMuted}>{trimmed}</Text>
      </Text>
    );
  }
  if (/^Next answer · /i.test(trimmed)) {
    const preview = trimmed.replace(/^Next answer · /i, "");
    return (
      <Box key={`rb-${index}-${line}`} marginTop={1}>
        <Text {...readableTextColorProps(W.success)} bold>{"➜ "}</Text>
        <Text {...readableTextColorProps(W.text)}>{preview}</Text>
      </Box>
    );
  }
  // Source category lines: "  workspace · 158 · ..."
  const sourceLine = trimmed.match(/^([a-z][a-z\s-]+?)\s*·\s*(\d+)\s*·\s*(.*)$/i);
  if (sourceLine && sourceLine[1] && sourceLine[2] && sourceLine[3]) {
    const category = sourceLine[1].trim();
    const count = sourceLine[2];
    const rawDetail = sourceLine[3];
    const meta = resolveContextSourceMeta(category, W);
    const icon = meta.icon;
    const iconColor = meta.color;
    const displayCategory = meta.label;
    // Replace raw on-disk loop-trail paths with a user-facing label so the
    // runbook never leaks internal storage details (e.g. .omo/.../ledger.jsonl).
    const detail = rawDetail
      .replace(/\.omo\/[^\s)]+/g, "session loop trail")
      .replace(/\.omo\b/g, "session storage");
    // Context Inspector cursor: highlight the selected source row.
    const isCursorRow = cursor !== undefined && cursor.cursorIndex === index;
    const cursorBg = isCursorRow ? { backgroundColor: W.user } : {};
    return (
      <Text key={`rb-${index}-${line}`} {...cursorBg}>
        <Text color={isCursorRow ? W.borderStrong : iconColor} bold>{`${isCursorRow ? "▶" : " "} ${icon} `}</Text>
        <Text color={isCursorRow ? W.borderStrong : W.user} bold>{`${displayCategory} `}</Text>
        <Text color={isCursorRow ? W.borderStrong : W.borderSoft}>{"· "}</Text>
        <Text color={isCursorRow ? W.borderStrong : W.text} bold>{`${count} `}</Text>
        <Text color={isCursorRow ? W.borderStrong : W.borderSoft}>{"· "}</Text>
        <Text color={isCursorRow ? W.borderStrong : W.textMuted}>{detail}</Text>
      </Text>
    );
  }
  // Hidden groups line
  if (/^\+\d+\s*more source groups/i.test(trimmed)) {
    return (
      <Text key={`rb-${index}-${line}`} color={W.textMuted} italic>
        {"  "}
        {trimmed}
      </Text>
    );
  }
  return <Text key={`rb-${index}-${line}`} color={W.textMuted}>{line}</Text>;
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

function formatWorkShellComposerDockDivider(width: number): string {
  // A pure soft rule. The `›` prompt row directly below announces the input
  // area, so the rule carries no label. Width is padded so the rule reaches
  // the right edge.
  return "─".repeat(Math.max(0, width));
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
  if (isInternalTraceConversationText(entry.text)) {
    return false;
  }
  // Tool calls belong in the transcript, in the order they happened. They used
  // to be dropped here and surfaced only in a hoisted panel above the
  // conversation, which showed the last four calls detached from the reasoning
  // that caused them — so the work never read as one downward flow.
  if (entry.role === "tool") {
    return entry.text.trim().length > 0;
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

/**
 * Usable width of one chrome row. The work-shell frame is wrapped in
 * `paddingX={2}`, so a row has four fewer columns than the terminal — not two.
 * Header, rule, and the string formatter all derive from this one rule; when
 * they drifted apart the header hint overflowed by exactly the two columns the
 * padding claimed, wrapping "/ commands" onto a second line.
 */
export function resolveWorkShellChromeWidth(terminalColumns?: number): number {
  return Math.max(32, (terminalColumns ?? process.stdout.columns ?? 96) - 4);
}

export function formatWorkShellHeaderLine(input: {
  readonly providerTitle: string;
  readonly headerHint: string;
  readonly terminalColumns?: number;
}): string {
  const width = resolveWorkShellChromeWidth(input.terminalColumns);
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

/**
 * Split a tool entry into its call line and its result lines.
 *
 * Producers put the invocation on the first line and the observation after it
 * (`packages/orchestrator/src/mini-loop-agent.ts` pushes
 * `observation.stdout || observation.stderr`). Rendering the whole blob as one
 * muted block made the call and its output indistinguishable; separating them
 * lets the call carry weight and the result recede.
 *
 * Result lines are capped: a tool that prints a thousand lines would otherwise
 * push the conversation off screen.
 */
export function splitWorkShellToolEntry(
  text: string,
  width: number,
  maxResultLines = 8,
): { readonly call: string; readonly resultLines: readonly string[] } {
  const normalized = text.trimEnd();
  if (!normalized) {
    return { call: "", resultLines: [] };
  }
  const [first = "", ...rest] = normalized.split("\n");
  const call = truncateForDisplayWidth(first.trim(), Math.max(20, width - 4));
  const body = rest.join("\n").trim();
  if (!body) {
    return { call, resultLines: [] };
  }
  const wrapped = formatWorkShellToolEntryLines(body, width - 4);
  if (wrapped.length <= maxResultLines) {
    return { call, resultLines: wrapped };
  }
  const shown = wrapped.slice(0, maxResultLines);
  return {
    call,
    resultLines: [...shown, `… +${wrapped.length - shown.length} more lines`],
  };
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
  readonly branch?: string;
  readonly modelWindow?: number;
  readonly gitFacts?: GitFacts;
  readonly cost?: string;
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
  // Idle: same accent as the hero ● so the eye lands on one cyan anchor.
  return "assistant";
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

export function resolveWorkShellComposerAdditionalRows(input: {
  readonly inputValue: string;
  readonly terminalColumns?: number | undefined;
  readonly attachmentCount?: number | undefined;
}): number {
  const dockWidth = getWorkShellDockWidth(input.terminalColumns);
  const contentWidth = Math.max(20, dockWidth - 3);
  const attachmentBadge = input.attachmentCount === undefined
    ? ""
    : ` [${input.attachmentCount}/5]`;
  const composerRows = wrapDisplayText(
    `${input.inputValue || " "}${attachmentBadge}`,
    contentWidth,
  ).length;
  return Math.max(0, composerRows - 1);
}


function renderWorkShellEntryBlock(input: {
  readonly entry: WorkShellEntry;
  readonly index: number;
  readonly width: number;
}): React.ReactNode {
  const presentation = getWorkShellEntryPresentation(input.entry.role);
  // For assistant replies, skip the Rust markdown *stripper* — we render
  // markdown structure natively now (headings, code, lists, tables). We still
  // sanitize the text (removes leaked plan JSON etc.) but keep all markdown
  // syntax so renderMarkdown can style it.
  const bodyText = input.entry.role === "assistant"
    ? formatWorkShellAssistantDisplayText(input.entry.text)
    : input.entry.text;
  const mdTheme = resolveMarkdownTheme();

  if (input.entry.role === "user") {
    // The user's own turn is set in an inverted chip rather than prefixed with
    // "◇ You ·". In a long transcript the eye needs to find where each turn
    // began; a label competes with the words around it, a block of reversed
    // ground does not. Continuation lines align under the chip's text.
    const lines = wrapDisplayText(bodyText, Math.max(20, input.width - 6));
    return (
      <Box
        key={`${input.entry.role}-${input.index}`}
        marginBottom={1}
        flexDirection="column"
      >
        {lines.map((line, lineIndex) => (
          <Text key={`user-${String(input.index)}-${String(lineIndex)}`}>
            {lineIndex === 0
              ? <Text color={W.user} bold inverse>{` ${WORK_SHELL_PROMPT_GLYPH} ${line} `}</Text>
              : (
                <>
                  <Text>{BODY_CONTINUATION_INDENT}</Text>
                  <WorkShellReadableText color={presentation.bodyColor}>{line}</WorkShellReadableText>
                </>
              )}
          </Text>
        ))}
      </Box>
    );
  }

  if (input.entry.role === "assistant") {
    // Render markdown for both streaming and final states. Streaming shows
    // partial markdown structure (a table grows row by row, a heading appears
    // as soon as # is typed) which reads better than raw syntax mid-stream.
    const isStreamingEntry = input.entry.text.endsWith(STREAMING_CURSOR);
    // Keep the cursor out of the markdown parser, then paint it explicitly
    // after the rendered content so partial replies retain a visible live edge.
    const renderText = isStreamingEntry
      ? bodyText.replace(STREAMING_CURSOR, "")
      : bodyText;
    const contentWidth = Math.max(20, input.width - 4);
    if (shouldUseCompactAssistantSurface({ text: input.entry.text, width: input.width })) {
      // A single dot marks where the reply starts; the body is plain indented
      // prose. The previous full-height ┃ rail had to predict the markdown's
      // rendered height, and every miss showed — tables render one line per row
      // but were estimated at two, so a long reply trailed dozens of empty rail
      // rows below it. A one-line marker cannot be the wrong height.
      return (
        <Box
          key={`${input.entry.role}-${input.index}`}
          marginBottom={1}
          flexDirection="column"
        >
          <Text color={W.assistant} bold>{presentation.badge} {presentation.label}</Text>
          <Box flexDirection="column" paddingLeft={3}>
            {renderMarkdown({ text: renderText, width: contentWidth, theme: mdTheme })}
            {isStreamingEntry ? <Text color={W.assistant} bold>{STREAMING_CURSOR}</Text> : null}
          </Box>
        </Box>
      );
    }
    return (
      <Box
        key={`${input.entry.role}-${input.index}`}
        marginBottom={1}
        borderStyle="single"
        borderColor={presentation.borderColor}
        paddingX={1}
        flexDirection="column"
      >
        <Box marginTop={0} flexDirection="column">
          {renderMarkdown({ text: renderText, width: contentWidth, theme: mdTheme })}
          {isStreamingEntry ? <Text color={W.assistant} bold>{STREAMING_CURSOR}</Text> : null}
        </Box>
      </Box>
    );
  }

  if (input.entry.role === "tool") {
    // A tool call reads as one event in the transcript: a dot, the call, then
    // its result hanging off a ⎿ underneath. The old form stacked a ▏ rail
    // whose height was computed from the wrapped line count — the same
    // predict-the-height trick that left dangling rails on assistant replies.
    const { call, resultLines } = splitWorkShellToolEntry(bodyText, input.width);
    return (
      <Box
        key={`${input.entry.role}-${input.index}`}
        marginBottom={1}
        flexDirection="column"
      >
        <Text>
          <Text color={W.success} bold>{"● "}</Text>
          <Text color={W.text} bold>{call}</Text>
        </Text>
        {resultLines.map((line, lineIndex) => (
          <Text key={`tool-${String(input.index)}-${String(lineIndex)}`}>
            <Text color={W.textDim}>{lineIndex === 0 ? "  ⎿ " : "    "}</Text>
            <Text color={W.textMuted}>{line}</Text>
          </Text>
        ))}
      </Box>
    );
  }

  if (input.entry.role === "system") {
    // System notices are infrastructure, not conversation. Render as a compact
    // left-aligned meta line with a status glyph — distinct from the user (│)
    // and assistant (┃) rails by using no rail, only a glyph + dimmed text.
    const isInProgress = bodyText.endsWith("…") || bodyText.endsWith("...");
    ;
    const statusColor = isInProgress ? W.warning : W.textDim;
    return (
      <Box
        key={`${input.entry.role}-${input.index}`}
        marginTop={0}
        marginBottom={0}
        paddingLeft={2}
        flexDirection="column"
      >
        <Text>
          <Text color={statusColor}>{"· "}</Text>
          <Text color={W.textMuted} italic>{bodyText}</Text>
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

/**
 * Two lines, not six. The Start/Inspect/Recover list restated what the hint
 * and the composer's own key legend (`Enter send · / commands · Ctrl+V image`)
 * already say, so an empty session opened onto a wall of onboarding.
 */
/**
 * Openers for the empty screen, laid out as one dim line.
 *
 * The trigger is its own bullet. omp's welcome panel lists `#`, `/`, `!`, `$`
 * down the left edge, so the glyph you read is the character you type — the
 * line documents itself and needs no "press" or "use". Prose that named the
 * keys instead ("Use /context before a risky edit") spent a line each to say
 * less. `Ctrl+O` is deliberately absent (sessions surface through `?` →
 * `/help`); the work shell contract asserts the view never advertises it.
 */
const WORK_SHELL_OPENERS = "/ commands · @ attach a file · ! shell · ? keys";

/**
 * Example tasks shown on the empty screen. Each leading digit is also a
 * hotkey: pressing `1`-`3` with an empty composer prefills the matching
 * prompt so the first screen answers "what do I type" with one keystroke.
 * The work shell input controller reads this same list (work-shell-hooks.ts)
 * so the rendered digit and the prefilled text can never drift apart.
 */
export const WORK_SHELL_STARTER_PROMPTS: readonly string[] = [
  "Explain this codebase and how it is organized",
  "Find the cause of a failing test and propose a fix",
  "Draft a plan for the next change",
];

/**
 * `unclecode` ASCII wordmark for the empty screen (Task 13 branding). Verbatim
 * `npx --yes figlet -f standard unclecode` output: 6 rows, every row padded to
 * the same 47-column display width (figlet's standard font is ASCII by
 * construction, so string length == display width; the trailing row is the
 * font's own blank descender line and doubles as the gap before the heading).
 * Rows render in a single dim color (`W.textDim`, palette §2 — no gradients);
 * below wordmark width + 4 columns of container width the art is skipped so a
 * narrow terminal never wraps or shreds it.
 */
export const WORK_SHELL_WORDMARK: readonly string[] = [
  "                   _                    _      ",
  "  _   _ _ __   ___| | ___  ___ ___   __| | ___ ",
  " | | | | '_ \\ / __| |/ _ \\/ __/ _ \\ / _` |/ _ \\",
  " | |_| | | | | (__| |  __/ (_| (_) | (_| |  __/",
  "  \\__,_|_| |_|\\___|_|\\___|\\___\\___/ \\__,_|\\___|",
  "                                               ",
];
const WORK_SHELL_WORDMARK_WIDTH = WORK_SHELL_WORDMARK[0]?.length ?? 0;

/**
 * Ghost hint the pane hands the Composer for the empty draft. It names the two
 * first-move affordances (plain task prose, `/` commands) without spending a
 * chrome row: the dim text sits inside the input row and the first keystroke
 * replaces it.
 */
export const WORK_SHELL_COMPOSER_PLACEHOLDER = "Describe a task · / for commands";

function renderWorkShellEmptyConversation(conversationWidth: number): React.ReactNode {
  // Width gate: the art needs its 47 columns plus 2 columns of breathing room
  // on each side. Narrower containers skip it entirely (no wrapping, no
  // shredding) and keep the pre-Task-13 text-only empty state.
  const showWordmark = conversationWidth >= WORK_SHELL_WORDMARK_WIDTH + 4;
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {showWordmark ? WORK_SHELL_WORDMARK.map((row, index) => (
        <Text key={`wordmark-${index}`} {...readableTextColorProps(W.textDim)}>{row}</Text>
      )) : null}
      <Text>
        <Text color={W.assistant} bold>{"● "}</Text>
        <Text color={W.text} bold>{"Ready for the next move"}</Text>
      </Text>
      <Box paddingLeft={2} flexDirection="column">
        <Text color={W.textMuted}>{getWorkShellEmptyConversationHint()}</Text>
        <Box marginTop={1} flexDirection="column">
          {WORK_SHELL_STARTER_PROMPTS.map((prompt, index) => (
            <Text key={prompt}>
              <Text color={W.assistant} bold>{`${index + 1}  `}</Text>
              <Text color={W.textDim}>{prompt}</Text>
            </Text>
          ))}
        </Box>
        <Text color={W.textDim}>{WORK_SHELL_OPENERS}</Text>
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

/**
 * Approximate how many transcript entries the terminal can show at once.
 * Entry height varies with body length; three rows per entry (badge or chip
 * line, body, breathing room) matches the observed average, and ten rows are
 * reserved for the shell chrome (header, status strip, composer dock, and the
 * scroll indicator itself). The approximation only has to be stable, not
 * exact: it sizes the scrolled window and the PageUp/PageDown step, and both
 * read it so a page never moves by a different amount than it shows.
 */
const WORK_SHELL_TRANSCRIPT_RESERVED_ROWS = 10;
const WORK_SHELL_TRANSCRIPT_ROWS_PER_ENTRY = 3;

export function getWorkShellTranscriptEntryCapacity(terminalRows?: number): number {
  const rows = terminalRows ?? process.stdout.rows ?? 24;
  return Math.max(
    3,
    Math.floor((rows - WORK_SHELL_TRANSCRIPT_RESERVED_ROWS) / WORK_SHELL_TRANSCRIPT_ROWS_PER_ENTRY),
  );
}

/**
 * Task 11 scrollback window. The offset counts entries hidden *below* the
 * window ("entries from the bottom"); 0 is bottom-follow. At 0 the window is
 * the historical last-50 slice, so the unscrolled frame is byte-identical to
 * the pre-scrollback render (the existing render tests guard that). Once
 * scrolled, the window is the rows-derived capacity anchored `scrollOffset`
 * entries above the newest entry. `entriesAbove` feeds the indicator row.
 */
export function resolveWorkShellTranscriptWindow(input: {
  readonly entries: readonly WorkShellEntry[];
  readonly terminalRows?: number | undefined;
  readonly scrollOffset: number;
}): {
  readonly window: readonly WorkShellEntry[];
  readonly entriesAbove: number;
  readonly scrolled: boolean;
} {
  if (input.scrollOffset <= 0 || input.entries.length === 0) {
    return {
      window: input.entries.slice(-50),
      entriesAbove: Math.max(0, input.entries.length - 50),
      scrolled: false,
    };
  }
  const capacity = getWorkShellTranscriptEntryCapacity(input.terminalRows);
  const end = Math.min(
    input.entries.length,
    Math.max(capacity, input.entries.length - input.scrollOffset),
  );
  const start = Math.max(0, end - capacity);
  return {
    window: input.entries.slice(start, end),
    entriesAbove: start,
    scrolled: true,
  };
}

const WorkShellConversationBlock = React.memo(function WorkShellConversationBlock(props: {
  readonly entries: readonly WorkShellEntry[];
  readonly streamingAssistantText?: string;
  readonly isBusy: boolean;
  readonly panelPlacement: WorkShellPanelPlacement;
  readonly terminalColumns?: number;
  readonly terminalRows?: number;
  /** Task 11 scrollback: entries hidden below the window; 0 = bottom-follow. */
  readonly scrollOffset?: number;
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
  const transcriptWindow = resolveWorkShellTranscriptWindow({
    entries,
    ...(props.terminalRows !== undefined ? { terminalRows: props.terminalRows } : {}),
    scrollOffset: props.scrollOffset ?? 0,
  });

  return (
    <Box flexDirection="column" width={props.panelPlacement === "side" ? "68%" : undefined} paddingRight={props.panelPlacement === "side" ? 1 : 0}>
      <Box flexDirection="column">
        {entries.length === 0 ? (
          props.isBusy ? null : renderWorkShellEmptyConversation(conversationWidth)
        ) : transcriptWindow.window.map((entry, index) => renderWorkShellEntryBlock({
          entry,
          index,
          width: conversationWidth,
        }))}
        {transcriptWindow.scrolled ? (
          <Text color={W.textDim}>{`↑ ${transcriptWindow.entriesAbove} entries above · PageUp/PageDown scroll · Esc newest`}</Text>
        ) : null}
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
  return `${pickBusySpinnerFrame(input.spinnerFrame ?? 0)} ${resolveWorkShellBusyActivityPhrase(input.busyStatus ?? "")}`;
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

/**
 * Auth only earns a slot when it needs action. Healthy labels ("Saved OAuth")
 * never change mid-session, so both the header chip and the status row hide
 * them and reappear the moment the wording turns actionable.
 */
function isWorkShellAuthWarning(authLabel: string): boolean {
  return /blocked|unavailable|not signed|needs refresh|needs API key|lacks/i.test(authLabel);
}

const WorkShellHeaderBlock = React.memo(function WorkShellHeaderBlock(props: {
  readonly provider: string;
  readonly model: string;
  readonly mode: string;
  readonly authLabel: string;
  readonly headerHint?: string;
  readonly terminalColumns?: number;
}) {
  const providerTitle = formatWorkShellProviderTitle(props.provider);
  const width = resolveWorkShellChromeWidth(props.terminalColumns);
  // No logo glyph. A bold wordmark is the mark; the ◢ that used to sit here
  // read as decoration from another era and was the only ornament on a screen
  // that otherwise earns its hierarchy from weight and spacing.
  const leftWidth = getDisplayWidth(providerTitle);
  const minGap = 2;
  const authSeparator = " · ";

  // A caller-supplied hint always wins (tests and narrow-viewport hosts inject
  // one); the shell's own right side is the session's identity — model · mode —
  // with the auth chip riding after it only when auth needs action.
  let rightText: string;
  let authChip: string | undefined;
  let wordmarkOnly = false;
  if (props.headerHint !== undefined) {
    // An injected hint still passes through the truncation ladder: a hint
    // sized for a wide host must not wrap the header onto a second line at
    // narrow widths (the wrap bug the resize-reflow tests pin down). If even
    // twelve columns cannot fit next to the wordmark, the shared fallback
    // below renders the wordmark alone over the rule.
    rightText = leftWidth + minGap + getDisplayWidth(props.headerHint) <= width
      ? props.headerHint
      : truncateForDisplayWidth(props.headerHint, Math.max(12, width - leftWidth - minGap));
    authChip = undefined;
  } else {
    const sessionFacts = formatWorkShellSessionFactsGroup({
      model: props.model,
      mode: props.mode,
    });
    const chip = isWorkShellAuthWarning(props.authLabel)
      ? formatWorkShellAuthFactsGroup(props.authLabel)
      : undefined;
    const chipWidth = chip === undefined
      ? 0
      : getDisplayWidth(authSeparator) + getDisplayWidth(chip);
    const fits = (rightWidth: number): boolean => leftWidth + minGap + rightWidth <= width;
    if (chip === undefined) {
      // Healthy auth stays silent: the right side is the identity alone, whole
      // when it fits and truncated against the wordmark when it does not.
      rightText = fits(getDisplayWidth(sessionFacts))
        ? sessionFacts
        : truncateForDisplayWidth(sessionFacts, Math.max(12, width - leftWidth - minGap));
      authChip = undefined;
    } else if (fits(chipWidth)) {
      // Warnings beat identity facts: the chip rides the header whenever it
      // can, and the facts truncate around it — down to nothing — instead of
      // evicting it. The old ladder dropped the chip first, hiding it at every
      // width from 72 to 92 columns whenever the model id ran long.
      rightText = fits(getDisplayWidth(sessionFacts) + chipWidth)
        ? sessionFacts
        : truncateForDisplayWidth(sessionFacts, Math.max(0, width - leftWidth - minGap - chipWidth));
      authChip = chip;
    } else {
      // Pathological width: the chip cannot stand next to the wordmark at all,
      // so the row falls back to the wordmark alone over the rule — the only
      // regime where a warning chip may be dropped (the narrow status row
      // still carries auth below 72 columns).
      rightText = "";
      authChip = undefined;
      wordmarkOnly = true;
    }
  }

  // The chip's leading separator only exists when there are facts to separate
  // it from; a chip riding alone must not dangle a leading " · ".
  const chipSeparatorWidth = authChip === undefined || rightText.length === 0
    ? 0
    : getDisplayWidth(authSeparator);
  const rightWidth = getDisplayWidth(rightText) + chipSeparatorWidth
    + (authChip === undefined ? 0 : getDisplayWidth(authChip));

  if (wordmarkOnly || (leftWidth + minGap + rightWidth > width && leftWidth + minGap + 12 > width)) {
    return (
      <Box flexDirection="column">
        <Text color={W.text} bold>{truncateForDisplayWidth(providerTitle, width)}</Text>
        {renderChromeRule({ width, color: W.borderSoft })}
      </Box>
    );
  }

  const gap = leftWidth + minGap + rightWidth <= width
    ? " ".repeat(Math.max(minGap, width - leftWidth - rightWidth))
    : " ".repeat(minGap);

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={W.text} bold>{providerTitle}</Text>
        <Text>{gap}</Text>
        {rightText.length > 0 ? <Text color={W.textDim}>{rightText}</Text> : null}
        {authChip === undefined ? null : (
          <>
            {chipSeparatorWidth > 0 ? <Text color={W.textDim}>{authSeparator}</Text> : null}
            <Text color={W.warning} bold>{authChip}</Text>
          </>
        )}
      </Text>
      {renderChromeRule({ width, color: W.borderSoft })}
    </Box>
  );
});

function resolveWorkShellCompactBusyActivityPhrase(status: string): string {
  const normalized = status.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();
  if (!normalized) return "Working";
  if (lower.includes("thinking") || lower.includes("reasoning")) return "Thinking";
  if (lower.includes("context")) return "Preparing context";
  if (lower.includes("queue")) return "Queued";
  if (lower.includes("stream")) return "Receiving reply";
  if (lower.includes("read") || lower.includes("search")) return "Reading context";
  if (lower.includes("tool") || lower.includes("call")) return "Running tools";
  if (lower.includes("verify") || lower.includes("test")) return "Checking result";
  if (lower.includes("write") || lower.includes("edit")) return "Applying changes";
  return truncateForDisplayWidth(normalized, 18);
}

/**
 * One sampled clock for the whole shell. The spinner needs frame-rate ticks
 * while a turn is in flight; a delegated agent only needs its elapsed label to
 * advance, so background-only work ticks once a second instead of repainting
 * the frame ten times for the same digit.
 */
const WORK_SHELL_BACKGROUND_CLOCK_INTERVAL_MS = 1_000;

export type WorkShellClockAnchor = {
  readonly wall: number;
  readonly monotonic: number;
};

export function resolveWorkShellActivityNow(
  anchor: WorkShellClockAnchor,
  monotonicNow: number,
): number {
  return anchor.wall + Math.max(0, monotonicNow - anchor.monotonic);
}

export type WorkShellActivityClock = {
  readonly activityFrame: number;
  readonly activityNow: number;
  readonly monotonicNow: number;
};

function useWorkShellActivityClock(input: {
  readonly isBusy: boolean;
  readonly backgroundActive: boolean;
}): WorkShellActivityClock {
  const running = input.isBusy || input.backgroundActive;
  const intervalMs = input.isBusy
    ? WORK_SHELL_SPINNER_INTERVAL_MS
    : WORK_SHELL_BACKGROUND_CLOCK_INTERVAL_MS;
  const [clock, setClock] = React.useState<WorkShellActivityClock>(() => ({
    activityFrame: 0,
    activityNow: Date.now(),
    monotonicNow: readWorkShellMonotonicMilliseconds(),
  }));
  React.useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      const sampledAt = readWorkShellMonotonicMilliseconds();
      setClock((previous) => ({
        activityFrame: previous.activityFrame + 1,
        activityNow: resolveWorkShellActivityNow(
          { wall: previous.activityNow, monotonic: previous.monotonicNow },
          sampledAt,
        ),
        monotonicNow: sampledAt,
      }));
    }, intervalMs);
    return () => { clearInterval(interval); };
  }, [intervalMs, running]);
  return clock;
}

/**
 * `4 agents · 4 jobs · Reading context · 16s` — the live half of the status row.
 *
 * Counts come first because they change what the operator does next; a zero
 * count is omitted rather than reported, so a solo session reads exactly as it
 * did before delegation existed.
 */
export function formatWorkShellStatusActivityFacts(input: {
  readonly activeAgents?: number;
  readonly activeJobs?: number;
  readonly activity: string;
  readonly elapsed?: string;
}): string {
  const agents = input.activeAgents ?? 0;
  const jobs = input.activeJobs ?? 0;
  return [
    agents > 0 ? formatCount(agents, "agent", "agents") : undefined,
    jobs > 0 ? formatCount(jobs, "job", "jobs") : undefined,
    input.activity,
    input.elapsed,
  ]
    .filter((fact): fact is string => fact !== undefined && fact.length > 0)
    .join(" · ");
}

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
  readonly clock: WorkShellActivityClock;
  /**
   * Live delegated work. Non-zero counts make this row busy even when the main
   * turn is idle, because something the operator started is still running.
   */
  readonly activeCounts?: AgentConsoleActiveCounts;
}) {
  const { activityFrame, activityNow } = props.clock;
  const activeAgents = props.activeCounts?.agents ?? 0;
  const activeJobs = props.activeCounts?.jobs ?? 0;
  const backgroundBusy = activeAgents > 0 || activeJobs > 0;
  const busy = props.isBusy || backgroundBusy;

  // The busy row moved down into the composer dock (pinned directly above its
  // hint row) so live progress rides next to the input even in a long
  // conversation. The top row is idle-only: a busy frame that still painted
  // here would put two spinners on one screen (DESIGN.md §6 "one spinner per
  // surface"). Because every WorkShellView branch renders this block with the
  // same liveness inputs, the null return covers them all.
  if (busy) {
    return null;
  }

  const authGroup = formatWorkShellAuthFactsGroup(props.authLabel);
  const isAuthWarning = isWorkShellAuthWarning(props.authLabel);
  const statusGlyph = busy ? pickBusySpinnerFrame(activityFrame) : "◇";
  const statusGlyphColor = busy ? W.spinner : W.assistant;
  // "no reply yet" spent a slot to report nothing. On a fresh session the
  // timing is simply omitted.
  const lastReplyTiming = props.lastTurnDurationMs === undefined
    ? undefined
    : `last ${formatCompactDuration(props.lastTurnDurationMs)}`;
  // Only a main turn has an elapsed anchor. Delegated runs carry their own
  // per-agent labels in the HUD below, so this slot stays empty for them
  // rather than reporting the previous turn's clock as if it were still live.
  const busyElapsed = props.currentTurnStartedAt === undefined
    ? "starting"
    : formatCompactDuration(Math.max(0, activityNow - props.currentTurnStartedAt));
  const activity = props.isBusy
    ? resolveWorkShellBusyActivityPhrase(props.busyStatus ?? "")
    : backgroundBusy
      ? "Working"
      : "Ready";
  const elapsed = props.isBusy ? busyElapsed : backgroundBusy ? undefined : lastReplyTiming;
  const statusDisplay = formatWorkShellStatusActivityFacts({
    activeAgents,
    activeJobs,
    activity,
    ...(elapsed === undefined ? {} : { elapsed }),
  });
  const isNarrow = props.terminalColumns !== undefined && props.terminalColumns < 72;
  if (isNarrow) {
    const compactStatus = isAuthWarning
      ? `${props.model} · ${authGroup}`
      : `${props.model} · ${formatWorkShellStatusActivityFacts({
        activeAgents,
        activeJobs,
        activity: props.isBusy
          ? resolveWorkShellCompactBusyActivityPhrase(props.busyStatus ?? "")
          : activity,
        ...(elapsed === undefined ? {} : { elapsed }),
      })}`;
    const availableStatusWidth = Math.max(1, (props.terminalColumns ?? 72) - 6);
    return (
      <Box marginTop={1} paddingLeft={1}>
        <Text>
          <Text color={statusGlyphColor} bold>{`${statusGlyph} `}</Text>
          <Text {...(busy
            ? { color: W.assistant, bold: true }
            : { color: W.textMuted })}>
            {truncateForDisplayWidth(compactStatus, availableStatusWidth)}
          </Text>
        </Text>
      </Box>
    );
  }

  // Wide hosts carry identity (model · mode) and the auth warning chip in the
  // header, so this row is state only: "◇ Ready · last 1.5s" when idle,
  // "⠋ Reading context · 16s" when something is live.
  return (
    <Box marginTop={1} paddingLeft={1}>
      <Text>
        <Text color={statusGlyphColor} bold>{`${statusGlyph} `}</Text>
        <Text {...(busy
          ? { color: W.assistant, bold: true }
          : { color: W.textMuted })}>{statusDisplay}</Text>
      </Text>
    </Box>
  );
});

/** An outcome needs a glyph as well as a tone: colour alone says nothing. */
const WORK_SHELL_CONTROL_RECEIPT_GLYPHS: Readonly<Record<AgentControlReceiptStatus, string>> = {
  accepted: "✔",
  not_delivered: "⊘",
  rejected: "✕",
};

const WORK_SHELL_CONTROL_RECEIPT_LABELS: Readonly<Record<AgentControlReceiptStatus, string>> = {
  accepted: "Control accepted",
  not_delivered: "Control not delivered",
  rejected: "Control rejected",
};

/**
 * The two Agent Console states the keyboard owns but nothing painted: an armed
 * cancel confirmation, and the outcome of the control that just ran.
 *
 * Both read straight from view state, which is what keeps them honest — the
 * reducer retires a receipt on every revision that does not carry a new one, so
 * a settled console cannot leave a stale question or a stale answer on screen.
 * Receipt messages are engine prose and may carry provider errors, paths, or
 * credentials. The chrome renders only the bounded status vocabulary.
 */
function renderWorkShellAgentConsoleControl(input: {
  readonly snapshot: AgentConsoleSnapshot;
  readonly view: AgentConsoleViewState;
  readonly width: number;
}): React.ReactNode {
  const { control, receipt } = input.view;
  if (control.kind !== "confirm-cancel" && receipt === undefined) {
    return null;
  }
  const bound = Math.max(24, input.width - 2);
  const target = control.kind === "confirm-cancel"
    ? input.snapshot.agents.find((agent) => agent.id === control.agentRunId)
    : undefined;
  return (
    <Box paddingLeft={2} flexDirection="column">
      {control.kind === "confirm-cancel" ? (
        <Text color={W.warning} bold>
          {truncateForDisplayWidth(
            `⚠ Cancel ${flattenRowText(target?.displayName ?? control.agentRunId)}?`
            + " y confirm · n keep running · Esc dismiss",
            bound,
          )}
        </Text>
      ) : null}
      {receipt ? (
        <Text color={receipt.status === "accepted" ? W.assistant : W.warning}>
          {truncateForDisplayWidth(
            `${WORK_SHELL_CONTROL_RECEIPT_GLYPHS[receipt.status]} ${WORK_SHELL_CONTROL_RECEIPT_LABELS[receipt.status]}`,
            bound,
          )}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * The pending AskUserQuestion, promoted to an interactive bar directly above
 * the composer dock. A single question renders its numbered options for
 * one-key replies (digits `1`-`9`, the recommended option keeps the same
 * `(recommended)` marker the decision lines use); anything wider stays a
 * one-line pointer because multi-question requests need typed
 * `question-id: n` answers. The engine clears `pendingDecision` on settle,
 * so the bar disappears the frame the decision is answered or cancelled.
 */
const WorkShellDecisionBar = React.memo(function WorkShellDecisionBar(props: {
  readonly request: AskUserQuestionRequest;
  /**
   * Engine feedback for a rejected typed reply (`Input needed · …`). That
   * line normally lives in the passive "Decision" panel, which this bar
   * suppresses — so without threading it here the rejection is silent.
   */
  readonly inputNeededLine?: string | undefined;
  readonly terminalColumns?: number | undefined;
}) {
  const title = props.request.title?.trim() || "Decision required";
  const singleQuestion = props.request.questions.length === 1
    ? props.request.questions[0]
    : undefined;
  const feedbackLine = props.inputNeededLine
    ? truncateForDisplayWidth(
      props.inputNeededLine,
      Math.max(20, getWorkShellDockWidth(props.terminalColumns) - 3),
    )
    : undefined;
  if (!singleQuestion) {
    return (
      <Box marginTop={1} paddingLeft={1} flexDirection="column">
        <Text>
          <Text color={W.assistant} bold>{"◆ "}</Text>
          <Text color={W.text} bold>{title}</Text>
          <Text color={W.textDim}>
            {` · ${props.request.questions.length} questions · type answers · /cancel`}
          </Text>
        </Text>
        {feedbackLine ? (
          <Box paddingLeft={2}>
            <Text color={W.warning}>{feedbackLine}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }
  const optionCount = singleQuestion.options.length;
  const keyRange = optionCount > 1 ? `1-${optionCount}` : "1";
  return (
    <Box marginTop={1} paddingLeft={1} flexDirection="column">
      <Text>
        <Text color={W.assistant} bold>{"◆ "}</Text>
        <Text color={W.text} bold>{title}</Text>
      </Text>
      <Box paddingLeft={2} flexDirection="column">
        {singleQuestion.options.map((option, index) => (
          <Text key={`${index}-${option.label}`}>
            <Text color={W.assistant} bold>{`${index + 1}. `}</Text>
            <Text color={W.textDim}>
              {singleQuestion.recommended === index
                ? `${option.label} (recommended)`
                : option.label}
            </Text>
          </Text>
        ))}
        <Text color={W.textDim}>{`${keyRange} answer · Esc cancel · or type`}</Text>
        {feedbackLine ? (
          <Text color={W.warning}>{feedbackLine}</Text>
        ) : null}
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
  readonly isBusy?: boolean;
  readonly queuePaused?: boolean;
  readonly queuedCount?: number;
  readonly branch?: string;
  readonly modelWindow?: number;
  readonly gitFacts?: GitFacts;
  readonly cost?: string;
  readonly busyStatus?: string;
  readonly currentTurnStartedAt?: number;
  readonly clock: WorkShellActivityClock;
  /**
   * Live delegated work — the same counts the status row gates on, so the
   * dock's activity row and the (idle-only) top row can never disagree about
   * what "busy" means.
   */
  readonly activeCounts?: AgentConsoleActiveCounts;
  /**
   * Task 10: the engine trace tail (max 3 lines) — what the running turn is
   * doing right now. Rendered dim below the activity row under the same busy
   * gate, one truncated row per line. Idle frames render no feed rows.
   */
  readonly liveToolTraceLines?: readonly string[];
}) {
  const dockWidth = getWorkShellDockWidth(props.terminalColumns);
  const footerLine = formatWorkShellFooterLine({
    ...(props.cwd ? { cwd: props.cwd } : {}),
    model: props.model,
    reasoningLabel: props.reasoningLabel,
    mode: props.mode,
    authLabel: props.authLabel,
    ...(props.contextIndicator ? { contextIndicator: props.contextIndicator } : {}),
    ...(props.branch ? { branch: props.branch } : {}),
    ...(props.gitFacts ? { gitFacts: props.gitFacts } : {}),
    ...(props.cost ? { cost: props.cost } : {}),
    ...(props.modelWindow !== undefined ? { modelWindow: props.modelWindow } : {}),
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
  const { activityFrame, activityNow } = props.clock;
  const activeAgents = props.activeCounts?.agents ?? 0;
  const activeJobs = props.activeCounts?.jobs ?? 0;
  const backgroundBusy = activeAgents > 0 || activeJobs > 0;
  // Same liveness rule the status block owns — a main turn OR live delegated
  // work — reusing its counts so the dock never invents a second definition.
  const busy = props.isBusy === true || backgroundBusy;
  // The busy half of the old status row, relocated to sit directly above the
  // hint row: spinner + activity phrase + elapsed, with agent/job counts
  // first when delegated work is live. Idle frames render nothing here, which
  // keeps the braille spinner off the idle screen the tmux smoke pins.
  const activityLine = busy
    ? truncateForDisplayWidth(
        formatWorkShellStatusActivityFacts({
          activeAgents,
          activeJobs,
          activity: props.isBusy
            ? resolveWorkShellBusyActivityPhrase(props.busyStatus ?? "")
            : "Working",
          ...(props.isBusy
            ? {
                elapsed: props.currentTurnStartedAt === undefined
                  ? "starting"
                  : formatCompactDuration(Math.max(0, activityNow - props.currentTurnStartedAt)),
              }
            : {}),
        }),
        Math.max(12, dockWidth - 2),
      )
    : undefined;

  return (
    <Box marginTop={1} flexDirection="column">
      {activityLine !== undefined ? (
        <Text>
          <Text color={W.spinner} bold>{`${pickBusySpinnerFrame(activityFrame)} `}</Text>
          <Text color={W.assistant} bold>{activityLine}</Text>
        </Text>
      ) : null}
      {/* The turn's trace tail, dim and one truncated row per line, directly
          under the activity row: which tools are running, where the user is
          looking. Idle frames render no feed rows (same gate as the spinner). */}
      {busy && props.liveToolTraceLines !== undefined
        ? props.liveToolTraceLines.map((line, index) => (
          <Text key={`${index}-${line}`} {...readableTextColorProps(W.textDim)}>
            {truncateForDisplayWidth(line, Math.max(12, dockWidth - 2))}
          </Text>
        ))
        : null}
      {props.composerHint ? (
        <Text {...hintColorProps}>{truncateForDisplayWidth(props.composerHint, dockWidth)}</Text>
      ) : null}
      <Text {...readableTextColorProps(W.borderSoft)}>{formatWorkShellComposerDockDivider(dockWidth)}</Text>
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
  // Task 10: the engine trace tail (max 3 lines), shown dim in the composer
  // dock while busy so the running turn's tools read next to the input. The
  // transcript's own entry filtering is unchanged — these raw lines never
  // enter the conversation rail.
  readonly liveToolTraceLines?: readonly string[];
  readonly activePanel: WorkShellPanel;
  readonly contextActionReceipt?: ContextPacketViewActionReceipt;
  readonly contextPreviewReceipt?: ContextPacketReceipt;
  readonly contextSubmittedReceipt?: ContextPacketReceipt;
  readonly contextPacketChange?: ContextPacketChangeClassification;
  readonly contextSourceActionsEnabled?: boolean;
  readonly contextPolicySuggestions?: readonly ContextPolicySuggestion[];
  readonly contextAdviceUnavailable?: string;
  readonly contextAdviceActionsEnabled?: boolean;
  // Context Inspector (Sprint 2): cursor index into the navigable source list
  // (-1 = none) and the source id whose full content is expanded.
  readonly contextInspectorCursor?: number;
  // Context Desk (Pure Yazi): which of the three panes has focus and which
  // collection the sources pane is filtered to. Both are forwarded straight
  // to the renderer so the desk never re-derives them.
  readonly contextInspectorPane?: ContextDeskPane;
  readonly contextInspectorCollection?: ContextDeskCollection;
  readonly contextInspectorExpanded?: string | null;
  readonly contextInspectorDetailContent?: string;
  readonly contextInspectorDetailOffset?: number;
  readonly contextPacket?: ContextPacketView;
  readonly modelWindow?: number;
  /**
   * Checked-out branch, for callers with no structured read. `gitFacts` wins.
   */
  readonly branch?: string;
  /** Workspace facts synced outside render by the pane's one Git effect. */
  readonly gitFacts?: GitFacts;
  readonly terminalRows?: number;
  /** Task 11 scrollback: transcript entries hidden below the window. */
  readonly transcriptScrollOffset?: number;
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
  readonly agentConsole?: AgentConsoleSnapshot;
  /**
   * Engine-owned Agent Console navigation. Absent (or closed) keeps the shell
   * on the quiet default HUD; Task 8 supplies the keyboard that opens it.
   */
  readonly agentConsoleView?: AgentConsoleViewState;
  /** `/auth` OMP provider catalog, injected at the pane boundary. */
  readonly ompAuthCatalog?: OmpAuthPickerCatalog;
  readonly ompAuthPickerCursor?: number;
  readonly ompAuthSignInReceipt?: string;
}) {
  // Hooks run before any early-return branch, so the clock keeps one identity
  // across every frame the shell can render.
  const clock = useWorkShellActivityClock({
    isBusy: props.isBusy,
    backgroundActive: props.agentConsole !== undefined
      && hasActiveAgentConsoleWork(props.agentConsole),
  });
  const activeCounts = props.agentConsole === undefined
    ? undefined
    : selectActiveAgentConsoleCounts(props.agentConsole);
  const sessionCost = props.agentConsole === undefined
    ? undefined
    : formatAgentConsoleTotalCost(props.agentConsole);
  // Decision bar: the pending AskUserQuestion rides the agent console
  // snapshot. A single question promotes its options above the composer; a
  // wider request stays a one-line pointer (its answers must be typed).
  const pendingDecisionRequest = props.agentConsole?.pendingDecision;
  // A rejected typed reply parks its feedback (`Input needed · …`) in the
  // passive "Decision" panel — the very panel the bar suppresses. Surface
  // that line inside the bar so the rejection is never silent. Pure derive:
  // no matching line means nothing changes.
  const decisionInputNeededLine = props.activePanel.title === "Decision"
    ? props.activePanel.lines.find((line) => /^Input needed /.test(line))
    : undefined;
  const decisionSingleQuestion = pendingDecisionRequest?.questions.length === 1
    ? pendingDecisionRequest.questions[0]
    : undefined;
  const decisionBarActive = pendingDecisionRequest !== undefined;
  const composerHint = resolveWorkShellComposerHint({
    ...(props.composerHintOverride ? { composerHintOverride: props.composerHintOverride } : {}),
    ...(decisionBarActive
      ? {
          decisionPending: decisionSingleQuestion
            ? decisionSingleQuestion.options.length
            : true,
        }
      : {}),
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
    decisionBarActive,
  });
  const queueIndicator = formatWorkShellQueueIndicator(props.queuedCount ?? 0, props.queuePaused ?? false);
  const agentConsoleOpen = props.agentConsole !== undefined && props.agentConsoleView?.open === true;
  const shouldRenderContextInspectorOverlay =
    props.activePanel.title === "Context expanded" && props.contextPacket !== undefined;
  const shouldRenderCacheTelemetryOverlay =
    props.activePanel.title === "Cache Telemetry" && props.agentConsole !== undefined;
  const shouldRenderAgentHistoryOverlay =
    props.activePanel.title === "Agent History" && props.agentConsole !== undefined;
  // `/auth` leads with the OMP credential catalog. The Rust auth-picker lines
  // stay behind the explicit subcommands (`/auth status`, `/auth login`, …).
  const shouldRenderOmpAuthPicker =
    props.activePanel.title === "Auth"
    && props.ompAuthCatalog !== undefined
    && shouldShowOmpAuthPicker(props.inputValue);

  const conversation = (
    <WorkShellConversationBlock
      entries={props.entries}
      {...(props.streamingAssistantText ? { streamingAssistantText: props.streamingAssistantText } : {})}
      isBusy={props.isBusy}
      panelPlacement={panelPlacement}
      {...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {})}
      {...(props.terminalRows !== undefined ? { terminalRows: props.terminalRows } : {})}
      {...(props.transcriptScrollOffset !== undefined
        ? { scrollOffset: props.transcriptScrollOffset }
        : {})}
    />
  );

  const panel = shouldRenderOmpAuthPicker && props.ompAuthCatalog !== undefined ? (
    renderOmpAuthProviderPicker({
      catalog: props.ompAuthCatalog,
      query: resolveOmpAuthPickerQuery(props.inputValue),
      cursor: props.ompAuthPickerCursor ?? 0,
      width: Math.max(32, (props.terminalColumns ?? process.stdout.columns ?? 96) - 4),
      borderColor: panelBorderColor,
      palette: W,
      ...(props.ompAuthSignInReceipt ? { signInReceipt: props.ompAuthSignInReceipt } : {}),
    })
  ) : (
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

  const composerDock = (
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
      {...(props.branch ? { branch: props.branch } : {})}
      {...(props.gitFacts ? { gitFacts: props.gitFacts } : {})}
      {...(sessionCost ? { cost: sessionCost } : {})}
      {...(props.modelWindow !== undefined ? { modelWindow: props.modelWindow } : {})}
      {...(props.attachmentCount !== undefined ? { attachmentCount: props.attachmentCount } : {})}
      isBusy={props.isBusy}
      {...(props.busyStatus ? { busyStatus: props.busyStatus } : {})}
      {...(props.currentTurnStartedAt !== undefined ? { currentTurnStartedAt: props.currentTurnStartedAt } : {})}
      {...(props.liveToolTraceLines && props.liveToolTraceLines.length > 0
        ? { liveToolTraceLines: props.liveToolTraceLines }
        : {})}
      clock={clock}
      {...(activeCounts ? { activeCounts } : {})}
      {...(props.queuePaused !== undefined ? { queuePaused: props.queuePaused } : {})}
      {...(props.queuedCount !== undefined ? { queuedCount: props.queuedCount } : {})}
    />
  );

  // The Agent Console is keyboard-owned rather than panel-title driven, so it
  // takes the frame ahead of every `/`-command overlay once it is open.
  if (agentConsoleOpen && props.agentConsole && props.agentConsoleView) {
    return (
      <Box flexDirection="column" paddingX={2}>
        <WorkShellHeaderBlock
          provider={props.provider}
          model={props.model}
          mode={props.mode}
          authLabel={props.authLabel}
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
          clock={clock}
          {...(activeCounts ? { activeCounts } : {})}
        />
        {composerDock}
        <WorkShellAgentConsoleOverlay
          snapshot={props.agentConsole}
          view={props.agentConsoleView}
          terminalColumns={props.terminalColumns ?? process.stdout.columns ?? 96}
          width={resolveWorkShellChromeWidth(props.terminalColumns)}
          borderColor={panelBorderColor}
          palette={W}
          now={clock.activityNow}
        />
        {renderWorkShellAgentConsoleControl({
          snapshot: props.agentConsole,
          view: props.agentConsoleView,
          width: resolveWorkShellChromeWidth(props.terminalColumns),
        })}
      </Box>
    );
  }

  if (
    shouldRenderContextInspectorOverlay
    && panelDisplayMode === "overlay"
    && !shouldSuppressOverlayForInput
  ) {
    // The base viewport budget reserves a one-line composer. Charge only the
    // draft's wrapped continuation rows so the dock and desk share one physical
    // terminal-height budget.
    const contextDeskTerminalRows = props.terminalRows === undefined
      ? undefined
      : Math.max(
          1,
          props.terminalRows - resolveWorkShellComposerAdditionalRows({
            inputValue: props.inputValue,
            ...(props.terminalColumns !== undefined
              ? { terminalColumns: props.terminalColumns }
              : {}),
            ...(props.attachmentCount !== undefined
              ? { attachmentCount: props.attachmentCount }
              : {}),
          }),
        );
    return (
      <Box flexDirection="column" paddingX={2}>
        <WorkShellHeaderBlock
          provider={props.provider}
          model={props.model}
          mode={props.mode}
          authLabel={props.authLabel}
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
          clock={clock}
          {...(activeCounts ? { activeCounts } : {})}
        />
        {composerDock}
        {renderContextInspectorOverlay({
          packet: props.contextPacket,
          cursorIndex: props.contextInspectorCursor ?? -1,
          ...(props.contextInspectorPane !== undefined
            ? { activePane: props.contextInspectorPane }
            : {}),
          ...(props.contextInspectorCollection !== undefined
            ? { activeCollection: props.contextInspectorCollection }
            : {}),
          ...(props.contextInspectorExpanded !== undefined ? { expandedId: props.contextInspectorExpanded } : {}),
          ...(props.contextInspectorDetailContent !== undefined
            ? { detailContent: props.contextInspectorDetailContent }
            : {}),
          ...(props.contextInspectorDetailOffset !== undefined
            ? { detailOffset: props.contextInspectorDetailOffset }
            : {}),
          width: Math.max(32, (props.terminalColumns ?? process.stdout.columns ?? 96) - 4),
          borderColor: panelBorderColor,
          palette: W,
          modelWindow: props.modelWindow ?? 200000,
          actionsEnabled: props.contextSourceActionsEnabled ?? false,
          ...(props.contextActionReceipt ? { actionReceipt: props.contextActionReceipt } : {}),
          ...(props.contextPreviewReceipt ? { previewReceipt: props.contextPreviewReceipt } : {}),
          ...(props.contextSubmittedReceipt ? { submittedReceipt: props.contextSubmittedReceipt } : {}),
          ...(props.contextPacketChange ? { packetChange: props.contextPacketChange } : {}),
          contextPolicySuggestions: props.contextPolicySuggestions ?? [],
          ...(props.contextAdviceUnavailable
            ? { contextAdviceUnavailable: props.contextAdviceUnavailable }
            : {}),
          contextAdviceActionsEnabled: props.contextAdviceActionsEnabled ?? false,
          ...(contextDeskTerminalRows !== undefined
            ? { terminalRows: contextDeskTerminalRows }
            : {}),
        })}
      </Box>
    );
  }
  if (
    panelDisplayMode === "overlay"
    && !shouldSuppressOverlayForInput
    && props.agentConsole
    && (shouldRenderCacheTelemetryOverlay || shouldRenderAgentHistoryOverlay)
  ) {
    const overlayWidth = Math.max(32, (props.terminalColumns ?? process.stdout.columns ?? 96) - 4);
    return (
      <Box flexDirection="column" paddingX={2}>
        <WorkShellHeaderBlock
          provider={props.provider}
          model={props.model}
          mode={props.mode}
          authLabel={props.authLabel}
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
          clock={clock}
          {...(activeCounts ? { activeCounts } : {})}
        />
        {composerDock}
        {shouldRenderCacheTelemetryOverlay
          ? renderCacheTelemetryOverlay({
              snapshot: props.agentConsole,
              width: overlayWidth,
              borderColor: panelBorderColor,
              palette: W,
            })
          : renderAgentHistoryOverlay({
              snapshot: props.agentConsole,
              width: overlayWidth,
              borderColor: panelBorderColor,
              palette: W,
            })}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={2}>
      <WorkShellHeaderBlock
        provider={props.provider}
        model={props.model}
        mode={props.mode}
        authLabel={props.authLabel}
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
        clock={clock}
        {...(activeCounts ? { activeCounts } : {})}
      />
      {props.agentConsole ? (
        <WorkShellAgentConsoleHud
          snapshot={props.agentConsole}
          width={resolveWorkShellChromeWidth(props.terminalColumns)}
          palette={W}
          now={clock.activityNow}
        />
      ) : null}
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
      {props.contextSubmittedReceipt ? (
        <Box marginTop={1} flexDirection="column">
          {renderContextTurnReceipt({
            receipt: props.contextSubmittedReceipt,
            ...(props.contextPacketChange ? { change: props.contextPacketChange } : {}),
            width: resolveWorkShellChromeWidth(props.terminalColumns),
            expanded: false,
            showPrimary: true,
            palette: W,
          })}
        </Box>
      ) : null}
      {queueIndicator !== null ? (
        <Box marginTop={1}>
          <Text {...readableTextColorProps(props.queuePaused ? W.warning : W.textMuted)}>{queueIndicator}</Text>
        </Box>
      ) : null}
      {pendingDecisionRequest ? (
        <WorkShellDecisionBar
          request={pendingDecisionRequest}
          {...(decisionInputNeededLine
            ? { inputNeededLine: decisionInputNeededLine }
            : {})}
          {...(props.terminalColumns !== undefined
            ? { terminalColumns: props.terminalColumns }
            : {})}
        />
      ) : null}
      {composerDock}
      {props.attachmentLines
        ? <WorkShellAttachmentBlock
            attachmentLines={props.attachmentLines}
            {...(props.terminalColumns !== undefined ? { terminalColumns: props.terminalColumns } : {})}
          />
        : null}
      {panelDisplayMode === "overlay" && !shouldSuppressOverlayForInput && shouldRenderContextInspectorOverlay ? (
        renderContextInspectorOverlay({
          packet: props.contextPacket,
          cursorIndex: props.contextInspectorCursor ?? -1,
          ...(props.contextInspectorPane !== undefined
            ? { activePane: props.contextInspectorPane }
            : {}),
          ...(props.contextInspectorCollection !== undefined
            ? { activeCollection: props.contextInspectorCollection }
            : {}),
          ...(props.contextInspectorExpanded !== undefined ? { expandedId: props.contextInspectorExpanded } : {}),
          ...(props.contextInspectorDetailContent !== undefined
            ? { detailContent: props.contextInspectorDetailContent }
            : {}),
          ...(props.contextInspectorDetailOffset !== undefined
            ? { detailOffset: props.contextInspectorDetailOffset }
            : {}),
          width: Math.max(32, (props.terminalColumns ?? process.stdout.columns ?? 96) - 4),
          borderColor: panelBorderColor,
          palette: W,
          modelWindow: props.modelWindow ?? 200000,
          actionsEnabled: props.contextSourceActionsEnabled ?? false,
          ...(props.contextActionReceipt ? { actionReceipt: props.contextActionReceipt } : {}),
          ...(props.contextPreviewReceipt ? { previewReceipt: props.contextPreviewReceipt } : {}),
          ...(props.contextSubmittedReceipt ? { submittedReceipt: props.contextSubmittedReceipt } : {}),
          ...(props.contextPacketChange ? { packetChange: props.contextPacketChange } : {}),
          contextPolicySuggestions: props.contextPolicySuggestions ?? [],
          ...(props.contextAdviceUnavailable
            ? { contextAdviceUnavailable: props.contextAdviceUnavailable }
            : {}),
          contextAdviceActionsEnabled: props.contextAdviceActionsEnabled ?? false,
          ...(props.terminalRows !== undefined ? { terminalRows: props.terminalRows } : {}),
        })
      ) : panelDisplayMode === "overlay" && !shouldSuppressOverlayForInput ? (
        <Box marginTop={1} borderStyle="single" borderColor={panelBorderColor} paddingX={1} flexDirection="column">
          <Box flexDirection="column">
            <Text>
              <Text color={W.assistant} bold>{"▤ UncleCode Context Desk"}</Text>
              <Text color={W.textDim}>{" · review what reaches the next answer"}</Text>
            </Text>
            <Text color={W.textMuted}>
              <Text color={W.borderSoft}>{"  "}</Text>
              {"Esc closes · /context refreshes · only included sources reach the model"}
            </Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {overlayLines.map((line, index) => renderRunbookLine(line, index, {
              cursorIndex: props.contextInspectorCursor ?? -1,
              ...(props.modelWindow !== undefined ? { modelWindow: props.modelWindow } : {}),
            }))}
          </Box>
        </Box>
      ) : panelDisplayMode === "bottom" && !shouldSuppressPassivePanel ? (
        panel
      ) : null}
    </Box>
  );
}
