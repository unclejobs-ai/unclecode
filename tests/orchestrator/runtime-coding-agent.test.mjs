import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { RuntimeCodingAgent } from "../../packages/orchestrator/src/runtime-coding-agent.ts";

const SUPPORTED_REASONING = {
  effort: "none",
  source: "mode-default",
  support: { status: "supported", defaultEffort: "none", supportedEfforts: ["none"] },
};

function createStubProvider() {
  const provider = {
    runTurnCalls: 0,
    async runTurn() {
      provider.runTurnCalls += 1;
      return { text: "stub" };
    },
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
  };
  return provider;
}

function createAgentOptions(overrides = {}) {
  return {
    provider: "openai",
    apiKey: "test-key",
    model: "test-model",
    cwd: "/tmp",
    reasoning: SUPPORTED_REASONING,
    ...overrides,
  };
}

test("providerOverrideFactory receives the agent tool runtime and its provider is used", async () => {
  const seen = {};
  const agent = new RuntimeCodingAgent(
    createAgentOptions({
      providerOverrideFactory: ({ toolRuntime }) => {
        seen.toolRuntime = toolRuntime;
        seen.provider = createStubProvider();
        return seen.provider;
      },
    }),
  );
  assert.deepEqual(await agent.runTurn("use factory provider"), { text: "stub" });

  assert.ok(seen.toolRuntime, "factory was not called");
  assert.ok(Array.isArray(seen.toolRuntime.definitions));
  assert.ok(seen.toolRuntime.definitions.length > 0);
  assert.equal(seen.toolRuntime.handlers, undefined, "the public runtime never exposes raw handlers");
  assert.equal(typeof seen.toolRuntime.executor.execute, "function");
  assert.equal(seen.provider.runTurnCalls, 1);
});

test("toolAccess none constructs a provider with no advertised or executable tools", async () => {
  let toolRuntime;
  const agent = new RuntimeCodingAgent(
    createAgentOptions({
      toolAccess: "none",
      providerOverrideFactory: (context) => {
        toolRuntime = context.toolRuntime;
        return createStubProvider();
      },
    }),
  );

  assert.deepEqual(await agent.runTurn("read-only synthesis"), { text: "stub" });
  assert.deepEqual(toolRuntime.definitions, []);
  assert.deepEqual(await toolRuntime.executor.execute({
    toolName: "write_file",
    input: { path: "forbidden.txt", content: "must not write" },
    cwd: "/tmp",
  }), {
    isError: true,
    content: "Quality review is read-only; tools are unavailable.",
  });
});

test("providerOverride takes precedence over providerOverrideFactory", async () => {
  let factoryCalled = false;
  const override = createStubProvider();
  const agent = new RuntimeCodingAgent(
    createAgentOptions({
      providerOverride: override,
      providerOverrideFactory: () => {
        factoryCalled = true;
        return createStubProvider();
      },
    }),
  );
  assert.deepEqual(await agent.runTurn("use explicit override"), { text: "stub" });

  assert.equal(factoryCalled, false);
  assert.equal(override.runTurnCalls, 1);
});

test("runtime mode grants autonomy per instance and updateMode revokes it", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-runtime-mode-"));
  let toolRuntime;
  const agent = new RuntimeCodingAgent(
    createAgentOptions({
      cwd,
      mode: "yolo",
      providerOverrideFactory: (context) => {
        toolRuntime = context.toolRuntime;
        return createStubProvider();
      },
    }),
  );

  try {
    const allowed = await toolRuntime.executor.execute({
      toolName: "write_file",
      input: { path: "allowed.txt", content: "written" },
      cwd,
    });
    assert.equal(allowed.isError ?? false, false);
    assert.equal(readFileSync(path.join(cwd, "allowed.txt"), "utf8"), "written");

    agent.updateMode("default");
    const denied = await toolRuntime.executor.execute({
      toolName: "write_file",
      input: { path: "denied.txt", content: "blocked" },
      cwd,
    });
    assert.equal(denied.isError, true);
    assert.match(denied.content, /confirmation.*not granted/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runtime coding agent emits cache usage with estimated savings", async () => {
  const events = [];
  const agent = new RuntimeCodingAgent(
    createAgentOptions({
      model: "gpt-5.6-sol",
      providerOverride: {
        ...createStubProvider(),
        async runTurn() {
          return {
            text: "cached",
            usage: {
              inputTokens: 1_000,
              outputTokens: 200,
              cacheReadTokens: 750,
              cacheWriteTokens: 0,
            },
            costUsd: 0.01,
          };
        },
      },
    }),
  );
  agent.setTraceListener((event) => events.push(event));

  await agent.runTurn("reuse the stable prompt prefix");

  const usage = events.find((event) => event.type === "usage.recorded");
  assert.equal(usage?.provider, "openai");
  assert.equal(usage?.model, "gpt-5.6-sol");
  assert.equal(usage?.inputTokens, 1_000);
  assert.equal(usage?.outputTokens, 200);
  assert.equal(usage?.cacheReadTokens, 750);
  assert.equal(usage?.cacheWriteTokens, 0);
  assert.equal(usage?.costUsd, 0.01);
  assert.ok(usage?.cacheSavingsUsd > 0);
});

test("runtime coding agent keeps one model route when settings change mid-turn", async () => {
  const events = [];
  let resolveTurn;
  const pendingTurn = new Promise((resolve) => {
    resolveTurn = resolve;
  });
  const agent = new RuntimeCodingAgent(
    createAgentOptions({
      model: "model-a",
      providerOverride: {
        ...createStubProvider(),
        runTurn: () => pendingTurn,
      },
    }),
  );
  agent.setTraceListener((event) => events.push(event));

  const result = agent.runTurn("keep the dispatched model");
  agent.updateRuntimeSettings({ model: "model-b" });
  resolveTurn({
    text: "done",
    usage: { inputTokens: 10, outputTokens: 2 },
    costUsd: 0.001,
  });
  await result;

  const routed = events.filter((event) =>
    event.type === "turn.started"
    || event.type === "provider.route"
    || event.type === "provider.calling"
    || event.type === "turn.completed"
    || event.type === "usage.recorded"
  );
  assert.deepEqual(routed.map((event) => event.model), routed.map(() => "model-a"));
});
