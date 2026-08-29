import assert from "node:assert/strict";
import test from "node:test";

import { LiveRuntimeEngineRegistry } from "../../apps/unclecode-server/src/runtime-engine-rpc.ts";

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
