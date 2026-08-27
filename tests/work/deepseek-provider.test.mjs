import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "@unclecode/orchestrator";
import { OpenAIProvider, createRuntimeProvider } from "@unclecode/providers";
import { loadWorkCliBootstrap } from "../../apps/unclecode-cli/src/work-runtime-bootstrap.ts";

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
