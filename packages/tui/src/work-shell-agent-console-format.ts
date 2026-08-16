import type {
  AgentRunStatus,
  AsyncJobStatus,
  ToolActivity,
  WorkNodeStatus,
} from "@unclecode/contracts";

import {
  buildDiffRows,
  formatDiffRow,
  formatDiffSummary,
  parseUnifiedDiff,
  resolveDiffGutterWidth,
  summarizeDiff,
} from "./diff-render.js";
import { truncateForDisplayWidth, wrapDisplayTextFast } from "./text-width.js";

/**
 * The Agent Console's shared row vocabulary: how a lifecycle status reads, and
 * how any snapshot string is made safe to place in a fixed-width row.
 *
 * This is an internal leaf both the console selectors and the console renderer
 * depend on. It is deliberately absent from the package barrel — nothing
 * outside the console needs `boundRow` or `positiveFinite`.
 */

/**
 * Row tone is a *semantic* name, not a colour. The renderer maps it onto the
 * palette, and every row also carries a textual status label so the state
 * survives a monochrome terminal.
 */
export type AgentConsoleRowTone = "active" | "pending" | "success" | "warning" | "danger";

/**
 * One tone table for all three lifecycles. Typing it against the union of the
 * three status unions makes a newly added status a compile error here instead
 * of a row that silently renders as "pending".
 */
export const STATUS_TONES: Readonly<
  Record<AgentRunStatus | AsyncJobStatus | WorkNodeStatus, AgentConsoleRowTone>
> = {
  proposed: "pending",
  approved: "pending",
  ready: "pending",
  queued: "pending",
  running: "active",
  waiting: "warning",
  blocked: "warning",
  requires_action: "warning",
  completed: "success",
  failed: "danger",
  cancelled: "danger",
  interrupted: "danger",
};

/** `◐ label` — the glyph pairs with a textual status on every row. */
export function agentConsoleStatusGlyph(tone: AgentConsoleRowTone): string {
  switch (tone) {
    case "active":
      return "◐";
    case "pending":
      return "○";
    case "success":
      return "●";
    case "warning":
      return "▲";
    case "danger":
      return "✕";
  }
}

/** `requires_action` is an internal id; the operator reads plain words. */
export function workNodeStatusLabel(status: WorkNodeStatus): string {
  return status === "requires_action" ? "requires action" : status;
}

export function toolActivityGlyph(status: ToolActivity["status"]): string {
  switch (status) {
    case "running":
      return "◐";
    case "completed":
      return "●";
    case "failed":
      return "✕";
    case "cancelled":
      return "⊘";
  }
}

/** Inspector budget: a change preview is evidence, not a file viewer. */
const PREVIEW_ROWS = 6;
/** Indent that marks a preview row as hanging off the call above it. */
const PREVIEW_INDENT = "  ";

/**
 * Render a change preview as bounded evidence rows. Returns nothing when the
 * preview is not a parseable patch, so a tool that attached something else
 * cannot spill text into the console.
 */
export function formatAgentConsoleActivityPreviewLines(
  preview: string,
  width: number,
): readonly string[] {
  const hunks = parseUnifiedDiff(preview);
  if (!hunks) return [];
  const rows = buildDiffRows(hunks, { contextLines: 1, maxRows: PREVIEW_ROWS });
  if (rows.length === 0) return [];
  const gutterWidth = resolveDiffGutterWidth(rows);
  const bound = boundWidth(width);
  const bodyWidth = Math.max(20, bound - PREVIEW_INDENT.length);
  // `parseUnifiedDiff` hands patch bytes through verbatim, so a CRLF ending, a
  // tab, or an escape sequence inside the changed line reaches this row. Strip
  // those *before* the width clamp: sanitizing afterwards would let a run of
  // controls widen the row past the pane it was just measured against.
  return [
    truncateForDisplayWidth(
      stripRowControls(`${PREVIEW_INDENT}⎿ ${formatDiffSummary(summarizeDiff(hunks))}`),
      bound,
    ),
    ...rows.map((row) => truncateForDisplayWidth(
      stripRowControls(`${PREVIEW_INDENT}${formatDiffRow(row, { gutterWidth, width: bodyWidth })}`),
      bound,
    )),
  ];
}

/**
 * Contract-valid text is not layout-safe text. Nothing in
 * `parseAgentConsoleSnapshot` strips newlines, tabs, or C0/C1 controls, so a
 * worker that names itself with one would break a bounded row into two
 * physical lines and push the console's hints off the frame.
 *
 * ZWJ and VS16 are deliberately left in place: stripping them would split
 * every emoji cluster and undo the display-width contract.
 */
const ROW_BREAKING_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * Collapse layout-breaking bytes without touching indentation. Generated
 * indents and diff gutters are layout the caller built on purpose, so they
 * survive; only the bytes that could move the cursor are replaced.
 */
export function stripRowControls(value: string): string {
  return value.replace(ROW_BREAKING_CHARACTERS, " ");
}

export function flattenRowText(value: string): string {
  return stripRowControls(value).trim();
}

export function boundRow(value: string, width: number): string {
  return truncateForDisplayWidth(flattenRowText(value), width);
}

/** Wrap a long prose field to a fixed row budget, marking what was dropped. */
export function boundBlock(
  value: string | undefined,
  width: number,
  maxRows: number,
): readonly string[] {
  const flattened = value === undefined ? "" : flattenRowText(value);
  if (flattened.length === 0) return [];
  const lines = wrapDisplayTextFast(flattened, width);
  if (lines.length <= maxRows) return lines;
  const kept = lines.slice(0, maxRows);
  kept[maxRows - 1] = truncateForDisplayWidth(`${kept[maxRows - 1] ?? ""} …`, width);
  return kept;
}

export function boundWidth(width: number): number {
  return Math.max(20, Math.trunc(width));
}

/** Console chrome counts records constantly; `1 jobs` reads like a bug. */
export function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Seconds under a minute, then minutes; a console row has no room for ms. */
export function formatElapsedLabel(durationMs: number): string {
  const seconds = Math.max(0, Math.trunc((Number.isFinite(durationMs) ? durationMs : 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.trunc(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.trunc(minutes / 60)}h ${minutes % 60}m`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

export function formatUsd(value: number): string {
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function positiveFinite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
