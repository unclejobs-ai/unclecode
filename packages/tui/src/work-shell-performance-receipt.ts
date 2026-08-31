import {
  classifyProviderCache,
  projectProviderTurnPerformance,
  type ProviderTurnPerformance,
  type ProviderTurnPerformanceProjection,
} from "@unclecode/contracts";

import { getDisplayWidth, truncateForDisplayWidth } from "./text-width.js";

export type ProviderPerformanceReceiptProjection = ProviderTurnPerformanceProjection & {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;
};

/**
 * Project the last completed provider turn for a single-line TUI receipt.
 * Usage fields remain optional all the way through so an unknown provider
 * value cannot become a misleading `$0.00`, `MISS`, or `0 tok/s`.
 */
export function projectProviderPerformanceReceipt(
  performance: ProviderTurnPerformance | undefined,
): ProviderPerformanceReceiptProjection | undefined {
  const timing = projectProviderTurnPerformance(performance);
  if (!timing || !performance) return undefined;
  return {
    ...timing,
    ...(performance.inputTokens === undefined ? {} : { inputTokens: performance.inputTokens }),
    ...(performance.outputTokens === undefined ? {} : { outputTokens: performance.outputTokens }),
    ...(performance.cacheReadTokens === undefined ? {} : { cacheReadTokens: performance.cacheReadTokens }),
    ...(performance.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: performance.cacheWriteTokens }),
    ...(performance.costUsd === undefined ? {} : { costUsd: performance.costUsd }),
  };
}

/**
 * Render the compact receipt. The full provider/route breakdown belongs to
 * `/cache`; the default workspace gets at most one bounded English line.
 */
export function formatProviderPerformanceReceipt(
  performance: ProviderTurnPerformance | undefined,
  maxWidth = 120,
): string | undefined {
  if (!performance || performance.completedAt === undefined) return undefined;
  const projection = projectProviderPerformanceReceipt(performance);
  if (!projection) return undefined;

  const cache = `cache ${projection.cache}`;
  const speed = projection.tokensPerSecond === undefined
    ? undefined
    : `${formatRate(projection.tokensPerSecond)} tok/s`;
  const ttft = projection.ttftMs === undefined
    ? undefined
    : `TTFT ${formatDuration(projection.ttftMs)}`;
  const read = projection.cacheReadTokens === undefined
    ? undefined
    : `read ${formatTokens(projection.cacheReadTokens)}`;
  const write = projection.cacheWriteTokens === undefined
    ? undefined
    : `write ${formatTokens(projection.cacheWriteTokens)}`;
  const cost = projection.costUsd === undefined
    ? undefined
    : formatUsd(projection.costUsd);

  const candidates = [
    [speed, ttft, cache, read, write, cost],
    [speed, ttft, cache, cost],
    [speed, cache, cost],
    [ttft, cache, cost],
    [cache, cost],
    [cache],
  ].map((parts) => joinReceiptParts(parts));
  const width = Number.isFinite(maxWidth) ? Math.max(1, Math.floor(maxWidth)) : 120;
  const fitting = candidates.find((candidate) => getDisplayWidth(candidate) <= width);
  return fitting ?? truncateForDisplayWidth(candidates[candidates.length - 1] ?? "✓", width);
}

function joinReceiptParts(parts: readonly (string | undefined)[]): string {
  const present = parts.filter((part): part is string => part !== undefined);
  return present.length === 0 ? "✓" : `✓ ${present.join(" · ")}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return trimCompactDecimal(value / 1_000_000, "m");
  if (value >= 1_000) return trimCompactDecimal(value / 1_000, "k");
  return String(value);
}

function formatRate(value: number): string {
  if (value >= 1_000) return trimCompactDecimal(value / 1_000, "k");
  return String(Math.round(value));
}

function trimCompactDecimal(value: number, suffix: string): string {
  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/u, "")}${suffix}`;
}

function formatDuration(valueMs: number): string {
  if (valueMs < 1_000) return `${Math.round(valueMs)}ms`;
  return `${(valueMs / 1_000).toFixed(1)}s`;
}

function formatUsd(value: number): string {
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

// Keep the import's cache classification visible in this module's public
// contract for callers that only have a usage bucket, without duplicating the
// semantic rule in a second formatter.
export { classifyProviderCache };
