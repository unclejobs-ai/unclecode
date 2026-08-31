import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LiveRuntimeEngineRegistry } from "../../apps/unclecode-server/src/runtime-engine-rpc.ts";
import { openRuntimeLedger } from "../../apps/unclecode-server/src/runtime-ledger.ts";
import {
  persistRuntimeAdmissionRevision,
  readRuntimeAdmissionRevision,
} from "../../apps/unclecode-server/src/runtime-admission-ledger.ts";
import { RuntimeSessionMutationArbiter } from "../../apps/unclecode-server/src/runtime-mutation-arbiter.ts";
import { LiveRuntimeControlRegistry } from "../../apps/unclecode-server/src/persistent-runtime.ts";
import { startPersistentRuntimeOwner } from "../../apps/unclecode-server/src/runtime-owner.ts";
import { RuntimeOwnerClient } from "../../apps/unclecode-server/src/runtime-owner-client.ts";
import {
  processStartIdentity,
  readRuntimeOwnerLease,
} from "../../apps/unclecode-server/src/runtime-owner-discovery.ts";
import { attachWorkShellRuntime } from "../../apps/unclecode-server/src/work-shell-control.ts";

function fakeEngine(label) {
  let state = {
    label,
    mode: "standard",
    isBusy: false,
    queuePaused: false,
    model: "test-model",
    uiLocale: "en",
    agentConsole: {},
  };
  const listeners = new Set();
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setMode(mode) { state = { ...state, mode }; for (const listener of listeners) listener(); },
    interruptTurn: () => false,
    getTurnLifecycle: () => ({ state: "idle" }),
    async requestTurnPause() { throw new Error("no active turn"); },
    resumeTurn: () => false,
    async resumeQueueItems() {},
    async handleSubmit() {},
    answerPendingDecisionByIndex: () => false,
    getAgentControlPort: () => ({ async steer() { return { status: "rejected" }; } }),
  };
}

function fakeDecisionEngine(label) {
  let pendingDecision;
  let answerCalls = 0;
  let cancelCalls = 0;
  let textCalls = 0;
  let submitCalls = 0;
  const decision = (id) => ({
    kind: "user-decision",
    id,
    title: id,
    questions: [{
      id: "choice",
      question: "Choose.",
      options: [{ label: "One" }, { label: "Two" }],
    }],
  });
  return {
    get answerCalls() { return answerCalls; },
    get cancelCalls() { return cancelCalls; },
    get textCalls() { return textCalls; },
    get submitCalls() { return submitCalls; },
    get pendingDecisionId() { return pendingDecision?.id; },
    replacePendingDecision(id) { pendingDecision = decision(id); },
    getState: () => ({
      label,
      isBusy: true,
      agentConsole: pendingDecision ? { pendingDecision } : {},
    }),
    subscribe: () => () => {},
    async handleSubmit() {
      submitCalls += 1;
    },
    submitPendingDecisionText(value, decisionId) {
      textCalls += 1;
      if (pendingDecision?.id !== decisionId || typeof value !== "string" || value.trim() === "") return false;
      pendingDecision = undefined;
      return true;
    },
    answerPendingDecisionByIndex(index, decisionId) {
      answerCalls += 1;
      if (pendingDecision?.id !== decisionId || index < 1 || index > 2) return false;
      pendingDecision = undefined;
      return true;
    },
    cancelPendingDecision(decisionId) {
      cancelCalls += 1;
      if (pendingDecision?.id !== decisionId) return false;
      pendingDecision = undefined;
      return true;
    },
  };
}

function fakeAgentSteerEngine(label) {
  let steerCalls = 0;
  let lastMessage;
  const state = {
    label,
    isBusy: true,
    composerMode: "agent-steer",
    agentSteerTarget: { kind: "agent-steer", agentRunId: "run-alpha" },
    agentConsoleView: { open: true, tab: "agents", cursor: 0 },
    agentConsole: { agents: [{ id: "run-alpha", status: "running" }] },
  };
  return {
    get steerCalls() { return steerCalls; },
    get lastMessage() { return lastMessage; },
    getState: () => state,
    subscribe: () => () => {},
    async submitAgentSteer(message) {
      steerCalls += 1;
      lastMessage = message;
    },
  };
}

test("production owner lease publishes its verifiable process-start identity", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-owner-process-start-"));
  const leasePath = join(rootDir, "owner.json");
  let owner;
  try {
    const expectedProcessStartId = await processStartIdentity(process.pid);
    assert.ok(expectedProcessStartId);
    owner = await startPersistentRuntimeOwner({
      rootDir,
      leasePath,
      tokenPath: join(rootDir, "server.token"),
    });

    assert.equal(owner.lease.processStartId, expectedProcessStartId);
    assert.equal((await readRuntimeOwnerLease(leasePath))?.processStartId, expectedProcessStartId);
  } finally {
    await owner?.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("production owner fails closed when its process-start identity is unavailable", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-owner-missing-process-start-"));
  const leasePath = join(rootDir, "owner.json");
  try {
    const settled = await startPersistentRuntimeOwner({
      rootDir,
      leasePath,
      tokenPath: join(rootDir, "server.token"),
      resolveProcessStartIdentity: async () => null,
    }).then(owner => ({ owner }), error => ({ error }));
    if ("owner" in settled) await settled.owner.stop();

    assert.match(settled.error?.message ?? "", /process-start identity/i);
    assert.equal(await readRuntimeOwnerLease(leasePath), null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("production owner fails closed before publishing when its single ledger is corrupt", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-owner-corrupt-ledger-"));
  const ledgerDirectory = join(rootDir, "runtime-owner-v1");
  const leasePath = join(rootDir, "owner.json");
  try {
    await mkdir(ledgerDirectory, { recursive: true });
    await writeFile(join(ledgerDirectory, "owner.db"), "not sqlite");
    await assert.rejects(
      startPersistentRuntimeOwner({
        rootDir,
        leasePath,
        tokenPath: join(rootDir, "server.token"),
      }),
      /runtime ledger/i,
    );
    assert.equal(await readRuntimeOwnerLease(leasePath), null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("owner migrates the legacy revision once and makes SQLite the only admission authority", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-owner-ledger-migration-"));
  const projectPath = join(rootDir, "workspace");
  const sessionId = "legacy-migration";
  let owner;
  try {
    await mkdir(projectPath);
    await persistRuntimeAdmissionRevision({ rootDir, projectPath, sessionId, revision: 37 });
    owner = await startPersistentRuntimeOwner({
      rootDir,
      leasePath: join(rootDir, "owner.json"),
      tokenPath: join(rootDir, "server.token"),
      async createSession(request) {
        return { engine: fakeEngine(request.sessionId), projectPath: request.projectPath };
      },
    });
    const created = await owner.engines.create({ sessionId, projectPath, idempotencyKey: "create-legacy" });
    assert.equal(created.ok, true);
    assert.equal(created.session.revision, 37);
    const changed = await owner.engines.invoke({
      sessionId,
      method: "setMode",
      args: ["deep"],
      expectedRevision: 37,
      idempotencyKey: "first-sqlite-mutation",
    });
    assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.equal(changed.revision, 38);
    await owner.stop();
    owner = undefined;

    const ledger = openRuntimeLedger({ dbPath: join(rootDir, "runtime-owner-v1", "owner.db") });
    assert.equal(ledger.getSessionState(sessionId)?.revision, 38);
    ledger.close();
    assert.equal(
      await readRuntimeAdmissionRevision({ rootDir, projectPath, sessionId }),
      37,
      "new admissions cannot race or overwrite the legacy bootstrap file",
    );
  } finally {
    await owner?.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("owner startup recovers admitted receipts as in-doubt before serving mutations", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-owner-in-doubt-"));
  const projectPath = join(rootDir, "workspace");
  const sessionId = "owner-crash-window";
  const dbPath = join(rootDir, "runtime-owner-v1", "owner.db");
  let ledger = openRuntimeLedger({ dbPath });
  ledger.admitMutation({
    sessionId,
    domain: "runtime-session",
    idempotencyKey: "crashed-mode",
    fingerprint: { method: "setMode", args: ["deep"], expectedRevision: 0 },
  });
  ledger.close();
  let executions = 0;
  let owner;
  try {
    await mkdir(projectPath);
    owner = await startPersistentRuntimeOwner({
      rootDir,
      leasePath: join(rootDir, "owner.json"),
      tokenPath: join(rootDir, "server.token"),
      async createSession(request) {
        const engine = fakeEngine(request.sessionId);
        const original = engine.setMode;
        engine.setMode = mode => { executions += 1; original(mode); };
        return { engine, projectPath: request.projectPath };
      },
    });
    await owner.engines.create({ sessionId, projectPath, idempotencyKey: "create-after-crash" });
    const result = await owner.engines.invoke({
      sessionId,
      method: "setMode",
      args: ["deep"],
      expectedRevision: 0,
      idempotencyKey: "crashed-mode",
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /in.doubt/i);
    assert.equal(executions, 0);
  } finally {
    await owner?.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("owner binds created engines to the same ledger-backed usage recorder", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-owner-usage-binding-"));
  const projectPath = join(rootDir, "workspace");
  let recorder;
  let owner;
  try {
    await mkdir(projectPath);
    owner = await startPersistentRuntimeOwner({
      rootDir,
      leasePath: join(rootDir, "owner.json"),
      tokenPath: join(rootDir, "server.token"),
      async createSession(request) {
        return {
          engine: {
            ...fakeEngine(request.sessionId),
            bindRuntimeUsageRecorder(value) { recorder = value; },
          },
          projectPath: request.projectPath,
        };
      },
    });
    await owner.engines.create({ sessionId: "usage-bound", projectPath, idempotencyKey: "create-usage" });
    assert.ok(recorder);
    const recorded = recorder.recordUsage({
      eventId: "owner-event-1",
      route: { provider: "openai", model: "gpt-5.6-sol" },
      counters: {
        inputTokens: 20,
        outputTokens: 5,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
        cacheSavingsUsd: 0.01,
        costUsd: 0.02,
      },
    });
    assert.equal(recorded.kind, "recorded");
    await owner.stop();
    owner = undefined;

    const ledger = openRuntimeLedger({ dbPath: join(rootDir, "runtime-owner-v1", "owner.db") });
    assert.equal(ledger.snapshotUsageTotals("usage-bound").session.inputTokens, 20);
    ledger.close();
  } finally {
    await owner?.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

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

test("durable receipt replay survives hot eviction and cannot cancel a newer turn", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-receipt-eviction-"));
  const ledger = openRuntimeLedger({ dbPath: join(root, "owner.db") });
  const clock = { value: 0 };
  const arbiter = new RuntimeSessionMutationArbiter(clock, {
    ledger,
    sessionId: "receipt-eviction",
    domain: "runtime-session",
  });
  let releaseOldTurn;
  let releaseNewTurn;
  let cancelCalls = 0;
  const resultCallbacks = {
    conflict: revision => ({ ok: false, code: "conflict", revision }),
    invalidReuse: revision => ({ ok: false, code: "reuse", revision }),
    complete: (output, revision) => ({ ok: true, output, revision }),
    fail: (error, revision) => ({ ok: false, code: error.message, revision }),
  };
  try {
    const oldTurn = arbiter.mutate({
      ...resultCallbacks,
      idempotencyKey: "old-turn",
      fingerprint: { method: "submit", message: "old" },
      expectedRevision: 0,
      execute: () => new Promise(resolve => { releaseOldTurn = resolve; }),
    });
    while (!releaseOldTurn) await new Promise(resolve => setImmediate(resolve));
    const oldCancelInput = {
      ...resultCallbacks,
      idempotencyKey: "cancel-old-turn",
      fingerprint: { method: "cancel", target: "old-turn" },
      expectedRevision: 1,
      lane: "cancel",
      execute() {
        cancelCalls += 1;
        releaseOldTurn("old-cancelled");
        return "cancelled";
      },
    };
    const firstCancel = await arbiter.mutate(oldCancelInput);
    await oldTurn;

    for (let index = 0; index < 2_048; index += 1) {
      const settled = await arbiter.mutate({
        ...resultCallbacks,
        idempotencyKey: `churn-${String(index)}`,
        fingerprint: { method: "control", index },
        expectedRevision: clock.value,
        lane: "control",
        execute: () => index,
      });
      assert.equal(settled.ok, true);
    }

    const newTurn = arbiter.mutate({
      ...resultCallbacks,
      idempotencyKey: "new-turn",
      fingerprint: { method: "submit", message: "new" },
      expectedRevision: clock.value,
      execute: () => new Promise(resolve => { releaseNewTurn = resolve; }),
    });
    while (!releaseNewTurn) await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(await arbiter.mutate(oldCancelInput), firstCancel);
    assert.equal(cancelCalls, 1, "an evicted old cancellation must replay without touching the new turn");
    releaseNewTurn("new-completed");
    assert.equal((await newTurn).ok, true);
  } finally {
    releaseOldTurn?.("cleanup");
    releaseNewTurn?.("cleanup");
    await arbiter.settle();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("durable terminal receipts replay canonically after restart and changed reuse fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-receipt-restart-"));
  const dbPath = join(root, "owner.db");
  let ledger = openRuntimeLedger({ dbPath });
  let executions = 0;
  const callbacks = {
    conflict: revision => ({ ok: false, code: "conflict", revision }),
    invalidReuse: revision => ({ ok: false, code: "reuse", revision }),
    complete: (output, revision) => ({ ok: true, output, revision }),
    fail: (error, revision) => ({ ok: false, code: error.message, revision }),
  };
  const firstArbiter = new RuntimeSessionMutationArbiter({ value: 0 }, {
    ledger,
    sessionId: "restart-terminal",
    domain: "runtime-session",
  });
  const input = {
    ...callbacks,
    idempotencyKey: "canonical-key",
    fingerprint: { method: "setMode", args: [{ alpha: 1, beta: 2 }] },
    expectedRevision: 0,
    execute() { executions += 1; return "deep"; },
  };
  const accepted = await firstArbiter.mutate(input);
  ledger.close();

  ledger = openRuntimeLedger({ dbPath });
  const restarted = new RuntimeSessionMutationArbiter({ value: 0 }, {
    ledger,
    sessionId: "restart-terminal",
    domain: "runtime-session",
  });
  try {
    const replay = await restarted.mutate({
      ...input,
      fingerprint: { args: [{ beta: 2, alpha: 1 }], method: "setMode" },
      execute() { executions += 1; return "must-not-run"; },
    });
    assert.deepEqual(replay, accepted);
    assert.equal(executions, 1);
    const changed = await restarted.mutate({ ...input, fingerprint: { method: "setMode", args: ["minimal"] } });
    assert.equal(changed.ok, false);
    assert.equal(changed.code, "reuse");
    assert.equal(executions, 1);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("crash-window admission becomes in-doubt and is never automatically re-executed", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-receipt-in-doubt-"));
  const dbPath = join(root, "owner.db");
  let ledger = openRuntimeLedger({ dbPath });
  ledger.admitMutation({
    sessionId: "crash-window",
    domain: "runtime-session",
    idempotencyKey: "admitted-before-crash",
    fingerprint: { method: "handleSubmit", args: ["ship"] },
  });
  ledger.close();
  ledger = openRuntimeLedger({ dbPath });
  assert.equal(ledger.recoverInDoubt(), 1);
  let executions = 0;
  const arbiter = new RuntimeSessionMutationArbiter({ value: 0 }, {
    ledger,
    sessionId: "crash-window",
    domain: "runtime-session",
  });
  try {
    const result = await arbiter.mutate({
      idempotencyKey: "admitted-before-crash",
      fingerprint: { args: ["ship"], method: "handleSubmit" },
      expectedRevision: 0,
      execute() { executions += 1; },
      conflict: revision => ({ ok: false, code: "conflict", revision }),
      invalidReuse: revision => ({ ok: false, code: "reuse", revision }),
      complete: (_output, revision) => ({ ok: true, revision }),
      fail: (error, revision) => ({ ok: false, code: error.message, revision }),
    });
    assert.equal(result.ok, false);
    assert.match(result.code, /in.doubt/i);
    assert.equal(result.revision, 1);
    assert.equal(executions, 0);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
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

test("owner admission stays bounded by a tiny durable reservation instead of the full transcript checkpoint", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-owner-admission-latency-"));
  const projectPath = join(rootDir, "workspace");
  const transcript = Array.from({ length: 10_000 }, (_, index) => ({
    role: "assistant",
    text: `${index}:${"x".repeat(240)}`,
  }));
  const transcriptBytes = Buffer.byteLength(JSON.stringify(transcript));
  let legacyCheckpointCalls = 0;
  let owner;
  try {
    await mkdir(projectPath);
    const engine = fakeEngine("large-transcript");
    engine.getState = () => ({ label: "large-transcript", mode: "standard", transcript });
    engine.setMode = () => {};
    engine.persistRuntimeRevision = async () => {
      legacyCheckpointCalls += 1;
      await new Promise(() => {});
    };
    owner = await startPersistentRuntimeOwner({
      rootDir,
      leasePath: join(rootDir, "owner.json"),
      tokenPath: join(rootDir, "server.token"),
      async createSession() { return { engine, projectPath }; },
    });
    const created = await owner.engines.create({
      sessionId: "large-transcript",
      projectPath,
      idempotencyKey: "create-large-transcript",
    });
    assert.equal(created.ok, true);

    const admissionStarted = performance.now();
    const admitted = await Promise.race([
      owner.engines.invoke({
        sessionId: "large-transcript",
        method: "setMode",
        args: ["deep"],
        expectedRevision: 0,
        idempotencyKey: "bounded-admission",
      }),
      new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 500)),
    ]);
    const admissionElapsedMs = performance.now() - admissionStarted;

    assert.equal(transcript.length, 10_000);
    assert.ok(transcriptBytes > 2_000_000, `the proof must exercise a nontrivial transcript; got ${transcriptBytes} bytes`);
    assert.equal(admitted.timedOut, undefined, "durable admission must finish within 500ms");
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.equal("state" in admitted, false, "mutation receipts cannot embed the full live engine projection");
    const receiptBytes = Buffer.byteLength(JSON.stringify(admitted));
    assert.ok(receiptBytes < 256, "the terminal receipt must remain tiny");
    t.diagnostic(`admission_latency elapsed_ms=${admissionElapsedMs.toFixed(3)} upper_bound_ms=500 transcript_bytes=${transcriptBytes} receipt_bytes=${receiptBytes}`);
    assert.equal(legacyCheckpointCalls, 0, "admission cannot call the full session/Agent Console checkpoint hook");

    await owner.stop();
    owner = undefined;
    let replayExecutions = 0;
    const replayEngine = fakeEngine("large-transcript-replay");
    replayEngine.getState = () => ({ label: "large-transcript-replay", mode: "standard", transcript });
    replayEngine.setMode = () => { replayExecutions += 1; };
    owner = await startPersistentRuntimeOwner({
      rootDir,
      leasePath: join(rootDir, "owner.json"),
      tokenPath: join(rootDir, "server.token"),
      async createSession() { return { engine: replayEngine, projectPath }; },
    });
    const recreated = await owner.engines.create({
      sessionId: "large-transcript",
      projectPath,
      idempotencyKey: "recreate-large-transcript",
    });
    assert.equal(recreated.ok, true);
    const replayed = await owner.engines.invoke({
      sessionId: "large-transcript",
      method: "setMode",
      args: ["deep"],
      expectedRevision: 0,
      idempotencyKey: "bounded-admission",
    });
    assert.deepEqual(replayed, admitted, "restart replay must return the exact bounded semantic result");
    assert.equal(replayExecutions, 0, "restart replay cannot execute the engine mutation again");
  } finally {
    await owner?.stop().catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true });
  }
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

test("idle pause fails precondition without reserving or publishing a revision", async () => {
  const persisted = [];
  const clock = { value: 0 };
  const arbiter = new RuntimeSessionMutationArbiter(clock, {
    async persistAcceptedRevision(revision) { persisted.push(revision); },
  });
  const controls = new LiveRuntimeControlRegistry();
  const engine = {
    getState: () => ({ isBusy: false, queuePaused: false, model: "test", mode: "standard", uiLocale: "en", agentConsole: {} }),
    subscribe: () => () => {},
    getTurnLifecycle: () => ({ state: "idle" }),
    async requestTurnPause() { throw new Error("idle pause must not execute"); },
    resumeTurn: () => false,
    interruptTurn: () => false,
    async resumeQueueItems() {},
    async handleSubmit() {},
    answerPendingDecisionByIndex: () => false,
    getAgentControlPort: () => ({ async steer() { return { status: "not_delivered" }; } }),
  };
  attachWorkShellRuntime(controls, {
    sessionId: "idle-pause",
    projectPath: "/work/idle-pause",
    engine,
    revisionClock: clock,
    mutationArbiter: arbiter,
  });

  const result = await controls.control({
    sessionId: "idle-pause",
    action: "pause",
    expectedRevision: 0,
    idempotencyKey: "idle-pause",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_action");
  assert.equal(result.revision, 0);
  assert.equal(clock.value, 0);
  assert.deepEqual(persisted, []);
});

test("idle engine RPC cancel is rejected before admission without consuming a revision", async () => {
  let interruptCalls = 0;
  const clock = { value: 0 };
  const engines = new LiveRuntimeEngineRegistry();
  const engine = fakeEngine("idle-rpc-cancel");
  engine.interruptTurn = () => {
    interruptCalls += 1;
    return false;
  };
  engines.attach("idle-rpc-cancel", engine, {
    projectPath: "/work/idle-rpc-cancel",
    revisionClock: clock,
  });

  const result = await engines.invoke({
    sessionId: "idle-rpc-cancel",
    method: "interruptTurn",
    args: [],
    expectedRevision: 0,
    idempotencyKey: "idle-rpc-cancel",
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_action");
  assert.equal(result.revision, 0);
  assert.equal(clock.value, 0);
  assert.equal(interruptCalls, 0, "the idle interrupt must be rejected before execution");
  await engines.disposeAll();
});

test("decision RPC schema and identity reject delayed A controls after B replaces it at the same revision", async () => {
  const clock = { value: 0 };
  const engines = new LiveRuntimeEngineRegistry();
  const engine = fakeDecisionEngine("direct-decision-race");
  engines.attach("direct-decision-race", engine, {
    projectPath: "/work/direct-decision-race",
    revisionClock: clock,
  });
  engine.replacePendingDecision("decision-a");
  engine.replacePendingDecision("decision-b");

  const invoke = (method, args, idempotencyKey) => engines.invoke({
    sessionId: "direct-decision-race",
    method,
    args,
    expectedRevision: 0,
    idempotencyKey,
  });
  for (const [method, args, key] of [
    ["answerPendingDecisionByIndex", [1], "missing-answer-id"],
    ["answerPendingDecisionByIndex", [0, "decision-b"], "unsafe-answer-index"],
    ["answerPendingDecisionByIndex", [1, " "], "blank-answer-id"],
    ["answerPendingDecisionByIndex", [1, "x".repeat(161)], "oversized-answer-id"],
    ["cancelPendingDecision", [], "missing-cancel-id"],
    ["cancelPendingDecision", [""], "blank-cancel-id"],
  ]) {
    const rejected = await invoke(method, args, key);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "invalid_action");
    assert.equal(rejected.revision, 0);
  }

  const delayedAnswer = await invoke(
    "answerPendingDecisionByIndex",
    [1, "decision-a"],
    "delayed-answer-a",
  );
  const delayedCancel = await invoke(
    "cancelPendingDecision",
    ["decision-a"],
    "delayed-cancel-a",
  );
  assert.equal(delayedAnswer.ok, false);
  assert.equal(delayedCancel.ok, false);
  assert.equal(delayedAnswer.revision, 0);
  assert.equal(delayedCancel.revision, 0);
  assert.equal(engine.pendingDecisionId, "decision-b");
  assert.equal(engine.answerCalls, 0);
  assert.equal(engine.cancelCalls, 0);
  assert.equal(clock.value, 0);

  const accepted = await invoke(
    "answerPendingDecisionByIndex",
    [2, "decision-b"],
    "answer-b",
  );
  assert.equal(accepted.ok, true);
  assert.equal(accepted.result, true);
  assert.equal(accepted.revision, 1);
  assert.equal(engine.pendingDecisionId, undefined);
  assert.equal(engine.answerCalls, 1);
  await engines.disposeAll();
});

test("steer submit rebases across autonomous revisions only for its bound run identity", async () => {
  const clock = { value: 4 };
  const engines = new LiveRuntimeEngineRegistry();
  const engine = fakeAgentSteerEngine("steer-revision-race");
  engines.attach("steer-revision-race", engine, {
    projectPath: "/work/steer-revision-race",
    revisionClock: clock,
  });

  clock.value = 5;
  const accepted = await engines.invoke({
    sessionId: "steer-revision-race",
    method: "submitAgentSteer",
    args: ["narrow the diff", "run-alpha"],
    expectedRevision: 4,
    idempotencyKey: "steer-run-alpha",
  });

  assert.equal(accepted.ok, true);
  assert.equal(engine.steerCalls, 1);
  assert.equal(engine.lastMessage, "narrow the diff");
  await engines.disposeAll();
});

test("steer submit rejects a replaced run identity without reporting false success", async () => {
  const clock = { value: 5 };
  const engines = new LiveRuntimeEngineRegistry();
  const engine = fakeAgentSteerEngine("steer-replaced-target");
  engines.attach("steer-replaced-target", engine, {
    projectPath: "/work/steer-replaced-target",
    revisionClock: clock,
  });

  const rejected = await engines.invoke({
    sessionId: "steer-replaced-target",
    method: "submitAgentSteer",
    args: ["do not retarget", "run-beta"],
    expectedRevision: 5,
    idempotencyKey: "steer-stale-run-beta",
  });

  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "invalid_action");
  assert.equal(engine.steerCalls, 0);
  await engines.disposeAll();
});

test("legacy one-argument steer remains valid only at its exact owner revision", async () => {
  const clock = { value: 6 };
  const engines = new LiveRuntimeEngineRegistry();
  const engine = fakeAgentSteerEngine("legacy-steer");
  engines.attach("legacy-steer", engine, {
    projectPath: "/work/legacy-steer",
    revisionClock: clock,
  });

  const accepted = await engines.invoke({
    sessionId: "legacy-steer",
    method: "submitAgentSteer",
    args: ["legacy exact steer"],
    expectedRevision: 6,
    idempotencyKey: "legacy-steer-exact-revision",
  });

  assert.equal(accepted.ok, true);
  assert.equal(engine.steerCalls, 1);
  assert.equal(engine.lastMessage, "legacy exact steer");
  await engines.disposeAll();
});

test("owner HTTP RPC keeps replacement decision B pending for delayed A answer and cancel", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-owner-decision-race-"));
  const projectPath = join(rootDir, "workspace");
  const engine = fakeDecisionEngine("http-decision-race");
  await mkdir(projectPath);
  const owner = await startPersistentRuntimeOwner({
    rootDir,
    leasePath: join(rootDir, "owner.json"),
    tokenPath: join(rootDir, "server.token"),
    async createSession() {
      return { engine, projectPath };
    },
  });
  t.after(async () => {
    await owner.stop();
    await rm(rootDir, { recursive: true, force: true });
  });
  const client = await RuntimeOwnerClient.connect(owner.lease);
  const created = await client.createRuntimeSession({
    sessionId: "http-decision-race",
    projectPath,
    idempotencyKey: "create-http-decision-race",
  });
  assert.equal(created.ok, true);
  engine.replacePendingDecision("decision-a");
  engine.replacePendingDecision("decision-b");

  const delayedAnswer = await client.invokeEngineMethod({
    sessionId: "http-decision-race",
    method: "answerPendingDecisionByIndex",
    args: [1, "decision-a"],
    expectedRevision: 0,
    idempotencyKey: "http-delayed-answer-a",
  });
  const delayedCancel = await client.invokeEngineMethod({
    sessionId: "http-decision-race",
    method: "cancelPendingDecision",
    args: ["decision-a"],
    expectedRevision: 0,
    idempotencyKey: "http-delayed-cancel-a",
  });
  const stateAfterStaleControls = await client.readEngineState("http-decision-race");

  assert.equal(delayedAnswer.ok, false);
  assert.equal(delayedCancel.ok, false);
  assert.equal(delayedAnswer.revision, 0);
  assert.equal(delayedCancel.revision, 0);
  assert.equal(stateAfterStaleControls.ok, true);
  assert.equal(stateAfterStaleControls.revision, 0);
  assert.equal(stateAfterStaleControls.state.agentConsole.pendingDecision.id, "decision-b");
  assert.equal(engine.answerCalls, 0);
  assert.equal(engine.cancelCalls, 0);

  const accepted = await client.invokeEngineMethod({
    sessionId: "http-decision-race",
    method: "cancelPendingDecision",
    args: ["decision-b"],
    expectedRevision: 0,
    idempotencyKey: "http-cancel-b",
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.result, true);
  assert.equal(accepted.revision, 1);
  assert.equal(engine.pendingDecisionId, undefined);
  assert.equal(engine.cancelCalls, 1);
});

test("owner HTTP RPC keeps replacement decision B pending for delayed typed text from A", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-owner-decision-text-race-"));
  const projectPath = join(rootDir, "workspace");
  const engine = fakeDecisionEngine("http-decision-text-race");
  await mkdir(projectPath);
  const owner = await startPersistentRuntimeOwner({
    rootDir,
    leasePath: join(rootDir, "owner.json"),
    tokenPath: join(rootDir, "server.token"),
    async createSession() {
      return { engine, projectPath };
    },
  });
  t.after(async () => {
    await owner.stop();
    await rm(rootDir, { recursive: true, force: true });
  });
  const client = await RuntimeOwnerClient.connect(owner.lease);
  const created = await client.createRuntimeSession({
    sessionId: "http-decision-text-race",
    projectPath,
    idempotencyKey: "create-http-decision-text-race",
  });
  assert.equal(created.ok, true);
  engine.replacePendingDecision("decision-a");
  engine.replacePendingDecision("decision-b");

  const stale = await client.invokeEngineMethod({
    sessionId: "http-decision-text-race",
    method: "submitPendingDecisionText",
    args: ["choice: 1", "decision-a"],
    expectedRevision: 0,
    idempotencyKey: "http-delayed-text-a",
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "invalid_action");
  assert.equal(stale.revision, 0);
  assert.equal(engine.pendingDecisionId, "decision-b");
  assert.equal(engine.textCalls, 0, "a stale identity must fail before engine dispatch");

  const generic = await client.invokeEngineMethod({
    sessionId: "http-decision-text-race",
    method: "handleSubmit",
    args: ["choice: 1"],
    expectedRevision: 0,
    idempotencyKey: "http-generic-text-without-id",
  });
  assert.equal(generic.ok, false);
  assert.equal(generic.code, "invalid_action");
  assert.equal(generic.revision, 0);
  assert.equal(engine.pendingDecisionId, "decision-b");
  assert.equal(engine.submitCalls, 0, "generic prompt RPC must not target a pending decision");

  const accepted = await client.invokeEngineMethod({
    sessionId: "http-decision-text-race",
    method: "submitPendingDecisionText",
    args: ["choice: 2", "decision-b"],
    expectedRevision: 0,
    idempotencyKey: "http-text-b",
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.result, true);
  assert.equal(accepted.revision, 1);
  assert.equal(engine.pendingDecisionId, undefined);
  assert.equal(engine.textCalls, 1);
});

test("timed-out admission persistence leaves the revision unpublished and releases the admission tail", async () => {
  let persistenceCalls = 0;
  let timedOutSignal;
  let engineCalls = 0;
  const clock = { value: 3 };
  const arbiter = new RuntimeSessionMutationArbiter(clock, {
    persistAcceptedRevisionTimeoutMs: 20,
    async persistAcceptedRevision(_revision, signal) {
      persistenceCalls += 1;
      if (persistenceCalls === 1) {
        timedOutSignal = signal;
        await new Promise(() => {});
      }
    },
  });
  const mutate = (idempotencyKey, expectedRevision) => arbiter.mutate({
    idempotencyKey,
    fingerprint: idempotencyKey,
    expectedRevision,
    execute() { engineCalls += 1; return idempotencyKey; },
    conflict: revision => ({ ok: false, code: "conflict", revision }),
    invalidReuse: revision => ({ ok: false, code: "reuse", revision }),
    complete: (output, revision) => ({ ok: true, output, revision }),
    fail: (error, revision) => ({ ok: false, code: error.message, revision }),
  });

  const timedOut = await Promise.race([
    mutate("stuck-persistence", 3),
    new Promise(resolve => setTimeout(() => resolve({ ok: false, code: "test deadline", revision: clock.value }), 100)),
  ]);
  assert.deepEqual(timedOut, {
    ok: false,
    code: "Runtime admission persistence timed out after 20ms.",
    revision: 3,
  });
  assert.equal(clock.value, 3);
  assert.equal(timedOutSignal?.aborted, true, "timeout must fence a late atomic rename from regressing the ledger");
  assert.equal(engineCalls, 0);

  assert.deepEqual(await mutate("after-timeout", 3), {
    ok: true,
    output: "after-timeout",
    revision: 4,
  });
  assert.equal(engineCalls, 1);
});

test("runtime RPC factory and method failures use the same bounded secret redaction", async () => {
  const secret = "sk-runtime-" + "A".repeat(80);
  const longTail = "z".repeat(2_000);
  const factoryRegistry = new LiveRuntimeEngineRegistry({
    async createSession() {
      throw new Error(`token=${secret} ${longTail}`);
    },
  });
  const factoryResult = await factoryRegistry.create({
    sessionId: "redacted-factory",
    projectPath: "/workspace/redacted",
    idempotencyKey: "redacted-factory",
  });
  assert.equal(factoryResult.ok, false);
  assert.doesNotMatch(factoryResult.message, /sk-runtime|AAAA/);
  assert.match(factoryResult.message, /\[REDACTED\]/);
  assert.ok(factoryResult.message.length <= 512);

  const methodRegistry = new LiveRuntimeEngineRegistry();
  const engine = fakeEngine("redacted-method");
  engine.setMode = () => { throw new Error(`api_key:${secret} ${longTail}`); };
  methodRegistry.attach("redacted-method", engine, { projectPath: "/workspace/redacted" });
  const methodResult = await methodRegistry.invoke({
    sessionId: "redacted-method",
    method: "setMode",
    args: ["deep"],
    expectedRevision: 0,
    idempotencyKey: "redacted-method",
  });
  assert.equal(methodResult.ok, false);
  assert.doesNotMatch(methodResult.message, /sk-runtime|AAAA/);
  assert.match(methodResult.message, /\[REDACTED\]/);
  assert.ok(methodResult.message.length <= 512);
  await methodRegistry.disposeAll();
});

test("runtime RPC failure serialization survives hostile string coercion without leaking its payload", async () => {
  const maliciousFailure = {
    toString() {
      throw new Error("token=sk-should-never-reach-the-client");
    },
  };
  const registry = new LiveRuntimeEngineRegistry({
    async createSession() {
      throw maliciousFailure;
    },
  });

  const result = await registry.create({
    sessionId: "hostile-error-coercion",
    projectPath: "/workspace/redacted",
    idempotencyKey: "hostile-error-coercion",
  });

  assert.deepEqual(result, {
    ok: false,
    code: "invalid_action",
    message: "Runtime operation failed.",
  });
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

  let releaseNewTurn;
  const newTurn = arbiter.mutate({
    idempotencyKey: "new-active-turn",
    fingerprint: { method: "submit", target: "new-turn" },
    expectedRevision: clock.value,
    execute: () => new Promise(resolve => { releaseNewTurn = resolve; }),
    conflict: revision => ({ ok: false, code: "conflict", revision }),
    invalidReuse: revision => ({ ok: false, code: "reuse", revision }),
    complete: (output, revision) => ({ ok: true, output, revision }),
    fail: (error, revision) => ({ ok: false, code: error.message, revision }),
  });
  while (!releaseNewTurn) await new Promise(resolve => setImmediate(resolve));
  const beforeWrongCancel = clock.value;
  const wrongGeneration = await arbiter.mutate({
    idempotencyKey: "wrong-generation-cancel",
    fingerprint: { method: "cancel", target: "old-turn" },
    expectedRevision: 11,
    lane: "cancel",
    execute() { cancelled += 1; return "must-not-cancel"; },
    conflict: revision => ({ ok: false, code: "conflict", revision }),
    invalidReuse: revision => ({ ok: false, code: "reuse", revision }),
    complete: (output, revision) => ({ ok: true, output, revision }),
    fail: (error, revision) => ({ ok: false, code: error.message, revision }),
  });
  assert.equal(wrongGeneration.ok, false);
  assert.equal(wrongGeneration.code, "conflict");
  assert.equal(clock.value, beforeWrongCancel, "an old-turn cancellation cannot reserve a new-turn revision");
  assert.equal(cancelled, 1);
  releaseNewTurn("completed");
  await newTurn;
});

test("cancel queued during durable submit admission executes before provider start", async () => {
  let markSubmitPersistenceStarted;
  const submitPersistenceStarted = new Promise(resolve => { markSubmitPersistenceStarted = resolve; });
  let releaseSubmitPersistence;
  const submitPersistenceGate = new Promise(resolve => { releaseSubmitPersistence = resolve; });
  const order = [];
  const clock = { value: 0 };
  const arbiter = new RuntimeSessionMutationArbiter(clock, {
    async persistAcceptedRevision(revision) {
      if (revision === 1) {
        markSubmitPersistenceStarted();
        await submitPersistenceGate;
      }
    },
  });
  const submit = arbiter.mutate({
    idempotencyKey: "persisting-submit",
    fingerprint: "submit",
    expectedRevision: 0,
    onAdmitted() { order.push("submit-admitted"); },
    execute() { order.push("provider-started"); return "submitted"; },
    conflict: revision => ({ ok: false, code: "conflict", revision }),
    invalidReuse: revision => ({ ok: false, code: "reuse", revision }),
    complete: (output, revision) => ({ ok: true, output, revision }),
    fail: (error, revision) => ({ ok: false, code: error.message, revision }),
  });
  await submitPersistenceStarted;
  const cancel = arbiter.mutate({
    idempotencyKey: "cancel-persisting-submit",
    fingerprint: "cancel",
    expectedRevision: 0,
    lane: "cancel",
    execute() { order.push("cancelled"); return "cancelled"; },
    conflict: revision => ({ ok: false, code: "conflict", revision }),
    invalidReuse: revision => ({ ok: false, code: "reuse", revision }),
    complete: (output, revision) => ({ ok: true, output, revision }),
    fail: (error, revision) => ({ ok: false, code: error.message, revision }),
  });

  releaseSubmitPersistence();
  const [submitResult, cancelResult] = await Promise.all([submit, cancel]);
  assert.equal(submitResult.ok, true);
  assert.equal(cancelResult.ok, true);
  assert.deepEqual(order, ["submit-admitted", "cancelled", "provider-started"]);
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

test("idle owner sessions use one teardown path and remain bounded across 2.5k churn", { timeout: 30_000 }, async () => {
  let disposed = 0;
  const registry = new LiveRuntimeEngineRegistry({
    maxIdleSessions: 32,
    async createSession(input) {
      return {
        engine: fakeEngine(input.sessionId),
        projectPath: input.projectPath,
        dispose() { disposed += 1; },
      };
    },
  });
  for (let index = 0; index < 2_500; index += 1) {
    const created = await registry.create({
      sessionId: `churn-${String(index)}`,
      projectPath: `/work/${String(index)}`,
      idempotencyKey: `create-${String(index)}`,
    });
    assert.equal(created.ok, true);
  }
  await registry.settleTeardowns();
  assert.ok(registry.list().length <= 32, `idle registry retained ${String(registry.list().length)} sessions`);
  assert.ok(disposed >= 2_468, `only ${String(disposed)} idle sessions were disposed`);
  await registry.disposeAll();
});

test("hard session capacity rejects before factory allocation while a client lease is protected", { timeout: 30_000 }, async () => {
  let factoryCalls = 0;
  const disposed = [];
  const registry = new LiveRuntimeEngineRegistry({
    maxIdleSessions: 32,
    maxTotalSessions: 1,
    async createSession(input) {
      factoryCalls += 1;
      return {
        engine: fakeEngine(input.sessionId),
        projectPath: input.projectPath,
        dispose() { disposed.push(input.sessionId); },
      };
    },
  });
  const first = await registry.create({
    sessionId: "protected-a",
    projectPath: "/work/a",
    idempotencyKey: "create-a",
  });
  assert.equal(first.ok, true);
  assert.equal(registry.attachSession("protected-a").ok, true);

  const rejectedPromise = registry.create({
    sessionId: "rejected-b",
    projectPath: "/work/b",
    idempotencyKey: "create-b-rejected",
  });
  assert.equal(registry.create({
    sessionId: "rejected-b",
    projectPath: "/work/b",
    idempotencyKey: "create-b-rejected",
  }), rejectedPromise, "a rejected admission remains idempotent");
  const rejected = await rejectedPromise;
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "invalid_action");
  assert.match(rejected.message, /capacity/i);

  let lastAttempt;
  for (let index = 0; index < 100_000; index += 1) {
    lastAttempt = registry.create({
      sessionId: `overflow-${index}`,
      projectPath: `/work/overflow-${index}`,
      idempotencyKey: `overflow-${index}`,
    });
  }
  assert.equal((await lastAttempt).ok, false);
  assert.equal(factoryCalls, 1, "known capacity exhaustion must not allocate another engine");
  assert.deepEqual(registry.list().map(session => session.sessionId), ["protected-a"]);
  assert.equal(registry.read("protected-a").ok, true, "the leased session must remain usable");
  assert.deepEqual(disposed, []);

  assert.equal(await registry.releaseSession("protected-a"), true);
  const admitted = await registry.create({
    sessionId: "rejected-b",
    projectPath: "/work/b",
    idempotencyKey: "create-b-after-release",
  });
  assert.equal(admitted.ok, true);
  assert.equal(factoryCalls, 2);
  assert.deepEqual(registry.list().map(session => session.sessionId), ["rejected-b"]);
  assert.deepEqual(disposed, ["protected-a"]);
  await registry.disposeAll();
});

test("hard session capacity never evicts active mutation work", async () => {
  let releaseTurn;
  const disposed = [];
  const registry = new LiveRuntimeEngineRegistry({
    maxTotalSessions: 1,
    async createSession(input) {
      const engine = fakeEngine(input.sessionId);
      if (input.sessionId === "active-a") {
        engine.setMode = async () => new Promise(resolve => { releaseTurn = resolve; });
      }
      return {
        engine,
        projectPath: input.projectPath,
        dispose() { disposed.push(input.sessionId); },
      };
    },
  });
  assert.equal((await registry.create({
    sessionId: "active-a",
    projectPath: "/work/active-a",
    idempotencyKey: "create-active-a",
  })).ok, true);
  const activeTurn = registry.invoke({
    sessionId: "active-a",
    method: "setMode",
    args: ["deep"],
    expectedRevision: 0,
    idempotencyKey: "active-a-turn",
  });
  while (!releaseTurn) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await registry.releaseSession("active-a"), false, "release cannot retire active work");

  const rejected = await registry.create({
    sessionId: "waiting-b",
    projectPath: "/work/waiting-b",
    idempotencyKey: "create-b-while-active",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /capacity/i);
  assert.equal(registry.read("active-a").ok, true);
  assert.deepEqual(disposed, []);

  assert.ok(releaseTurn);
  releaseTurn();
  await activeTurn;
  await registry.releaseSession("active-a");
  assert.equal((await registry.create({
    sessionId: "waiting-b",
    projectPath: "/work/waiting-b",
    idempotencyKey: "create-b-after-active",
  })).ok, true);
  assert.deepEqual(registry.list().map(session => session.sessionId), ["waiting-b"]);
  assert.ok(disposed.includes("active-a"));
  await registry.disposeAll();
});

test("hard session capacity reserves pending factory slots and bounds direct attachment", async () => {
  let resolveFirst;
  let factoryCalls = 0;
  const registry = new LiveRuntimeEngineRegistry({
    maxTotalSessions: 1,
    createSession(input) {
      factoryCalls += 1;
      return new Promise(resolve => {
        resolveFirst = () => resolve({ engine: fakeEngine(input.sessionId), projectPath: input.projectPath });
      });
    },
  });
  const pending = registry.create({
    sessionId: "pending-a",
    projectPath: "/work/pending-a",
    idempotencyKey: "create-pending-a",
  });
  const rejected = await registry.create({
    sessionId: "pending-b",
    projectPath: "/work/pending-b",
    idempotencyKey: "create-pending-b",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /capacity/i);
  assert.equal(factoryCalls, 1);
  assert.throws(
    () => registry.attach("direct-b", fakeEngine("direct-b"), { projectPath: "/work/direct-b" }),
    /capacity/i,
  );

  resolveFirst();
  assert.equal((await pending).ok, true);
  assert.equal(registry.list().length, 1, "session listing cannot exceed the configured hard capacity");
  await registry.disposeAll();
});

test("runtime session listing has an absolute 2,048-item response bound", async () => {
  const registry = new LiveRuntimeEngineRegistry({
    maxIdleSessions: Number.MAX_SAFE_INTEGER,
    maxTotalSessions: Number.MAX_SAFE_INTEGER,
  });
  for (let index = 0; index < 2_049; index += 1) {
    registry.attach(`listed-${index}`, fakeEngine(`listed-${index}`), {
      projectPath: `/work/listed-${index}`,
    });
  }

  const listed = registry.list();
  assert.equal(listed.length, 2_048);
  assert.equal(listed.some(session => session.sessionId === "listed-0"), false);
  assert.equal(listed.some(session => session.sessionId === "listed-2048"), true);
  await registry.disposeAll();
});

test("factory completion rejected by cleanup quarantine cannot strand creation admission", async () => {
  let resolveFactory;
  let releaseAttachedDisposer;
  let releaseCreatedDisposer;
  let createdDisposerSignal;
  const factoryGate = new Promise(resolve => { resolveFactory = resolve; });
  const registry = new LiveRuntimeEngineRegistry({
    maxTotalSessions: 2,
    teardownTimeoutMs: 25,
    async createSession(input) {
      await factoryGate;
      return {
        engine: fakeEngine(input.sessionId),
        projectPath: input.projectPath,
        dispose(signal) {
          createdDisposerSignal = signal;
          return new Promise(resolve => { releaseCreatedDisposer = resolve; });
        },
      };
    },
  });
  registry.attach("hung-attached", fakeEngine("hung-attached"), {
    projectPath: "/work/hung-attached",
    dispose: () => new Promise(resolve => { releaseAttachedDisposer = resolve; }),
  });
  const creating = registry.create({
    sessionId: "late-created",
    projectPath: "/work/late-created",
    idempotencyKey: "create-late-created",
  });
  await assert.rejects(registry.releaseSession("hung-attached"), /timed out/i);
  resolveFactory();

  const outcome = await Promise.race([
    creating,
    new Promise(resolve => setTimeout(() => resolve("creation-stuck"), 250)),
  ]);
  assert.notEqual(outcome, "creation-stuck", "cleanup must not strand the creation receipt or reservation");
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /quarantined/i);
  assert.equal(createdDisposerSignal?.aborted, true);
  assert.equal(registry.systemSnapshot().engines.pendingCreations, 0);
  assert.equal(registry.systemSnapshot().engines.pendingTeardowns, 2);

  releaseAttachedDisposer();
  releaseCreatedDisposer();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registry.systemSnapshot().engines.pendingTeardowns, 0);
  await assert.rejects(registry.settleTeardowns(), /timed out/i);
  await registry.disposeAll();
});

test("bounded idle teardown never evicts an active turn or an attached client", async () => {
  let releaseTurn;
  const disposed = [];
  const registry = new LiveRuntimeEngineRegistry({
    maxIdleSessions: 1,
    async createSession(input) {
      const engine = fakeEngine(input.sessionId);
      if (input.sessionId === "active-turn") {
        engine.setMode = async () => new Promise(resolve => { releaseTurn = resolve; });
      }
      return {
        engine,
        projectPath: input.projectPath,
        dispose() { disposed.push(input.sessionId); },
      };
    },
  });
  await registry.create({ sessionId: "attached-client", projectPath: "/work/client", idempotencyKey: "create-client" });
  assert.equal(registry.attachSession("attached-client").ok, true);
  await registry.create({ sessionId: "active-turn", projectPath: "/work/active", idempotencyKey: "create-active" });
  const turn = registry.invoke({
    sessionId: "active-turn",
    method: "setMode",
    args: ["deep"],
    expectedRevision: 0,
    idempotencyKey: "active-call",
  });
  while (!releaseTurn) await new Promise(resolve => setImmediate(resolve));
  await registry.create({ sessionId: "idle-candidate", projectPath: "/work/idle", idempotencyKey: "create-idle" });
  await registry.settleTeardowns();
  assert.equal(registry.read("active-turn").ok, true, "active provider/tool work cannot be evicted");
  assert.equal(registry.attachSession("attached-client").ok, true, "an attached client lease cannot be evicted");

  releaseTurn();
  await turn;
  assert.equal(await registry.releaseSession("attached-client"), true);
  assert.ok(disposed.includes("attached-client"));
  await registry.disposeAll();
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

test("a busy follow-up reaches the engine before the active submit settles", async () => {
  const listeners = new Set();
  let releaseTurn;
  let markTurnStarted;
  const turnStarted = new Promise(resolve => { markTurnStarted = resolve; });
  const submissions = [];
  const engine = {
    // Deliberately keep the projection idle. Admission itself is the
    // authoritative signal that a second submit is a follow-up; waiting for
    // a later busy render strands it behind the first long receipt.
    getState: () => ({ isBusy: false, queuePaused: false, model: "test", mode: "standard", uiLocale: "en", agentConsole: {} }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    admitRuntimeTurn() {},
    async handleSubmit(value) {
      submissions.push(value);
      if (value === "first") {
        markTurnStarted();
        await new Promise(resolve => { releaseTurn = resolve; });
      }
    },
  };
  const registry = new LiveRuntimeEngineRegistry();
  registry.attach("busy-follow-up", engine, { projectPath: "/work/busy-follow-up" });

  const first = registry.invoke({
    sessionId: "busy-follow-up", method: "handleSubmit", args: ["first"],
    expectedRevision: 0, idempotencyKey: "busy-first",
  });
  await turnStarted;
  const followUp = registry.invoke({
    sessionId: "busy-follow-up", method: "handleSubmit", args: ["follow-up"],
    expectedRevision: 1, idempotencyKey: "busy-follow-up",
  });
  const admittedWhileBusy = await Promise.race([
    followUp.then(result => result.ok),
    new Promise(resolve => setTimeout(() => resolve(false), 100)),
  ]);

  assert.equal(admittedWhileBusy, true, "busy follow-up admission must not wait for provider/post-turn settlement");
  assert.deepEqual(submissions, ["first", "follow-up"]);
  releaseTurn();
  assert.equal((await first).ok, true);
  await registry.disposeAll();
});

test("a busy follow-up rebases across repeated autonomous revisions without duplicate execution", async () => {
  const listeners = new Set();
  const submissions = [];
  const engine = {
    getState: () => ({ isBusy: true, queuePaused: false, model: "test", mode: "standard", uiLocale: "en", agentConsole: {} }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    admitRuntimeTurn() {},
    async handleSubmit(value) { submissions.push(value); },
  };
  const registry = new LiveRuntimeEngineRegistry();
  registry.attach("busy-autonomous-follow-up", engine, { projectPath: "/work/busy-autonomous-follow-up" });

  for (const listener of listeners) listener();
  for (const listener of listeners) listener();
  assert.equal(registry.read("busy-autonomous-follow-up").revision, 2);
  const input = {
    sessionId: "busy-autonomous-follow-up",
    method: "handleSubmit",
    args: ["follow-up"],
    expectedRevision: 0,
    idempotencyKey: "busy-autonomous-follow-up",
  };
  const accepted = await registry.invoke(input);
  const replay = await registry.invoke(input);

  assert.equal(accepted.ok, true);
  assert.equal(replay.ok, true);
  assert.deepEqual(submissions, ["follow-up"], "same-key replay must not execute twice");
  await registry.disposeAll();
});

test("Agent Console view controls preempt an active submitted turn", async () => {
  const listeners = new Set();
  let releaseTurn;
  const controls = [];
  const engine = {
    getState: () => ({
      isBusy: true,
      agentSteerTarget: { kind: "agent-steer", agentRunId: "run-alpha" },
      agentConsoleView: { open: controls.includes("open") },
    }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async handleSubmit() { await new Promise(resolve => { releaseTurn = resolve; }); },
    openAgentConsole() { controls.push("open"); for (const listener of listeners) listener(); },
    selectAgentConsoleTab(tab) { controls.push(`tab:${tab}`); },
    moveAgentConsoleCursor(delta) { controls.push(`move:${delta}`); },
    toggleAgentConsoleInspector() { controls.push("toggle-inspector"); },
    async submitAgentSteer(message) { controls.push(`steer:${message}`); },
    closeAgentConsole() { controls.push("close"); },
  };
  const registry = new LiveRuntimeEngineRegistry();
  registry.attach("live-console-control", engine, { projectPath: "/work/live-console" });

  const turn = registry.invoke({
    sessionId: "live-console-control", method: "handleSubmit", args: ["keep working"],
    expectedRevision: 0, idempotencyKey: "console-turn",
  });
  while (!releaseTurn) await new Promise(resolve => setImmediate(resolve));
  const invokeControl = (method, args, idempotencyKey) => registry.invoke({
    sessionId: "live-console-control", method, args,
    expectedRevision: registry.read("live-console-control").revision, idempotencyKey,
  });
  // The active turn may publish autonomous agent/job revisions after this
  // view was rendered. View-only console controls rebase onto the latest
  // projection instead of crashing the TUI with a second revision conflict.
  const open = registry.invoke({
    sessionId: "live-console-control", method: "openAgentConsole", args: [],
    expectedRevision: 0, idempotencyKey: "console-open",
  });
  const result = await Promise.race([
    open,
    new Promise(resolve => setTimeout(() => resolve({ outcome: "blocked" }), 100)),
  ]);

  assert.equal(result.outcome, undefined, `Agent Console open must preempt the active turn: ${JSON.stringify(result)}`);
  assert.equal(result.ok, true);
  const replay = await registry.invoke({
    sessionId: "live-console-control", method: "openAgentConsole", args: [],
    expectedRevision: 0, idempotencyKey: "console-open",
  });
  assert.deepEqual(replay, result, "a reconnect may replay the exact receipt without opening twice");
  for (const [method, args, key] of [
    ["selectAgentConsoleTab", ["jobs"], "console-tab"],
    ["moveAgentConsoleCursor", [1], "console-move"],
    ["toggleAgentConsoleInspector", [], "console-toggle"],
    ["submitAgentSteer", ["keep the evidence bounded", "run-alpha"], "console-steer"],
    ["closeAgentConsole", [], "console-close"],
  ]) {
    const controlled = await invokeControl(method, args, key);
    assert.equal(controlled.ok, true);
  }
  assert.deepEqual(controls, [
    "open", "tab:jobs", "move:1", "toggle-inspector",
    "steer:keep the evidence bounded", "close",
  ]);
  releaseTurn();
  await turn;
});

test("an exact Agent Console steer target survives autonomous revisions without retargeting", async () => {
  const listeners = new Set();
  const begins = [];
  const state = {
    isBusy: true,
    agentConsoleView: { open: true, tab: "agents", cursor: 0 },
    agentConsole: { agents: [{ id: "run-alpha", status: "running" }, { id: "run-beta", status: "running" }] },
  };
  const engine = {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    beginAgentSteer(agentRunId) {
      if (state.agentConsole.agents[state.agentConsoleView.cursor]?.id !== agentRunId) return false;
      begins.push(agentRunId);
      return true;
    },
  };
  const registry = new LiveRuntimeEngineRegistry();
  registry.attach("exact-agent-steer", engine, { projectPath: "/work/exact-agent-steer" });

  for (const listener of listeners) listener();
  for (const listener of listeners) listener();
  const accepted = await registry.invoke({
    sessionId: "exact-agent-steer", method: "beginAgentSteer", args: ["run-alpha"],
    expectedRevision: 0, idempotencyKey: "begin-alpha",
  });
  assert.equal(accepted.ok, true);
  assert.deepEqual(begins, ["run-alpha"]);

  state.agentConsoleView.cursor = 1;
  const staleTarget = await registry.invoke({
    sessionId: "exact-agent-steer", method: "beginAgentSteer", args: ["run-alpha"],
    expectedRevision: 0, idempotencyKey: "stale-alpha",
  });
  assert.equal(staleTarget.ok, false);
  assert.deepEqual(begins, ["run-alpha"], "a stale selection must never retarget another run");
  await registry.disposeAll();
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
