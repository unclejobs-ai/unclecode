import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyProviderCache,
  reduceProviderTurnPerformance,
} from "../../packages/contracts/src/performance.ts";

test("provider cache status distinguishes a reported zero from absent cache evidence", () => {
  assert.equal(classifyProviderCache({ cacheReadTokens: 9 }), "HIT");
  assert.equal(classifyProviderCache({ cacheReadTokens: 0 }), "MISS");
  assert.equal(classifyProviderCache({}), "n/a");
});

test("provider performance records only the first non-empty assistant delta", () => {
  let performance = reduceProviderTurnPerformance(undefined, {
    type: "turn.started",
    provider: "openai",
    model: "gpt-5.6-sol",
    startedAt: 1_000,
  });

  performance = reduceProviderTurnPerformance(performance, {
    type: "assistant.delta",
    delta: "",
    observedAt: 1_100,
  });
  assert.equal(performance?.firstTokenAt, undefined);

  performance = reduceProviderTurnPerformance(performance, {
    type: "assistant.delta",
    delta: "가",
    observedAt: 1_250,
  });
  performance = reduceProviderTurnPerformance(performance, {
    type: "assistant.delta",
    delta: "more",
    observedAt: 1_500,
  });
  assert.equal(performance?.firstTokenAt, 1_250);

  performance = reduceProviderTurnPerformance(performance, {
    type: "turn.completed",
    provider: "openai",
    model: "gpt-5.6-sol",
    startedAt: 1_000,
    completedAt: 2_250,
  });
  performance = reduceProviderTurnPerformance(performance, {
    type: "usage.recorded",
    provider: "openai",
    model: "gpt-5.6-sol",
    startedAt: 1_000,
    outputTokens: 100,
    cacheReadTokens: 20,
    cacheWriteTokens: 4,
    costUsd: 0.04,
  });

  assert.deepEqual(performance, {
    provider: "openai",
    model: "gpt-5.6-sol",
    startedAt: 1_000,
    firstTokenAt: 1_250,
    completedAt: 2_250,
    outputTokens: 100,
    cacheReadTokens: 20,
    cacheWriteTokens: 4,
    costUsd: 0.04,
  });
});

test("executor-scoped usage cannot replace the main provider performance receipt", () => {
  const current = {
    provider: "openai",
    model: "gpt-5.6-sol",
    startedAt: 1_000,
    completedAt: 2_000,
    outputTokens: 50,
  };
  const next = reduceProviderTurnPerformance(current, {
    type: "usage.recorded",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    agentRunId: "agent-1",
    startedAt: 3_000,
    completedAt: 4_000,
    outputTokens: 900,
    cacheReadTokens: 1,
  });
  assert.deepEqual(next, current);
});
