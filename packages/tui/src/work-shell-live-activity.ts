import React from "react";

import { formatCount } from "./work-shell-agent-console-format.js";

const WORK_SHELL_BUSY_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const WORK_SHELL_SPINNER_INTERVAL_MS = 100;
const WORK_SHELL_BACKGROUND_CLOCK_INTERVAL_MS = 1_000;

const WORK_SHELL_LIVE_TOOL_VERBS: Readonly<Record<string, string>> = {
  read_file: "read",
  write_file: "write",
  run_shell: "bash",
  search_text: "search",
  apply_patch: "patch",
  grep: "search",
  list_files: "read",
  delete_file: "delete",
  $: "bash",
};

const WORK_SHELL_LIVE_ROUTE_WORDS = new Set([
  "openai",
  "anthropic",
  "gemini",
  "google",
  "xai",
  "grok",
  "mistral",
  "openrouter",
  "model",
  "planner",
  "action",
  "turn",
  "route",
  "response",
  "thinking",
  "reasoning",
]);

export function pickBusySpinnerFrame(frame = 0): string {
  const count = WORK_SHELL_BUSY_SPINNER_FRAMES.length;
  return WORK_SHELL_BUSY_SPINNER_FRAMES[((frame % count) + count) % count] ?? WORK_SHELL_BUSY_SPINNER_FRAMES[0];
}

export function formatCompactDuration(durationMs: number): string {
  const duration = Math.max(0, Math.trunc(durationMs));
  if (duration < 1000) {
    return `${duration}ms`;
  }
  if (duration < 10_000) {
    return `${(duration / 1000).toFixed(1)}s`;
  }
  return `${Math.trunc(duration / 1000)}s`;
}

function unwrapFullyQuotedWorkShellArg(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const quote = trimmed[0];
  if ((quote === "\"" || quote === "'" || quote === "`") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseWorkShellLiveToolCall(text: string): { readonly verb: string; readonly arg: string } | undefined {
  const body = text.trim().replace(/^[→●✓✖·★]\s+/u, "");
  if (!body) {
    return undefined;
  }
  const calling = /^calling\s+(\S+)(?:\s+(.*))?$/iu.exec(body);
  const rawName = calling?.[1] ?? body.split(/\s+/, 1)[0] ?? "";
  const rest = calling ? (calling[2] ?? "").trim() : body.slice(rawName.length).trim();
  const verb = WORK_SHELL_LIVE_TOOL_VERBS[rawName] ?? rawName;
  if (!verb || WORK_SHELL_LIVE_ROUTE_WORDS.has(verb.toLowerCase())) {
    return undefined;
  }
  return { verb, arg: unwrapFullyQuotedWorkShellArg(rest) };
}

function formatWorkShellLiveToolCallText(parsed: { readonly verb: string; readonly arg: string }): string {
  return parsed.arg.length > 0 ? `${parsed.verb} ${parsed.arg}` : parsed.verb;
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
  if (
    lower.startsWith("read ")
    || lower.startsWith("write ")
    || lower.startsWith("search ")
    || lower.startsWith("bash ")
    || lower.startsWith("edit ")
    || lower.startsWith("patch ")
  ) {
    return stripped;
  }
  if (lower.startsWith("calling ")) {
    const parsed = parseWorkShellLiveToolCall(stripped);
    return parsed === undefined ? "Thinking" : formatWorkShellLiveToolCallText(parsed);
  }
  if (lower.startsWith("model ")) {
    return "Thinking";
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

export function resolveWorkShellBusyActivityPhrase(detail: string): string {
  const normalized = normalizeBusyDetail(detail);
  if (normalized.length === 0 || normalized === "Thinking") {
    return "Thinking";
  }
  if (/^(?:thinking|reasoning)\b/iu.test(normalized)) {
    return "Thinking";
  }
  if (normalized.toLowerCase().startsWith("preparing context")) {
    return "Preparing context";
  }
  if (normalized === "Planning parallel work") {
    return "Planning";
  }
  if (normalized === "Synthesizing answer") {
    return "Writing";
  }
  if (normalized === "Reviewing results") {
    return "Reviewing";
  }
  if (normalized === "Reading files" || normalized.toLowerCase().startsWith("reading ")) {
    return "Reading";
  }
  if (normalized === "Parallel workers") {
    return "Working";
  }
  return normalized;
}

export function resolveWorkShellCompactBusyActivityPhrase(status: string): string {
  return resolveWorkShellBusyActivityPhrase(status);
}

export function formatWorkShellUsageLine(input: {
  readonly isBusy: boolean;
  readonly busyStatus?: string;
  readonly currentTurnStartedAt?: number;
  readonly lastTurnDurationMs?: number;
  readonly nowMs?: number;
  readonly spinnerFrame?: number;
}): string {
  if (input.isBusy) {
    const elapsed = input.currentTurnStartedAt === undefined
      ? "starting"
      : formatCompactDuration(Math.max(0, (input.nowMs ?? input.currentTurnStartedAt) - input.currentTurnStartedAt));
    const detail = normalizeBusyDetail(input.busyStatus ?? "");
    return [
      `${pickBusySpinnerFrame(input.spinnerFrame ?? 0)} ${elapsed}`,
      detail.length > 0 ? detail : undefined,
      "Ctrl+C/Esc · Enter queues",
    ].filter((part): part is string => part !== undefined && part.length > 0).join(" · ");
  }
  const replyTiming = input.lastTurnDurationMs === undefined
    ? "no reply yet"
    : `last reply ${formatCompactDuration(input.lastTurnDurationMs)}`;
  return ["Ready", replyTiming].join(" · ");
}

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

export function formatWorkShellLiveToolTraceLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  if (
    /^(?:Turn (?:started|completed|interrupted)|route |thinking |· thinking)/iu.test(trimmed)
    || /^✦ (?:thinking|reasoning)/u.test(trimmed)
    || /^[↗↔★📎]/u.test(trimmed)
  ) {
    return null;
  }
  const parsed = parseWorkShellLiveToolCall(trimmed);
  if (parsed === undefined) {
    return null;
  }
  const glyph = trimmed.match(/^([→●✓✖])\s+/u)?.[1] ?? "→";
  const arg = parsed.arg;
  return arg.length > 0 ? `${glyph} ${parsed.verb} ${arg}` : `${glyph} ${parsed.verb}`;
}

export function selectWorkShellLiveToolTraceLines(
  lines: readonly string[] | undefined,
  maxLines = 3,
): readonly string[] {
  if (!lines || lines.length === 0) {
    return [];
  }
  const formatted: string[] = [];
  for (const line of lines) {
    const next = formatWorkShellLiveToolTraceLine(line);
    if (next) {
      formatted.push(next);
    }
  }
  return formatted.slice(-Math.max(1, maxLines));
}

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

function readWorkShellMonotonicMilliseconds(): number {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}

export function useWorkShellActivityClock(input: {
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
