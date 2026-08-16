import { runRustCommandSync } from "./rust-command.js";

export type ModelPrice = {
  readonly inputUsdPer1M: number;
  readonly outputUsdPer1M: number;
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
}): number {
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

export function estimateCacheSavingsUsd(args: {
  readonly provider: string;
  readonly modelId: string;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens?: number;
}): number {
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
  const writePremium = args.provider === "anthropic"
    ? Math.max(0, args.cacheWriteTokens ?? 0) * 0.25
    : 0;
  const avoidedInputTokens = Math.max(0, args.cacheReadTokens * readDiscount - writePremium);
  return avoidedInputTokens * price.inputUsdPer1M / 1_000_000;
}

function parseRustKeyValueLines(stdout: string): Map<string, string> {
  return new Map(
    stdout
      .split(/\r?\n/)
      .map((line) => line.split("=", 2))
      .filter((parts): parts is [string, string] => parts.length === 2),
  );
}
