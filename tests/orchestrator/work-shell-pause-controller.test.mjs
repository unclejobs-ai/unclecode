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

test("a cancelled turn's ignored operation drains before a new turn begins, while the new wait remains cancellable", async () => {
  const controller = new CooperativePauseController();
  controller.beginTurn("turn-old");
  let releaseOperation;
  const operation = controller.runNonInterruptible(
    "provider.request",
    () => new Promise((resolve) => { releaseOperation = resolve; }),
    async () => undefined,
  );
  await tick();
  assert.equal(controller.cancel(), true);

  const cancelledWait = new AbortController();
  const cancelledBegin = controller.beginTurn("turn-cancelled-wait", cancelledWait.signal);
  cancelledWait.abort();
  assert.equal(await cancelledBegin, false);
  assert.equal(controller.snapshot().turnId, "turn-old");

  let nextBegan = false;
  const nextBegin = controller.beginTurn("turn-next").then((began) => {
    nextBegan = began;
    return began;
  });
  await tick();
  assert.equal(nextBegan, false);

  releaseOperation("late-result");
  await assert.rejects(operation, { name: "AbortError" });
  assert.equal(await nextBegin, true);
  assert.equal(controller.snapshot().state, "running");
  assert.equal(controller.snapshot().turnId, "turn-next");
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

test("a provider waiting on approval can pause at its durable pre-approval boundary before the answer arrives", async () => {
  const controller = new CooperativePauseController();
  controller.beginTurn("turn-approval");
  const durable = [];
  const persist = async (snapshot) => { durable.push(snapshot.boundary); };
  let answerApproval;
  const provider = controller.runNonInterruptible(
    "provider.request",
    () => new Promise((resolve) => { answerApproval = resolve; }),
    persist,
  );
  await tick();

  const pause = controller.requestPause();
  const checkpoint = controller.checkpoint("before_approval", persist);
  const receipt = await pause;

  assert.equal(receipt.boundary, "before_approval");
  assert.equal(controller.snapshot().state, "paused");
  assert.deepEqual(durable, ["before_approval"]);
  assert.equal(controller.resume(), true);
  await checkpoint;

  answerApproval("approved");
  assert.equal(await provider, "approved");
});

test("overlapping approval checkpoints share one durable transition and one resume gate", async () => {
  const controller = new CooperativePauseController();
  controller.beginTurn("turn-approval-overlap");
  const pause = controller.requestPause();
  let persists = 0;
  let releasePersist;
  const persist = async () => {
    persists += 1;
    await new Promise(resolve => { releasePersist = resolve; });
  };

  let firstReleased = false;
  let secondReleased = false;
  const beforeApproval = controller.checkpoint("before_approval", persist)
    .then(() => { firstReleased = true; });
  const afterApproval = controller.checkpoint("after_approval", persist)
    .then(() => { secondReleased = true; });
  await tick();
  assert.equal(persists, 1, "only the checkpoint that atomically claims the transition may persist");
  releasePersist();
  const receipt = await pause;
  assert.equal(receipt.boundary, "before_approval");
  assert.equal(controller.snapshot().state, "paused");
  assert.equal(controller.resume(), true);
  assert.equal(controller.resume(), false);
  await Promise.all([beforeApproval, afterApproval]);
  assert.equal(firstReleased, true);
  assert.equal(secondReleased, true);
  assert.equal(controller.snapshot().state, "running");
});
