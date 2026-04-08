import assert from "node:assert/strict";
import test from "node:test";

import { WorkAgent } from "../../src/work-agent.ts";

const supportedReasoning = {
  effort: "medium",
  source: "mode-default",
  support: {
    status: "supported",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high"],
  },
};

test("WorkAgent keeps simple turns on the direct single-call path", async () => {
  const calls = [];
  const traces = [];
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      calls.push(prompt);
      return { text: `direct:${prompt}` };
    },
  };

  const agent = new WorkAgent({
    directAgent,
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
  });

  agent.setTraceListener((event) => traces.push(event));
  const result = await agent.runTurn("summarize this file");

  assert.equal(result.text, "direct:summarize this file");
  assert.deepEqual(calls, ["summarize this file"]);
  assert.equal(traces.filter((event) => event.type === "orchestrator.step").length, 0);
});

test("WorkAgent routes complex turns through the real orchestrator and synthesizes executor output", async () => {
  const calls = [];
  const traces = [];
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      calls.push(prompt);
      if (prompt.startsWith("Synthesize executor findings")) {
        return { text: "final synthesis" };
      }
      return { text: `result:${calls.length}` };
    },
  };

  const agent = new WorkAgent({
    directAgent,
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
  });

  agent.setTraceListener((event) => traces.push(event));
  const result = await agent.runTurn("refactor login.ts oauth.ts session.ts");

  assert.equal(result.text, "final synthesis");
  assert.equal(calls.length, 5);
  assert.ok(calls[0]?.includes("login.ts"));
  assert.ok(calls[1]?.includes("oauth.ts"));
  assert.ok(calls[2]?.includes("session.ts"));
  assert.ok(calls[3]?.startsWith("Review the executor findings"));
  assert.ok(calls[4]?.startsWith("Synthesize executor findings"));
  assert.ok(
    traces.some(
      (event) =>
        event.type === "orchestrator.step" &&
        event.role === "planner" &&
        event.status === "completed",
    ),
  );
  assert.ok(
    traces.some(
      (event) =>
        event.type === "orchestrator.step" &&
        event.role === "reviewer" &&
        event.status === "completed",
    ),
  );
});

test("WorkAgent includes executable guardian checks in review and synthesis prompts", async () => {
  const calls = [];
  const guardCalls = [];
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      calls.push(prompt);
      if (prompt.startsWith("Synthesize executor findings")) {
        return { text: "final synthesis" };
      }
      return { text: `result:${calls.length}` };
    },
  };

  const agent = new WorkAgent({
    directAgent,
    mode: "ultrawork",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
    async runExecutableGuardianChecks(input) {
      guardCalls.push({
        mode: input.mode,
        taskCount: input.tasks.length,
        resultCount: input.results.length,
        changedFiles: input.changedFiles,
      });
      return {
        summary: "check PASS (420ms) · lint PASS (510ms)",
      };
    },
  });

  const result = await agent.runTurn("refactor login.ts oauth.ts session.ts");

  assert.equal(result.text, "final synthesis");
  assert.deepEqual(guardCalls, [{
    mode: "ultrawork",
    taskCount: 3,
    resultCount: 3,
    changedFiles: ["login.ts", "oauth.ts", "session.ts"],
  }]);
  assert.match(calls[3] ?? "", /Executable verification:/);
  assert.match(calls[3] ?? "", /check PASS/);
  assert.match(calls[4] ?? "", /Executable checks:/);
  assert.match(calls[4] ?? "", /lint PASS/);
});
