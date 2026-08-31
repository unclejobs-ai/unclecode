import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { estimateCacheSavingsUsd, estimateCostUsd, getModelPrice } from "@unclecode/providers";

test("getModelPrice returns official GPT-5.6 family prices", () => {
  assert.deepEqual(getModelPrice("gpt-5.6-sol"), {
    inputUsdPer1M: 5,
    outputUsdPer1M: 30,
  });
  assert.deepEqual(getModelPrice("gpt-5.6-terra"), {
    inputUsdPer1M: 2.5,
    outputUsdPer1M: 15,
  });
  assert.deepEqual(getModelPrice("gpt-5.6-luna"), {
    inputUsdPer1M: 1,
    outputUsdPer1M: 6,
  });
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

test("estimateCostUsd computes GPT-5.6 input and output cost from usage", () => {
  const cost = estimateCostUsd({
    modelId: "gpt-5.6-sol",
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
  });
  assert.equal(cost, 35);
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

test("estimateCostUsd applies Anthropic cache rates by bucket", () => {
  const cost = estimateCostUsd({
    modelId: "claude-sonnet-4-6",
    promptTokens: 100_000,
    completionTokens: 200_000,
    cacheReadTokens: 300_000,
    cacheWrite5mTokens: 200_000,
    cacheWrite1hTokens: 300_000,
  });
  // $0.30 ordinary + $0.09 read + $0.75 5m write + $1.80 1h write
  // + $3.00 output = $5.94.
  assert.ok(Math.abs(cost - 5.94) < 1e-12);
});

test("estimateCacheSavingsUsd uses provider cache read and write rates", () => {
  assert.ok(Math.abs(estimateCacheSavingsUsd({
    provider: "openai",
    modelId: "gpt-5.6-sol",
    cacheReadTokens: 1_000,
  }) - 0.0045) < 1e-12);
  assert.ok(Math.abs(estimateCacheSavingsUsd({
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    cacheReadTokens: 1_000,
    cacheWriteTokens: 300,
  }) - 0.002475) < 1e-12);
  assert.ok(Math.abs(estimateCacheSavingsUsd({
    provider: "gemini",
    modelId: "gemini-2.5-pro",
    cacheReadTokens: 1_000,
  }) - 0.0009375) < 1e-12);
});

test("estimateCacheSavingsUsd prices Anthropic 5m and 1h writes separately", () => {
  const savings = estimateCacheSavingsUsd({
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    cacheReadTokens: 1_000,
    cacheWrite5mTokens: 300,
    cacheWrite1hTokens: 200,
  });
  // 900 avoided read tokens - 75 5m premium - 200 1h premium, at $3/M.
  assert.ok(Math.abs(savings - 0.001875) < 1e-12);
});

test("cache-savings telemetry stays optional when the pricing helper is unavailable", () => {
  const script = [
    'import { estimateCacheSavingsUsd } from "@unclecode/providers";',
    "process.stdout.write(String(estimateCacheSavingsUsd({",
    'provider: "openai", modelId: "gpt-5.6-sol", cacheReadTokens: 1_000',
    "})));",
  ].join("");
  const result = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--conditions=source",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, UNCLECODE_RUST_BIN: "/definitely/missing/unclecode" },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "0");
});
