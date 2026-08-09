import assert from "node:assert/strict";
import test from "node:test";

import { WorkAgent } from "@unclecode/orchestrator";
import { runExecutorWithLifecycle } from "../../packages/orchestrator/src/work-agent-lifecycle.ts";

const supportedReasoning = {
  effort: "medium",
  source: "mode-default",
  support: {
    status: "supported",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high"],
  },
};

const goalPlan = JSON.stringify([
  {
    id: "task-1",
    summary: "Implement auth refactor",
    prompt: "Implement login.ts and oauth.ts",
    goal: "Refactor authentication safely",
    constraints: ["Preserve public behavior"],
    acceptanceCriteria: ["Auth unit tests pass"],
    dependsOn: [],
    writePaths: ["login.ts", "oauth.ts"],
  },
  {
    id: "task-2",
    summary: "Verify session integration",
    prompt: "Update and verify session.ts",
    goal: "Refactor authentication safely",
    constraints: ["Preserve public behavior"],
    acceptanceCriteria: ["Session integration passes"],
    dependsOn: ["task-1"],
    writePaths: ["session.ts"],
  },
]);

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

test("WorkAgent never mutates UNCLECODE_ALLOW_RUN_SHELL and forwards mode changes", () => {
  const modeUpdates = [];
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    updateMode(mode) {
      modeUpdates.push(mode);
    },
    async runTurn() {
      return { text: "" };
    },
  };
  const prev = process.env.UNCLECODE_ALLOW_RUN_SHELL;
  try {
    delete process.env.UNCLECODE_ALLOW_RUN_SHELL;

    new WorkAgent({ directAgent, mode: "default", reasoning: supportedReasoning, model: "gpt-5.4" });
    assert.equal(
      process.env.UNCLECODE_ALLOW_RUN_SHELL,
      undefined,
      "default mode leaves the process env untouched",
    );

    new WorkAgent({ directAgent, mode: "yolo", reasoning: supportedReasoning, model: "gpt-5.4" });
    assert.equal(
      process.env.UNCLECODE_ALLOW_RUN_SHELL,
      undefined,
      "yolo grants shell per instance, never through process.env",
    );

    const planAgent = new WorkAgent({ directAgent, mode: "plan", reasoning: supportedReasoning, model: "gpt-5.4" });
    planAgent.updateMode("ultrawork");
    assert.equal(
      process.env.UNCLECODE_ALLOW_RUN_SHELL,
      undefined,
      "switching to ultrawork grants shell per instance, never through process.env",
    );
    assert.deepEqual(modeUpdates, ["ultrawork"], "mode changes reach the direct agent");
  } finally {
    if (prev === undefined) {
      delete process.env.UNCLECODE_ALLOW_RUN_SHELL;
    } else {
      process.env.UNCLECODE_ALLOW_RUN_SHELL = prev;
    }
  }
});

test("WorkAgent plans goal tasks, runs isolated executors, and emits truthful lifecycle events", async () => {
  const calls = [];
  const executorCalls = [];
  const traces = [];
  let executorCount = 0;
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      calls.push(prompt);
      if (prompt.startsWith("<goal_task_planner>")) {
        return { text: goalPlan };
      }
      if (prompt.startsWith("Synthesize executor findings")) {
        return { text: "final synthesis" };
      }
      return { text: "guardian passed" };
    },
  };

  const agent = new WorkAgent({
    directAgent,
    async createExecutorAgent() {
      executorCount += 1;
      const executorId = executorCount;
      let traceListener;
      return {
        clear() {},
        updateRuntimeSettings() {},
        setTraceListener(listener) {
          traceListener = listener;
        },
        async runTurn(prompt) {
          executorCalls.push([executorId, prompt]);
          traceListener?.({
            type: "tool.started",
            level: "default",
            toolCallId: `tool-${executorId}`,
            toolName: "read",
            intent: "Inspect executor input",
            startedAt: 100 + executorId,
          });
          traceListener?.({
            type: "tool.completed",
            level: "default",
            toolCallId: `tool-${executorId}`,
            toolName: "read",
            intent: "Inspect executor input",
            status: "completed",
            startedAt: 100 + executorId,
            completedAt: 110 + executorId,
          });
          traceListener?.({
            type: "usage.recorded",
            level: "low-signal",
            eventId: `usage-${executorId}`,
            inputTokens: 1_000,
            outputTokens: 100,
            cacheReadTokens: 750,
            startedAt: 100 + executorId,
          });
          return { text: `executor:${executorId}` };
        },
      };
    },
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
  });

  agent.setTraceListener((event) => traces.push(event));
  const result = await agent.runTurn("refactor login.ts oauth.ts session.ts");

  assert.equal(result.text, "final synthesis");
  assert.equal(calls.length, 3, "planner, guardian, and synthesis use the coordinator");
  assert.deepEqual(executorCalls, [
    [1, "Implement login.ts and oauth.ts"],
    [2, "Update and verify session.ts"],
  ]);
  const proposed = traces.find((event) => event.type === "work.proposed");
  assert.equal(proposed?.graph?.goal, "Refactor authentication safely");
  assert.deepEqual(proposed?.graph?.nodes[1]?.dependsOn, ["task-1"]);
  assert.deepEqual(
    traces.filter((event) => event.type === "work.status").map((event) => [event.nodeId, event.status]),
    [
      ["task-1", "ready"],
      ["task-1", "running"],
      ["task-1", "completed"],
      ["task-2", "ready"],
      ["task-2", "running"],
      ["task-2", "completed"],
    ],
  );
  const queuedJobs = traces.filter((event) => event.type === "job.queued");
  const startedRuns = traces.filter((event) => event.type === "agent.run.started");
  const settledRuns = traces.filter((event) => event.type === "agent.run.settled");
  const usageEvents = traces.filter((event) => event.type === "usage.recorded");
  assert.equal(queuedJobs.length, 2);
  assert.deepEqual(startedRuns.map((event) => event.displayName), [
    "Implement auth refactor",
    "Verify session integration",
  ]);
  assert.deepEqual(settledRuns.map((event) => event.status), ["completed", "completed"]);
  assert.deepEqual(
    usageEvents.map((event) => event.agentRunId),
    startedRuns.map((event) => event.runId),
  );
  assert.deepEqual(
    traces
      .filter((event) => event.type === "tool.started" || event.type === "tool.completed")
      .map((event) => event.agentRunId),
    [startedRuns[0].runId, startedRuns[0].runId, startedRuns[1].runId, startedRuns[1].runId],
  );
  assert.ok(
    traces.some(
      (event) =>
        event.type === "orchestrator.step"
        && event.role === "reviewer"
        && event.status === "completed",
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
      if (prompt.startsWith("<goal_task_planner>")) {
        return { text: goalPlan };
      }
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
    taskCount: 2,
    resultCount: 2,
    changedFiles: ["login.ts", "oauth.ts", "session.ts"],
  }]);
  const reviewCall = calls.find((c) => /Executable verification:/.test(c));
  const synthesisCall = calls.find((c) => /Executable checks:/.test(c));
  assert.ok(reviewCall, "guardian review includes executable verification");
  assert.match(reviewCall ?? "", /check PASS/);
  assert.ok(synthesisCall, "synthesis includes executable checks");
  assert.match(synthesisCall ?? "", /lint PASS/);
});

test("executor factory failure settles the run and job as failed", async () => {
  const traces = [];
  const directAgent = {
    clear() {},
    setTraceListener() {},
    async runTurn() {
      return { text: "unused" };
    },
  };

  await assert.rejects(
    runExecutorWithLifecycle({
      taskId: "factory-failure",
      label: "Factory failure",
      prompt: "run",
      options: {},
      directAgent,
      createExecutorAgent: async () => {
        throw new Error("factory failed");
      },
      settings: { mode: "default", model: "gpt-5.6-sol", reasoning: supportedReasoning },
      onTrace: (event) => traces.push(event),
    }),
    /factory failed/,
  );

  assert.deepEqual(
    traces
      .filter((event) => event.type === "agent.run.settled" || event.type === "job.settled")
      .map((event) => event.status),
    ["failed", "failed"],
  );
});

test("aborted executor settles the run and job as cancelled", async () => {
  const traces = [];
  const controller = new AbortController();
  const executor = {
    clear() {},
    setTraceListener() {},
    async runTurn() {
      controller.abort();
      const error = new Error("cancelled");
      error.name = "AbortError";
      throw error;
    },
  };

  await assert.rejects(
    runExecutorWithLifecycle({
      taskId: "cancelled",
      label: "Cancelled run",
      prompt: "run",
      options: { signal: controller.signal },
      directAgent: executor,
      settings: { mode: "default", model: "gpt-5.6-sol", reasoning: supportedReasoning },
      onTrace: (event) => traces.push(event),
    }),
    /cancelled/,
  );

  assert.deepEqual(
    traces
      .filter((event) => event.type === "agent.run.settled" || event.type === "job.settled")
      .map((event) => event.status),
    ["cancelled", "cancelled"],
  );
});
