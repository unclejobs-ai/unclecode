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

test("shared owner arbiter cancels an admitted handleSubmit before projected busy state", async () => {
  let releaseBlocker;
  let admitted = 0;
  let cancelled = 0;
  let interruptCalls = 0;
  let submitCalls = 0;
  const engine = fakeEngine("pre-busy-cancel");
  engine.setMode = async () => new Promise(resolve => { releaseBlocker = resolve; });
  engine.admitRuntimeTurn = () => { admitted += 1; };
  engine.interruptTurn = () => {
    interruptCalls += 1;
    if (admitted <= cancelled) return false;
    cancelled += 1;
    return true;
  };
  engine.handleSubmit = async () => {
    if (cancelled > 0) { cancelled -= 1; admitted -= 1; return; }
    admitted -= 1;
    submitCalls += 1;
  };
  const registry = new LiveRuntimeEngineRegistry();
  registry.attach("pre-busy-cancel", engine, { projectPath: "/work/pre-busy" });

  const blocker = registry.invoke({
    sessionId: "pre-busy-cancel", method: "setMode", args: ["deep"],
    expectedRevision: 0, idempotencyKey: "block-normal-execution",
  });
  while (!releaseBlocker) await new Promise(resolve => setImmediate(resolve));
  const admittedSubmit = registry.invoke({
    sessionId: "pre-busy-cancel", method: "handleSubmit", args: ["must not start"],
    expectedRevision: 1, idempotencyKey: "admitted-submit",
  });
  while (registry.read("pre-busy-cancel").revision < 2) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(admitted, 1);

  const cancelInput = {
    sessionId: "pre-busy-cancel", method: "interruptTurn", args: [],
    expectedRevision: 2, idempotencyKey: "pre-busy-cancel",
  };
  const cancel = await registry.invoke(cancelInput);
  assert.equal(cancel.ok, true);
  assert.deepEqual(await registry.invoke(cancelInput), cancel, "an exact retry must replay the accepted cancellation");
  const changedRetry = await registry.invoke({ ...cancelInput, args: ["changed-payload"] });
  assert.equal(changedRetry.ok, false);
  assert.equal(changedRetry.code, "invalid_action");
  assert.equal(interruptCalls, 1, "replay and invalid key reuse must not consume the admission twice");
  releaseBlocker();
  await Promise.all([blocker, admittedSubmit]);
  assert.equal(submitCalls, 0, "the accepted submit must consume its pre-start cancellation");
});

test("one accepted mutation persists its reserved owner revision exactly once before execution", async () => {
  const persisted = [];
  let calls = 0;
  const clock = { value: 6 };
  const arbiter = new RuntimeSessionMutationArbiter(clock, {
    async persistAcceptedRevision(revision) { persisted.push(revision); },
  });
  const input = {
    idempotencyKey: "durable-revision",
    fingerprint: "set-mode-deep",
    expectedRevision: 6,
    execute() {
      calls += 1;
      assert.deepEqual(persisted, [7], "execution cannot start before its accepted revision is durable");
      return "deep";
    },
    conflict: revision => ({ ok: false, revision }),
    invalidReuse: revision => ({ ok: false, revision }),
    complete: (result, revision) => ({ ok: true, result, revision }),
    fail: (error, revision) => ({ ok: false, error, revision }),
  };

  const first = await arbiter.mutate(input);
  const replay = await arbiter.mutate(input);
  assert.deepEqual(first, { ok: true, result: "deep", revision: 7 });
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
  assert.deepEqual(persisted, [7]);
});

test("failed accepted-revision persistence rolls back admission without executing", async () => {
  let calls = 0;
  const clock = { value: 6 };
  const arbiter = new RuntimeSessionMutationArbiter(clock, {
    async persistAcceptedRevision() { throw new Error("disk unavailable"); },
  });
  const result = await arbiter.mutate({
    idempotencyKey: "failed-durable-revision",
    fingerprint: "set-mode-deep",
    expectedRevision: 6,
    execute() { calls += 1; return "deep"; },
    conflict: revision => ({ ok: false, code: "conflict", revision }),
    invalidReuse: revision => ({ ok: false, code: "reuse", revision }),
    complete: (output, revision) => ({ ok: true, output, revision }),
    fail: (error, revision) => ({ ok: false, code: error.message, revision }),
  });

  assert.deepEqual(result, { ok: false, code: "disk unavailable", revision: 6 });
  assert.equal(calls, 0, "the engine mutation cannot run before revision durability succeeds");
  assert.equal(clock.value, 6, "failed persistence cannot publish an accepted revision");
});

test("a later mutation cannot reserve or depend on an unpublished revision", async () => {
  let markFirstPersistenceStarted;
  const firstPersistenceStarted = new Promise(resolve => { markFirstPersistenceStarted = resolve; });
  let releaseFirstPersistence;
  const firstPersistenceGate = new Promise(resolve => { releaseFirstPersistence = resolve; });
  const persisted = [];
  const calls = [];
  const clock = { value: 6 };
  const arbiter = new RuntimeSessionMutationArbiter(clock, {
    async persistAcceptedRevision(revision) {
      persisted.push(revision);
      if (revision === 7) {
        markFirstPersistenceStarted();
        await firstPersistenceGate;
        throw new Error("first revision was not durable");
      }
    },
  });
  const mutation = (idempotencyKey, expectedRevision, label) => arbiter.mutate({
    idempotencyKey,
    fingerprint: label,
    expectedRevision,
    execute() { calls.push(label); return label; },
    conflict: revision => ({ ok: false, code: "conflict", revision }),
    invalidReuse: revision => ({ ok: false, code: "reuse", revision }),
    complete: (output, revision) => ({ ok: true, output, revision }),
    fail: (error, revision) => ({ ok: false, code: error.message, revision }),
  });

  const first = mutation("first-unpublished", 6, "first");
  await firstPersistenceStarted;
  assert.equal(clock.value, 6, "a reserved revision cannot be published before persistence succeeds");
  const dependent = mutation("dependent-unpublished", 7, "dependent");
  releaseFirstPersistence();

  assert.deepEqual(await first, { ok: false, code: "first revision was not durable", revision: 6 });
  assert.deepEqual(await dependent, { ok: false, code: "conflict", revision: 6 });
  assert.deepEqual(persisted, [7], "the dependent revision must never reach persistence");
  assert.deepEqual(calls, [], "neither engine mutation may execute");
  assert.equal(clock.value, 6);
});

test("a stale cross-client cancel remains preemptive after multiple control admissions", async () => {
  const clock = { value: 10 };
  const arbiter = new RuntimeSessionMutationArbiter(clock);
  let releaseTurn;
  const turn = arbiter.mutate({
    idempotencyKey: "active-turn",
    fingerprint: "submit",
    expectedRevision: 10,
    execute: () => new Promise(resolve => { releaseTurn = resolve; }),
    conflict: revision => ({ ok: false, code: "conflict", revision }),
    invalidReuse: revision => ({ ok: false, code: "reuse", revision }),
    complete: (output, revision) => ({ ok: true, output, revision }),
    fail: (error, revision) => ({ ok: false, code: error.message, revision }),
  });
  await new Promise(resolve => setImmediate(resolve));
  const mutateControl = (key, expectedRevision) => arbiter.mutate({
    idempotencyKey: key,
    fingerprint: key,
    expectedRevision,
    lane: "control",
    execute: () => key,
    conflict: revision => ({ ok: false, code: "conflict", revision }),
    invalidReuse: revision => ({ ok: false, code: "reuse", revision }),
    complete: (output, revision) => ({ ok: true, output, revision }),
    fail: (error, revision) => ({ ok: false, code: error.message, revision }),
  });
  assert.equal((await mutateControl("pause", 11)).ok, true);
  assert.equal((await mutateControl("approval", 12)).ok, true);
  assert.equal(clock.value, 13);

  let cancelled = 0;
  const staleCancel = await arbiter.mutate({
    idempotencyKey: "stale-cancel",
    fingerprint: "cancel-from-client-at-11",
    expectedRevision: 11,
    lane: "cancel",
    execute() { cancelled += 1; releaseTurn("cancelled"); return "cancelled"; },
    conflict: revision => ({ ok: false, code: "conflict", revision }),
    invalidReuse: revision => ({ ok: false, code: "reuse", revision }),
    complete: (output, revision) => ({ ok: true, output, revision }),
    fail: (error, revision) => ({ ok: false, code: error.message, revision }),
  });
  assert.equal(staleCancel.ok, true);
  assert.equal(cancelled, 1);
  assert.equal((await turn).ok, true);

  const staleNonCancel = await mutateControl("stale-control", 11);
  assert.equal(staleNonCancel.ok, false);
  assert.equal(staleNonCancel.code, "conflict", "only cancel may bypass a stale client revision");
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

test("an active submitted turn does not retain the owner lane needed to pause it", async () => {
  const listeners = new Set();
  let lifecycle = { state: "idle" };
  let releaseTurn;
  let pauseCalls = 0;
  const engine = {
    getState: () => ({ isBusy: lifecycle.state !== "idle", queuePaused: false, model: "test", mode: "standard", uiLocale: "en", agentConsole: {} }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async handleSubmit() {
      lifecycle = { state: "running", turnId: "turn-live" };
      for (const listener of listeners) listener();
      await new Promise(resolve => { releaseTurn = resolve; });
      lifecycle = { state: "idle" };
    },
    getTurnLifecycle: () => lifecycle,
    async requestTurnPause() {
      pauseCalls += 1;
      lifecycle = { state: "paused", turnId: "turn-live", boundary: "after_provider" };
      return { turnId: "turn-live", boundary: "after_provider" };
    },
    resumeTurn: () => false,
    interruptTurn() { releaseTurn?.(); },
    async resumeQueueItems() {},
    answerPendingDecisionByIndex: () => false,
    getAgentControlPort: () => ({ async steer() { return { status: "delivered" }; } }),
  };
  const clock = { value: 0 };
  const arbiter = new RuntimeSessionMutationArbiter(clock);
  const engines = new LiveRuntimeEngineRegistry();
  const controls = new LiveRuntimeControlRegistry();
  engines.attach("live-control", engine, { projectPath: "/work/live", revisionClock: clock, mutationArbiter: arbiter });
  attachWorkShellRuntime(controls, {
    sessionId: "live-control", projectPath: "/work/live", engine,
    revisionClock: clock, mutationArbiter: arbiter,
  });

  const turn = engines.invoke({
    sessionId: "live-control", method: "handleSubmit", args: ["keep working"],
    expectedRevision: 0, idempotencyKey: "turn-live",
  });
  while (lifecycle.state !== "running") await new Promise(resolve => setImmediate(resolve));
  const admittedRevision = engines.read("live-control").revision;
  const pause = controls.control({
    sessionId: "live-control", action: "pause",
    expectedRevision: admittedRevision, idempotencyKey: "pause-live",
  });
  const result = await Promise.race([
    pause,
    new Promise(resolve => setTimeout(() => resolve({ outcome: "blocked", pauses: pauseCalls }), 100)),
  ]);

  assert.equal(result.outcome, undefined, `pause must reach the active turn: ${JSON.stringify(result)}`);
  assert.equal(result.ok, true);
  assert.equal(pauseCalls, 1);
  releaseTurn();
  await turn;
});

test("owner disposal reports a non-settling engine instead of silently dropping it", async () => {
  let disposed = false;
  const engine = fakeEngine("shutdown-refusal");
  engine.shutdown = async () => false;
  const registry = new LiveRuntimeEngineRegistry();
  registry.attach("shutdown-refusal", engine, {
    projectPath: "/work/shutdown-refusal",
    dispose: () => { disposed = true; },
  });

  await assert.rejects(registry.disposeAll(), /did not settle/i);
  assert.equal(disposed, true, "owned subscriptions still need deterministic cleanup on failure");
});
