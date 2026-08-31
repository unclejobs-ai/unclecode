import assert from "node:assert/strict";
import test from "node:test";

import {
  LiveRuntimeControlRegistry,
  attachWorkShellRuntime,
} from "../../apps/unclecode-server/src/index.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function cooperativeEngine() {
  const listeners = new Set();
  let lifecycle = { state: "running", turnId: "turn-1" };
  let acknowledge;
  let rejectAcknowledge;
  let interrupts = 0;
  return {
    get interrupts() { return interrupts; },
    acknowledge(boundary = "after_provider") {
      lifecycle = { state: "paused", turnId: "turn-1", boundary };
      for (const listener of listeners) listener();
      acknowledge?.({ turnId: "turn-1", boundary });
    },
    getState() {
      return {
        isBusy: true,
        queuePaused: false,
        model: "test-model",
        mode: "default",
        uiLocale: "en",
        agentConsole: {},
      };
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    interruptTurn() {
      interrupts += 1;
      lifecycle = { state: "cancelled", turnId: "turn-1" };
      rejectAcknowledge?.(new Error("turn cancelled"));
    },
    getTurnLifecycle() { return lifecycle; },
    requestTurnPause() {
      lifecycle = { state: "pause_pending", turnId: "turn-1" };
      for (const listener of listeners) listener();
      return new Promise((resolve, reject) => { acknowledge = resolve; rejectAcknowledge = reject; });
    },
    resumeTurn() {
      if (lifecycle.state !== "paused") return false;
      lifecycle = { state: "running", turnId: "turn-1" };
      for (const listener of listeners) listener();
      return true;
    },
    async resumeQueueItems() { throw new Error("queue resume is not turn resume"); },
    async handleSubmit() {},
    answerPendingDecisionByIndex() { return false; },
    getAgentControlPort() { return { async steer() { return { status: "delivered" }; } }; },
  };
}

test("runtime pause remains pending until the engine acknowledges a safe checkpoint and never interrupts", async () => {
  const registry = new LiveRuntimeControlRegistry();
  const engine = cooperativeEngine();
  const changes = [];
  const detach = attachWorkShellRuntime(registry, {
    sessionId: "cooperative-1",
    projectPath: "/tmp/workspace",
    engine,
    initialRevision: 4,
    onChanged: (event) => changes.push(event),
  });

  const control = registry.control({
    sessionId: "cooperative-1",
    action: "pause",
    expectedRevision: 4,
    idempotencyKey: "pause-1",
  });
  await tick();

  assert.equal(engine.interrupts, 0);
  assert.equal(registry.snapshot("cooperative-1").state, "pause_pending");
  assert.equal(changes.at(-1).state, "pause_pending");

  engine.acknowledge();
  const paused = await control;
  assert.equal(paused.ok, true);
  assert.equal(paused.state, "paused");
  assert.equal(engine.interrupts, 0);

  const resumed = await registry.control({
    sessionId: "cooperative-1",
    action: "resume",
    expectedRevision: paused.revision,
    idempotencyKey: "resume-1",
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state, "running");
  assert.equal(engine.interrupts, 0);
  detach();
});

test("cancel preempts a pause mutation that is waiting for a safe boundary", async () => {
  const registry = new LiveRuntimeControlRegistry();
  const engine = cooperativeEngine();
  attachWorkShellRuntime(registry, {
    sessionId: "cancel-lane", projectPath: "/tmp/workspace", engine, initialRevision: 8,
  });
  const pause = registry.control({
    sessionId: "cancel-lane", action: "pause", expectedRevision: 8, idempotencyKey: "pause-pending",
  });
  await tick();
  assert.equal(registry.snapshot("cancel-lane").state, "pause_pending");

  const cancel = registry.control({
    sessionId: "cancel-lane", action: "cancel", expectedRevision: 8, idempotencyKey: "cancel-now",
  });
  const cancelled = await Promise.race([
    cancel,
    new Promise((_, reject) => setTimeout(() => reject(new Error("cancel waited behind pause")), 100)),
  ]);
  assert.equal(cancelled.ok, true);
  assert.equal(engine.interrupts, 1);
  const pauseResult = await pause;
  assert.equal(pauseResult.ok, false);
  assert.match(pauseResult.message, /cancelled/);
});
