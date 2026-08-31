import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTraceEventToAgentConsole,
} from "../../packages/orchestrator/src/work-shell-agent-console.ts";

function emptySnapshot() {
  return { profileId: "build", activity: [], agents: [], jobs: [] };
}

test("agent console keeps one bounded main-turn performance projection from lifecycle traces", () => {
  let snapshot = applyTraceEventToAgentConsole(emptySnapshot(), {
    type: "turn.started",
    provider: "openai",
    model: "gpt-5.6-sol",
    startedAt: 1_000,
  });
  snapshot = applyTraceEventToAgentConsole(snapshot, {
    type: "assistant.delta",
    provider: "openai",
    model: "gpt-5.6-sol",
    itemId: "answer",
    delta: "first",
    observedAt: 1_200,
  });
  snapshot = applyTraceEventToAgentConsole(snapshot, {
    type: "turn.completed",
    provider: "openai",
    model: "gpt-5.6-sol",
    startedAt: 1_000,
    completedAt: 2_000,
  });
  snapshot = applyTraceEventToAgentConsole(snapshot, {
    type: "usage.recorded",
    eventId: "usage-1",
    provider: "openai",
    model: "gpt-5.6-sol",
    startedAt: 1_000,
    completedAt: 2_000,
    firstTokenAt: 1_200,
    outputTokens: 100,
    cacheReadTokens: 0,
  });

  assert.deepEqual(snapshot.lastTurnPerformance, {
    provider: "openai",
    model: "gpt-5.6-sol",
    startedAt: 1_000,
    firstTokenAt: 1_200,
    completedAt: 2_000,
    outputTokens: 100,
    cacheReadTokens: 0,
  });
});

test("scoped worker traces never replace the main performance projection", () => {
  const main = applyTraceEventToAgentConsole(emptySnapshot(), {
    type: "usage.recorded",
    eventId: "main-usage",
    provider: "openai",
    model: "gpt-5.6-sol",
    startedAt: 1_000,
    completedAt: 2_000,
    outputTokens: 10,
    cacheReadTokens: 4,
  });
  const worker = applyTraceEventToAgentConsole(main, {
    type: "usage.recorded",
    eventId: "worker-usage",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    agentRunId: "agent-1",
    startedAt: 3_000,
    completedAt: 4_000,
    outputTokens: 100,
    cacheReadTokens: 900,
  });

  assert.strictEqual(worker, main);
});
