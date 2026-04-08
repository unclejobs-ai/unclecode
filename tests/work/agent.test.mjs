import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeCodingAgent as CodingAgent } from "@unclecode/orchestrator";

const supportedReasoning = {
  effort: "medium",
  source: "mode-default",
  support: {
    status: "supported",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high"],
  },
};

test("CodingAgent emits honest turn traces around a successful turn", async () => {
  const traces = [];
  const provider = {
    async runTurn(prompt) {
      assert.equal(prompt, "inspect the repo");
      return { text: "done" };
    },
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
  };

  const agent = new CodingAgent({
    provider: "openai-api",
    apiKey: "sk-test-123",
    model: "gpt-5.4",
    cwd: process.cwd(),
    reasoning: supportedReasoning,
    providerOverride: provider,
  });

  agent.setTraceListener((event) => traces.push(event));
  const result = await agent.runTurn("inspect the repo");

  assert.equal(result.text, "done");
  assert.deepEqual(traces.map((event) => event.type), [
    "turn.started",
    "provider.calling",
    "turn.completed",
  ]);
  assert.equal(traces[1]?.provider, "openai-api");
  assert.equal(traces[1]?.model, "gpt-5.4");
  assert.equal(traces.filter((event) => event.type === "orchestrator.step").length, 0);
});

test("CodingAgent keeps failures honest without fake orchestrator steps", async () => {
  const traces = [];
  const provider = {
    async runTurn() {
      throw new Error("provider exploded");
    },
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
  };

  const agent = new CodingAgent({
    provider: "openai-api",
    apiKey: "sk-test-123",
    model: "gpt-5.4",
    cwd: process.cwd(),
    reasoning: supportedReasoning,
    providerOverride: provider,
  });

  agent.setTraceListener((event) => traces.push(event));

  await assert.rejects(() => agent.runTurn("inspect the repo"), /provider exploded/);
  assert.deepEqual(traces.map((event) => event.type), [
    "turn.started",
    "provider.calling",
  ]);
  assert.equal(traces.filter((event) => event.type === "orchestrator.step").length, 0);
});

test("CodingAgent can refresh provider auth tokens in place", () => {
  const updates = [];
  const provider = {
    async runTurn() {
      return { text: "done" };
    },
    clear() {},
    updateRuntimeSettings() {},
    updateAuthToken(apiKey) {
      updates.push(apiKey);
    },
    setTraceListener() {},
  };

  const agent = new CodingAgent({
    provider: "openai-api",
    apiKey: "sk-test-123",
    model: "gpt-5.4",
    cwd: process.cwd(),
    reasoning: supportedReasoning,
    providerOverride: provider,
  });

  agent.refreshAuthToken("sk-refreshed-456");
  agent.refreshAuthToken("");

  assert.deepEqual(updates, ["sk-refreshed-456", ""]);
});
