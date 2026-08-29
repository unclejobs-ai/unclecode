import assert from "node:assert/strict";
import test from "node:test";

import { LiveRuntimeEngineRegistry } from "../../apps/unclecode-server/src/runtime-engine-rpc.ts";
import { RuntimeSessionMutationArbiter } from "../../apps/unclecode-server/src/runtime-mutation-arbiter.ts";
import { LiveRuntimeControlRegistry } from "../../apps/unclecode-server/src/persistent-runtime.ts";
import { attachWorkShellRuntime } from "../../apps/unclecode-server/src/work-shell-control.ts";

function fakeEngine(label) {
  let state = { label, mode: "standard" };
  const listeners = new Set();
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setMode(mode) { state = { ...state, mode }; for (const listener of listeners) listener(); },
  };
}

test("one owner creates and independently revisions multiple workspace sessions", async () => {
  const created = [];
  const disposed = [];
  const registry = new LiveRuntimeEngineRegistry({
    async createSession(input) {
      created.push(input);
      return {
        engine: fakeEngine(input.sessionId),
        projectPath: input.projectPath,
        provider: input.provider,
        dispose: () => disposed.push(input.sessionId),
      };
    },
  });

  const [alpha, alphaReplay, beta] = await Promise.all([
    registry.create({ sessionId: "alpha", projectPath: "/work/a", provider: "openai", idempotencyKey: "create-a" }),
    registry.create({ sessionId: "alpha", projectPath: "/work/a", provider: "openai", idempotencyKey: "create-a" }),
    registry.create({ sessionId: "beta", projectPath: "/work/b", provider: "deepseek", idempotencyKey: "create-b" }),
  ]);
  assert.deepEqual(alphaReplay, alpha);
  assert.equal(alpha.ok, true);
  assert.equal(beta.ok, true);
  assert.equal(created.length, 2, "concurrent idempotent create must construct one engine");
  assert.deepEqual(registry.list().map(item => [item.sessionId, item.projectPath]), [
    ["alpha", "/work/a"], ["beta", "/work/b"],
  ]);

  const alphaState = registry.read("alpha");
  const betaState = registry.read("beta");
  assert.equal(alphaState.revision, 0);
  assert.equal(betaState.revision, 0);
  const changed = await registry.invoke({
    sessionId: "alpha", method: "setMode", args: ["deep"], expectedRevision: 0, idempotencyKey: "mode-a",
  });
  assert.equal(changed.ok, true);
  assert.equal(registry.read("alpha").revision, 1);
  assert.equal(registry.read("beta").revision, 0, "session revisions must be isolated");

  const attached = registry.attachSession("beta");
  assert.equal(attached.ok, true);
  assert.equal(attached.session.projectPath, "/work/b");
  assert.equal(attached.engine.revision, 0);

  await registry.disposeAll();
  assert.deepEqual(disposed.sort(), ["alpha", "beta"]);
});

test("durable persistence notices advance but never regress the attached session clock", () => {
  const registry = new LiveRuntimeEngineRegistry();
  registry.attach("restored", fakeEngine("restored"), {
    projectPath: "/work/restored",
    revisionClock: { value: 7 },
  });
  assert.equal(registry.publishDurableRevision("restored", 11), 11);
  assert.equal(registry.read("restored").revision, 11);
  assert.equal(registry.publishDurableRevision("restored", 9), 11);
  assert.equal(registry.read("restored").revision, 11);
});

test("session id cannot be rebound to a different workspace", async () => {
  const registry = new LiveRuntimeEngineRegistry({
    async createSession(input) { return { engine: fakeEngine(input.sessionId), projectPath: input.projectPath }; },
  });
  await registry.create({ sessionId: "same", projectPath: "/work/a", idempotencyKey: "first" });
  const conflict = await registry.create({ sessionId: "same", projectPath: "/work/b", idempotencyKey: "second" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "session_conflict");
});

test("revision conflicts do not bind receipts while accepted mutations replay exactly once", async () => {
  const engine = fakeEngine("shared");
  let mutations = 0;
  const originalSetMode = engine.setMode;
  engine.setMode = mode => { mutations += 1; originalSetMode(mode); };
  const registry = new LiveRuntimeEngineRegistry();
  registry.attach("shared", engine, { projectPath: "/work/shared" });

  // An autonomous owner update makes both clients' revision 0 stale.
  originalSetMode("owner-updated");
  const staleInput = {
    sessionId: "shared", method: "setMode", args: ["deep"],
    expectedRevision: 0, idempotencyKey: "client-a",
  };
  const stale = await registry.invoke(staleInput);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "revision_conflict");
  assert.equal(mutations, 0);

  const acceptedInput = { ...staleInput, expectedRevision: stale.revision };
  const [accepted, competing] = await Promise.all([
    registry.invoke(acceptedInput),
    registry.invoke({ ...acceptedInput, idempotencyKey: "client-b", args: ["minimal"] }),
  ]);
  assert.equal(accepted.ok, true);
  assert.equal(competing.ok, false);
  assert.equal(competing.code, "revision_conflict");
  assert.equal(mutations, 1, "only the accepted client mutation may execute");

  const exactReplay = await registry.invoke(acceptedInput);
  assert.deepEqual(exactReplay, accepted);
  assert.equal(mutations, 1, "an accepted idempotency key must never execute twice");
  const changedPayload = await registry.invoke({ ...acceptedInput, args: ["standard"] });
  assert.equal(changedPayload.ok, false);
  assert.equal(changedPayload.code, "invalid_action");
  assert.equal(mutations, 1, "retry payload cannot change under the accepted key");
});

test("concurrent async calls with one idempotency key execute the engine method once", async () => {
  let calls = 0;
  let release;
  const engine = fakeEngine("async-key");
  engine.setMode = async mode => {
    calls += 1;
    await new Promise(resolve => { release = resolve; });
    return mode;
  };
  const registry = new LiveRuntimeEngineRegistry();
  registry.attach("async-key", engine, { projectPath: "/work/async-key" });
  const input = {
    sessionId: "async-key", method: "setMode", args: ["deep"],
    expectedRevision: 0, idempotencyKey: "same-async-call",
  };

  const first = registry.invoke(input);
  const replay = registry.invoke(input);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, "the pending receipt must be installed before awaiting the method");
  release();
  assert.deepEqual(await replay, await first);
  assert.equal(calls, 1);
});

test("different create keys for one session share one owner-side engine construction", async () => {
  let constructions = 0;
  let release;
  const registry = new LiveRuntimeEngineRegistry({
    async createSession(input) {
      constructions += 1;
      await new Promise(resolve => { release = resolve; });
      return { engine: fakeEngine(input.sessionId), projectPath: input.projectPath };
    },
  });
  const first = registry.create({ sessionId: "one-agent", projectPath: "/work/one", idempotencyKey: "create-a" });
  const second = registry.create({ sessionId: "one-agent", projectPath: "/work/one", idempotencyKey: "create-b" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(constructions, 1, "deduplication must happen before the session factory builds an agent");
  release();
  assert.deepEqual(await second, await first);
  assert.equal(constructions, 1);
});

test("engine RPC and web control share one revision admission and execute one same-revision mutation", async () => {
  const listeners = new Set();
  let modeCalls = 0;
  let submitCalls = 0;
  let releaseMode;
  const engine = {
    getState: () => ({ isBusy: true, queuePaused: false, model: "test", mode: "standard", uiLocale: "en", agentConsole: {} }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async setMode() { modeCalls += 1; await new Promise(resolve => { releaseMode = resolve; }); },
    interruptTurn() {},
    getTurnLifecycle: () => ({ state: "running", turnId: "turn-race" }),
    async requestTurnPause() { return { turnId: "turn-race", boundary: "after_provider" }; },
    resumeTurn: () => false,
    async resumeQueueItems() {},
    async handleSubmit() { submitCalls += 1; },
    answerPendingDecisionByIndex: () => false,
    getAgentControlPort: () => ({ async steer() { return { status: "delivered" }; } }),
  };
  const clock = { value: 0 };
  const arbiter = new RuntimeSessionMutationArbiter(clock);
  const engines = new LiveRuntimeEngineRegistry();
  const controls = new LiveRuntimeControlRegistry();
  engines.attach("shared-lane", engine, { projectPath: "/work/shared", revisionClock: clock, mutationArbiter: arbiter });
  attachWorkShellRuntime(controls, {
    sessionId: "shared-lane", projectPath: "/work/shared", engine,
    revisionClock: clock, mutationArbiter: arbiter,
  });

  const engineMutation = engines.invoke({
    sessionId: "shared-lane", method: "setMode", args: ["deep"],
    expectedRevision: 0, idempotencyKey: "engine-race",
  });
  const webMutation = controls.control({
    sessionId: "shared-lane", action: "follow-up", payload: { message: "next" },
    expectedRevision: 0, idempotencyKey: "web-race",
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(modeCalls, 1);
  assert.equal(submitCalls, 0, "the web mutation must wait behind the owner session arbiter");
  releaseMode();
  const [accepted, conflict] = await Promise.all([engineMutation, webMutation]);
  assert.equal(accepted.ok, true);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "revision_conflict");
  assert.equal(modeCalls + submitCalls, 1);
});

test("owner disposal aborts and settles a live provider or tool mutation before returning", async () => {
  let started = false;
  let interrupted = false;
  let release;
  let disposed = false;
  const engine = fakeEngine("shutdown-live-turn");
  engine.handleSubmit = async () => {
    started = true;
    await new Promise(resolve => { release = resolve; });
    throw new Error("turn aborted by owner shutdown");
  };
  engine.interruptTurn = () => {
    interrupted = true;
    release?.();
  };
  const registry = new LiveRuntimeEngineRegistry();
  registry.attach("shutdown-live-turn", engine, {
    projectPath: "/work/shutdown",
    dispose: () => { disposed = true; },
  });
  const turn = registry.invoke({
    sessionId: "shutdown-live-turn", method: "handleSubmit", args: ["run provider/tool"],
    expectedRevision: 0, idempotencyKey: "live-turn",
  });
  while (!started) await new Promise(resolve => setImmediate(resolve));

  let settled;
  try {
    settled = await Promise.race([
      Promise.all([registry.disposeAll(), turn]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("owner shutdown did not settle the live turn")), 200)),
    ]);
  } finally {
    release?.();
  }
  const [, result] = settled;
  assert.equal(interrupted, true);
  assert.equal(disposed, true);
  assert.equal(result.ok, false);
  assert.match(result.message, /aborted by owner shutdown/);
});
