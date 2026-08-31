import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderCapabilityMismatchError,
  getProviderAdapter,
  resolveOpenAICompatPolicy,
  resolveProviderRoute,
} from "@unclecode/providers";

test("openai provider exposes only GPT-5.6 defaults after an active custom model", () => {
  const adapter = getProviderAdapter("openai");
  const registry = adapter.getModelRegistry({ OPENAI_MODEL: "custom-openai-model" });

  assert.equal(registry.providerId, "openai");
  assert.equal(registry.defaultModel, "gpt-5.6-sol");
  assert.deepEqual(registry.models, [
    "custom-openai-model",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
});

test("openai provider keeps the GPT-5.6 family in capability order", () => {
  const adapter = getProviderAdapter("openai");
  const registry = adapter.getModelRegistry({ OPENAI_MODEL: "" });

  assert.deepEqual(registry.models, [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
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

test("openai provider exposes GPT-5.6 reasoning levels", () => {
  const adapter = getProviderAdapter("openai");
  const expected = {
    status: "supported",
    defaultEffort: "medium",
    supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
  };

  for (const modelId of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.deepEqual(adapter.getReasoningSupport({ modelId }), expected);
  }
  assert.deepEqual(adapter.getReasoningSupport({ modelId: "gpt-5.5" }), {
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
      defaultModel: "gpt-5.6-sol",
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

test("deepseek is a first-class runtime route with a pinned compat catalog", () => {
  const route = resolveProviderRoute("deepseek");
  assert.deepEqual(
    {
      providerId: route.providerId,
      label: route.label,
      transport: route.transport,
      runtimeSupported: route.runtimeSupported,
      defaultModel: route.defaultModel,
      endpointUrl: route.endpointUrl,
      envKeys: route.envKeys,
      thinkingFormat: route.compatPolicy.thinkingFormat,
    },
    {
      providerId: "deepseek",
      label: "DeepSeek",
      transport: "compat",
      runtimeSupported: true,
      defaultModel: "deepseek-chat",
      endpointUrl: "https://api.deepseek.com/chat/completions",
      envKeys: ["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL", "DEEPSEEK_BASE_URL"],
      thinkingFormat: "deepseek",
    },
  );

  const registry = getProviderAdapter("deepseek").getModelRegistry({});
  assert.equal(registry.providerId, "deepseek");
  assert.equal(registry.defaultModel, "deepseek-chat");
  assert.deepEqual(registry.models, ["deepseek-chat", "deepseek-reasoner"]);

  const policy = resolveOpenAICompatPolicy("deepseek", "deepseek-reasoner");
  assert.equal(policy.thinkingFormat, "deepseek");
  assert.equal(policy.supportsToolChoice, false);
  assert.equal(policy.requiresReasoningContentForToolCalls, true);
});

test("deepseek registry keeps an explicit empty env isolated from the host model", (t) => {
  const previousModel = process.env.DEEPSEEK_MODEL;
  process.env.DEEPSEEK_MODEL = "host-only-model";
  t.after(() => {
    if (previousModel === undefined) {
      delete process.env.DEEPSEEK_MODEL;
    } else {
      process.env.DEEPSEEK_MODEL = previousModel;
    }
  });

  const registry = getProviderAdapter("deepseek").getModelRegistry({});

  assert.equal(registry.defaultModel, "deepseek-chat");
  assert.deepEqual(registry.models, ["deepseek-chat", "deepseek-reasoner"]);
});

test("omp resolves as an executor-only native route instead of being rejected", () => {
  const ompRoute = resolveProviderRoute("omp");
  assert.deepEqual(
    {
      providerId: ompRoute.providerId,
      label: ompRoute.label,
      transport: ompRoute.transport,
      runtimeSupported: ompRoute.runtimeSupported,
      defaultModel: ompRoute.defaultModel,
      endpointUrl: ompRoute.endpointUrl,
      envKeys: ompRoute.envKeys,
    },
    {
      providerId: "omp",
      label: "OMP",
      transport: "native",
      // Executor-only: OMP is never selectable as the interactive runtime.
      runtimeSupported: false,
      defaultModel: "kimi-code/k3",
      // OMP runs as a local subprocess and resolves its own credentials, so it
      // has no endpoint to proxy and UncleCode reads no environment for it.
      endpointUrl: "",
      envKeys: [],
    },
  );
  // A route with no endpoint must still report a usable, proxy-free policy
  // rather than failing to parse an empty URL.
  assert.deepEqual(ompRoute.proxyPolicy, {
    proxyUrl: null,
    source: "none",
    bypassed: false,
    targetHost: "",
    noProxy: [],
  });
});

test("the omp adapter reports one pinned model and OMP's own capability shape", () => {
  const adapter = getProviderAdapter("omp");
  const registry = adapter.getModelRegistry({
    // Neither knob may widen a delegated route: work turns are pinned to K3.
    OMP_MODEL: "zai/glm-5",
    OMP_MODELS: "groq/openai/gpt-oss-20b",
  });

  assert.equal(registry.providerId, "omp");
  assert.equal(registry.defaultModel, "kimi-code/k3");
  assert.deepEqual(registry.models, ["kimi-code/k3"]);

  adapter.assertCapability("tool-calls", { modelId: "kimi-code/k3" });
  adapter.assertCapability("prompt-caching", { modelId: "kimi-code/k3" });
  assert.throws(
    () => adapter.assertCapability("session-memory", { modelId: "kimi-code/k3" }),
    ProviderCapabilityMismatchError,
    "OMP starts a fresh session per delegated turn",
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
