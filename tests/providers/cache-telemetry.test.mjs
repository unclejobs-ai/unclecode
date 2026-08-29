import assert from "node:assert/strict";
import test from "node:test";

import {
  AnthropicProvider,
  getProviderCacheTelemetrySnapshot,
  invalidateProviderDerivationCaches,
  invalidateProviderSystemPromptCache,
} from "@unclecode/providers";

function systemPromptTelemetry() {
  return getProviderCacheTelemetrySnapshot().find((snapshot) => snapshot.name === "provider-system-prompt");
}

test("provider system-prompt cache reports hits, misses, exact invalidation, and retained size", () => {
  invalidateProviderDerivationCaches();
  const before = systemPromptTelemetry();
  const appendix = `cache telemetry appendix ${process.pid}`;
  const args = {
    apiKey: "test-key",
    model: "claude-test",
    cwd: process.cwd(),
    systemPrompt: appendix,
    client: { messages: { create: async () => ({ content: [], usage: {} }) } },
  };

  new AnthropicProvider(args);
  new AnthropicProvider(args);
  const afterHit = systemPromptTelemetry();

  assert.equal(afterHit.misses - before.misses, 1);
  assert.equal(afterHit.hits - before.hits, 1);
  assert.equal(afterHit.currentSize, 1);
  assert.ok(afterHit.retainedBytesEstimate > appendix.length);
  assert.equal(invalidateProviderSystemPromptCache(appendix), true);
  assert.equal(invalidateProviderSystemPromptCache(appendix), false);

  const afterInvalidation = systemPromptTelemetry();
  assert.equal(afterInvalidation.invalidations - afterHit.invalidations, 1);
  assert.equal(afterInvalidation.currentSize, 0);
  assert.equal(afterInvalidation.retainedBytesEstimate, 0);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(getProviderCacheTelemetrySnapshot())));
});

test("provider system-prompt cache evicts under repeated unique appendix churn", () => {
  invalidateProviderDerivationCaches();
  const before = systemPromptTelemetry();

  for (let index = 0; index < 80; index += 1) {
    new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-test",
      cwd: process.cwd(),
      systemPrompt: `unique appendix ${process.pid}-${index}`,
      client: { messages: { create: async () => ({ content: [], usage: {} }) } },
    });
  }

  const snapshot = systemPromptTelemetry();
  assert.equal(snapshot.maxEntries, 64);
  assert.equal(snapshot.currentSize, 64);
  assert.equal(snapshot.evictions - before.evictions, 16);
  assert.ok(snapshot.retainedBytesEstimate < 1_000_000);
});
