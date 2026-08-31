import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import { WorkAgent } from "@unclecode/orchestrator";
import * as workAgentLifecycle from "../../packages/orchestrator/src/work-agent-lifecycle.ts";

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
            provider: "openai",
            model: "gpt-5.6-sol",
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
  assert.equal(Number.isSafeInteger(proposed?.sequence), true);
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

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createPlanningDirectAgent() {
  return {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      if (prompt.startsWith("<goal_task_planner>")) {
        return { text: goalPlan };
      }
      if (prompt.startsWith("Synthesize executor findings")) {
        return { text: "final synthesis" };
      }
      return { text: "guardian passed" };
    },
  };
}

test("WorkAgent queues one planned job per graph node before the first executor starts", async () => {
  const traces = [];
  const agent = new WorkAgent({
    directAgent: createPlanningDirectAgent(),
    async createExecutorAgent() {
      return {
        clear() {},
        updateRuntimeSettings() {},
        setTraceListener() {},
        async runTurn() {
          return { text: "executor done" };
        },
      };
    },
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
  });

  agent.setTraceListener((event) => traces.push(event));
  await agent.runTurn("refactor login.ts oauth.ts session.ts");

  const graphId = traces.find((event) => event.type === "work.proposed")?.graphId;
  assert.ok(graphId, "the plan produced a work graph");
  const types = traces.map((event) => event.type);
  assert.deepEqual(
    traces.filter((event) => event.type === "job.queued").map((event) => event.jobId),
    [`${graphId}:task-1`, `${graphId}:task-2`],
  );
  assert.ok(
    types.lastIndexOf("job.queued") < types.indexOf("agent.run.started"),
    "every planned job is queued when the plan is accepted, before any run starts",
  );
  assert.deepEqual(
    traces.filter((event) => event.type === "agent.run.started").map((event) => event.jobId),
    [`${graphId}:task-1`, `${graphId}:task-2`],
  );
});

test("the agent control runtime steers a live executor run", async () => {
  const traces = [];
  const prompts = [];
  const runStarted = createDeferred();
  const releaseFirstTurn = createDeferred();
  const agent = new WorkAgent({
    directAgent: createPlanningDirectAgent(),
    async createExecutorAgent() {
      return {
        clear() {},
        updateRuntimeSettings() {},
        setTraceListener() {},
        async runTurn(prompt) {
          prompts.push(prompt);
          if (prompts.length === 1) {
            await releaseFirstTurn.promise;
          }
          return { text: `executor:${prompts.length}` };
        },
      };
    },
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
  });

  agent.setTraceListener((event) => {
    traces.push(event);
    if (event.type === "agent.run.started") {
      runStarted.resolve(event.runId);
    }
  });

  const turn = agent.runTurn("refactor login.ts oauth.ts session.ts");
  const runId = await runStarted.promise;
  const receipt = await agent.getAgentControlRuntime().steer(runId, "Prefer the existing helper");
  assert.equal(receipt.status, "accepted");
  releaseFirstTurn.resolve();
  await turn;

  assert.equal(
    prompts[1],
    "Operator guidance:\nPrefer the existing helper\n\nContinue the assigned task. Report only the updated result.",
  );
  assert.ok(
    !JSON.stringify(traces).includes("Prefer the existing helper"),
    "operator control text stays out of the trace stream",
  );
});

test("cancelling one executor run marks the node cancelled and settles its blocked dependent", async () => {
  const traces = [];
  const runStarted = createDeferred();
  let executorCount = 0;
  const agent = new WorkAgent({
    directAgent: createPlanningDirectAgent(),
    async createExecutorAgent() {
      executorCount += 1;
      return {
        clear() {},
        updateRuntimeSettings() {},
        setTraceListener() {},
        async runTurn(_prompt, _attachments, options) {
          if (options.signal.aborted) {
            const aborted = new Error("aborted");
            aborted.name = "AbortError";
            throw aborted;
          }
          return await new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          });
        },
      };
    },
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
  });

  agent.setTraceListener((event) => {
    traces.push(event);
    if (event.type === "agent.run.started") {
      runStarted.resolve(event.runId);
    }
  });

  const turn = agent.runTurn("refactor login.ts oauth.ts session.ts");
  const runId = await runStarted.promise;
  assert.equal((await agent.getAgentControlRuntime().cancel(runId)).status, "accepted");
  await turn;

  const graphId = traces.find((event) => event.type === "work.proposed")?.graphId;
  assert.equal(executorCount, 1, "the blocked dependent never dispatches an executor");
  assert.deepEqual(
    traces
      .filter((event) => event.type === "work.status")
      .map((event) => [event.nodeId, event.status]),
    [["task-1", "ready"], ["task-1", "running"], ["task-1", "cancelled"], ["task-2", "blocked"]],
  );
  assert.deepEqual(
    traces
      .filter((event) => event.type === "job.settled")
      .map((event) => [event.jobId, event.status]),
    [[`${graphId}:task-1`, "cancelled"], [`${graphId}:task-2`, "cancelled"]],
  );
  const blockedJob = traces.find(
    (event) => event.type === "job.settled" && event.jobId === `${graphId}:task-2`,
  );
  assert.match(blockedJob.summary, /dependency/i);
  assert.equal(
    traces.some((event) => event.type === "agent.run.started" && event.jobId === `${graphId}:task-2`),
    false,
    "a blocked node never opens an agent run",
  );
});

test("the obsolete executor lifecycle runner is gone from production", () => {
  // Its factory-failure and abort coverage now lives on WorkAgentRunController,
  // the single production path that settles executor lifecycles.
  assert.equal(workAgentLifecycle.runExecutorWithLifecycle, undefined);
  assert.equal(workAgentLifecycle.createExecutorLifecycle, undefined);
  assert.equal(typeof workAgentLifecycle.settleExecutorLifecycle, "function");
  assert.equal(typeof workAgentLifecycle.attributeTraceToAgentRun, "function");
});

test("planner and guardian usage reaches the main ledger unscoped", async () => {
  const traces = [];
  let internalTurns = 0;
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener(listener) {
      this.traceListener = listener;
    },
    async runTurn(prompt) {
      // Planner and guardian both go through the coordinator's internal path;
      // synthesis is a direct turn.
      const isInternal = !prompt.startsWith("Synthesize executor findings");
      if (isInternal) {
        internalTurns += 1;
        // A real provider emits the whole turn bracket; only usage may escape
        // an internal turn.
        this.traceListener?.({
          type: "turn.started",
          level: "low-signal",
          provider: "openai",
          model: "gpt-5.4",
          prompt,
          startedAt: internalTurns,
        });
        this.traceListener?.({
          type: "usage.recorded",
          level: "low-signal",
          eventId: `internal-usage-${internalTurns}`,
          provider: "openai",
          model: "gpt-5.4",
          inputTokens: 100 * internalTurns,
          startedAt: internalTurns,
        });
      }
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
      return {
        clear() {},
        updateRuntimeSettings() {},
        setTraceListener() {},
        async runTurn() {
          return { text: "executor done" };
        },
      };
    },
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
  });

  agent.setTraceListener((event) => traces.push(event));
  await agent.runTurn("refactor login.ts oauth.ts session.ts");

  assert.equal(internalTurns, 2, "planner and guardian both ran on the coordinator");
  const internalUsage = traces.filter(
    (event) => event.type === "usage.recorded" && event.eventId.startsWith("internal-usage-"),
  );
  assert.deepEqual(
    internalUsage.map((event) => event.eventId),
    ["internal-usage-1", "internal-usage-2"],
  );
  assert.deepEqual(
    internalUsage.map((event) => event.agentRunId),
    [undefined, undefined],
    "internal-turn usage lands on the main ledger, never on an agent run",
  );
  assert.equal(
    traces.some((event) => event.type === "turn.started"),
    false,
    "planner and guardian provider brackets stay suppressed",
  );
});

test("clear stops the turn before guardian and synthesis and settles its owned work", async () => {
  const traces = [];
  const prompts = [];
  const runStarted = createDeferred();
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      prompts.push(prompt);
      if (prompt.startsWith("<goal_task_planner>")) {
        return { text: goalPlan };
      }
      return { text: "should not be reached" };
    },
  };

  const agent = new WorkAgent({
    directAgent,
    async createExecutorAgent() {
      return {
        clear() {},
        updateRuntimeSettings() {},
        setTraceListener() {},
        async runTurn(_prompt, _attachments, options) {
          if (options.signal.aborted) {
            const aborted = new Error("aborted");
            aborted.name = "AbortError";
            throw aborted;
          }
          return await new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              const aborted = new Error("aborted");
              aborted.name = "AbortError";
              reject(aborted);
            }, { once: true });
          });
        },
      };
    },
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
  });

  agent.setTraceListener((event) => {
    traces.push(event);
    if (event.type === "agent.run.started") {
      runStarted.resolve(event.runId);
    }
  });

  const turn = agent.runTurn("refactor login.ts oauth.ts session.ts");
  await runStarted.promise;
  agent.clear();
  const result = await turn;

  assert.equal(result.cancelled, true, "a cleared turn reports cancellation, not a synthesis");
  assert.deepEqual(
    prompts.filter((prompt) => !prompt.startsWith("<goal_task_planner>")),
    [],
    "no guardian or synthesis turn runs after clear",
  );
  const graphId = traces.find((event) => event.type === "work.proposed")?.graphId;
  // The queued node settles synchronously inside clear(); the dispatched run
  // settles when its abort unwinds. Their interleaving is not a contract.
  assert.deepEqual(
    traces
      .filter((event) => event.type === "job.settled")
      .map((event) => [event.jobId, event.status])
      .sort(),
    [[`${graphId}:task-1`, "cancelled"], [`${graphId}:task-2`, "cancelled"]],
    "every job the turn queued settles terminally",
  );
  assert.deepEqual(
    traces
      .filter((event) => event.type === "agent.run.settled")
      .map((event) => event.status),
    ["cancelled"],
    "only the dispatched run has a run to settle",
  );
});

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Builds an agent whose coordinator clears itself the moment it reaches the
 * named phase, then behaves like a real provider by rejecting its aborted
 * signal. Deterministic: the clear happens inside the provider call, not on a
 * timer.
 */
function createPhaseClearAgent(clearOn) {
  const prompts = [];
  const traces = [];
  // Records, per cleared phase, whether the signal that phase was handed
  // observed the clear. A phase wired to the caller's raw options instead of
  // the turn epoch records `false`.
  const clearReachedPhaseSignal = [];
  let agent;
  const phaseOf = (prompt) => {
    if (prompt.startsWith("<goal_task_planner>")) return "planning";
    if (prompt.startsWith("Synthesize executor findings")) return "synthesis";
    return "guardian";
  };
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt, attachments = [], options = {}) {
      const phase = attachments.length > 0 ? "attachment" : phaseOf(prompt);
      prompts.push(phase);
      if (phase === clearOn) {
        agent.clear();
        clearReachedPhaseSignal.push([phase, options.signal?.aborted === true]);
        throw abortError();
      }
      if (options.signal?.aborted) {
        throw abortError();
      }
      if (phase === "planning") return { text: goalPlan };
      if (phase === "synthesis") return { text: "final synthesis" };
      return { text: "guardian passed" };
    },
  };
  agent = new WorkAgent({
    directAgent,
    async createExecutorAgent() {
      return {
        clear() {},
        updateRuntimeSettings() {},
        setTraceListener() {},
        async runTurn(_prompt, _attachments, options) {
          if (options.signal.aborted) throw abortError();
          return { text: "executor done" };
        },
      };
    },
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
  });
  agent.setTraceListener((event) => traces.push(event));
  return { agent, prompts, traces, clearReachedPhaseSignal };
}

test("clear during an attachment turn cancels the turn and runs nothing else", async () => {
  const { agent, prompts, clearReachedPhaseSignal } = createPhaseClearAgent("attachment");

  const result = await agent.runTurn("describe this", [{ kind: "image", path: "a.png" }]);

  assert.equal(result.cancelled, true, "the caller sees a typed cancellation, not prose");
  assert.deepEqual(prompts, ["attachment"], "no phase runs after clear");
  assert.deepEqual(clearReachedPhaseSignal, [["attachment", true]]);
});

test("clear during a simple turn cancels the turn", async () => {
  const prompts = [];
  let agent;
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      prompts.push(prompt);
      agent.clear();
      throw abortError();
    },
  };
  agent = new WorkAgent({
    directAgent,
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
  });

  const result = await agent.runTurn("summarize this file");

  assert.equal(result.cancelled, true);
  assert.equal(prompts.length, 1, "the cleared simple turn is the only provider call");
});

test("clear during planning queues no jobs and proposes no graph", async () => {
  const { agent, prompts, traces, clearReachedPhaseSignal } = createPhaseClearAgent("planning");

  const result = await agent.runTurn("refactor login.ts oauth.ts session.ts");

  assert.equal(result.cancelled, true);
  assert.deepEqual(prompts, ["planning"], "planning aborts instead of falling back to a static plan");
  assert.deepEqual(clearReachedPhaseSignal, [["planning", true]]);
  assert.deepEqual(
    traces.filter((event) => event.type === "job.queued" || event.type === "work.proposed"),
    [],
    "a cleared plan never reaches acceptance, so it queues nothing",
  );
});

test("clear during guardian cancels the turn before synthesis", async () => {
  const { agent, prompts, traces, clearReachedPhaseSignal } = createPhaseClearAgent("guardian");

  const result = await agent.runTurn("refactor login.ts oauth.ts session.ts");

  assert.equal(result.cancelled, true);
  assert.deepEqual(prompts, ["planning", "guardian"], "synthesis never runs");
  assert.deepEqual(clearReachedPhaseSignal, [["guardian", true]]);
  const graphId = traces.find((event) => event.type === "work.proposed")?.graphId;
  assert.deepEqual(
    traces
      .filter((event) => event.type === "job.settled")
      .map((event) => [event.jobId, event.status])
      .sort(),
    [[`${graphId}:task-1`, "completed"], [`${graphId}:task-2`, "completed"]],
    "work that finished before the clear keeps its real outcome",
  );
});

test("clear during synthesis cancels the turn", async () => {
  const { agent, prompts, clearReachedPhaseSignal } = createPhaseClearAgent("synthesis");

  const result = await agent.runTurn("refactor login.ts oauth.ts session.ts");

  assert.equal(result.cancelled, true);
  assert.deepEqual(prompts, ["planning", "guardian", "synthesis"]);
  assert.deepEqual(clearReachedPhaseSignal, [["synthesis", true]]);
});

test("a completed turn carries no cancellation marker", async () => {
  const { agent } = createPhaseClearAgent("never");

  const result = await agent.runTurn("refactor login.ts oauth.ts session.ts");

  assert.equal(result.text, "final synthesis");
  assert.equal(result.cancelled, undefined, "success must not look like cancellation");
});

test("a parent abort between plan acceptance and dispatch settles every queued job once", async () => {
  const parent = new AbortController();
  const traces = [];
  const executorCalls = [];
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt, _attachments, options = {}) {
      if (prompt.startsWith("<goal_task_planner>")) {
        return { text: goalPlan };
      }
      if (options.signal?.aborted) {
        throw abortError();
      }
      return { text: "unreachable" };
    },
  };

  const agent = new WorkAgent({
    directAgent,
    async createExecutorAgent() {
      return {
        clear() {},
        updateRuntimeSettings() {},
        setTraceListener() {},
        async runTurn(prompt) {
          executorCalls.push(prompt);
          return { text: "executor done" };
        },
      };
    },
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
  });

  agent.setTraceListener((event) => {
    traces.push(event);
    // Deterministic window: the plan is accepted and its jobs are queued inside
    // onPlan, so aborting here lands strictly between acceptance and dispatch.
    if (event.type === "work.approved") {
      parent.abort();
    }
  });

  await assert.rejects(
    agent.runTurn("refactor login.ts oauth.ts session.ts", [], { signal: parent.signal }),
    (error) => error.name === "AbortError",
    "a parent abort keeps ordinary abort semantics instead of the clear outcome",
  );

  const graphId = traces.find((event) => event.type === "work.proposed")?.graphId;
  assert.deepEqual(executorCalls, [], "no executor dispatches on an aborted turn");
  assert.deepEqual(
    traces.filter((event) => event.type === "job.queued").map((event) => event.jobId),
    [`${graphId}:task-1`, `${graphId}:task-2`],
  );
  assert.deepEqual(
    traces
      .filter((event) => event.type === "job.settled")
      .map((event) => [event.jobId, event.status])
      .sort(),
    [[`${graphId}:task-1`, "cancelled"], [`${graphId}:task-2`, "cancelled"]],
    "every queued job settles exactly once instead of stranding nonterminal",
  );
});

/**
 * Plans two tasks, runs both executors, then parks inside the executable
 * guardian check until the test releases it. `hold` resolves once the check is
 * running, so a clear/abort lands deterministically inside that await.
 */
function createHeldGuardianAgent() {
  const prompts = [];
  const guardianCheckSignals = [];
  const traces = [];
  const checkEntered = createDeferred();
  let agent;
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
    async runTurn(prompt) {
      prompts.push(prompt.startsWith("<goal_task_planner>") ? "planning" : "review");
      if (prompt.startsWith("<goal_task_planner>")) {
        return { text: goalPlan };
      }
      return { text: "guardian passed" };
    },
  };
  agent = new WorkAgent({
    directAgent,
    async createExecutorAgent() {
      return {
        clear() {},
        updateRuntimeSettings() {},
        setTraceListener() {},
        async runTurn() {
          return { text: "executor done" };
        },
      };
    },
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
    async runExecutableGuardianChecks(guardianInput) {
      guardianCheckSignals.push(guardianInput.signal);
      checkEntered.resolve();
      return await new Promise((_resolve, reject) => {
        guardianInput.signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    },
  });
  agent.setTraceListener((event) => traces.push(event));
  return { agent, prompts, traces, guardianCheckSignals, checkEntered };
}

test("clear during an executable guardian check aborts the check and never reviews", async () => {
  const { agent, prompts, traces, guardianCheckSignals, checkEntered } = createHeldGuardianAgent();

  const turn = agent.runTurn("refactor login.ts oauth.ts session.ts");
  await checkEntered.promise;
  assert.equal(guardianCheckSignals.length, 1, "the check receives the turn signal");
  assert.equal(guardianCheckSignals[0].aborted, false);

  agent.clear();
  const result = await turn;
  assert.equal(
    traces.some((event) => event.type === "orchestrator.step" && event.status === "failed"),
    false,
    "a cancelled check is not reported as a guardian failure",
  );

  assert.equal(guardianCheckSignals[0].aborted, true, "the held check is cancelled, not orphaned");
  assert.equal(result.cancelled, true);
  assert.deepEqual(prompts, ["planning"], "the review provider is never dispatched");
});

test("a parent abort during an executable guardian check keeps abort semantics", async () => {
  const parent = new AbortController();
  const { agent, prompts, guardianCheckSignals, checkEntered } = createHeldGuardianAgent();

  const turn = agent.runTurn("refactor login.ts oauth.ts session.ts", [], { signal: parent.signal });
  await checkEntered.promise;
  parent.abort();

  await assert.rejects(
    turn,
    // Cancellation reports the turn signal's own reason, never whatever error
    // happened to race it.
    (error) => error === parent.signal.reason,
    "an aborted check must not be reformatted as an 'unavailable' summary",
  );
  assert.equal(guardianCheckSignals[0].aborted, true);
  assert.deepEqual(prompts, ["planning"], "the review provider is never dispatched");
});

test("a check that ignores its abort still cannot buy a review turn", async () => {
  const prompts = [];
  const checkEntered = createDeferred();
  const releaseCheck = createDeferred();
  let agent;
  agent = new WorkAgent({
    directAgent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt) {
        prompts.push(prompt.startsWith("<goal_task_planner>") ? "planning" : "review");
        return { text: prompt.startsWith("<goal_task_planner>") ? goalPlan : "guardian passed" };
      },
    },
    async createExecutorAgent() {
      return {
        clear() {},
        updateRuntimeSettings() {},
        setTraceListener() {},
        async runTurn() {
          return { text: "executor done" };
        },
      };
    },
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
    async runExecutableGuardianChecks() {
      checkEntered.resolve();
      await releaseCheck.promise;
      // Deliberately signal-deaf: it resolves normally after the clear.
      return { summary: "check PASS (1ms)" };
    },
  });

  const turn = agent.runTurn("refactor login.ts oauth.ts session.ts");
  await checkEntered.promise;
  agent.clear();
  releaseCheck.resolve();
  const result = await turn;

  assert.equal(result.cancelled, true);
  assert.deepEqual(prompts, ["planning"], "the review is refused after the check returns");
});

test("a turn cleared during execution never starts the guardian check at all", async () => {
  const prompts = [];
  let guardianCheckCalls = 0;
  const runStarted = createDeferred();
  let agent;
  agent = new WorkAgent({
    directAgent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt) {
        prompts.push(prompt.startsWith("<goal_task_planner>") ? "planning" : "review");
        return { text: prompt.startsWith("<goal_task_planner>") ? goalPlan : "guardian passed" };
      },
    },
    async createExecutorAgent() {
      return {
        clear() {},
        updateRuntimeSettings() {},
        setTraceListener() {},
        async runTurn(_prompt, _attachments, options) {
          if (options.signal.aborted) throw abortError();
          return await new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
          });
        },
      };
    },
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
    async runExecutableGuardianChecks() {
      guardianCheckCalls += 1;
      return { summary: "check PASS (1ms)" };
    },
  });
  agent.setTraceListener((event) => {
    if (event.type === "agent.run.started") {
      runStarted.resolve();
    }
  });

  const turn = agent.runTurn("refactor login.ts oauth.ts session.ts");
  await runStarted.promise;
  agent.clear();
  const result = await turn;

  assert.equal(result.cancelled, true);
  assert.equal(guardianCheckCalls, 0, "a cleared turn does not spend work discovering changed files");
  assert.deepEqual(prompts, ["planning"]);
});

test("a failing executable check is still reported rather than aborting the turn", async () => {
  const prompts = [];
  const agent = new WorkAgent({
    directAgent: {
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
      async runTurn(prompt) {
        prompts.push(prompt);
        if (prompt.startsWith("<goal_task_planner>")) return { text: goalPlan };
        if (prompt.startsWith("Synthesize executor findings")) return { text: "final synthesis" };
        return { text: "guardian passed" };
      },
    },
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
    async runExecutableGuardianChecks() {
      throw new Error("npm exploded");
    },
  });

  const result = await agent.runTurn("refactor login.ts oauth.ts session.ts");

  assert.equal(result.text, "final synthesis");
  assert.equal(result.cancelled, undefined);
  assert.ok(
    prompts.some((prompt) => /Executable checks unavailable: npm exploded/.test(prompt)),
    "an ordinary check failure is still surfaced to the reviewer",
  );
});

test("every terminal turn path releases its parent abort listener", async () => {
  const parent = new AbortController();
  const listeners = () => getEventListeners(parent.signal, "abort").length;
  const build = (runTurn, guardian) => new WorkAgent({
    directAgent: { clear() {}, updateRuntimeSettings() {}, setTraceListener() {}, runTurn },
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
    ...(guardian ? { runExecutableGuardianChecks: guardian } : {}),
  });

  assert.equal(listeners(), 0, "no listener before the first turn");

  const completed = build(async () => ({ text: "done" }));
  assert.equal((await completed.runTurn("summarize this file", [], { signal: parent.signal })).text, "done");
  assert.equal(listeners(), 0, "completed turn");

  const failed = build(async () => {
    throw new Error("provider exploded");
  });
  await assert.rejects(
    failed.runTurn("summarize this file", [], { signal: parent.signal }),
    /provider exploded/,
  );
  assert.equal(listeners(), 0, "failed turn");

  let cleared;
  cleared = build(async () => {
    cleared.clear();
    throw abortError();
  });
  assert.equal(
    (await cleared.runTurn("summarize this file", [], { signal: parent.signal })).cancelled,
    true,
  );
  assert.equal(listeners(), 0, "clear-cancelled turn");

  const abortedByParent = build(async (_prompt, _attachments, options) => {
    parent.abort();
    if (options.signal.aborted) throw abortError();
    return { text: "unreachable" };
  });
  await assert.rejects(
    abortedByParent.runTurn("summarize this file", [], { signal: parent.signal }),
    (error) => error.name === "AbortError",
  );
  assert.equal(listeners(), 0, "parent-aborted turn");
});

/**
 * Lets every pending microtask and immediate run, so "the second caller has not
 * reached the provider yet" is a real observation rather than a race.
 */
function settleScheduler() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** The finished run an operator continues from; its lineage is what we track. */
const continuationSource = {
  id: "graph-0:task-1:agent",
  displayName: "Earlier run",
  agentType: "executor",
  status: "completed",
  startedAt: 1_000,
  summary: "prior result",
};

test("a live continuation owns the direct agent's listener while a new main turn waits", async () => {
  const traces = [];
  const prompts = [];
  const continuationEntered = createDeferred();
  const releaseContinuation = createDeferred();
  let installed;
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener(listener) {
      installed = listener;
    },
    async runTurn(prompt) {
      prompts.push(prompt);
      if (prompt.startsWith("Continue the earlier agent run")) {
        continuationEntered.resolve();
        await releaseContinuation.promise;
        return { text: "continuation done" };
      }
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
  const emitThroughInstalledListener = (itemId) => {
    installed({
      type: "assistant.delta",
      level: "default",
      provider: "openai",
      model: "gpt-5.4",
      itemId,
      delta: "worker output",
    });
    return traces.find((event) => event.itemId === itemId);
  };

  assert.equal(
    (await agent.getAgentControlRuntime().continueRun(continuationSource)).status,
    "accepted",
  );
  await continuationEntered.promise;
  const started = traces.find((event) => event.type === "agent.run.started");

  // A continuation leaves the shell idle, so the operator's next prompt is one
  // keystroke away — and with no executor factory it lands on the same agent.
  const mainTurn = agent.runTurn("summarize this file");
  await settleScheduler();
  assert.deepEqual(
    prompts.slice(1),
    [],
    "the main turn waits for the agent instead of replacing its listener",
  );

  // Emitted after the main turn already asked for the slot: still the
  // continuation's output, so still the continuation's ownership.
  const workerOutput = emitThroughInstalledListener("continuation-delta");
  assert.equal(workerOutput.agentRunId, started.runId);
  assert.equal(workerOutput.asyncJobId, started.jobId);

  releaseContinuation.resolve();
  assert.equal((await mainTurn).text, "direct:summarize this file");
  assert.deepEqual(prompts.slice(1), ["summarize this file"]);

  const mainOutput = emitThroughInstalledListener("main-delta");
  assert.equal(
    Object.hasOwn(mainOutput, "agentRunId"),
    false,
    "main-turn output never carries an executor's ownership",
  );
});

test("an internal planner turn cannot swap the listener out from under a live continuation", async () => {
  const traces = [];
  const prompts = [];
  const continuationEntered = createDeferred();
  const releaseContinuation = createDeferred();
  let installed;
  const directAgent = {
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener(listener) {
      installed = listener;
    },
    async runTurn(prompt) {
      prompts.push(prompt);
      if (prompt.startsWith("Continue the earlier agent run")) {
        continuationEntered.resolve();
        await releaseContinuation.promise;
        return { text: "continuation done" };
      }
      if (prompt.startsWith("<goal_task_planner>")) {
        // An internal turn spends real tokens; only its usage may escape.
        installed?.({
          type: "usage.recorded",
          level: "low-signal",
          eventId: "planner-usage",
          provider: "openai",
          model: "gpt-5.4",
          inputTokens: 100,
          startedAt: 1,
        });
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
    mode: "default",
    reasoning: supportedReasoning,
    model: "gpt-5.4",
  });
  agent.setTraceListener((event) => traces.push(event));

  assert.equal(
    (await agent.getAgentControlRuntime().continueRun(continuationSource)).status,
    "accepted",
  );
  await continuationEntered.promise;
  const started = traces.find((event) => event.type === "agent.run.started");

  const turn = agent.runTurn("refactor login.ts oauth.ts session.ts");
  await settleScheduler();
  assert.equal(
    prompts.filter((prompt) => prompt.startsWith("<goal_task_planner>")).length,
    0,
    "the planner's usage-only listener must not displace a live executor's",
  );

  installed({
    type: "assistant.delta",
    level: "default",
    provider: "openai",
    model: "gpt-5.4",
    itemId: "continuation-delta",
    delta: "worker output",
  });
  const workerOutput = traces.find((event) => event.itemId === "continuation-delta");
  assert.equal(workerOutput.agentRunId, started.runId);
  assert.equal(workerOutput.asyncJobId, started.jobId);

  releaseContinuation.resolve();
  assert.equal((await turn).text, "final synthesis");
  assert.ok(
    prompts[0].startsWith("Continue the earlier agent run"),
    "the continuation reached the provider first",
  );
  assert.ok(
    prompts[1].startsWith("<goal_task_planner>"),
    "the planner turn ran only once the continuation released the agent",
  );
  const plannerUsage = traces.find((event) => event.eventId === "planner-usage");
  assert.equal(
    Object.hasOwn(plannerUsage, "agentRunId"),
    false,
    "internal-turn usage still lands on the main ledger",
  );
});
