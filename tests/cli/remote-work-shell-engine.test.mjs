import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createRemoteWorkShellEngine } from "../../apps/unclecode-cli/src/remote-work-shell-engine.ts";

test("remote WorkShell adapter reuses owner state and dispose detaches only the client", async () => {
  let revision = 3;
  let state = { model: "owner-model", mode: "standard", entries: [], turnLifecycle: { state: "running", turnId: "turn-1" } };
  let invokes = 0;
  let ownerStopped = false;
  const client = {
    async readEngineState() { return { ok: true, revision, state, result: null }; },
    async invokeEngineMethod(input) {
      invokes += 1;
      assert.equal(input.expectedRevision, revision);
      revision += 1;
      state = { ...state, mode: input.args[0] };
      return { ok: true, revision, state, result: undefined };
    },
    stopOwner() { ownerStopped = true; },
  };
  const engine = await createRemoteWorkShellEngine(client, "session-1");
  assert.equal(engine.then, undefined, "dynamic RPC methods must not make the adapter a thenable");
  const seen = [];
  const unsubscribe = engine.subscribe((next) => seen.push(next));

  await engine.setMode("deep");
  assert.equal(engine.getState().mode, "deep");
  assert.equal(engine.getTurnLifecycle().turnId, "turn-1");
  assert.equal(invokes, 1);
  assert.equal(seen.length, 1);

  unsubscribe();
  engine.dispose();
  assert.equal(ownerStopped, false, "client detach must not expose or call owner shutdown");

  const reattached = await createRemoteWorkShellEngine(client, "session-1");
  assert.equal(reattached.getState().mode, "deep", "a new TUI adapter must reconnect to the same owner state");
  reattached.dispose();
});

test("remote adapter refreshes and retries one stale revision with the same idempotency key", async () => {
  let revision = 1;
  let state = { mode: "standard", entries: [] };
  const attempts = [];
  const client = {
    async readEngineState() { return { ok: true, revision, state, result: null }; },
    async invokeEngineMethod(input) {
      attempts.push(input);
      if (attempts.length === 1) {
        revision = 2;
        state = { ...state, background: "owner update" };
        return { ok: false, code: "revision_conflict", message: "Engine revision changed.", revision };
      }
      assert.equal(input.expectedRevision, 2);
      revision = 3;
      state = { ...state, mode: input.args[0] };
      return { ok: true, revision, state, result: undefined };
    },
  };
  const engine = await createRemoteWorkShellEngine(client, "session-race");
  await engine.setMode("deep");
  assert.equal(engine.getState().mode, "deep");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].idempotencyKey, attempts[1].idempotencyKey);
  engine.dispose();
});

test("remote adapter rejects a late stale poll instead of regressing owner state", async () => {
  let reads = 0;
  const client = {
    async readEngineState() {
      reads += 1;
      return reads === 1
        ? { ok: true, revision: 5, state: { mode: "deep" }, result: null }
        : { ok: true, revision: 4, state: { mode: "standard" }, result: null };
    },
  };
  const engine = await createRemoteWorkShellEngine(client, "late-poll");
  await engine.initialize();
  assert.equal(engine.getState().mode, "deep");
  engine.dispose();
});

test("remote adapter surfaces a decision conflict without retrying against a changed decision", async () => {
  let revision = 1;
  let state = { agentConsole: { pendingDecision: { id: "decision-a" } } };
  let attempts = 0;
  const client = {
    async readEngineState() { return { ok: true, revision, state, result: null }; },
    async invokeEngineMethod() {
      attempts += 1;
      revision = 2;
      state = { agentConsole: { pendingDecision: { id: "decision-b" } } };
      return { ok: false, code: "revision_conflict", message: "Engine revision changed.", revision };
    },
  };
  const engine = await createRemoteWorkShellEngine(client, "decision-conflict");
  await assert.rejects(engine.answerPendingDecisionByIndex(1), /Engine revision changed/);
  assert.equal(attempts, 1, "an index cannot be replayed against a different pending decision identity");
  assert.equal(engine.getState().agentConsole.pendingDecision.id, "decision-a");
  engine.dispose();
});

test("TUI boot attaches through discovery without a fixed port or split local registry", async () => {
  const source = await readFile(new URL("../../apps/unclecode-cli/src/work-runtime.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /17677|EADDRINUSE|startServer\s*\(/);
  assert.doesNotMatch(source, /startPersistentRuntimeOwner\s*\(/,
    "the TUI process must never become the long-lived runtime owner");
  assert.doesNotMatch(source, /new\s+LiveRuntime(?:Control|Engine)Registry/);
  assert.match(source, /ensureRuntimeOwner\s*\(/);
  assert.match(source, /spawnDetachedRuntimeOwner\s*\(/,
    "the first client must atomically hand ownership to a detached service");
  assert.match(source, /createRuntimeSession\s*\(/);
  assert.match(source, /attachRuntimeSession\s*\(/);
  assert.match(source, /createRemoteWorkShellEngine\s*\(/);
});
