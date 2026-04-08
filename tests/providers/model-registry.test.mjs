import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderCapabilityMismatchError,
  getProviderAdapter,
} from "@unclecode/providers";

test("openai provider exposes a model registry with the configured model first", () => {
  const adapter = getProviderAdapter("openai");
  const registry = adapter.getModelRegistry({ OPENAI_MODEL: "gpt-4.1" });

  assert.equal(registry.providerId, "openai");
  assert.equal(registry.defaultModel, "gpt-5.4");
  assert.equal(registry.models[0], "gpt-4.1");
  assert.ok(registry.models.includes("gpt-5.4"));
});

test("openai provider keeps newer gpt-5 picks ahead of stale fallback models", () => {
  const adapter = getProviderAdapter("openai");
  const registry = adapter.getModelRegistry({ OPENAI_MODEL: "gpt-5.4" });

  assert.deepEqual(registry.models.slice(0, 4), [
    "gpt-5.4",
    "gpt-5.4-mini",
    "o4-mini",
    "gpt-4.1-mini",
  ]);
});

test("provider adapter raises a capability mismatch error for unsupported requirements", () => {
  const adapter = getProviderAdapter("openai");

  assert.throws(
    () => adapter.assertCapability("prompt-caching", { modelId: "gpt-5.4" }),
    ProviderCapabilityMismatchError,
  );
});

test("openai provider exposes model-specific reasoning support", () => {
  const adapter = getProviderAdapter("openai");

  assert.deepEqual(adapter.getReasoningSupport({ modelId: "gpt-5.4" }), {
    status: "supported",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high"],
  });
  assert.deepEqual(adapter.getReasoningSupport({ modelId: "o4-mini" }), {
    status: "supported",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high"],
  });
  assert.deepEqual(adapter.getReasoningSupport({ modelId: "gpt-4.1-mini" }), {
    status: "unsupported",
    supportedEfforts: [],
  });
});
