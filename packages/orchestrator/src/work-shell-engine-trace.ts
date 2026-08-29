import { runRustCommandSync } from "./rust-command.js";
import { countUnifiedDiffLines, deriveToolOutputMetric } from "./work-shell-agent-console.js";
import { createWorkShellBusyStatePatch } from "./work-shell-engine-state.js";
import type { WorkShellChatEntry, WorkShellEngineState } from "./work-shell-engine.js";
import type { WorkShellReasoningConfig } from "./reasoning.js";

type WorkShellTraceEventDecision = {
  readonly busyStatusAction: "set" | "clear" | "none";
  readonly busyStatus?: string;
  readonly currentTurnStartedAt?: number;
  readonly traceEntryRole: WorkShellChatEntry["role"];
  readonly traceEntry?: WorkShellChatEntry;
};

type AssistantDeltaTraceEvent = {
  readonly type: "assistant.delta";
  readonly delta: string;
};

function isAssistantDeltaTraceEvent(event: { readonly type: string }): event is AssistantDeltaTraceEvent {
  return event.type === "assistant.delta" &&
    typeof (event as { readonly delta?: unknown }).delta === "string";
}

type ReasoningDeltaTraceEvent = {
  readonly type: "reasoning.delta";
  readonly kind?: unknown;
  readonly delta?: unknown;
};

function isReasoningDeltaTraceEvent(event: { readonly type: string }): event is ReasoningDeltaTraceEvent {
  return event.type === "reasoning.delta";
}

/**
 * Prefix the engine puts on a turn's settled reasoning summary entry. Chosen
 * to sit outside the transcript kill filter's glyph class in the view
 * (`✓✖→·★↔↗📎`), so the summary survives into the conversation and the
 * view's dim render branch can claim it. No live chatter: the entry appears
 * once per turn, ahead of the answer (or alone for an answer-less turn).
 */
export const WORK_SHELL_REASONING_ENTRY_PREFIX = "✻ ";

/** State-size guard for one turn's accumulated reasoning buffer. */
const WORK_SHELL_REASONING_ACCUMULATION_MAX_CHARS = 2000;

/** Row cap for the settled summary the ✻ entry carries. */
const WORK_SHELL_REASONING_SUMMARY_MAX_ROWS = 6;

/**
 * Row cap for the always-filled live trace tail feeding the composer dock.
 * The dock renders the newest 3; the wider 8-entry buffer keeps the tail
 * meaningful across the coalesced publish window without growing state.
 */
const WORK_SHELL_LIVE_TRACE_LINES_MAX = 8;

/**
 * Accumulate one reasoning delta into the per-turn buffer. Both `text` and
 * `summary` reasoning kinds contribute to the same buffer — they are two
 * spellings of the turn's thinking, not two summaries. Returns undefined
 * when the delta adds nothing (empty delta, foreign kind, or a buffer
 * already at the cap) so no state patch is staged for it.
 */
export function appendWorkShellStreamingReasoningDelta<
  Reasoning extends WorkShellReasoningConfig,
>(input: {
  readonly state: WorkShellEngineState<Reasoning>;
  readonly event: ReasoningDeltaTraceEvent;
}): Partial<WorkShellEngineState<Reasoning>> | undefined {
  if (input.event.kind !== "text" && input.event.kind !== "summary") {
    return undefined;
  }
  if (typeof input.event.delta !== "string" || input.event.delta.length === 0) {
    return undefined;
  }
  const current = input.state.streamingReasoningText ?? "";
  if (current.length >= WORK_SHELL_REASONING_ACCUMULATION_MAX_CHARS) {
    return undefined;
  }
  return {
    streamingReasoningText: `${current}${input.event.delta}`.slice(
      0,
      WORK_SHELL_REASONING_ACCUMULATION_MAX_CHARS,
    ),
  };
}

/**
 * Resolve the settled ✻ reasoning entry for an accumulated buffer: the first
 * {@link WORK_SHELL_REASONING_SUMMARY_MAX_ROWS} newline rows of the
 * accumulated text under the ✻ prefix. An empty (or whitespace-only)
 * accumulation resolves to no entry — a turn without visible thinking stays
 * out of the transcript entirely.
 */
export function resolveWorkShellReasoningSummaryEntry(
  streamingReasoningText: string | undefined,
): WorkShellChatEntry | undefined {
  const accumulated = streamingReasoningText?.trim();
  if (accumulated === undefined || accumulated.length === 0) {
    return undefined;
  }
  const rows = accumulated
    .split(/\r?\n/)
    .slice(0, WORK_SHELL_REASONING_SUMMARY_MAX_ROWS);
  return {
    role: "assistant",
    text: `${WORK_SHELL_REASONING_ENTRY_PREFIX}${rows.join("\n")}`,
  };
}

function resolveWorkShellTraceEventDecision(input: {
  readonly event: { readonly type: string; readonly status?: string; readonly startedAt?: unknown };
  readonly line: string;
  readonly traceMode?: "minimal" | "verbose";
}): WorkShellTraceEventDecision {
  const raw = runRustCommandSync(
    ["rust", "ux", "trace-event"],
    process.cwd(),
    JSON.stringify({
      event: input.event,
      line: input.line,
      traceMode: input.traceMode ?? "minimal",
    }),
  );
  return JSON.parse(raw) as WorkShellTraceEventDecision;
}

export function resolveBusyStatusFromTraceEvent(
  event: { readonly type: string; readonly status?: string },
  line: string,
): string | null | undefined {
  const decision = resolveWorkShellTraceEventDecision({ event, line });
  if (decision.busyStatusAction === "clear") {
    return undefined;
  }
  if (decision.busyStatusAction === "set") {
    return decision.busyStatus ?? "thinking";
  }

  return null;
}

export function resolveTraceEntryRole(event: { readonly type: string }): WorkShellChatEntry["role"] {
  return resolveWorkShellTraceEventDecision({ event, line: "" }).traceEntryRole;
}

export function extractCurrentTurnStartedAt(event: { readonly type: string; readonly startedAt?: unknown }): number | undefined {
  return resolveWorkShellTraceEventDecision({ event, line: "" }).currentTurnStartedAt;
}

export function createTraceEventBusyPatch<Reasoning extends WorkShellReasoningConfig>(input: {
  state: WorkShellEngineState<Reasoning>;
  event: { readonly type: string; readonly status?: string; readonly startedAt?: unknown };
  line: string;
}): Partial<WorkShellEngineState<Reasoning>> | undefined {
  const decision = resolveWorkShellTraceEventDecision({ event: input.event, line: input.line });
  if (decision.busyStatusAction === "none") {
    return undefined;
  }

  return createWorkShellBusyStatePatch({
    state: input.state,
    isBusy: input.state.isBusy,
    ...(decision.busyStatusAction === "set" ? { busyStatus: decision.busyStatus ?? "thinking" } : {}),
    ...(decision.currentTurnStartedAt !== undefined ? { currentTurnStartedAt: decision.currentTurnStartedAt } : {}),
    ...(decision.busyStatusAction === "clear"
      ? { clearCurrentTurnStartedAt: true }
      : {}),
  });
}

export function resolveVerboseTraceEntry(input: {
  traceMode: "minimal" | "verbose";
  event: { readonly type: string };
  line: string;
}): WorkShellChatEntry | undefined {
  return resolveWorkShellTraceEventDecision(input).traceEntry;
}

/**
 * Claude-Code-style verb per known tool name. Unknown names pass through
 * unchanged so exotic tools stay honest about what ran.
 */
const WORK_SHELL_TOOL_DETAIL_VERB_BY_NAME: Readonly<Record<string, string>> = {
  read_file: "read",
  write_file: "write",
  run_shell: "bash",
  search_text: "search",
  apply_patch: "patch",
};

/** Total rendered-row budget for one tool detail entry, ellipsis row included. */
const WORK_SHELL_TOOL_DETAIL_MAX_ROWS = 8;

/** How many output rows the excerpt carries before the cap kicks in. */
const WORK_SHELL_TOOL_DETAIL_EXCERPT_ROWS = 6;

/**
 * Per-row character guard for assembled rows. This is a state-size guard, not a
 * display-width calculation — the renderer owns wrapping and truncation for the
 * terminal. Purely code-point based; no Rust spawn.
 */
const WORK_SHELL_TOOL_DETAIL_ROW_MAX_CHARS = 120;

type WorkShellToolDetailSourceEvent = {
  readonly type: string;
  readonly toolName?: unknown;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly isError?: unknown;
  readonly durationMs?: unknown;
};

function truncateWorkShellToolDetailRow(row: string): string {
  const normalized = row.trimEnd();
  const chars = Array.from(normalized);
  if (chars.length <= WORK_SHELL_TOOL_DETAIL_ROW_MAX_CHARS) {
    return normalized;
  }
  return `${chars.slice(0, WORK_SHELL_TOOL_DETAIL_ROW_MAX_CHARS - 1).join("")}…`;
}

function resolveWorkShellToolDetailVerb(toolName: unknown): string {
  if (typeof toolName !== "string" || toolName.trim().length === 0) {
    return "tool";
  }
  const normalized = toolName.trim();
  return WORK_SHELL_TOOL_DETAIL_VERB_BY_NAME[normalized] ?? normalized;
}

/**
 * Key argument precedence: path, then command, then query — the display-safe
 * input the provider layer retains for exactly these three keys.
 */
function resolveWorkShellToolDetailKeyArgument(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of ["path", "command", "query"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      // The first row is one row: newlines inside a command would split it.
      return value.trim().replace(/\s+/g, " ");
    }
  }
  return undefined;
}

function resolveWorkShellToolDetailDurationSuffix(durationMs: unknown): string | undefined {
  return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
    ? `${Math.round(durationMs)}ms`
    : undefined;
}

function readWorkShellToolDetailFirstNonEmptyLine(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length > 0) {
      return line;
    }
  }
  return undefined;
}

/**
 * Assemble the glyph-less multi-row text for a completed tool call.
 *
 * Row shape (plain text only — the renderer owns `● `/`⎿` glyphs):
 *   1. `{verb} {key argument}` on the first row.
 *   2. Metric rows: the output metric (`N lines`, or the first error line when
 *      the call failed), then `+N −M` when the output embeds a unified diff.
 *      The duration lands on the last metric row as `· {ms}ms`.
 *   3. An output excerpt of at most 6 per-row-truncated lines.
 *
 * The whole entry is capped at 8 rows; overflow collapses into exactly one
 * `… +N more lines` row so the renderer's own cap never stacks a second
 * ellipsis onto this one. Diff stats derive only from the unified diff found in
 * `output` — the provider layer strips patch arguments from display input.
 */
export function formatWorkShellToolDetailEntry(event: WorkShellToolDetailSourceEvent): string {
  const verb = resolveWorkShellToolDetailVerb(event.toolName);
  const keyArgument = resolveWorkShellToolDetailKeyArgument(event.input);
  const rows: string[] = [truncateWorkShellToolDetailRow(keyArgument ? `${verb} ${keyArgument}` : verb)];

  const output = typeof event.output === "string" ? event.output : undefined;
  const normalizedOutput = output?.trim();
  const metricRows: string[] = [];
  if (event.isError === true) {
    const firstErrorLine = normalizedOutput !== undefined
      ? readWorkShellToolDetailFirstNonEmptyLine(normalizedOutput)
      : undefined;
    if (firstErrorLine !== undefined) {
      metricRows.push(truncateWorkShellToolDetailRow(firstErrorLine.trim()));
    }
  } else {
    const metric = deriveToolOutputMetric(output);
    if (metric !== undefined) {
      metricRows.push(metric);
    }
  }
  const diffLines = countUnifiedDiffLines(output);
  if (diffLines !== undefined) {
    metricRows.push(`+${diffLines.additions} −${diffLines.deletions}`);
  }
  const duration = resolveWorkShellToolDetailDurationSuffix(event.durationMs);
  if (duration !== undefined) {
    if (metricRows.length > 0) {
      metricRows[metricRows.length - 1] = `${metricRows[metricRows.length - 1]} · ${duration}`;
    } else {
      metricRows.push(duration);
    }
  }
  rows.push(...metricRows);

  if (normalizedOutput !== undefined) {
    const excerptRows = normalizedOutput
      .split(/\r?\n/)
      .slice(0, WORK_SHELL_TOOL_DETAIL_EXCERPT_ROWS)
      .map(truncateWorkShellToolDetailRow);
    rows.push(...excerptRows);
  }

  if (rows.length <= WORK_SHELL_TOOL_DETAIL_MAX_ROWS) {
    return rows.join("\n");
  }
  const shown = rows.slice(0, WORK_SHELL_TOOL_DETAIL_MAX_ROWS - 1);
  const hidden = rows.length - shown.length;
  return [...shown, `… +${hidden} more lines`].join("\n");
}

export function applyWorkShellTraceEvent<
  Reasoning extends WorkShellReasoningConfig,
  TraceEvent extends { readonly type: string },
>(input: {
  state: WorkShellEngineState<Reasoning>;
  event: TraceEvent;
  formatAgentTraceLine: (event: TraceEvent, uiLocale?: "en" | "ko") => string;
  setState: (patch: Partial<WorkShellEngineState<Reasoning>>) => void;
  appendEntries: (...entries: readonly WorkShellChatEntry[]) => void;
  pushTraceLine: (line: string) => void;
}): void {
  // Settle the turn's reasoning as ONE ✻ transcript entry: flush at the
  // first assistant delta or at turn completion, whichever arrives first.
  // The flush runs before the assistant text/state lands so the summary
  // always sits in front of the answer it preceded — and stands alone for
  // an answer-less turn (the turn.completed trigger).
  const flushStreamingReasoning = (): void => {
    const reasoningEntry = resolveWorkShellReasoningSummaryEntry(
      input.state.streamingReasoningText,
    );
    if (input.state.streamingReasoningText !== undefined) {
      input.setState({ streamingReasoningText: undefined });
    }
    if (reasoningEntry !== undefined) {
      input.appendEntries(reasoningEntry);
    }
  };

  if (isAssistantDeltaTraceEvent(input.event)) {
    flushStreamingReasoning();
    if (input.event.delta.length === 0) {
      return;
    }
    input.setState({
      streamingAssistantText: `${input.state.streamingAssistantText ?? ""}${input.event.delta}`,
    });
    return;
  }

  // Reasoning deltas accumulate in ADDITION to the busy-status handling
  // below: the dock activity row keeps showing the live busy phrase while
  // the buffer quietly builds toward the one settled summary entry.
  if (isReasoningDeltaTraceEvent(input.event)) {
    const reasoningPatch = appendWorkShellStreamingReasoningDelta({
      state: input.state,
      event: input.event,
    });
    if (reasoningPatch !== undefined) {
      input.setState(reasoningPatch);
    }
  }

  const line = input.formatAgentTraceLine(input.event, input.state.uiLocale);
  const busyPatch = createTraceEventBusyPatch({
    state: input.state,
    event: input.event,
    line,
  });
  if (busyPatch) {
    input.setState(busyPatch);
  }

  // turn.completed is the answer-less fallback trigger: flush whatever the
  // turn accumulated before any other end-of-turn effects append entries.
  if (input.event.type === "turn.completed") {
    flushStreamingReasoning();
  }

  if (line.trim().length > 0 && input.state.traceMode === "verbose") {
    input.pushTraceLine(line);
  }

  // The dock feed rides its own always-filled buffer: every meaningful line
  // lands in liveTraceLines in EVERY trace mode, capped to the newest
  // WORK_SHELL_LIVE_TRACE_LINES_MAX entries (oldest dropped first). This is
  // deliberately separate from the verbose-only traceLines push above — the
  // context overlay, the panel rebuild, and `/minimal`'s traceLines cleanup
  // keep their exact semantics, while the busy dock never goes dark in
  // default (minimal) mode. Executor-scoped events never reach here (the
  // engine drops them before applying this function).
  if (line.trim().length > 0) {
    input.setState({
      liveTraceLines: [...(input.state.liveTraceLines ?? []), line].slice(
        -WORK_SHELL_LIVE_TRACE_LINES_MAX,
      ),
    });
  }

  const traceEntry = resolveVerboseTraceEntry({
    traceMode: input.state.traceMode,
    event: input.event,
    line,
  });
  if (!traceEntry) {
    return;
  }

  // tool.completed entries carry the assembled multi-row detail text, not the
  // formatted one-liner: the Rust decision says "emit an entry", the shape of
  // that entry comes from the structured event. Degenerate events whose
  // assembly collapses to nothing keep the formatted line rather than
  // appending an entry the transcript kill filter would drop anyway.
  if (input.event.type === "tool.completed") {
    const detailText = formatWorkShellToolDetailEntry(input.event);
    input.appendEntries({
      ...traceEntry,
      text: detailText.trim().length > 0 ? detailText : traceEntry.text,
    });
    return;
  }

  input.appendEntries(traceEntry);
}
