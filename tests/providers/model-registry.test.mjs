import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderCapabilityMismatchError,
  getProviderAdapter,
  resolveOpenAICompatPolicy,
  resolveProviderRoute,
} from "@unclecode/providers";

test("openai provider exposes a model registry with the configured model first", () => {
  const adapter = getProviderAdapter("openai");
  const registry = adapter.getModelRegistry({ OPENAI_MODEL: "gpt-4.1" });

  assert.equal(registry.providerId, "openai");
  assert.equal(registry.defaultModel, "gpt-5.5");
  assert.equal(registry.models[0], "gpt-4.1");
  assert.ok(registry.models.includes("gpt-5.5"));
  assert.ok(registry.models.includes("gpt-5.4"));
  assert.ok(registry.models.includes("gpt-5.4-mini"));
});

test("openai provider keeps newer gpt-5 picks ahead of stale fallback models", () => {
  const adapter = getProviderAdapter("openai");
  const registry = adapter.getModelRegistry({ OPENAI_MODEL: "gpt-5.4" });

  assert.deepEqual(registry.models.slice(0, 5), [
    "gpt-5.4",
    "gpt-5.5",
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

test("provider adapter capability decisions come from the Rust registry", () => {
  assert.doesNotThrow(() => {
    getProviderAdapter("anthropic").assertCapability("prompt-caching", {
      modelId: "claude-sonnet-4-6",
    });
  });
  assert.doesNotThrow(() => {
    getProviderAdapter("gemini").assertCapability("tool-calls", {
      modelId: "gemini-2.5-pro",
    });
  });
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

test("provider route metadata is resolved by the Rust router", () => {
  const openaiRoute = resolveProviderRoute("openai");
  assert.deepEqual(
    {
      providerId: openaiRoute.providerId,
      label: openaiRoute.label,
      transport: openaiRoute.transport,
      runtimeSupported: openaiRoute.runtimeSupported,
      defaultModel: openaiRoute.defaultModel,
      endpointUrl: openaiRoute.endpointUrl,
      envKeys: openaiRoute.envKeys,
    },
    {
      providerId: "openai",
      label: "OpenAI",
      transport: "native",
      runtimeSupported: true,
      defaultModel: "gpt-5.5",
      endpointUrl: "https://api.openai.com/v1/responses",
      envKeys: ["OPENAI_API_KEY", "OPENAI_MODEL"],
    },
  );

  const anthropicRoute = resolveProviderRoute("auto", "Claude-Sonnet");
  assert.deepEqual(
    {
      providerId: anthropicRoute.providerId,
      label: anthropicRoute.label,
      transport: anthropicRoute.transport,
      runtimeSupported: anthropicRoute.runtimeSupported,
      defaultModel: anthropicRoute.defaultModel,
      endpointUrl: anthropicRoute.endpointUrl,
      envKeys: anthropicRoute.envKeys,
    },
    {
      providerId: "anthropic",
      label: "Anthropic",
      transport: "native",
      runtimeSupported: true,
      defaultModel: "claude-sonnet-4-20250514",
      endpointUrl: "https://api.anthropic.com/v1/messages",
      envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"],
    },
  );

  const ollamaRoute = resolveProviderRoute("ollama");
  assert.deepEqual(
    {
      providerId: ollamaRoute.providerId,
      label: ollamaRoute.label,
      transport: ollamaRoute.transport,
      runtimeSupported: ollamaRoute.runtimeSupported,
      defaultModel: ollamaRoute.defaultModel,
      endpointUrl: ollamaRoute.endpointUrl,
      envKeys: ollamaRoute.envKeys,
    },
    {
      providerId: "ollama",
      label: "Ollama",
      transport: "compat",
      runtimeSupported: false,
      defaultModel: "qwen3",
      endpointUrl: "http://localhost:11434/api/chat",
      envKeys: ["OLLAMA_BASE_URL", "OLLAMA_MODEL", "OLLAMA_API_KEY"],
    },
  );
});

test("provider route metadata includes Rust proxy policy", () => {
  const originalNoProxy = process.env.NO_PROXY;
  const originalHttpsProxy = process.env.HTTPS_PROXY;
  try {
    process.env.NO_PROXY = ".internal";
    process.env.HTTPS_PROXY = "http://proxy.local:8080";

    const route = resolveProviderRoute("openai");

    assert.equal(route.endpointUrl, "https://api.openai.com/v1/responses");
    assert.deepEqual(route.proxyPolicy, {
      proxyUrl: "http://proxy.local:8080",
      source: "HTTPS_PROXY",
      bypassed: false,
      targetHost: "api.openai.com",
      noProxy: [".internal"],
    });
  } finally {
    if (originalNoProxy === undefined) {
      delete process.env.NO_PROXY;
    } else {
      process.env.NO_PROXY = originalNoProxy;
    }
    if (originalHttpsProxy === undefined) {
      delete process.env.HTTPS_PROXY;
    } else {
      process.env.HTTPS_PROXY = originalHttpsProxy;
    }
  }
});

test("openai-compatible policy exposes provider-specific wire constraints", () => {
  const kimi = resolveOpenAICompatPolicy(
    "zai",
    "moonshotai/kimi-k2-instruct",
    "https://api.moonshot.ai/v1/chat/completions",
  );
  assert.equal(kimi.thinkingFormat, "zai");
  assert.equal(kimi.requiresAssistantContentForToolCalls, true);
  assert.equal(kimi.requiresReasoningContentForToolCalls, true);
  assert.equal(kimi.supportsReasoningEffort, false);

  const groq = resolveOpenAICompatPolicy("groq", "qwen/qwen3-32b");
  assert.equal(groq.supportsReasoningEffort, true);
  assert.equal(groq.thinkingFormat, "qwen");

  const deepseek = resolveOpenAICompatPolicy("ollama", "deepseek-r1:8b");
  assert.equal(deepseek.thinkingFormat, "deepseek");
  assert.equal(deepseek.supportsToolChoice, false);
});
