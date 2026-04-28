/**
 * Per-model token pricing for stateless `LlmProvider.query` calls.
 *
 * Prices are USD per 1M tokens, snapshotted from the provider's public
 * pricing page on the date noted next to each entry. They are advisory,
 * not load-bearing — a worker run that exceeds `costLimitUsd` halts
 * with `limits_exceeded`, but the provider bill is the source of truth.
 *
 * Unknown models return cost 0 so the step budget stays the only
 * guardrail; this avoids over-charging callers when a new model lands
 * before this table is updated.
 */

export type ModelPrice = {
  readonly inputUsdPer1M: number;
  readonly outputUsdPer1M: number;
};

const OPENAI_PRICES: Record<string, ModelPrice> = {
  // 2026-04 snapshot from OpenAI pricing page.
  "gpt-4.1-mini": { inputUsdPer1M: 0.4, outputUsdPer1M: 1.6 },
  "gpt-4.1": { inputUsdPer1M: 2.0, outputUsdPer1M: 8.0 },
  "gpt-4o-mini": { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  "gpt-4o": { inputUsdPer1M: 2.5, outputUsdPer1M: 10.0 },
  "gpt-5.4-mini": { inputUsdPer1M: 1.0, outputUsdPer1M: 4.0 },
  "gpt-5.4": { inputUsdPer1M: 5.0, outputUsdPer1M: 15.0 },
  "o4-mini": { inputUsdPer1M: 1.1, outputUsdPer1M: 4.4 },
};

const ANTHROPIC_PRICES: Record<string, ModelPrice> = {
  // 2026-04 snapshot from Anthropic pricing page.
  "claude-haiku-4-5": { inputUsdPer1M: 0.8, outputUsdPer1M: 4.0 },
  "claude-sonnet-4-6": { inputUsdPer1M: 3.0, outputUsdPer1M: 15.0 },
  "claude-opus-4-7": { inputUsdPer1M: 15.0, outputUsdPer1M: 75.0 },
};

const GEMINI_PRICES: Record<string, ModelPrice> = {
  // 2026-04 snapshot from Google AI pricing page.
  "gemini-2.5-flash": { inputUsdPer1M: 0.3, outputUsdPer1M: 2.5 },
  "gemini-2.5-pro": { inputUsdPer1M: 1.25, outputUsdPer1M: 10.0 },
  "gemini-3.1-flash": { inputUsdPer1M: 0.5, outputUsdPer1M: 3.0 },
  "gemini-3.1-pro": { inputUsdPer1M: 2.0, outputUsdPer1M: 12.0 },
};

export function getModelPrice(modelId: string): ModelPrice | undefined {
  const normalized = modelId.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  const lower = normalized.toLowerCase();
  if (lower.startsWith("claude")) {
    return ANTHROPIC_PRICES[normalized] ?? matchPrefix(ANTHROPIC_PRICES, normalized);
  }
  if (lower.startsWith("gemini")) {
    return GEMINI_PRICES[normalized] ?? matchPrefix(GEMINI_PRICES, normalized);
  }
  return OPENAI_PRICES[normalized] ?? matchPrefix(OPENAI_PRICES, normalized);
}

function matchPrefix(
  table: Record<string, ModelPrice>,
  modelId: string,
): ModelPrice | undefined {
  // Allow date-suffixed variants like `claude-sonnet-4-6-20260301`
  // to map to their family entry without a dedicated row.
  for (const [key, price] of Object.entries(table)) {
    if (modelId.startsWith(`${key}-`)) {
      return price;
    }
  }
  return undefined;
}

export function estimateCostUsd(args: {
  readonly modelId: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
}): number {
  const price = getModelPrice(args.modelId);
  if (!price) {
    return 0;
  }
  const promptCost = (args.promptTokens / 1_000_000) * price.inputUsdPer1M;
  const completionCost = (args.completionTokens / 1_000_000) * price.outputUsdPer1M;
  return promptCost + completionCost;
}
