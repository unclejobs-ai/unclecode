import assert from "node:assert/strict";
import test from "node:test";

import { CooperativePauseController } from "../../packages/orchestrator/src/work-shell-pause-controller.ts";
import {
  runExecutionNonInterruptible,
  withExecutionPausePort,
} from "../../packages/orchestrator/src/execution-pause.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("pause stays pending inside a non-interruptible operation and acknowledges only after a durable safe boundary", async () => {
  const states = [];
  const durable = [];
  const controller = new CooperativePauseController({
    onStateChanged: (snapshot) => states.push(snapshot.state),
  });
  controller.beginTurn("turn-1");

  let releaseOperation;
  const operation = controller.runNonInterruptible(
    "provider.request",
    async () => new Promise((resolve) => { releaseOperation = resolve; }),
    async (snapshot) => { durable.push(`${snapshot.turnId}:${snapshot.boundary}`); },
  );
  await tick();

  let acknowledged = false;
  const pause = controller.requestPause().then((receipt) => {
    acknowledged = true;
    return receipt;
  });
  await tick();

  assert.equal(controller.snapshot().state, "pause_pending");
  assert.equal(acknowledged, false);
  assert.deepEqual(durable, []);

  releaseOperation("provider-result");
  await tick();
  const paused = await pause;

  assert.equal(paused.turnId, "turn-1");
  assert.equal(paused.boundary, "after_provider");
  assert.equal(controller.snapshot().state, "paused");
  assert.deepEqual(durable, ["turn-1:after_provider"]);
  assert.deepEqual(states, ["running", "pause_pending", "paused"]);

  controller.resume();
  assert.equal(await operation, "provider-result");
  assert.equal(controller.snapshot().state, "running");
});

test("two pause callers share one acknowledgement and resume releases the same turn once", async () => {
  let flushes = 0;
  const controller = new CooperativePauseController();
  controller.beginTurn("turn-same");

  const first = controller.requestPause();
  const second = controller.requestPause();
  let crossed = false;
  const checkpoint = controller.checkpoint("before_tool", async () => { flushes += 1; })
    .then(() => { crossed = true; });

  const [one, two] = await Promise.all([first, second]);
  assert.deepEqual(one, two);
  assert.equal(flushes, 1);
  assert.equal(crossed, false);

  assert.equal(controller.resume(), true);
  assert.equal(controller.resume(), false);
  await checkpoint;
  assert.equal(crossed, true);
  assert.equal(controller.snapshot().turnId, "turn-same");
  assert.equal(controller.snapshot().state, "running");
});

test("cancel is distinct from pause and releases a paused checkpoint as cancelled", async () => {
  const controller = new CooperativePauseController();
  controller.beginTurn("turn-cancel");
  const pause = controller.requestPause();
  const checkpoint = controller.checkpoint("before_completion", async () => undefined);
  await pause;

  assert.equal(controller.cancel(), true);
  await assert.rejects(checkpoint, { name: "AbortError" });
  assert.equal(controller.snapshot().state, "cancelled");
  assert.equal(controller.resume(), false);
});

test("an irreversible tool stays pause_pending until the handler settles, then pauses at after_tool", async () => {
  const controller = new CooperativePauseController();
  controller.beginTurn("turn-tool");
  const durable = [];
  const persist = async (snapshot) => { durable.push(snapshot.boundary); };
  const port = {
    checkpoint: (boundary) => controller.checkpoint(boundary, persist),
    runNonInterruptible: (operation, run) => controller.runNonInterruptible(operation, run, persist),
  };
  let releaseTool;
  const tool = withExecutionPausePort(port, () => runExecutionNonInterruptible(
    "tool.dispatch",
    () => new Promise((resolve) => { releaseTool = resolve; }),
  ));
  await tick();

  let acknowledged = false;
  const pause = controller.requestPause().then((receipt) => { acknowledged = true; return receipt; });
  await tick();
  assert.equal(controller.snapshot().state, "pause_pending");
  assert.equal(acknowledged, false);
  assert.deepEqual(durable, []);

  releaseTool("written-once");
  const receipt = await pause;
  assert.equal(receipt.boundary, "after_tool");
  assert.equal(controller.snapshot().state, "paused");
  assert.deepEqual(durable, ["after_tool"]);
  assert.equal(controller.resume(), true);
  assert.equal(await tool, "written-once");
});
