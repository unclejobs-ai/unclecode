import assert from "node:assert/strict";
import test from "node:test";

import { CodingAgent } from "../../packages/orchestrator/src/coding-agent.ts";

test("coding agent carries first-token and completion timestamps into usage evidence", async () => {
  let traceListener;
  const provider = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener(listener) {
      traceListener = listener;
    },
    async runTurn() {
      traceListener?.({
        type: "assistant.delta",
        level: "default",
        provider: "openai",
        model: "test-model",
        itemId: "answer-1",
        delta: "answer",
      });
      return {
        text: "answer",
        usage: { inputTokens: 20, outputTokens: 6, cacheReadTokens: 0 },
        costUsd: 0.01,
      };
    },
  };
  const agent = new CodingAgent({
    providerName: "openai",
    model: "test-model",
    provider,
  });
  const events = [];
  agent.setTraceListener((event) => events.push(event));

  await agent.runTurn("hello");

  const started = events.find((event) => event.type === "turn.started");
  const usage = events.find((event) => event.type === "usage.recorded");
  assert.ok(started);
  assert.ok(usage);
  assert.equal(usage.cacheReadTokens, 0);
  assert.equal(usage.completedAt >= usage.startedAt, true);
  assert.equal(usage.firstTokenAt >= usage.startedAt, true);
  assert.equal(usage.firstTokenAt <= usage.completedAt, true);
});

test("empty assistant deltas do not create first-token evidence", async () => {
  let traceListener;
  const provider = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener(listener) {
      traceListener = listener;
    },
    async runTurn() {
      traceListener?.({
        type: "assistant.delta",
        level: "default",
        provider: "openai",
        model: "test-model",
        itemId: "answer-empty",
        delta: "",
      });
      return { text: "", usage: { inputTokens: 20, outputTokens: 0 } };
    },
  };
  const agent = new CodingAgent({
    providerName: "openai",
    model: "test-model",
    provider,
  });
  const events = [];
  agent.setTraceListener((event) => events.push(event));

  await agent.runTurn("hello");

  const usage = events.find((event) => event.type === "usage.recorded");
  assert.ok(usage);
  assert.equal(usage.firstTokenAt, undefined);
});
