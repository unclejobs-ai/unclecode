import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createRemoteWorkShellEngine } from "../../apps/unclecode-cli/src/remote-work-shell-engine.ts";

async function flushRemotePoll() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

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

test("remote adapter dispose aborts an in-flight owner poll and settles initialize", async () => {
  let reads = 0;
  let pollStarted;
  let pollAborted = false;
  const started = new Promise((resolve) => { pollStarted = resolve; });
  const client = {
    async readEngineState(_sessionId, options = {}) {
      reads += 1;
      if (reads === 1) {
        return { ok: true, revision: 1, state: { mode: "standard" }, result: null };
      }
      pollStarted();
      return await new Promise((resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          pollAborted = true;
          const error = new Error("poll detached");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  };
  const engine = await createRemoteWorkShellEngine(client, "detach-poll");
  const initializing = engine.initialize();
  await started;
  engine.dispose();
  await initializing;
  assert.equal(pollAborted, true);
});

test("remote adapter backs off a transient owner outage without losing its last revision", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
  const readTimes = [];
  const unhandled = [];
  const onUnhandled = (error) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => { process.off("unhandledRejection", onUnhandled); });

  let reads = 0;
  const client = {
    async readEngineState() {
      reads += 1;
      readTimes.push(Date.now());
      if (reads === 1) {
        return { ok: true, revision: 5, state: { mode: "deep", marker: "revision-5" }, result: null };
      }
      if (reads <= 8) {
        const error = new Error("connect ECONNREFUSED 127.0.0.1");
        error.code = "ECONNREFUSED";
        throw error;
      }
      if (reads === 9) {
        return { ok: true, revision: 4, state: { mode: "standard", marker: "stale" }, result: null };
      }
      return { ok: true, revision: 6, state: { mode: "deep", marker: "recovered" }, result: null };
    },
  };
  const engine = await createRemoteWorkShellEngine(client, "transient-owner-outage");
  const seen = [];
  engine.subscribe((state) => { seen.push(state); });

  for (const delay of [100, 100, 200, 400, 800, 1_600, 2_000, 2_000, 100]) {
    t.mock.timers.tick(delay);
    await flushRemotePoll();
  }

  assert.deepEqual(
    readTimes,
    [0, 100, 200, 400, 800, 1_600, 3_200, 5_200, 7_200, 7_300],
    "owner reads should exponentially back off at two seconds and reset after recovery",
  );
  assert.equal(unhandled.length, 0, "scheduled polling failures must always settle inside the adapter");
  assert.equal(
    seen.some((state) => state.remoteConnection?.state === "disconnected"),
    true,
    "the retained owner snapshot should expose a disconnected projection after a failed read",
  );
  assert.equal(
    seen.some((state) => state.remoteConnection?.state === "reconnecting"),
    true,
    "the retained owner snapshot should expose each reconnect attempt",
  );
  assert.equal(engine.getState().marker, "recovered");
  assert.equal(engine.getState().mode, "deep", "the stale recovery response must not regress revision 5");
  assert.equal(engine.getState().remoteConnection, undefined, "successful recovery should clear client-local outage state");
  engine.dispose();
});

test("remote adapter releases polling resources after one hundred reconnect cycles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const baselineHandles = new Set(process._getActiveHandles());
  let reads = 0;
  let revision = 10;
  const client = {
    async readEngineState() {
      reads += 1;
      if (reads === 1) {
        return { ok: true, revision, state: { marker: "initial" }, result: null };
      }
      if (reads % 2 === 0) {
        const error = new Error("connect ECONNREFUSED 127.0.0.1");
        error.code = "ECONNREFUSED";
        throw error;
      }
      revision += 1;
      return { ok: true, revision, state: { marker: `cycle-${(reads - 1) / 2}` }, result: null };
    },
    async invokeEngineMethod(input) {
      assert.equal(input.expectedRevision, 110, "reconnects must retain the latest monotonic owner revision");
      revision += 1;
      return { ok: true, revision, state: { marker: "invoked-after-recovery" }, result: undefined };
    },
  };
  const engine = await createRemoteWorkShellEngine(client, "reconnect-soak");
  const seen = [];
  engine.subscribe((state) => { seen.push(state); });

  for (let cycle = 0; cycle < 100; cycle += 1) {
    t.mock.timers.tick(100);
    await flushRemotePoll();
    assert.equal(engine.getState().remoteConnection?.state, "disconnected");
    t.mock.timers.tick(100);
    await flushRemotePoll();
    assert.equal(engine.getState().remoteConnection, undefined);
  }

  assert.equal(reads, 201);
  assert.equal(engine.getState().marker, "cycle-100");
  await engine.setMode("deep");
  assert.equal(engine.getState().marker, "invoked-after-recovery");
  const seenBeforeDispose = seen.length;
  const readsBeforeDispose = reads;
  engine.dispose();
  t.mock.timers.tick(60_000);
  await flushRemotePoll();

  assert.equal(reads, readsBeforeDispose, "dispose must remove the reconnect timer");
  assert.equal(seen.length, seenBeforeDispose, "dispose must remove every polling listener");
  const leakedHandles = process._getActiveHandles().filter((handle) => !baselineHandles.has(handle));
  assert.deepEqual(
    leakedHandles.map((handle) => handle.constructor?.name ?? typeof handle),
    [],
    "reconnect churn and disposal must return process handles to baseline",
  );
});

test("remote adapter dispose aborts its in-flight RPC without cancelling the owner turn", async () => {
  let invokeStarted;
  let receivedSignal;
  const started = new Promise((resolve) => { invokeStarted = resolve; });
  const client = {
    async readEngineState() {
      return { ok: true, revision: 1, state: { mode: "standard" }, result: null };
    },
    async invokeEngineMethod(input) {
      receivedSignal = input.signal;
      invokeStarted();
      return await new Promise((resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
      });
    },
  };
  const engine = await createRemoteWorkShellEngine(client, "detach-rpc");
  const pending = engine.submit("keep running in the owner");
  await started;
  engine.dispose();
  await assert.rejects(pending, /attachment closed/);
  assert.equal(receivedSignal.aborted, true);
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

test("remote interrupt preempts a long submitted turn instead of waiting on invocation order", async () => {
  let revision = 1;
  let releaseSubmit;
  let interrupts = 0;
  const client = {
    async readEngineState() {
      return { ok: true, revision, state: { isBusy: true, turnLifecycle: { state: "running", turnId: "turn-1" } }, result: null };
    },
    async invokeEngineMethod(input) {
      revision += 1;
      if (input.method === "handleSubmit") {
        await new Promise(resolve => { releaseSubmit = resolve; });
      } else if (input.method === "interruptTurn") {
        interrupts += 1;
        releaseSubmit?.();
      }
      return { ok: true, revision, state: { isBusy: input.method !== "interruptTurn", turnLifecycle: { state: input.method === "interruptTurn" ? "cancelled" : "running", turnId: "turn-1" } }, result: undefined };
    },
  };
  const engine = await createRemoteWorkShellEngine(client, "preemptive-interrupt");
  const turn = engine.handleSubmit("long turn");
  await new Promise(resolve => setImmediate(resolve));
  const interrupted = await Promise.race([
    engine.interruptTurn(),
    new Promise(resolve => setTimeout(() => resolve("blocked"), 100)),
  ]);
  assert.notEqual(interrupted, "blocked");
  assert.equal(interrupts, 1);
  await turn;
  engine.dispose();
});
