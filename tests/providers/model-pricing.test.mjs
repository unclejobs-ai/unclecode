import test from "node:test";
import assert from "node:assert/strict";

import { estimateCostUsd, getModelPrice } from "@unclecode/providers";

test("getModelPrice returns the openai entry for known gpt models", () => {
  const price = getModelPrice("gpt-4.1-mini");
  assert.ok(price);
  assert.equal(price.inputUsdPer1M, 0.4);
  assert.equal(price.outputUsdPer1M, 1.6);
});

test("getModelPrice returns the anthropic entry for known claude models", () => {
  const price = getModelPrice("claude-sonnet-4-6");
  assert.ok(price);
  assert.equal(price.inputUsdPer1M, 3.0);
  assert.equal(price.outputUsdPer1M, 15.0);
});

test("getModelPrice returns the gemini entry for known gemini models", () => {
  const price = getModelPrice("gemini-3.1-pro");
  assert.ok(price);
  assert.equal(price.inputUsdPer1M, 2.0);
  assert.equal(price.outputUsdPer1M, 12.0);
});

test("getModelPrice falls back to the family entry for date-suffixed claude variants", () => {
  const price = getModelPrice("claude-sonnet-4-6-20260301");
  assert.ok(price);
  assert.equal(price.inputUsdPer1M, 3.0);
});

test("getModelPrice returns undefined for unknown models", () => {
  assert.equal(getModelPrice("totally-unknown-model"), undefined);
  assert.equal(getModelPrice(""), undefined);
});

test("estimateCostUsd computes input+output cost from usage", () => {
  const cost = estimateCostUsd({
    modelId: "gpt-4.1-mini",
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
  });
  // 1M input @ $0.40 + 1M output @ $1.60 = $2.00
  assert.equal(cost, 2.0);
});

test("estimateCostUsd is zero for unknown models so the budget cap stays inert", () => {
  const cost = estimateCostUsd({
    modelId: "no-such-model",
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
  });
  assert.equal(cost, 0);
});

test("estimateCostUsd handles fractional usage counts cleanly", () => {
  const cost = estimateCostUsd({
    modelId: "claude-haiku-4-5",
    promptTokens: 500,
    completionTokens: 1000,
  });
  // 500/1M * $0.80 + 1000/1M * $4.00 = 0.0004 + 0.004 = 0.0044
  assert.ok(Math.abs(cost - 0.0044) < 1e-9);
});
