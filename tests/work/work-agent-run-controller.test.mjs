import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import {
  applyTraceEventToAgentConsole,
  WorkAgentRunController,
} from "@unclecode/orchestrator";
import {
  isExecutorScopedTraceEvent,
  REDACTED_CONTROL_PROMPT,
} from "../../packages/orchestrator/src/work-agent-lifecycle.ts";
import { findGoalTaskPlanViolation } from "../../packages/orchestrator/src/turn-orchestrator.ts";

const reasoning = { effort: "medium" };

const STEER_PROMPT = (message) =>
  `Operator guidance:\n${message}\n\nContinue the assigned task. Report only the updated result.`;

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function planTask(id, prompt = `Do ${id}`) {
  return { id, summary: `Summary ${id}`, prompt };
}

/**
 * Lets every pending microtask and immediate run. "The second provider call
 * has not started yet" is only an observation once the scheduler has nothing
 * left to hand out.
 */
function settleScheduler() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** A finished executor run the operator can continue from. */
function priorRun(id = "graph-0:task-9:agent") {
  return {
    id,
    displayName: "Earlier run",
    agentType: "executor",
    status: "completed",
    startedAt: 1_000,
    summary: "prior result",
  };
}

/**
 * Builds a controller wired to a recording trace sink. `traces` doubles as the
 * ordering log: tests push their own markers into it so "did the steer turn run
 * before the run settled" is a single array assertion.
 *
 * `workerBudget` is the concurrent-run ceiling manual continuations are charged
 * against; it defaults high enough that only the tests about the budget itself
 * ever reach it. `directAgent` is overridable for the runs that share one agent
 * — and therefore one trace-listener slot — across siblings.
 */
function createHarness(createExecutor, options = {}) {
  const traces = [];
  const waiters = new Set();
  const emitTrace = (event) => {
    traces.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(event)) {
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  };
  const directAgent = options.directAgent ?? {
    clear() {},
    setTraceListener() {},
    async runTurn(prompt) {
      return { text: `direct:${prompt}` };
    },
  };
  const controller = new WorkAgentRunController({
    directAgent,
    ...(createExecutor ? { createExecutorAgent: async () => await createExecutor(traces) } : {}),
    resolveSettings: () => ({ mode: "default", model: "gpt-5.4", reasoning }),
    resolveWorkerBudget: () => options.workerBudget ?? 4,
    emitTrace,
    isTracing: () => true,
  });
  return {
    controller,
    runtime: controller.getControlRuntime(),
    traces,
    typesOf: () => traces.map((event) => event.type),
    waitForTrace(predicate) {
      const existing = traces.find(predicate);
      return existing
        ? Promise.resolve(existing)
        : new Promise((resolve) => waiters.add({ predicate, resolve }));
    },
  };
}

function startedRunOf(traces) {
  const started = traces.find((event) => event.type === "agent.run.started");
  assert.ok(started, "controller emits agent.run.started");
  return started;
}

test("steer runs operator guidance as a follow-up provider turn before the run settles", async () => {
  const prompts = [];
  const firstTurnEntered = createDeferred();
  const releaseFirstTurn = createDeferred();
  const harness = createHarness((traces) => ({
    clear() {},
    setTraceListener() {},
    async runTurn(prompt) {
      prompts.push(prompt);
      traces.push({ type: "test.turn", index: prompts.length });
      if (prompts.length === 1) {
        firstTurnEntered.resolve();
        await releaseFirstTurn.promise;
        return { text: "first pass" };
      }
      return { text: "steered result" };
    },
  }));

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  const runPromise = harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });
  await firstTurnEntered.promise;

  const receipt = await harness.runtime.steer(
    startedRunOf(harness.traces).runId,
    "  Check cancellation cleanup  ",
  );
  assert.equal(receipt.status, "accepted");
  assert.ok(!receipt.message.includes("Check cancellation cleanup"), "receipt does not echo control text");

  releaseFirstTurn.resolve();
  const outcome = await runPromise;

  assert.deepEqual(outcome, { text: "steered result", status: "completed" });
  assert.deepEqual(prompts, ["Do task-1", STEER_PROMPT("Check cancellation cleanup")]);
  const order = harness.typesOf();
  assert.ok(
    order.lastIndexOf("test.turn") < order.indexOf("agent.run.settled"),
    "the steer turn runs before the terminal settle event",
  );
  assert.equal(order.filter((type) => type === "agent.run.settled").length, 1, "exactly one terminal event");
  assert.equal(order.filter((type) => type === "job.settled").length, 1);
});

test("queued steer messages drain FIFO across successive provider turns", async () => {
  const prompts = [];
  const firstTurnEntered = createDeferred();
  const releaseFirstTurn = createDeferred();
  const harness = createHarness(() => ({
    clear() {},
    setTraceListener() {},
    async runTurn(prompt) {
      prompts.push(prompt);
      if (prompts.length === 1) {
        firstTurnEntered.resolve();
        await releaseFirstTurn.promise;
      }
      return { text: `text-${prompts.length}` };
    },
  }));

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  const runPromise = harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });
  await firstTurnEntered.promise;

  const runId = startedRunOf(harness.traces).runId;
  await harness.runtime.steer(runId, "first steer");
  await harness.runtime.steer(runId, "second steer");
  releaseFirstTurn.resolve();

  const outcome = await runPromise;
  assert.equal(outcome.text, "text-3");
  assert.deepEqual(prompts.slice(1), [STEER_PROMPT("first steer"), STEER_PROMPT("second steer")]);
});

test("steer is not delivered after settlement and rejected when blank", async () => {
  const prompts = [];
  const harness = createHarness(() => ({
    clear() {},
    setTraceListener() {},
    async runTurn(prompt) {
      prompts.push(prompt);
      return { text: "done" };
    },
  }));

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  await harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });

  const runId = startedRunOf(harness.traces).runId;
  assert.equal((await harness.runtime.steer(runId, "too late")).status, "not_delivered");
  assert.equal((await harness.runtime.steer("no-such-run", "nobody home")).status, "not_delivered");
  assert.equal((await harness.runtime.steer(runId, "   ")).status, "rejected");
  assert.deepEqual(prompts, ["Do task-1"], "a settled run never receives another provider turn");
});

test("steer caps an oversized control message before it reaches the provider", async () => {
  const prompts = [];
  const firstTurnEntered = createDeferred();
  const releaseFirstTurn = createDeferred();
  const harness = createHarness(() => ({
    clear() {},
    setTraceListener() {},
    async runTurn(prompt) {
      prompts.push(prompt);
      if (prompts.length === 1) {
        firstTurnEntered.resolve();
        await releaseFirstTurn.promise;
      }
      return { text: "done" };
    },
  }));

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  const runPromise = harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });
  await firstTurnEntered.promise;

  await harness.runtime.steer(startedRunOf(harness.traces).runId, "x".repeat(9_000));
  releaseFirstTurn.resolve();
  await runPromise;

  assert.equal(prompts.length, 2);
  assert.equal(prompts[1], STEER_PROMPT("x".repeat(4_000)));
});

test("cancel aborts only the targeted run and leaves a sibling running", async () => {
  const entered = { "task-1": createDeferred(), "task-2": createDeferred() };
  const release = { "task-1": createDeferred(), "task-2": createDeferred() };
  const seenSignals = new Map();
  const harness = createHarness(() => ({
    clear() {},
    setTraceListener() {},
    async runTurn(prompt, _attachments, options) {
      // Real providers reject a pre-aborted signal instead of hanging on a
      // listener that will never fire.
      if (options.signal.aborted) throw abortError();
      const id = prompt.replace("Do ", "");
      seenSignals.set(id, options.signal);
      entered[id].resolve();
      return await new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
        void release[id].promise.then(() => resolve({ text: `done:${id}` }));
      });
    },
  }));

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1"), planTask("task-2")], 1_000);
  const first = harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });
  const second = harness.controller.runTask({ graphId: "graph-1", task: planTask("task-2") });
  await Promise.all([entered["task-1"].promise, entered["task-2"].promise]);

  const runIds = harness.traces
    .filter((event) => event.type === "agent.run.started")
    .map((event) => event.runId);
  assert.equal(runIds.length, 2);

  const receipt = await harness.runtime.cancel(runIds[0]);
  assert.equal(receipt.status, "accepted");
  assert.equal((await first).status, "cancelled");
  assert.equal(seenSignals.get("task-2").aborted, false, "the sibling signal stays live");

  release["task-2"].resolve();
  assert.deepEqual(await second, { text: "done:task-2", status: "completed" });

  assert.deepEqual(
    harness.traces
      .filter((event) => event.type === "agent.run.settled")
      .map((event) => [event.runId, event.status]),
    [[runIds[0], "cancelled"], [runIds[1], "completed"]],
  );
  assert.equal((await harness.runtime.cancel(runIds[0])).status, "not_delivered");
});

test("aborting the parent turn cancels every child run and unhooks its listeners", async () => {
  const parent = new AbortController();
  const entered = [createDeferred(), createDeferred()];
  let index = 0;
  const harness = createHarness(() => {
    const slot = index++;
    return {
      clear() {},
      setTraceListener() {},
      async runTurn(_prompt, _attachments, options) {
        entered[slot].resolve();
        if (options.signal.aborted) throw abortError();
        return await new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      },
    };
  });

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1"), planTask("task-2")], 1_000);
  const runs = Promise.all([
    harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1"), signal: parent.signal }),
    harness.controller.runTask({ graphId: "graph-1", task: planTask("task-2"), signal: parent.signal }),
  ]);
  await Promise.all(entered.map((deferred) => deferred.promise));
  assert.equal(getEventListeners(parent.signal, "abort").length, 2, "each run links to the parent signal");

  parent.abort();
  assert.deepEqual((await runs).map((outcome) => outcome.status), ["cancelled", "cancelled"]);
  assert.deepEqual(
    harness.traces.filter((event) => event.type === "agent.run.settled").map((event) => event.status),
    ["cancelled", "cancelled"],
  );
  assert.equal(getEventListeners(parent.signal, "abort").length, 0, "parent abort listeners are released");
});

test("a cancel landing while the executor is being built spends no provider turn", async () => {
  const prompts = [];
  const factoryEntered = createDeferred();
  const releaseFactory = createDeferred();
  const harness = createHarness(async () => {
    factoryEntered.resolve();
    await releaseFactory.promise;
    return {
      clear() {},
      setTraceListener() {},
      async runTurn(prompt) {
        prompts.push(prompt);
        return { text: "should not run" };
      },
    };
  });

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  const runPromise = harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });
  await factoryEntered.promise;

  assert.equal((await harness.runtime.cancel(startedRunOf(harness.traces).runId)).status, "accepted");
  releaseFactory.resolve();

  assert.deepEqual(await runPromise, { text: "Executor cancelled.", status: "cancelled" });
  assert.deepEqual(prompts, [], "the provider is never called for a run cancelled during startup");
  assert.deepEqual(
    harness.traces.filter((event) => event.type === "agent.run.settled").map((event) => event.status),
    ["cancelled"],
  );
});

test("a pre-aborted dispatch settles its queued job once and opens no run", async () => {
  const parent = new AbortController();
  parent.abort();
  const prompts = [];
  const harness = createHarness(() => ({
    clear() {},
    setTraceListener() {},
    async runTurn(prompt) {
      prompts.push(prompt);
      return { text: "should not run" };
    },
  }));

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  const outcome = await harness.controller.runTask({
    graphId: "graph-1",
    task: planTask("task-1"),
    signal: parent.signal,
  });

  assert.equal(outcome.status, "cancelled");
  assert.deepEqual(prompts, [], "an aborted turn spends no provider call");
  assert.deepEqual(
    harness.traces
      .filter((event) => event.type === "job.settled")
      .map((event) => [event.jobId, event.status]),
    [["graph-1:task-1", "cancelled"]],
    "the queued job settles exactly once instead of staying queued forever",
  );
  assert.equal(
    harness.traces.some((event) => event.type.startsWith("agent.run.")),
    false,
    "a task that never dispatched has no agent run",
  );
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});

test("a dispatch after clear settles nothing twice", async () => {
  const harness = createHarness(() => ({
    clear() {},
    setTraceListener() {},
    async runTurn() {
      return { text: "should not run" };
    },
  }));

  const epoch = harness.controller.beginTurn();
  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  harness.controller.clear("shell cleared");

  const outcome = await harness.controller.runTask({
    graphId: "graph-1",
    task: planTask("task-1"),
    signal: epoch.signal,
  });

  assert.equal(outcome.status, "cancelled");
  assert.equal(
    harness.traces.filter((event) => event.type === "job.settled").length,
    1,
    "clear already settled the job; dispatch must not settle it again",
  );
});

test("continueRun dispatches a new linked run and job carrying the source lineage", async () => {
  const prompts = [];
  const harness = createHarness(() => ({
    clear() {},
    setTraceListener() {},
    async runTurn(prompt) {
      prompts.push(prompt);
      return { text: "continued result" };
    },
  }));

  const source = {
    id: "graph-1:task-1:agent",
    displayName: "Implement auth refactor",
    agentType: "executor",
    status: "completed",
    startedAt: 1_000,
    completedAt: 2_000,
    summary: "shipped the first pass",
  };

  const receipt = await harness.runtime.continueRun(source, "Also cover the refresh path");
  assert.equal(receipt.status, "accepted");

  const settled = await harness.waitForTrace((event) => event.type === "agent.run.settled");
  const started = startedRunOf(harness.traces);
  const queued = harness.traces.find((event) => event.type === "job.queued");

  assert.equal(started.continuationOf, source.id);
  assert.equal(started.parentRunId, source.id);
  assert.notEqual(started.runId, source.id);
  assert.equal(queued.jobId, started.jobId, "the continuation queues its own linked job");
  assert.equal(queued.agentRunId, started.runId);
  assert.deepEqual(
    harness.typesOf().slice(0, 2),
    ["job.queued", "agent.run.started"],
    "the linked job is queued immediately before dispatch",
  );
  assert.equal(settled.status, "completed");
  assert.equal(settled.runId, started.runId);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Also cover the refresh path/);
  assert.match(prompts[0], /shipped the first pass/);
});

test("clear aborts every active continuation and reports later control as not delivered", async () => {
  const entered = [createDeferred(), createDeferred()];
  let index = 0;
  const harness = createHarness(() => {
    const slot = index++;
    return {
      clear() {},
      setTraceListener() {},
      async runTurn(_prompt, _attachments, options) {
        entered[slot].resolve();
        if (options.signal.aborted) throw abortError();
        return await new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      },
    };
  });

  const source = (id) => ({
    id,
    displayName: `Run ${id}`,
    agentType: "executor",
    status: "completed",
    startedAt: 1_000,
  });
  await harness.runtime.continueRun(source("run-a"));
  await harness.runtime.continueRun(source("run-b"));
  await Promise.all(entered.map((deferred) => deferred.promise));

  const runIds = harness.traces
    .filter((event) => event.type === "agent.run.started")
    .map((event) => event.runId);
  harness.controller.clear("shell cleared");

  const settled = [];
  for (const runId of runIds) {
    settled.push(await harness.waitForTrace(
      (event) => event.type === "agent.run.settled" && event.runId === runId,
    ));
  }
  assert.deepEqual(settled.map((event) => event.status), ["cancelled", "cancelled"]);
  assert.equal((await harness.runtime.steer(runIds[0], "still there?")).status, "not_delivered");
});

test("a failing continuation settles as failed without rejecting the operator receipt", async () => {
  const harness = createHarness(() => ({
    clear() {},
    setTraceListener() {},
    async runTurn() {
      throw new Error("provider exploded");
    },
  }));

  const receipt = await harness.runtime.continueRun({
    id: "run-a",
    displayName: "Run a",
    agentType: "executor",
    status: "completed",
    startedAt: 1_000,
  });
  assert.equal(receipt.status, "accepted");

  const settled = await harness.waitForTrace((event) => event.type === "agent.run.settled");
  assert.equal(settled.status, "failed");
  assert.equal(
    harness.typesOf().filter((type) => type === "agent.run.settled").length,
    1,
    "a failed continuation still emits exactly one terminal event",
  );
});

test("lifecycle events never carry the raw control message", async () => {
  const secret = "ZZ-OPERATOR-SECRET-ZZ";
  const firstTurnEntered = createDeferred();
  const releaseFirstTurn = createDeferred();
  let turns = 0;
  const harness = createHarness(() => ({
    clear() {},
    setTraceListener() {},
    async runTurn() {
      turns += 1;
      if (turns === 1) {
        firstTurnEntered.resolve();
        await releaseFirstTurn.promise;
      }
      return { text: "neutral executor output" };
    },
  }));

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  const runPromise = harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });
  await firstTurnEntered.promise;
  await harness.runtime.steer(startedRunOf(harness.traces).runId, secret);
  releaseFirstTurn.resolve();
  await runPromise;

  assert.equal(turns, 2, "the steer message did reach the provider");
  assert.ok(
    !JSON.stringify(harness.traces).includes(secret),
    "no emitted lifecycle event carries the operator control text",
  );
});

test("every provider turn in a steered run contributes exactly one scoped usage event", async () => {
  const firstTurnEntered = createDeferred();
  const releaseFirstTurn = createDeferred();
  let turns = 0;
  const harness = createHarness(() => {
    let traceListener;
    return {
      clear() {},
      setTraceListener(listener) {
        traceListener = listener;
      },
      async runTurn() {
        turns += 1;
        const turn = turns;
        if (turn === 1) {
          firstTurnEntered.resolve();
          await releaseFirstTurn.promise;
        }
        // Mirrors CodingAgent: the provider layer owns the measurement and its
        // dedupe key; the controller only routes it to the owning run.
        traceListener?.({
          type: "usage.recorded",
          level: "low-signal",
          eventId: `usage:openai:${turn}`,
          provider: "openai",
          model: "gpt-5.4",
          inputTokens: 10 * turn,
          outputTokens: turn,
          startedAt: turn,
        });
        return { text: `turn-${turn}` };
      },
    };
  });

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  const runPromise = harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });
  await firstTurnEntered.promise;
  await harness.runtime.steer(startedRunOf(harness.traces).runId, "keep going");
  releaseFirstTurn.resolve();
  await runPromise;

  const runId = startedRunOf(harness.traces).runId;
  const usage = harness.traces.filter((event) => event.type === "usage.recorded");
  assert.equal(turns, 2, "the steer added a second provider turn");
  assert.equal(usage.length, 2, "one usage event per provider turn, never duplicated");
  assert.deepEqual(usage.map((event) => event.eventId), ["usage:openai:1", "usage:openai:2"]);
  assert.deepEqual(usage.map((event) => event.agentRunId), [runId, runId]);
  assert.deepEqual(usage.map((event) => [event.inputTokens, event.outputTokens]), [[10, 1], [20, 2]]);
});

test("executor-emitted usage is scoped once instead of duplicated by the controller", async () => {
  const harness = createHarness(() => {
    let traceListener;
    return {
      clear() {},
      setTraceListener(listener) {
        traceListener = listener;
      },
      async runTurn() {
        traceListener?.({
          type: "usage.recorded",
          level: "low-signal",
          eventId: "provider-usage-1",
          provider: "openai",
          model: "gpt-5.4",
          inputTokens: 7,
          startedAt: 1,
        });
        traceListener?.({
          type: "tool.started",
          level: "default",
          toolCallId: "tool-1",
          toolName: "read",
          intent: "Inspect",
          startedAt: 1,
        });
        return { text: "done", usage: { inputTokens: 7, outputTokens: 2 } };
      },
    };
  });

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  await harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });

  const started = startedRunOf(harness.traces);
  const usage = harness.traces.filter((event) => event.type === "usage.recorded");
  assert.deepEqual(usage.map((event) => event.eventId), ["provider-usage-1"]);
  assert.equal(usage[0].agentRunId, started.runId);
  const tool = harness.traces.find((event) => event.type === "tool.started");
  assert.equal(tool.agentRunId, started.runId);
  assert.equal(tool.asyncJobId, started.jobId, "executor tool traces are scoped to the owning job");
});

test("planned jobs queue exactly once and runTask refuses an unplanned task", async () => {
  const harness = createHarness(() => ({
    clear() {},
    setTraceListener() {},
    async runTurn() {
      return { text: "done" };
    },
  }));

  const tasks = [planTask("task-1"), planTask("task-2")];
  harness.controller.queuePlannedJobs("graph-1", tasks, 1_000);
  harness.controller.queuePlannedJobs("graph-1", tasks, 2_000);

  const queued = harness.traces.filter((event) => event.type === "job.queued");
  assert.deepEqual(queued.map((event) => event.jobId), ["graph-1:task-1", "graph-1:task-2"]);
  assert.deepEqual(queued.map((event) => event.queuedAt), [1_000, 1_000]);
  assert.deepEqual(queued.map((event) => event.eventId), [
    "graph-1:task-1:queued",
    "graph-1:task-2:queued",
  ]);

  await assert.rejects(
    harness.controller.runTask({ graphId: "graph-1", task: planTask("task-9") }),
    /planned job/i,
  );
});

test("attempt-specific job keys keep the stable planned task identity", async () => {
  const prompts = [];
  const harness = createHarness(() => ({
    clear() {},
    setTraceListener() {},
    async runTurn(prompt) {
      prompts.push(prompt);
      return { text: "retry complete" };
    },
  }));
  const task = planTask("task-1");
  const jobKey = "task-1:attempt-1:iteration-1";

  harness.controller.queuePlannedJobs("graph-1", [task], 1_000, {
    resolveJobKey: () => jobKey,
  });
  const outcome = await harness.controller.runTask({
    graphId: "graph-1",
    jobKey,
    task,
  });

  assert.deepEqual(outcome, { text: "retry complete", status: "completed" });
  assert.deepEqual(prompts, ["Do task-1"], "the executor still receives the stable task prompt");
  assert.equal(
    harness.traces.find((event) => event.type === "job.queued")?.jobId,
    `graph-1:${jobKey}`,
  );
  assert.equal(
    harness.traces.find((event) => event.type === "agent.run.started")?.jobId,
    `graph-1:${jobKey}`,
  );
});

test("a blocked dependency settles its planned job as cancelled without an agent run", () => {
  const harness = createHarness(() => ({
    clear() {},
    setTraceListener() {},
    async runTurn() {
      return { text: "done" };
    },
  }));

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  harness.controller.settleBlockedJob("graph-1", "task-1");

  const settled = harness.traces.filter((event) => event.type === "job.settled");
  assert.equal(settled.length, 1);
  assert.deepEqual(
    { jobId: settled[0].jobId, status: settled[0].status, summary: settled[0].summary },
    { jobId: "graph-1:task-1", status: "cancelled", summary: "Blocked because a dependency failed." },
  );
  assert.equal(Object.hasOwn(settled[0], "startedAt"), false, "a blocked job never started");
  assert.equal(harness.traces.some((event) => event.type === "agent.run.settled"), false);
});

/** Mirrors CodingAgent: the provider echoes the prompt it was handed. */
function createPromptEchoingExecutor(prompts) {
  let traceListener;
  return {
    clear() {},
    setTraceListener(listener) {
      traceListener = listener;
    },
    async runTurn(prompt) {
      prompts.push(prompt);
      traceListener?.({
        type: "turn.started",
        level: "low-signal",
        provider: "openai",
        model: "gpt-5.4",
        prompt,
        startedAt: 1,
      });
      return { text: "neutral executor output" };
    },
  };
}

test("a steered provider turn never leaks its operator prompt into the trace stream", async () => {
  const secret = "ZZ-STEER-PROMPT-SECRET-ZZ";
  const prompts = [];
  const firstTurnEntered = createDeferred();
  const releaseFirstTurn = createDeferred();
  const harness = createHarness(() => {
    const executor = createPromptEchoingExecutor(prompts);
    const runTurn = executor.runTurn.bind(executor);
    return {
      ...executor,
      async runTurn(prompt) {
        if (prompts.length === 0) {
          const pending = runTurn(prompt);
          firstTurnEntered.resolve();
          await releaseFirstTurn.promise;
          return await pending;
        }
        return await runTurn(prompt);
      },
    };
  });

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  const runPromise = harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });
  await firstTurnEntered.promise;
  await harness.runtime.steer(startedRunOf(harness.traces).runId, secret);
  releaseFirstTurn.resolve();
  await runPromise;

  assert.equal(prompts.length, 2, "the steer message did reach the provider");
  assert.ok(prompts[1].includes(secret), "the provider turn really carried the control text");
  const started = harness.traces.filter((event) => event.type === "turn.started");
  assert.equal(started.length, 2);
  assert.equal(started[0].prompt, "Do task-1", "a plan prompt is not operator control text");
  assert.equal(started[1].prompt, REDACTED_CONTROL_PROMPT);
  assert.ok(
    !JSON.stringify(harness.traces).includes(secret),
    "no emitted trace carries the operator control text",
  );
});

test("a continuation turn never leaks its operator prompt into the trace stream", async () => {
  const secret = "ZZ-CONTINUE-PROMPT-SECRET-ZZ";
  const prompts = [];
  const harness = createHarness(() => createPromptEchoingExecutor(prompts));

  await harness.runtime.continueRun(
    {
      id: "run-a",
      displayName: "Run a",
      agentType: "executor",
      status: "completed",
      startedAt: 1_000,
      summary: "prior result",
    },
    secret,
  );
  await harness.waitForTrace((event) => event.type === "agent.run.settled");

  assert.ok(prompts[0].includes(secret), "the provider turn really carried the control text");
  assert.deepEqual(
    harness.traces.filter((event) => event.type === "turn.started").map((event) => event.prompt),
    [REDACTED_CONTROL_PROMPT],
  );
  assert.ok(!JSON.stringify(harness.traces).includes(secret));
});

test("clear terminally settles every still-queued planned job", () => {
  const harness = createHarness(() => ({
    clear() {},
    setTraceListener() {},
    async runTurn() {
      return { text: "done" };
    },
  }));

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1"), planTask("task-2")], 1_000);
  harness.controller.clear("shell cleared");

  assert.deepEqual(
    harness.traces
      .filter((event) => event.type === "job.settled")
      .map((event) => [event.jobId, event.status]),
    [["graph-1:task-1", "cancelled"], ["graph-1:task-2", "cancelled"]],
  );
  assert.equal(
    harness.traces.some((event) => event.type === "agent.run.settled"),
    false,
    "a job that never dispatched has no run to settle",
  );
});

test("a turn epoch tells clear apart from an ordinary parent abort", () => {
  const parent = new AbortController();
  const harness = createHarness();

  const cleared = harness.controller.beginTurn(parent.signal);
  assert.equal(cleared.signal.aborted, false);
  assert.equal(cleared.isCleared(), false);
  harness.controller.clear("shell cleared");
  assert.equal(cleared.signal.aborted, true, "clear cancels the enclosing turn, not just its runs");
  assert.equal(cleared.isCleared(), true);

  const aborted = harness.controller.beginTurn(parent.signal);
  assert.equal(aborted.signal.aborted, false, "a later turn starts clean");
  assert.equal(
    getEventListeners(parent.signal, "abort").length,
    1,
    "each new turn replaces the previous parent link instead of stacking one",
  );
  parent.abort();
  assert.equal(aborted.signal.aborted, true, "the parent turn signal still cancels the work turn");
  assert.equal(
    aborted.isCleared(),
    false,
    "a parent abort is not a clear; the caller must still see abort semantics",
  );
  assert.equal(cleared.isCleared(), true, "an earlier epoch keeps its own verdict");
});

test("continuation identities stay distinct across controller reconstruction", async () => {
  const source = {
    id: "graph-1:task-1:agent",
    displayName: "Implement auth refactor",
    agentType: "executor",
    status: "completed",
    startedAt: 1_000,
    summary: "prior result",
  };
  const streams = [];
  for (let instance = 0; instance < 2; instance += 1) {
    const harness = createHarness(() => ({
      clear() {},
      setTraceListener() {},
      async runTurn() {
        return { text: `continued-${instance}` };
      },
    }));
    await harness.runtime.continueRun(source, "keep going");
    await harness.waitForTrace((event) => event.type === "agent.run.settled");
    streams.push(harness.traces);
  }

  const runIds = streams.map((traces) =>
    traces.find((event) => event.type === "agent.run.started").runId);
  assert.notEqual(runIds[0], runIds[1], "a rebuilt controller must not remint a run id");

  // Replay both streams into one persisted projection: reducer dedupe keys on
  // run/job/event id, so a reused identity would silently collapse the second
  // continuation into the first.
  let snapshot = { profileId: "build", activity: [], agents: [], jobs: [] };
  for (const traces of streams) {
    for (const event of traces) {
      snapshot = applyTraceEventToAgentConsole(snapshot, event);
    }
  }
  assert.equal(snapshot.agents.length, 2, "both continuations survive one replayed snapshot");
  assert.equal(snapshot.jobs.length, 2);
  assert.deepEqual(
    snapshot.agents.map((agent) => [agent.continuationOf, agent.parentRunId]),
    [[source.id, source.id], [source.id, source.id]],
  );
});

test("queuePlannedJobs refuses an invalid plan before emitting any job", () => {
  const invalidPlans = [
    [/duplicate/i, [planTask("task-1"), planTask("task-1")]],
    [/dependency/i, [planTask("task-1"), { ...planTask("task-2"), dependsOn: ["ghost"] }]],
    [/dependency/i, [{ ...planTask("task-1"), dependsOn: ["task-2"] }, planTask("task-2")]],
  ];

  for (const [expected, tasks] of invalidPlans) {
    const harness = createHarness();
    assert.throws(() => harness.controller.queuePlannedJobs("graph-1", tasks, 1_000), expected);
    assert.deepEqual(
      harness.traces.filter((event) => event.type === "job.queued"),
      [],
      "an invalid plan leaves no orphan job records",
    );
  }
});

test("findGoalTaskPlanViolation is the single plan rule shared with the scheduler", () => {
  assert.equal(
    findGoalTaskPlanViolation([planTask("task-1"), { ...planTask("task-2"), dependsOn: ["task-1"] }]),
    undefined,
  );
  assert.match(findGoalTaskPlanViolation([planTask("a"), planTask("a")]) ?? "", /duplicate/i);
  assert.match(
    findGoalTaskPlanViolation([planTask("a"), { ...planTask("b"), dependsOn: ["ghost"] }]) ?? "",
    /dependency/i,
  );
});

test("an executor factory failure settles the run and job as failed", async () => {
  const harness = createHarness(() => {
    throw new Error("factory failed");
  });

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  await assert.rejects(
    harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") }),
    /factory failed/,
  );

  assert.deepEqual(
    harness.traces
      .filter((event) => event.type === "agent.run.settled" || event.type === "job.settled")
      .map((event) => event.status),
    ["failed", "failed"],
  );
});

test("an executor that aborts itself settles the run and job as cancelled", async () => {
  const harness = createHarness(() => ({
    clear() {},
    setTraceListener() {},
    async runTurn() {
      throw abortError();
    },
  }));

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  const outcome = await harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });

  assert.equal(outcome.status, "cancelled");
  assert.deepEqual(
    harness.traces
      .filter((event) => event.type === "agent.run.settled" || event.type === "job.settled")
      .map((event) => event.status),
    ["cancelled", "cancelled"],
  );
});

test("releasing a turn epoch unlinks its parent listener immediately", () => {
  const parent = new AbortController();
  const harness = createHarness();

  const epoch = harness.controller.beginTurn(parent.signal);
  assert.equal(getEventListeners(parent.signal, "abort").length, 1);

  epoch.release();
  assert.equal(
    getEventListeners(parent.signal, "abort").length,
    0,
    "a settled turn must not keep a listener on a long-lived parent signal",
  );

  epoch.release();
  assert.equal(getEventListeners(parent.signal, "abort").length, 0, "release is idempotent");

  harness.controller.clear("shell cleared");
  assert.equal(epoch.signal.aborted, false, "clear does not reach an already-settled turn");
  assert.equal(epoch.isCleared(), false);
});

test("releasing an old epoch leaves the current turn linked", () => {
  const parent = new AbortController();
  const harness = createHarness();

  const first = harness.controller.beginTurn(parent.signal);
  const second = harness.controller.beginTurn(parent.signal);
  first.release();

  assert.equal(
    getEventListeners(parent.signal, "abort").length,
    1,
    "the live turn keeps its own link",
  );
  harness.controller.clear("shell cleared");
  assert.equal(second.isCleared(), true, "clear still reaches the current turn");
});

test("every terminal run path releases its planned-job record", async () => {
  const cases = [
    ["completed", async () => ({ text: "done" })],
    ["failed", async () => {
      throw new Error("provider exploded");
    }],
    ["cancelled", async () => {
      throw abortError();
    }],
  ];

  for (const [label, runTurn] of cases) {
    const harness = createHarness(() => ({ clear() {}, setTraceListener() {}, runTurn }));
    harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
    const dispatch = harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });
    if (label === "failed") {
      await assert.rejects(dispatch, /provider exploded/);
    } else {
      await dispatch;
    }

    // White-box on purpose: the defect is unbounded registry growth, and an
    // empty registry is the only direct evidence of the fix.
    assert.equal(
      harness.controller.plannedJobs.size,
      0,
      `a ${label} run must not retain its planned-job record`,
    );
    const settledBefore = harness.traces.filter((event) => event.type === "job.settled").length;
    assert.equal(settledBefore, 1, `${label}: settled exactly once`);
    harness.controller.clear("shell cleared");
    assert.equal(
      harness.traces.filter((event) => event.type === "job.settled").length,
      settledBefore,
      `${label}: clear must not resettle a finished job`,
    );
  }
});

test("a factory error releases the planned-job record too", async () => {
  const harness = createHarness(() => {
    throw new Error("factory failed");
  });

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  await assert.rejects(
    harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") }),
    /factory failed/,
  );

  assert.equal(harness.controller.plannedJobs.size, 0);
  harness.controller.clear("shell cleared");
  assert.equal(harness.traces.filter((event) => event.type === "job.settled").length, 1);
});

test("clear still settles the jobs that never dispatched", () => {
  const harness = createHarness(() => ({
    clear() {},
    setTraceListener() {},
    async runTurn() {
      return { text: "done" };
    },
  }));

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1"), planTask("task-2")], 1_000);
  assert.equal(harness.controller.plannedJobs.size, 2);
  harness.controller.clear("shell cleared");

  assert.deepEqual(
    harness.traces.filter((event) => event.type === "job.settled").map((event) => event.jobId),
    ["graph-1:task-1", "graph-1:task-2"],
  );
  assert.equal(harness.controller.plannedJobs.size, 0);
});

/** Every executor-originated family a real provider turn can emit, in order. */
const EXECUTOR_TRACE_FAMILIES = [
  "turn.started",
  "provider.calling",
  "reasoning.delta",
  "assistant.delta",
  "tool.started",
  "tool.completed",
  "usage.recorded",
  "turn.completed",
];

function emitExecutorTraceFamilies(traceListener, turn) {
  traceListener?.({
    type: "turn.started",
    level: "low-signal",
    provider: "openai",
    model: "gpt-5.4",
    prompt: `prompt-${turn}`,
    startedAt: turn,
  });
  traceListener?.({
    type: "provider.calling",
    level: "default",
    provider: "openai",
    model: "gpt-5.4",
    startedAt: turn,
  });
  traceListener?.({
    type: "reasoning.delta",
    level: "default",
    provider: "openai",
    model: "gpt-5.4",
    kind: "summary",
    itemId: `reasoning-${turn}`,
    delta: "thinking",
  });
  traceListener?.({
    type: "assistant.delta",
    level: "default",
    provider: "openai",
    model: "gpt-5.4",
    itemId: `assistant-${turn}`,
    delta: "partial answer",
  });
  traceListener?.({
    type: "tool.started",
    level: "default",
    provider: "openai",
    toolName: "read",
    toolCallId: `tool-${turn}`,
    input: { path: "a.ts" },
    startedAt: turn,
  });
  traceListener?.({
    type: "tool.completed",
    level: "default",
    provider: "openai",
    toolName: "read",
    toolCallId: `tool-${turn}`,
    isError: false,
    output: "ok",
    startedAt: turn,
    completedAt: turn + 1,
    durationMs: 1,
  });
  traceListener?.({
    type: "usage.recorded",
    level: "low-signal",
    eventId: `usage-${turn}`,
    provider: "openai",
    model: "gpt-5.4",
    inputTokens: 10,
    outputTokens: 2,
    startedAt: turn,
  });
  traceListener?.({
    type: "turn.completed",
    level: "low-signal",
    provider: "openai",
    model: "gpt-5.4",
    text: "answer",
    startedAt: turn,
    completedAt: turn + 1,
    durationMs: 1,
  });
}

function createFamilyEmittingExecutor() {
  let traceListener;
  return {
    clear() {},
    setTraceListener(listener) {
      traceListener = listener;
    },
    async runTurn() {
      emitExecutorTraceFamilies(traceListener, 1);
      return { text: "done" };
    },
  };
}

test("every executor-originated trace family names the run and job that own it", async () => {
  const harness = createHarness(() => createFamilyEmittingExecutor());

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  await harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });

  const started = startedRunOf(harness.traces);
  const executorTraces = harness.traces.filter(
    (event) => EXECUTOR_TRACE_FAMILIES.includes(event.type),
  );
  assert.deepEqual(
    executorTraces.map((event) => event.type),
    EXECUTOR_TRACE_FAMILIES,
    "the executor really emitted every family",
  );
  for (const event of executorTraces) {
    assert.equal(event.agentRunId, started.runId, `${event.type} names its owning run`);
    assert.equal(event.asyncJobId, started.jobId, `${event.type} names its owning job`);
    assert.equal(
      isExecutorScopedTraceEvent(event),
      true,
      `${event.type} must be recognisable as executor output, not main-shell work`,
    );
  }

  // The lifecycle spine owns itself: the console keys agents and jobs on these
  // ids, so the boundary must leave them exactly as the controller minted them.
  assert.deepEqual(
    harness.traces
      .filter((event) => event.type === "agent.run.started" || event.type === "agent.run.settled")
      .map((event) => [event.runId, event.jobId]),
    [
      [started.runId, "graph-1:task-1"],
      [started.runId, "graph-1:task-1"],
    ],
  );
  assert.deepEqual(
    harness.traces
      .filter((event) => event.type === "job.queued" || event.type === "job.settled")
      .map((event) => [event.jobId, event.agentRunId]),
    [
      ["graph-1:task-1", undefined],
      ["graph-1:task-1", started.runId],
    ],
  );
  for (const event of harness.traces.filter(
    (candidate) => candidate.type.startsWith("job.") || candidate.type.startsWith("agent.run."),
  )) {
    assert.equal(Object.hasOwn(event, "asyncJobId"), false, `${event.type} scopes itself via jobId`);
    assert.equal(
      isExecutorScopedTraceEvent(event),
      false,
      `${event.type} is console spine the shell still reduces normally`,
    );
  }
});

test("a steered continuation scopes every family of both of its provider turns", async () => {
  const firstTurnEntered = createDeferred();
  const releaseFirstTurn = createDeferred();
  let turns = 0;
  const harness = createHarness(() => {
    let traceListener;
    return {
      clear() {},
      setTraceListener(listener) {
        traceListener = listener;
      },
      async runTurn() {
        turns += 1;
        const turn = turns;
        if (turn === 1) {
          firstTurnEntered.resolve();
          await releaseFirstTurn.promise;
        }
        emitExecutorTraceFamilies(traceListener, turn);
        return { text: `turn-${turn}` };
      },
    };
  });

  const receipt = await harness.runtime.continueRun({
    id: "graph-1:task-1:agent",
    displayName: "Implement auth refactor",
    agentType: "executor",
    status: "completed",
    startedAt: 1_000,
    summary: "prior result",
  });
  assert.equal(receipt.status, "accepted");
  await firstTurnEntered.promise;
  const started = startedRunOf(harness.traces);
  await harness.runtime.steer(started.runId, "keep going");
  releaseFirstTurn.resolve();
  await harness.waitForTrace((event) => event.type === "agent.run.settled");

  assert.equal(turns, 2, "the steer added a second provider turn");
  const executorTraces = harness.traces.filter(
    (event) => EXECUTOR_TRACE_FAMILIES.includes(event.type),
  );
  assert.equal(executorTraces.length, EXECUTOR_TRACE_FAMILIES.length * 2);
  for (const event of executorTraces) {
    assert.equal(event.agentRunId, started.runId, `${event.type} stays on the continuation run`);
    assert.equal(event.asyncJobId, started.jobId, `${event.type} stays on the continuation job`);
  }
  // Redaction still applies once ownership is stamped: the two must compose,
  // not shadow each other.
  assert.deepEqual(
    harness.traces.filter((event) => event.type === "turn.started").map((event) => event.prompt),
    [REDACTED_CONTROL_PROMPT, REDACTED_CONTROL_PROMPT],
  );
});

test("records an executor already owns cross the boundary unchanged", async () => {
  const harness = createHarness(() => {
    let traceListener;
    return {
      clear() {},
      setTraceListener(listener) {
        traceListener = listener;
      },
      async runTurn() {
        // A sub-agent the executor dispatched itself. Relabelling these with
        // the parent's ids makes the console reject the nested run as owned by
        // somebody else.
        traceListener?.({
          type: "job.queued",
          level: "default",
          eventId: "nested-job:queued",
          jobId: "nested-job",
          jobType: "executor",
          label: "Nested",
          agentRunId: "nested-run",
          queuedAt: 1,
        });
        traceListener?.({
          type: "agent.run.started",
          level: "high-signal",
          eventId: "nested-run:started",
          runId: "nested-run",
          jobId: "nested-job",
          displayName: "Nested",
          agentType: "executor",
          startedAt: 1,
        });
        traceListener?.({
          type: "tool.started",
          level: "default",
          provider: "openai",
          toolName: "read",
          toolCallId: "nested-tool",
          input: {},
          agentRunId: "nested-run",
          asyncJobId: "nested-job",
          startedAt: 1,
        });
        return { text: "done" };
      },
    };
  });

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  await harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });

  const nestedQueued = harness.traces.find(
    (event) => event.type === "job.queued" && event.jobId === "nested-job",
  );
  assert.equal(nestedQueued.agentRunId, "nested-run", "the parent run must not claim a nested job");
  assert.equal(Object.hasOwn(nestedQueued, "asyncJobId"), false);

  const nestedStarted = harness.traces.find(
    (event) => event.type === "agent.run.started" && event.runId === "nested-run",
  );
  assert.equal(nestedStarted.jobId, "nested-job");
  assert.equal(
    Object.hasOwn(nestedStarted, "agentRunId"),
    false,
    "a run record names itself in runId; an agentRunId would re-own it",
  );

  const nestedTool = harness.traces.find((event) => event.toolCallId === "nested-tool");
  assert.deepEqual(
    [nestedTool.agentRunId, nestedTool.asyncJobId],
    ["nested-run", "nested-job"],
    "a producer that already named its owner keeps it",
  );
});

test("a blank ownership id is replaced rather than trusted", async () => {
  const harness = createHarness(() => {
    let traceListener;
    return {
      clear() {},
      setTraceListener(listener) {
        traceListener = listener;
      },
      async runTurn() {
        // The console drops usage whose agentRunId is present but blank, so a
        // boundary that honoured it would lose the measurement outright.
        traceListener?.({
          type: "usage.recorded",
          level: "low-signal",
          eventId: "blank-owner-usage",
          provider: "openai",
          model: "gpt-5.4",
          agentRunId: "",
          inputTokens: 5,
          startedAt: 1,
        });
        return { text: "done" };
      },
    };
  });

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  await harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });

  const started = startedRunOf(harness.traces);
  const usage = harness.traces.find((event) => event.type === "usage.recorded");
  assert.equal(usage.agentRunId, started.runId);
  assert.equal(usage.asyncJobId, started.jobId);
});

test("two runs sharing the direct agent serialize the whole listener critical section", async () => {
  const turns = [];
  const entered = { "task-1": createDeferred(), "task-2": createDeferred() };
  const release = { "task-1": createDeferred(), "task-2": createDeferred() };
  let installed;
  const directAgent = {
    clear() {},
    setTraceListener(listener) {
      installed = listener;
    },
    async runTurn(prompt) {
      const id = prompt.replace("Do ", "");
      turns.push(id);
      entered[id].resolve();
      await release[id].promise;
      return { text: `done:${id}` };
    },
  };
  const harness = createHarness(undefined, { directAgent });
  const emitThroughInstalledListener = (itemId) => {
    installed({
      type: "assistant.delta",
      level: "default",
      provider: "openai",
      model: "gpt-5.4",
      itemId,
      delta: "partial answer",
    });
    return harness.traces.find((event) => event.itemId === itemId);
  };

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1"), planTask("task-2")], 1_000);
  const first = harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });
  const second = harness.controller.runTask({ graphId: "graph-1", task: planTask("task-2") });
  await entered["task-1"].promise;
  await settleScheduler();

  // One agent, one listener slot: the second run may already own a run record,
  // but it must not reach the provider — nor the listener — until the first
  // run has installed, used, and torn its own listener back down.
  assert.deepEqual(turns, ["task-1"], "the second run waits for the shared agent");
  const runIds = harness.traces
    .filter((event) => event.type === "agent.run.started")
    .map((event) => event.runId);
  assert.equal(runIds.length, 2);

  // The emission the token-only guard could not attribute: run 1 emits after
  // run 2 is already trying to take the slot.
  const duringFirst = emitThroughInstalledListener("while-second-waits");
  assert.equal(duringFirst.agentRunId, runIds[0]);
  assert.equal(duringFirst.asyncJobId, "graph-1:task-1");

  release["task-1"].resolve();
  assert.equal((await first).status, "completed");
  await entered["task-2"].promise;
  assert.deepEqual(turns, ["task-1", "task-2"], "the slot is handed over between turns, never during one");

  const duringSecond = emitThroughInstalledListener("while-second-runs");
  assert.equal(duringSecond.agentRunId, runIds[1]);
  assert.equal(duringSecond.asyncJobId, "graph-1:task-2");

  release["task-2"].resolve();
  assert.equal((await second).status, "completed");

  const afterAll = emitThroughInstalledListener("after-every-run");
  assert.equal(
    Object.hasOwn(afterAll, "agentRunId"),
    false,
    "with no executor run live the unscoped main listener is restored",
  );
});

test("a continuation is refused when every executor slot is already committed", async () => {
  const entered = createDeferred();
  const releaseTurn = createDeferred();
  const harness = createHarness(
    () => ({
      clear() {},
      setTraceListener() {},
      async runTurn() {
        entered.resolve();
        await releaseTurn.promise;
        return { text: "done" };
      },
    }),
    { workerBudget: 1 },
  );
  const source = {
    id: "graph-1:task-1:agent",
    displayName: "Implement auth refactor",
    agentType: "executor",
    status: "completed",
    startedAt: 1_000,
    summary: "prior result",
  };

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  const planned = harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });
  await entered.promise;

  const refused = await harness.runtime.continueRun(source, "keep going");
  assert.equal(refused.status, "rejected");
  assert.match(refused.message, /slots are all busy/i);
  assert.deepEqual(
    harness.traces.filter((event) => event.type === "job.queued").map((event) => event.jobId),
    ["graph-1:task-1"],
    "a refused continuation queues no job",
  );
  assert.deepEqual(
    harness.traces.filter((event) => event.type === "agent.run.started").map((event) => event.jobId),
    ["graph-1:task-1"],
    "a refused continuation opens no run",
  );

  releaseTurn.resolve();
  assert.equal((await planned).status, "completed");

  // The gate is capacity, not a permanent refusal: the freed slot takes it.
  assert.equal((await harness.runtime.continueRun(source, "keep going")).status, "accepted");
  const continuation = await harness.waitForTrace(
    (event) => event.type === "agent.run.started" && event.continuationOf === source.id,
  );
  assert.equal(continuation.parentRunId, source.id);
  const settled = await harness.waitForTrace(
    (event) => event.type === "agent.run.settled" && event.runId === continuation.runId,
  );
  assert.equal(settled.status, "completed", "the continuation the freed slot admitted really ran");
});

test("repeated continuations stop at the worker budget instead of stacking paid runs", async () => {
  const releaseTurns = createDeferred();
  let dispatched = 0;
  const harness = createHarness(
    () => ({
      clear() {},
      setTraceListener() {},
      async runTurn() {
        dispatched += 1;
        await releaseTurns.promise;
        return { text: "done" };
      },
    }),
    { workerBudget: 2 },
  );
  const source = (id) => ({
    id,
    displayName: `Run ${id}`,
    agentType: "executor",
    status: "completed",
    startedAt: 1_000,
    summary: "prior result",
  });

  const receipts = [];
  for (const id of ["run-a", "run-b", "run-c", "run-d"]) {
    receipts.push(await harness.runtime.continueRun(source(id)));
  }

  assert.deepEqual(
    receipts.map((receipt) => receipt.status),
    ["accepted", "accepted", "rejected", "rejected"],
    "holding the continue key must not open unbounded concurrent provider runs",
  );
  assert.equal(
    harness.traces.filter((event) => event.type === "job.queued").length,
    2,
    "only the accepted continuations left records behind",
  );
  assert.deepEqual(
    harness.traces
      .filter((event) => event.type === "agent.run.started")
      .map((event) => event.continuationOf),
    ["run-a", "run-b"],
  );

  releaseTurns.resolve();
  for (const id of ["run-a", "run-b"]) {
    const settled = await harness.waitForTrace(
      (event) => event.type === "agent.run.settled" && event.runId.startsWith(`${id}:continuation:`),
    );
    assert.equal(settled.status, "completed");
  }
  assert.equal(dispatched, 2, "the refused continuations never reached a provider");
});

/**
 * Executors whose provider turn parks until the test releases it. `peak` is the
 * high-water mark of concurrent provider calls, which is the only honest
 * evidence a capacity ceiling held: a breach is transient and a snapshot taken
 * afterwards would miss it.
 */
function createParkedExecutors() {
  const started = [];
  const gates = [];
  const arrivals = [];
  let live = 0;
  let peak = 0;
  const announce = () => {
    for (const arrival of [...arrivals]) {
      if (started.length >= arrival.count) {
        arrivals.splice(arrivals.indexOf(arrival), 1);
        arrival.resolve();
      }
    }
  };
  return {
    started,
    peak: () => peak,
    release: (index) => gates[index].resolve(),
    whenStarted(count) {
      if (started.length >= count) {
        return Promise.resolve();
      }
      return new Promise((resolve) => arrivals.push({ count, resolve }));
    },
    create: () => ({
      clear() {},
      setTraceListener() {},
      async runTurn(prompt) {
        const gate = createDeferred();
        gates.push(gate);
        started.push(prompt);
        live += 1;
        peak = Math.max(peak, live);
        announce();
        try {
          await gate.promise;
          return { text: `done:${prompt}` };
        } finally {
          live -= 1;
        }
      },
    }),
  };
}

test("planned work waits for the same executor permits a live continuation already holds", async () => {
  const executors = createParkedExecutors();
  const harness = createHarness(() => executors.create(), { workerBudget: 2 });

  // The reverse of the covered ordering: the manual continuation is live first
  // and the plan arrives afterwards, so the scheduler's own `maxWorkers` has
  // no idea a slot is already spent.
  assert.equal((await harness.runtime.continueRun(priorRun())).status, "accepted");
  await executors.whenStarted(1);
  const continuation = harness.traces.find((event) => event.type === "agent.run.started");

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1"), planTask("task-2")], 1_000);
  const planned = [
    harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") }),
    harness.controller.runTask({ graphId: "graph-1", task: planTask("task-2") }),
  ];
  await executors.whenStarted(2);
  await settleScheduler();

  assert.equal(executors.started.length, 2, "the budget is shared, not one ceiling per dispatch path");
  assert.equal(executors.peak(), 2);
  assert.deepEqual(
    harness.traces.filter((event) => event.type === "agent.run.started").map((event) => event.jobId),
    [continuation.jobId, "graph-1:task-1"],
    "the parked task mints no run while both permits are spent",
  );

  // Releasing the continuation hands its permit straight to the waiter; nothing
  // polls and nothing sleeps.
  executors.release(0);
  await executors.whenStarted(3);
  assert.equal(executors.peak(), 2, "three paid provider calls never overlapped");

  executors.release(1);
  executors.release(2);
  assert.deepEqual(
    (await Promise.all(planned)).map((outcome) => outcome.status),
    ["completed", "completed"],
  );
  assert.deepEqual(
    harness.traces.filter((event) => event.type === "agent.run.started").map((event) => event.jobId),
    [continuation.jobId, "graph-1:task-1", "graph-1:task-2"],
  );
});

test("every terminal executor outcome hands its permit to the parked planned run", async () => {
  const outcomes = [
    ["completed", async () => ({ text: "holder done" })],
    ["failed", async () => {
      throw new Error("holder exploded");
    }],
    ["cancelled", async () => {
      throw abortError();
    }],
  ];

  for (const [label, finishHolder] of outcomes) {
    const holderEntered = createDeferred();
    const releaseHolder = createDeferred();
    const harness = createHarness(
      () => ({
        clear() {},
        setTraceListener() {},
        async runTurn(prompt) {
          if (!prompt.startsWith("Continue the earlier agent run")) {
            return { text: "planned done" };
          }
          holderEntered.resolve();
          await releaseHolder.promise;
          return await finishHolder();
        },
      }),
      { workerBudget: 1 },
    );

    assert.equal((await harness.runtime.continueRun(priorRun())).status, "accepted");
    await holderEntered.promise;

    harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
    const planned = harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });
    await settleScheduler();
    assert.equal(
      harness.traces.filter((event) => event.type === "agent.run.started").length,
      1,
      `${label}: the planned run waits for the only permit`,
    );

    releaseHolder.resolve();
    assert.deepEqual(
      await planned,
      { text: "planned done", status: "completed" },
      `${label}: a settled run must not strand the permit it held`,
    );
  }
});

test("clear releases a planned run parked on a busy permit instead of hanging it", async () => {
  const holderEntered = createDeferred();
  const harness = createHarness(
    () => ({
      clear() {},
      setTraceListener() {},
      async runTurn(_prompt, _attachments, options) {
        holderEntered.resolve();
        return await new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      },
    }),
    { workerBudget: 1 },
  );

  assert.equal((await harness.runtime.continueRun(priorRun())).status, "accepted");
  await holderEntered.promise;

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1")], 1_000);
  const planned = harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1") });
  await settleScheduler();

  harness.controller.clear("shell cleared");
  assert.deepEqual(await planned, { text: "Executor cancelled.", status: "cancelled" });
  assert.deepEqual(
    harness.traces
      .filter((event) => event.type === "job.settled" && event.jobId === "graph-1:task-1")
      .map((event) => event.summary),
    ["shell cleared"],
    "the parked job settles exactly once",
  );
  assert.equal(
    harness.traces.filter((event) => event.type === "agent.run.started").length,
    1,
    "a run cleared while parked never opens",
  );
  assert.equal(harness.controller.plannedJobs.size, 0);
});

test("a parent abort frees every planned run parked on a busy permit", async () => {
  const parent = new AbortController();
  const holderEntered = createDeferred();
  const releaseHolder = createDeferred();
  const harness = createHarness(
    () => ({
      clear() {},
      setTraceListener() {},
      async runTurn(prompt, _attachments, options) {
        if (prompt.startsWith("Continue the earlier agent run")) {
          holderEntered.resolve();
          return await releaseHolder.promise.then(() => ({ text: "holder done" }));
        }
        return await new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      },
    }),
    { workerBudget: 1 },
  );

  assert.equal((await harness.runtime.continueRun(priorRun())).status, "accepted");
  await holderEntered.promise;

  harness.controller.queuePlannedJobs("graph-1", [planTask("task-1"), planTask("task-2")], 1_000);
  const planned = Promise.all([
    harness.controller.runTask({ graphId: "graph-1", task: planTask("task-1"), signal: parent.signal }),
    harness.controller.runTask({ graphId: "graph-1", task: planTask("task-2"), signal: parent.signal }),
  ]);
  await settleScheduler();
  assert.equal(
    getEventListeners(parent.signal, "abort").length,
    2,
    "each parked run links to the parent signal exactly once",
  );

  // The freed permit promotes one waiter; the promotion must take that waiter's
  // abort listener with it rather than leaving a second one behind.
  releaseHolder.resolve();
  await harness.waitForTrace(
    (event) => event.type === "agent.run.started" && event.jobId === "graph-1:task-1",
  );
  assert.equal(getEventListeners(parent.signal, "abort").length, 2);

  parent.abort();
  assert.deepEqual((await planned).map((outcome) => outcome.status), ["cancelled", "cancelled"]);
  assert.equal(
    getEventListeners(parent.signal, "abort").length,
    0,
    "neither the parked run nor the promoted one leaves an abort listener behind",
  );
  assert.equal(harness.controller.plannedJobs.size, 0);
});
