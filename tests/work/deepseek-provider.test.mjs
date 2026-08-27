import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "@unclecode/orchestrator";
import { OpenAIProvider, createRuntimeProvider } from "@unclecode/providers";
import {
  loadWorkCliBootstrap,
  resolveQualityReviewSelection,
} from "../../apps/unclecode-cli/src/work-runtime-bootstrap.ts";

const unsupportedReasoning = {
  effort: "unsupported",
  source: "model-capability",
  support: { status: "unsupported", supportedEfforts: [] },
};

test("loadConfig exposes DeepSeek defaults and optional endpoint override", async () => {
  const originalEnv = { ...process.env };
  try {
    process.env.LLM_PROVIDER = "deepseek";
    process.env.DEEPSEEK_API_KEY = "ds-test-key";
    delete process.env.DEEPSEEK_MODEL;
    process.env.DEEPSEEK_BASE_URL = "https://gateway.example/v1";

    const config = await loadConfig();
    assert.equal(config.provider, "deepseek");
    assert.equal(config.apiKey, "ds-test-key");
    assert.equal(config.model, "deepseek-chat");
    assert.equal(config.baseUrl, "https://gateway.example/v1/chat/completions");
    assert.equal(config.authLabel, "env-key");
    assert.equal(config.reasoning.effort, "unsupported");
  } finally {
    process.env = originalEnv;
  }
});

test("loadConfig resolves injected env auth, model, and home extension overlays", async () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-injected-config-"));
  const injectedHome = path.join(workspaceRoot, "injected-home");
  const extensionRoot = path.join(injectedHome, ".unclecode", "extensions");
  const env = {
    PATH: process.env.PATH,
    HOME: injectedHome,
    LLM_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "injected-direct-secret",
    DEEPSEEK_MODEL: "deepseek-reasoner",
    DEEPSEEK_BASE_URL: "https://injected.example/v1",
  };

  try {
    mkdirSync(extensionRoot, { recursive: true });
    writeFileSync(path.join(extensionRoot, "mode.json"), `${JSON.stringify({
      name: "injected-home-mode",
      config: { mode: "analyze" },
    })}\n`, "utf8");

    const config = await loadConfig({ cwd: workspaceRoot, env });

    assert.equal(config.provider, "deepseek");
    assert.equal(config.apiKey, "injected-direct-secret");
    assert.equal(config.model, "deepseek-reasoner");
    assert.equal(config.baseUrl, "https://injected.example/v1/chat/completions");
    assert.equal(config.mode, "analyze");
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("the native DeepSeek runtime reuses chat completions at the configured endpoint", async () => {
  const requests = [];
  const provider = new OpenAIProvider({
    providerName: "deepseek",
    endpointUrl: "https://gateway.example/v1/chat/completions",
    apiKey: "ds-test-key",
    model: "deepseek-chat",
    cwd: process.cwd(),
    reasoning: unsupportedReasoning,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        choices: [{ message: { content: "deepseek-ready" } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }), { status: 200 });
    },
  });

  const result = await provider.runTurn("hello");
  assert.equal(result.text, "deepseek-ready");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://gateway.example/v1/chat/completions");
  assert.equal(requests[0].init.headers.Authorization, "Bearer ds-test-key");
  assert.equal(JSON.parse(requests[0].init.body).model, "deepseek-chat");
});

test("DeepSeek tool continuation resends reasoning_content in the second HTTP body", async () => {
  const requestBodies = [];
  const responses = [
    {
      choices: [{
        message: {
          content: "",
          reasoning_content: "retain this chain for the tool continuation",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "inspect", arguments: "{\"path\":\"src\"}" },
          }],
        },
      }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    },
    {
      choices: [{ message: { content: "inspection complete" } }],
      usage: { prompt_tokens: 4, completion_tokens: 1 },
    },
  ];
  const provider = new OpenAIProvider({
    providerName: "deepseek",
    endpointUrl: "https://api.deepseek.com/chat/completions",
    apiKey: "ds-test-key",
    model: "deepseek-reasoner",
    cwd: process.cwd(),
    reasoning: unsupportedReasoning,
    toolRuntime: {
      definitions: [{
        name: "inspect",
        description: "Inspect one workspace path.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }],
      executor: {
        async execute() {
          return { content: "src/index.ts" };
        },
      },
    },
    fetchImpl: async (_url, init) => {
      requestBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    },
  });

  const result = await provider.runTurn("inspect src");

  assert.equal(result.text, "inspection complete");
  assert.equal(requestBodies.length, 2);
  const assistant = requestBodies[1].messages.find((message) => message.role === "assistant");
  assert.equal(assistant.reasoning_content, "retain this chain for the tool continuation");
  assert.equal(assistant.tool_calls[0].id, "call_1");
  assert.equal(requestBodies[1].messages.at(-1).role, "tool");
});

test("createRuntimeProvider accepts the canonical DeepSeek runtime", () => {
  const provider = createRuntimeProvider({
    provider: "deepseek",
    apiKey: "ds-test-key",
    model: "deepseek-chat",
    cwd: process.cwd(),
    reasoning: unsupportedReasoning,
  });
  assert.ok(provider instanceof OpenAIProvider);
});

test("the real work CLI bootstrap preserves the selected DeepSeek route", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-deepseek-bootstrap-"));
  try {
    process.env = {
      ...originalEnv,
      LLM_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "ds-test-key",
      DEEPSEEK_MODEL: "deepseek-reasoner",
      DEEPSEEK_BASE_URL: "https://gateway.example/v1",
      HOME: workspaceRoot,
    };

    const result = await loadWorkCliBootstrap({
      argv: ["--cwd", workspaceRoot, "--provider", "deepseek", "--engine", "native"],
      env: process.env,
      userHomeDir: workspaceRoot,
    });

    assert.equal(result.options.provider, "deepseek");
    assert.equal(result.options.model, "deepseek-reasoner");
    assert.equal(typeof result.agent.runTurn, "function");
    assert.deepEqual(await result.options.refreshAuthState(), {
      authLabel: "env-key",
      authIssueLines: [],
    });
  } finally {
    process.env = originalEnv;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("quality review bootstrap prefers a genuinely distinct configured provider", () => {
  assert.deepEqual(resolveQualityReviewSelection({
    directProvider: "openai",
    directModel: "gpt-5.6-sol",
    env: {
      OPENAI_API_KEY: "openai-key",
      ANTHROPIC_API_KEY: "anthropic-key",
      ANTHROPIC_MODEL: "claude-review",
    },
  }), {
    provider: "anthropic",
    model: "claude-review",
    distinct: true,
  });

  assert.deepEqual(resolveQualityReviewSelection({
    directProvider: "deepseek",
    directModel: "deepseek-chat",
    env: { DEEPSEEK_API_KEY: "deepseek-key" },
  }), {
    provider: "deepseek",
    model: "deepseek-chat",
    distinct: false,
  });
});

test("the real bootstrap uses injected env for distinct direct and review routes", async () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-injected-review-bootstrap-"));
  const injectedHome = path.join(workspaceRoot, "home");
  const before = {
    LLM_PROVIDER: process.env.LLM_PROVIDER,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    UNCLECODE_REVIEW_PROVIDER: process.env.UNCLECODE_REVIEW_PROVIDER,
  };
  const env = {
    PATH: process.env.PATH,
    HOME: injectedHome,
    LLM_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "injected-direct-secret",
    DEEPSEEK_MODEL: "deepseek-reasoner",
    ANTHROPIC_API_KEY: "injected-review-secret",
    ANTHROPIC_MODEL: "claude-injected-review",
    UNCLECODE_REVIEW_PROVIDER: "anthropic",
    UNCLECODE_SESSION_STORE_ROOT: path.join(workspaceRoot, ".state"),
    UNCLECODE_OMP_BIN: path.join(workspaceRoot, "missing-omp"),
    UNCLECODE_OMP_BUN_BIN: path.join(workspaceRoot, "missing-bun"),
  };

  try {
    mkdirSync(injectedHome, { recursive: true });
    const result = await loadWorkCliBootstrap({
      argv: ["--cwd", workspaceRoot, "--provider", "deepseek", "--engine", "native"],
      env,
      userHomeDir: injectedHome,
    });

    assert.equal(result.options.provider, "deepseek");
    assert.equal(result.options.model, "deepseek-reasoner");
    assert.deepEqual(result.agent.directRoute, {
      provider: "deepseek",
      model: "deepseek-reasoner",
    });
    assert.deepEqual(result.agent.reviewRoute, {
      provider: "anthropic",
      model: "claude-injected-review",
    });
    const safeRouteMetadata = JSON.stringify({
      provider: result.options.provider,
      model: result.options.model,
      directRoute: result.agent.directRoute,
      reviewRoute: result.agent.reviewRoute,
    });
    assert.doesNotMatch(safeRouteMetadata, /injected-(?:direct|review)-secret/);
    assert.deepEqual({
      LLM_PROVIDER: process.env.LLM_PROVIDER,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      UNCLECODE_REVIEW_PROVIDER: process.env.UNCLECODE_REVIEW_PROVIDER,
    }, before);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
