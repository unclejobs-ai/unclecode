import { type AgentConsoleTab } from "@unclecode/contracts";
import { isAgentConsoleTab } from "./work-shell-engine-commands.js";
import type { QueueAttachmentArtifact } from "./work-shell-queue-attachments.js";

/**
 * Pure parsers for the Rust orchestrator's stdout JSON envelopes. They
 * validate the shape and throw on malformed input so the engine surfaces
 * Rust contract drift as a hard error instead of silently corrupting
 * queue state.
 *
 * Extracted from `work-shell-engine.ts` so the engine class itself can
 * shrink toward a single concern (state machine + render dispatch).
 * No dependencies on engine state — safe to unit-test in isolation.
 */

export type BusySubmitDecision =
  | { readonly action: "ignore" }
  | { readonly action: "show_queue"; readonly line: string }
  | { readonly action: "clear_queue"; readonly line: string; readonly message: string }
  | { readonly action: "queue_command"; readonly line: string }
  | { readonly action: "cancel_turn"; readonly line: string; readonly message: string }
  | { readonly action: "reject_slash"; readonly line: string; readonly message: string }
  | { readonly action: "open_agent_console"; readonly line: string; readonly tab: AgentConsoleTab }
  | { readonly action: "queue"; readonly line: string; readonly displayIndex: number; readonly message: string };

export type QueueDrainStartDecision = { readonly action: "skip" | "drain" };

export type QueueDrainStepDecision =
  | { readonly action: "empty"; readonly queuedCount: number }
  | {
      readonly action: "run";
      readonly queuedCount: number;
      readonly message: string;
      readonly item: QueuedSubmit;
    };

export type QueueItemStatus = "pending" | "in-flight" | "requires-action";

export type QueuedSubmit = {
  readonly id: number;
  readonly line: string;
  readonly createdAt: number;
  readonly status: QueueItemStatus;
  readonly attachmentRefs: readonly string[];
  readonly attachmentCount: number;
  readonly attachments: readonly QueueAttachmentArtifact[];
  readonly recoveryReason?: string | undefined;
};

export type QueueLimitCode =
  | "item_count"
  | "message_bytes"
  | "attachment_count"
  | "item_bytes"
  | "queue_bytes";

export type QueueWriteResult =
  | { readonly accepted: true; readonly item?: QueuedSubmit | undefined }
  | {
      readonly accepted: false;
      readonly error: {
        readonly code: QueueLimitCode;
        readonly actual: number;
        readonly limit: number;
      };
    };

const QUEUE_LIMIT_CODES = new Set<QueueLimitCode>([
  "item_count",
  "message_bytes",
  "attachment_count",
  "item_bytes",
  "queue_bytes",
]);

function normalizeQueueItem(value: unknown): QueuedSubmit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as {
    id?: unknown;
    line?: unknown;
    createdAt?: unknown;
    status?: unknown;
    attachmentRefs?: unknown;
    attachmentCount?: unknown;
    attachments?: unknown;
    recoveryReason?: unknown;
  };
  if (
    typeof candidate.id !== "number"
    || !Number.isSafeInteger(candidate.id)
    || candidate.id <= 0
    || typeof candidate.line !== "string"
    || candidate.line.length === 0
  ) {
    return undefined;
  }
  const createdAt = candidate.createdAt === undefined ? 0 : candidate.createdAt;
  const status = candidate.status === undefined ? "pending" : candidate.status;
  const attachmentRefs = candidate.attachmentRefs === undefined ? [] : candidate.attachmentRefs;
  const attachmentCount = candidate.attachmentCount === undefined
    ? Array.isArray(attachmentRefs) ? attachmentRefs.length : 0
    : candidate.attachmentCount;
  const artifacts = candidate.attachments === undefined ? [] : candidate.attachments;
  if (
    typeof createdAt !== "number"
    || !Number.isSafeInteger(createdAt)
    || createdAt < 0
    || (status !== "pending" && status !== "in-flight" && status !== "requires-action")
    || !Array.isArray(attachmentRefs)
    || !attachmentRefs.every((reference) => typeof reference === "string" && reference.length > 0)
    || typeof attachmentCount !== "number"
    || !Number.isSafeInteger(attachmentCount)
    || attachmentCount < 0
    || !Array.isArray(artifacts)
    || !artifacts.every((artifact) => {
      if (!artifact || typeof artifact !== "object") return false;
      const descriptor = artifact as Record<string, unknown>;
      return typeof descriptor.ref === "string"
        && descriptor.ref.length > 0
        && descriptor.schema === "unclecode.queue-attachment.v1"
        && typeof descriptor.sha256 === "string"
        && /^[a-f0-9]{64}$/.test(descriptor.sha256)
        && typeof descriptor.size === "number"
        && Number.isSafeInteger(descriptor.size)
        && descriptor.size >= 0;
    })
    || (candidate.recoveryReason !== undefined
      && candidate.recoveryReason !== null
      && typeof candidate.recoveryReason !== "string")
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    line: candidate.line,
    createdAt,
    status,
    attachmentRefs,
    attachmentCount,
    attachments: artifacts as QueueAttachmentArtifact[],
    ...(typeof candidate.recoveryReason === "string"
      ? { recoveryReason: candidate.recoveryReason }
      : {}),
  };
}

export function isQueueItem(value: unknown): value is QueuedSubmit {
  return normalizeQueueItem(value) !== undefined;
}

export function parseQueuedSubmit(stdout: string): QueuedSubmit | undefined {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === "null") {
    return undefined;
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid Rust queue response: ${trimmed}`);
  }
  const candidate = normalizeQueueItem(parsed);
  if (candidate === undefined) {
    throw new Error(`Invalid Rust queue response: ${trimmed}`);
  }
  return candidate;
}

export function parseQueueWriteResult(stdout: string): QueueWriteResult {
  const trimmed = stdout.trim();
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid Rust queue write response.");
  }
  const candidate = parsed as {
    accepted?: unknown;
    error?: { code?: unknown; actual?: unknown; limit?: unknown };
  };
  if (candidate.accepted === true) {
    return { accepted: true };
  }
  if (candidate.accepted === false) {
    const code = candidate.error?.code;
    const actual = candidate.error?.actual;
    const limit = candidate.error?.limit;
    if (
      typeof code === "string"
      && QUEUE_LIMIT_CODES.has(code as QueueLimitCode)
      && typeof actual === "number"
      && Number.isSafeInteger(actual)
      && actual >= 0
      && typeof limit === "number"
      && Number.isSafeInteger(limit)
      && limit >= 0
    ) {
      return {
        accepted: false,
        error: { code: code as QueueLimitCode, actual, limit },
      };
    }
    throw new Error("Invalid Rust queue write response.");
  }
  const item = normalizeQueueItem(parsed);
  if (item) return { accepted: true, item };
  throw new Error("Invalid Rust queue write response.");
}

export function parseQueueLength(stdout: string): number {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return 0;
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid Rust queue length response.");
  }
  const length = (parsed as { length?: unknown }).length;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw new Error("Invalid Rust queue length response.");
  }
  return length;
}

export function parseQueuedSubmitList(stdout: string): readonly QueuedSubmit[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid Rust queue list response.");
  }
  return parsed.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("Invalid Rust queue list response.");
    }
    const candidate = normalizeQueueItem(item);
    if (candidate === undefined) {
      throw new Error("Invalid Rust queue list response.");
    }
    return candidate;
  });
}

export function parseBusySubmitDecision(stdout: string): BusySubmitDecision {
  const parsed = JSON.parse(stdout.trim()) as Partial<BusySubmitDecision>;
  if (parsed.action === "ignore") {
    return { action: "ignore" };
  }
  if (parsed.action === "show_queue" && typeof parsed.line === "string") {
    return { action: "show_queue", line: parsed.line };
  }
  if (parsed.action === "clear_queue" && typeof parsed.line === "string" && typeof parsed.message === "string") {
    return { action: "clear_queue", line: parsed.line, message: parsed.message };
  }
  if (parsed.action === "queue_command" && typeof parsed.line === "string") {
    return { action: "queue_command", line: parsed.line };
  }
  if (parsed.action === "cancel_turn" && typeof parsed.line === "string" && typeof parsed.message === "string") {
    return { action: "cancel_turn", line: parsed.line, message: parsed.message };
  }
  if (parsed.action === "reject_slash" && typeof parsed.line === "string" && typeof parsed.message === "string") {
    return { action: "reject_slash", line: parsed.line, message: parsed.message };
  }
  if (parsed.action === "open_agent_console" && typeof parsed.line === "string" && isAgentConsoleTab(parsed.tab)) {
    return { action: "open_agent_console", line: parsed.line, tab: parsed.tab };
  }
  if (
    parsed.action === "queue"
    && typeof parsed.line === "string"
    && typeof parsed.message === "string"
    && typeof parsed.displayIndex === "number"
    && Number.isSafeInteger(parsed.displayIndex)
    && parsed.displayIndex > 0
  ) {
    return {
      action: "queue",
      line: parsed.line,
      displayIndex: parsed.displayIndex,
      message: parsed.message,
    };
  }
  throw new Error("Invalid Rust busy submit response.");
}

export function parseQueueDrainStartDecision(stdout: string): QueueDrainStartDecision {
  const parsed = JSON.parse(stdout.trim()) as Partial<QueueDrainStartDecision>;
  if (parsed.action === "skip" || parsed.action === "drain") {
    return { action: parsed.action };
  }
  throw new Error("Invalid Rust queue drain start response.");
}

export function parseQueueDrainStepDecision(stdout: string): QueueDrainStepDecision {
  const parsed = JSON.parse(stdout.trim()) as Partial<QueueDrainStepDecision>;
  if (
    parsed.action === "empty"
    && typeof parsed.queuedCount === "number"
    && Number.isSafeInteger(parsed.queuedCount)
    && parsed.queuedCount === 0
  ) {
    return { action: "empty", queuedCount: 0 };
  }
  if (
    parsed.action === "run"
    && typeof parsed.queuedCount === "number"
    && Number.isSafeInteger(parsed.queuedCount)
    && parsed.queuedCount >= 0
    && typeof parsed.message === "string"
    && isQueueItem(parsed.item)
  ) {
    return {
      action: "run",
      queuedCount: parsed.queuedCount,
      message: parsed.message,
      item: parsed.item,
    };
  }
  throw new Error("Invalid Rust queue drain step response.");
}
