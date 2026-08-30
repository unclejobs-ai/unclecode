import { runRustCommandSync } from "./rust-command.js";

export type ModelPrice = {
  readonly inputUsdPer1M: number;
  readonly outputUsdPer1M: number;
};

export type AnthropicCacheTokenUsage = {
  /** Ordinary input tokens exclude all cache buckets. */
  readonly cacheReadTokens?: number;
  /** Legacy aggregate cache-creation counter; unspecified writes use 5m pricing. */
  readonly cacheWriteTokens?: number;
  readonly cacheWrite5mTokens?: number;
  readonly cacheWrite1hTokens?: number;
  /** Wire-compatible aliases for `usage.cache_creation` buckets. */
  readonly cacheCreationInputTokens?: number;
  readonly cacheCreation5mTokens?: number;
  readonly cacheCreation1hTokens?: number;
};

export function getModelPrice(modelId: string): ModelPrice | undefined {
  const stdout = runRustCommandSync(["rust", "model", "price", modelId], process.cwd());
  const fields = parseRustKeyValueLines(stdout);
  if (fields.get("found") !== "yes") {
    return undefined;
  }
  return {
    inputUsdPer1M: Number(fields.get("inputUsdPer1M") ?? 0),
    outputUsdPer1M: Number(fields.get("outputUsdPer1M") ?? 0),
  };
}

export function estimateCostUsd(args: {
  readonly modelId: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
} & AnthropicCacheTokenUsage): number {
  if (isAnthropicModel(args.modelId) && hasAnthropicCacheUsage(args)) {
    return estimateAnthropicCostUsd(args);
  }
  const stdout = runRustCommandSync(
    [
      "rust",
      "model",
      "estimate-cost",
      args.modelId,
      String(args.promptTokens),
      String(args.completionTokens),
    ],
    process.cwd(),
  );
  return Number(parseRustKeyValueLines(stdout).get("costUsd") ?? 0);
}

export function estimateAnthropicCostUsd(args: {
  readonly modelId: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
} & AnthropicCacheTokenUsage): number {
  let price: ModelPrice | undefined;
  try {
    price = getModelPrice(args.modelId);
  } catch {
    return 0;
  }
  if (!price) {
    return 0;
  }

  const { cacheWrite5mTokens, cacheWrite1hTokens } = resolveAnthropicCacheWrites(args);
  const inputCost = (
    nonNegativeTokenCount(args.promptTokens)
    + nonNegativeTokenCount(args.cacheReadTokens) * 0.1
    + cacheWrite5mTokens * 1.25
    + cacheWrite1hTokens * 2
  ) * price.inputUsdPer1M / 1_000_000;
  const outputCost = nonNegativeTokenCount(args.completionTokens)
    * price.outputUsdPer1M
    / 1_000_000;
  return inputCost + outputCost;
}

export function estimateCacheSavingsUsd(args: {
  readonly provider: string;
  readonly modelId: string;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens?: number;
} & Pick<AnthropicCacheTokenUsage, "cacheWrite5mTokens" | "cacheWrite1hTokens" | "cacheCreationInputTokens" | "cacheCreation5mTokens" | "cacheCreation1hTokens">): number {
  if (args.cacheReadTokens <= 0) {
    return 0;
  }
  const readDiscount = args.provider === "gemini"
    ? 0.75
    : args.provider === "openai" || args.provider === "anthropic"
      ? 0.9
      : 0;
  if (readDiscount === 0) {
    return 0;
  }
  let price: ModelPrice | undefined;
  try {
    price = getModelPrice(args.modelId);
  } catch {
    return 0;
  }
  if (!price) {
    return 0;
  }
  const { cacheWrite5mTokens, cacheWrite1hTokens } = resolveAnthropicCacheWrites(args);
  const writePremium = args.provider === "anthropic"
    ? cacheWrite5mTokens * 0.25 + cacheWrite1hTokens
    : 0;
  const avoidedInputTokens = Math.max(0, args.cacheReadTokens * readDiscount - writePremium);
  return avoidedInputTokens * price.inputUsdPer1M / 1_000_000;
}

function isAnthropicModel(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith("claude");
}

function hasAnthropicCacheUsage(args: AnthropicCacheTokenUsage): boolean {
  return [
    args.cacheReadTokens,
    args.cacheWriteTokens,
    args.cacheWrite5mTokens,
    args.cacheWrite1hTokens,
    args.cacheCreationInputTokens,
    args.cacheCreation5mTokens,
    args.cacheCreation1hTokens,
  ].some((value) => value !== undefined);
}

function resolveAnthropicCacheWrites(args: AnthropicCacheTokenUsage): {
  readonly cacheWrite5mTokens: number;
  readonly cacheWrite1hTokens: number;
} {
  const aggregate = nonNegativeTokenCount(args.cacheWriteTokens ?? args.cacheCreationInputTokens);
  const explicit5m = args.cacheWrite5mTokens ?? args.cacheCreation5mTokens;
  const explicit1h = args.cacheWrite1hTokens ?? args.cacheCreation1hTokens;
  const cacheWrite1hTokens = nonNegativeTokenCount(explicit1h);
  const cacheWrite5mTokens = explicit5m === undefined
    ? Math.max(0, aggregate - cacheWrite1hTokens)
    : nonNegativeTokenCount(explicit5m);
  return { cacheWrite5mTokens, cacheWrite1hTokens };
}

function nonNegativeTokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function parseRustKeyValueLines(stdout: string): Map<string, string> {
  return new Map(
    stdout
      .split(/\r?\n/)
      .map((line) => line.split("=", 2))
      .filter((parts): parts is [string, string] => parts.length === 2),
  );
}
