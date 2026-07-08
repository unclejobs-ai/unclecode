import { createHash } from "node:crypto";

import {
  type ContextPacketViewBadge,
  type UpsertContextSourceInput,
} from "@unclecode/contracts";

import {
  estimateTokens,
  type ContextProvider,
} from "./crp-provider-utils.js";

const MAX_HISTORY_LINES = 64;
const RECENT_WINDOW_LINES = 8;
const SUMMARY_LINE_LIMIT = 6;
const CONDENSED_HISTORY_ID_PREFIX = "condensed-history-";

type MaskedTraceLine = {
  readonly line: string;
  readonly masked: boolean;
};

export type CondensedHistoryProvider = ContextProvider & {
  readonly pushTraceLine: (line: string) => void;
  readonly clearTrace: () => void;
};

function condensedHistoryId(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return `${CONDENSED_HISTORY_ID_PREFIX}${digest}`;
}

function digestText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function traceEventId(input: {
  readonly sessionId: string;
  readonly index: number;
  readonly line: string;
}): string {
  const digest = createHash("sha256")
    .update(input.sessionId)
    .update("\0")
    .update(String(input.index))
    .update("\0")
    .update(input.line)
    .digest("hex")
    .slice(0, 16);
  return `trace-${digest}`;
}

function normalizeTraceLine(line: string): string {
  return line.replace(/\s+/gu, " ").trim();
}

function truncateTraceLine(line: string): string {
  return line.length <= 140 ? line : `${line.slice(0, 137)}...`;
}

function maskSensitiveTraceLine(line: string): MaskedTraceLine {
  const masked = line
    .replace(
      /\b([A-Z0-9_-]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|OAUTH)[A-Z0-9_-]*)\s*:\s*[^\s]+/giu,
      "$1: [REDACTED]",
    )
    .replace(
      /\b([A-Z0-9_-]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|OAUTH)[A-Z0-9_-]*)\s*=\s*[^\s]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}\b/giu, "$1 [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/gu, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}\b/gu, "[REDACTED]")
    .replace(/\bA(?:KIA|SIA)[A-Z0-9]{16}\b/gu, "[REDACTED]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED]")
    .replace(/\bya29\.[A-Za-z0-9._-]{8,}\b/gu, "[REDACTED]");
  return { line: masked, masked: masked !== line };
}

function summarizeTraceLines(lines: readonly string[]): readonly string[] {
  const visible = lines.slice(-SUMMARY_LINE_LIMIT).map((line) => `- ${truncateTraceLine(normalizeTraceLine(line))}`);
  const hiddenCount = Math.max(0, lines.length - visible.length);
  return hiddenCount > 0
    ? [`- ${hiddenCount} earlier compacted trace lines omitted from this preview.`, ...visible]
    : visible;
}

function condensedHistoryBadges(input: {
  readonly totalEvents: number;
  readonly maskingApplied: boolean;
}): readonly ContextPacketViewBadge[] {
  const badges: ContextPacketViewBadge[] = [
    { label: "compressed", tone: "info" },
  ];
  if (input.maskingApplied) {
    badges.push({ label: "masking", tone: "warning" });
  }
  badges.push(
    { label: "recent-window", tone: "muted" },
    { label: `events ${input.totalEvents}`, tone: "muted" },
  );
  return badges;
}

function buildCondensedHistorySource(input: {
  readonly projectId: string;
  readonly sessionId: string;
  readonly history: readonly string[];
}): UpsertContextSourceInput | undefined {
  if (input.history.length <= RECENT_WINDOW_LINES) {
    return undefined;
  }
  const compacted = input.history.slice(0, -RECENT_WINDOW_LINES);
  const maskedCompacted = compacted.map(maskSensitiveTraceLine);
  const compactedForSummary = maskedCompacted.map((entry) => entry.line);
  const maskingApplied = maskedCompacted.some((entry) => entry.masked);
  const recentCount = input.history.length - compacted.length;
  const summary = `${compacted.length} earlier trace lines summarized; ${recentCount} recent trace lines stay as runtime rows.`;
  const recomputeReason = maskingApplied
    ? "history exceeded recent-window threshold; sensitive trace fragments masked"
    : "history exceeded recent-window threshold";
  const content = [
    maskingApplied
      ? "History compressed by masked recent-window summary."
      : "History compressed by recent-window summary.",
    summary,
    "Earlier signals:",
    ...summarizeTraceLines(compactedForSummary),
  ].join("\n");
  const inputText = compactedForSummary.join("\n");
  const tokenEstimate = estimateTokens(content);
  return {
    id: condensedHistoryId(input.sessionId),
    projectId: input.projectId,
    category: "condensed-history",
    label: "Session history compact",
    content,
    reason: "compressed session history; CRP controls inclusion",
    sha256: digestText(content),
    salience: 0.68,
    tokenEstimate,
    badges: condensedHistoryBadges({
      totalEvents: input.history.length,
      maskingApplied,
    }),
    metadata: {
      kind: "condensed-history",
      sourceEventIds: compacted.map((line, index) =>
        traceEventId({
          sessionId: input.sessionId,
          index,
          line,
        })),
      sourceEventPreviews: compactedForSummary.map((line) => truncateTraceLine(normalizeTraceLine(line))),
      summary,
      recomputeReason,
      compactedEventCount: compacted.length,
      recentEventCount: recentCount,
      compression: {
        method: maskingApplied ? "masking" : "recent-window",
        inputTokensEstimate: estimateTokens(inputText),
        outputTokensEstimate: tokenEstimate,
      },
    },
  };
}

export function createCondensedHistoryProvider(): CondensedHistoryProvider {
  let historyBuffer: string[] = [];
  return {
    providerId: "condensed-history",
    categories: ["condensed-history"],
    refresh: "on-turn",
    trustTier: "builtin",
    pushTraceLine(line: string) {
      const normalized = normalizeTraceLine(line);
      if (normalized.length === 0) return;
      historyBuffer.push(normalized);
      if (historyBuffer.length > MAX_HISTORY_LINES) {
        historyBuffer = historyBuffer.slice(-MAX_HISTORY_LINES);
      }
    },
    clearTrace() {
      historyBuffer = [];
    },
    async sync(input) {
      const upsert = buildCondensedHistorySource({
        projectId: input.projectId,
        sessionId: input.sessionId,
        history: historyBuffer,
      });
      const touched = upsert === undefined ? [] : [upsert.id];
      if (upsert !== undefined) {
        input.store.upsertContextSource(upsert);
      }
      input.store.deleteContextSourcesByIdPrefix({
        projectId: input.projectId,
        idPrefix: CONDENSED_HISTORY_ID_PREFIX,
        keepIds: touched,
      });
      return touched;
    },
  };
}
