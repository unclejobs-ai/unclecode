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

function parseRustKeyValueLines(stdout: string): Map<string, string> {
  return new Map(
    stdout
      .split(/\r?\n/)
      .map((line) => line.split("=", 2))
      .filter((parts): parts is [string, string] => parts.length === 2),
  );
}
