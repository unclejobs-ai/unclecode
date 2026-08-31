/**
 * A bounded, provider-owned timing/usage projection for the most recent
 * interactive turn. It is intentionally separate from lifetime usage totals:
 * totals answer "how much did this session spend?", while this record answers
 * "how did the last provider turn perform?".
 */
export type ProviderTurnPerformance = {
  readonly provider: string;
  readonly model: string;
  readonly startedAt: number;
  readonly firstTokenAt?: number;
  readonly completedAt?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;
};

export const PROVIDER_CACHE_STATES = ["HIT", "MISS", "n/a"] as const;
export type ProviderCacheState = (typeof PROVIDER_CACHE_STATES)[number];

/**
 * Cache state is based only on the provider's cache-read bucket. A local
 * memo/cache hit is not evidence about a provider prompt cache. An omitted
 * bucket stays unknown; it must never be displayed as a miss by defaulting to
 * zero.
 */
export function classifyProviderCache(input: {
  readonly cacheReadTokens?: number;
}): ProviderCacheState {
  const value = input.cacheReadTokens;
  if (!isNonNegativeInteger(value)) return "n/a";
  return value > 0 ? "HIT" : "MISS";
}

export type ProviderPerformanceTraceEvent = {
  readonly type: "turn.started" | "assistant.delta" | "turn.completed" | "usage.recorded";
  readonly [key: string]: unknown;
};

/**
 * Fold the main provider lifecycle into one bounded performance record.
 * `observedAt` is supplied by the runtime when a provider delta has no wire
 * timestamp. The first non-empty assistant delta wins permanently.
 * Executor-scoped events are ignored so worker activity cannot replace the
 * main conversation's receipt.
 */
export function reduceProviderTurnPerformance(
  current: ProviderTurnPerformance | undefined,
  event: ProviderPerformanceTraceEvent,
  observedAt?: number,
): ProviderTurnPerformance | undefined {
  if (Object.hasOwn(event, "agentRunId")) return current;

  if (event.type === "turn.started") {
    const provider = readNonEmptyString(event.provider);
    const model = readNonEmptyString(event.model);
    const startedAt = readTimestamp(event.startedAt);
    if (!provider || !model || startedAt === undefined) return current;
    return { provider, model, startedAt };
  }

  if (event.type === "assistant.delta") {
    if (typeof event.delta !== "string" || event.delta.length === 0) return current;
    if (!current || current.firstTokenAt !== undefined) return current;
    const firstTokenAt = readTimestamp(event.observedAt) ?? readTimestamp(observedAt);
    if (firstTokenAt === undefined || firstTokenAt < current.startedAt) return current;
    return { ...current, firstTokenAt };
  }

  if (event.type === "turn.completed") {
    const completedAt = readTimestamp(event.completedAt);
    if (completedAt === undefined) return current;
    const provider = readNonEmptyString(event.provider);
    const model = readNonEmptyString(event.model);
    const startedAt = readTimestamp(event.startedAt);
    if (!current) {
      if (!provider || !model || startedAt === undefined || completedAt < startedAt) return current;
      return { provider, model, startedAt, completedAt };
    }
    if (provider !== undefined && provider !== current.provider) return current;
    if (model !== undefined && model !== current.model) return current;
    if (startedAt !== undefined && startedAt !== current.startedAt) return current;
    if (completedAt < current.startedAt || current.completedAt === completedAt) return current;
    return { ...current, completedAt };
  }

  return reduceProviderUsage(current, event);
}

export type ProviderTurnPerformanceProjection = {
  readonly cache: ProviderCacheState;
  readonly ttftMs?: number;
  readonly generationDurationMs?: number;
  readonly tokensPerSecond?: number;
};

/**
 * Derive display-neutral timing values without inventing missing evidence.
 * Generation speed uses completion time minus first-token time when available
 * and otherwise the explicit turn duration. It never uses wall-clock task
 * duration or a fabricated zero.
 */
export function projectProviderTurnPerformance(
  performance: ProviderTurnPerformance | undefined,
): ProviderTurnPerformanceProjection | undefined {
  if (!performance) return undefined;
  const projection: {
    cache: ProviderCacheState;
    ttftMs?: number;
    generationDurationMs?: number;
    tokensPerSecond?: number;
  } = { cache: classifyProviderCache(performance) };

  const startedAt = performance.startedAt;
  const completedAt = performance.completedAt;
  if (!isTimestamp(startedAt) || !isTimestamp(completedAt) || completedAt < startedAt) {
    return projection;
  }

  const firstTokenAt = performance.firstTokenAt;
  if (isTimestamp(firstTokenAt) && firstTokenAt >= startedAt && firstTokenAt <= completedAt) {
    projection.ttftMs = firstTokenAt - startedAt;
  }

  const outputTokens = performance.outputTokens;
  if (!isNonNegativeInteger(outputTokens) || outputTokens <= 0) return projection;
  const generationStart = isTimestamp(firstTokenAt) && firstTokenAt >= startedAt && firstTokenAt <= completedAt
    ? firstTokenAt
    : startedAt;
  const generationDurationMs = completedAt - generationStart;
  if (generationDurationMs <= 0) return projection;
  projection.generationDurationMs = generationDurationMs;
  const tokensPerSecond = outputTokens * 1_000 / generationDurationMs;
  if (Number.isFinite(tokensPerSecond) && tokensPerSecond > 0) {
    projection.tokensPerSecond = tokensPerSecond;
  }
  return projection;
}

function reduceProviderUsage(
  current: ProviderTurnPerformance | undefined,
  event: ProviderPerformanceTraceEvent,
): ProviderTurnPerformance | undefined {
  const provider = readNonEmptyString(event.provider);
  const model = readNonEmptyString(event.model);
  const startedAt = readTimestamp(event.startedAt);
  if (!provider || !model || startedAt === undefined) return current;

  if (current && (
    current.provider !== provider
    || current.model !== model
    || current.startedAt !== startedAt
  )) {
    return current;
  }

  const fields = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const;
  for (const field of fields) {
    if (Object.hasOwn(event, field) && !isNonNegativeInteger(event[field])) return current;
  }
  if (Object.hasOwn(event, "costUsd") && !isNonNegativeMoney(event.costUsd)) return current;

  const completedAt = readOptionalTimestamp(event.completedAt);
  if (Object.hasOwn(event, "completedAt") && completedAt === undefined) return current;
  const firstTokenAt = readOptionalTimestamp(event.firstTokenAt);
  if (Object.hasOwn(event, "firstTokenAt") && firstTokenAt === undefined) return current;
  if (completedAt !== undefined && completedAt < startedAt) return current;
  if (firstTokenAt !== undefined && firstTokenAt < startedAt) return current;
  if (firstTokenAt !== undefined && completedAt !== undefined && firstTokenAt > completedAt) return current;

  const base = current ?? { provider, model, startedAt };
  const next: ProviderTurnPerformance = {
    ...base,
    ...(firstTokenAt !== undefined && base.firstTokenAt === undefined ? { firstTokenAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(typeof event.inputTokens === "number" ? { inputTokens: event.inputTokens } : {}),
    ...(typeof event.outputTokens === "number" ? { outputTokens: event.outputTokens } : {}),
    ...(typeof event.cacheReadTokens === "number" ? { cacheReadTokens: event.cacheReadTokens } : {}),
    ...(typeof event.cacheWriteTokens === "number" ? { cacheWriteTokens: event.cacheWriteTokens } : {}),
    ...(typeof event.costUsd === "number" ? { costUsd: event.costUsd } : {}),
  };
  return hasPerformanceChanged(base, next) ? next : current;
}

function hasPerformanceChanged(
  left: ProviderTurnPerformance,
  right: ProviderTurnPerformance,
): boolean {
  return left.provider !== right.provider
    || left.model !== right.model
    || left.startedAt !== right.startedAt
    || left.firstTokenAt !== right.firstTokenAt
    || left.completedAt !== right.completedAt
    || left.inputTokens !== right.inputTokens
    || left.outputTokens !== right.outputTokens
    || left.cacheReadTokens !== right.cacheReadTokens
    || left.cacheWriteTokens !== right.cacheWriteTokens
    || left.costUsd !== right.costUsd;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readTimestamp(value: unknown): number | undefined {
  return isTimestamp(value) ? value : undefined;
}

function readOptionalTimestamp(value: unknown): number | undefined {
  return value === undefined ? undefined : readTimestamp(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
