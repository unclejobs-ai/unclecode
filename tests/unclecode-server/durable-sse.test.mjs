import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { BoundedEventJournal } from "../../apps/unclecode-server/src/event-journal.ts";
import { startPersistentRuntimeOwner } from "../../apps/unclecode-server/src/runtime-owner.ts";
import * as serverEntry from "../../apps/unclecode-server/src/index.ts";

function cancellableEngine() {
  let state = { isBusy: true, queuePaused: false, model: "test", mode: "standard", uiLocale: "en", agentConsole: {} };
  let lifecycle = { state: "running", turnId: "turn-1" };
  const listeners = new Set();
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    interruptTurn() {
      state = { ...state, isBusy: false };
      lifecycle = { state: "cancelled", turnId: "turn-1" };
      for (const listener of listeners) listener();
    },
    getTurnLifecycle: () => lifecycle,
    async requestTurnPause() { throw new Error("not used"); },
    resumeTurn: () => false,
    async resumeQueueItems() {},
    async handleSubmit() {},
    answerPendingDecisionByIndex: () => false,
    getAgentControlPort: () => ({ async steer() { return { status: "not_delivered" }; } }),
  };
}

async function readSse(endpoint, token, sessionId, afterId) {
  const controller = new AbortController();
  const response = await fetch(`${endpoint}/sessions/${sessionId}/events`, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(afterId > 0 ? { "last-event-id": String(afterId) } : {}),
    },
    signal: controller.signal,
  });
  if (response.status !== 200) {
    return { status: response.status, body: await response.json() };
  }
  const reader = response.body.getReader();
  const chunk = await reader.read();
  controller.abort();
  const text = new TextDecoder().decode(chunk.value);
  return {
    status: response.status,
    ids: [...text.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1])),
    text,
  };
}

test("server bootstrap exports the one runtime ledger API", () => {
  assert.equal(typeof serverEntry.openRuntimeLedger, "function");
});

test("runtime owner SSE sequence and replay survive owner restart", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-durable-sse-restart-"));
  const leasePath = join(rootDir, "owner.json");
  const tokenPath = join(rootDir, "server.token");
  let owner;
  try {
    owner = await startPersistentRuntimeOwner({
      rootDir,
      leasePath,
      tokenPath,
      journal: new BoundedEventJournal({ capacity: 2 }),
    });
    assert.equal(owner.journal.publish("session-a", "run.updated", { revision: 1 }).id, 1);
    assert.equal(owner.journal.publish("session-a", "run.updated", { revision: 2 }).id, 2);
    await owner.stop();

    owner = await startPersistentRuntimeOwner({
      rootDir,
      leasePath,
      tokenPath,
      journal: new BoundedEventJournal({ capacity: 2 }),
    });
    assert.equal(owner.journal.publish("session-a", "run.updated", { revision: 3 }).id, 3);
    assert.deepEqual(owner.journal.replay("session-a", 1).events.map(event => event.id), [2, 3]);
  } finally {
    await owner?.stop().catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("one accepted owner control publishes one durable SSE event", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-durable-sse-single-publish-"));
  const leasePath = join(rootDir, "owner.json");
  const tokenPath = join(rootDir, "server.token");
  let owner;
  try {
    owner = await startPersistentRuntimeOwner({
      rootDir,
      leasePath,
      tokenPath,
      async createSession() {
        return { engine: cancellableEngine(), projectPath: rootDir };
      },
    });
    assert.equal((await owner.engines.create({
      sessionId: "session-control",
      projectPath: rootDir,
      idempotencyKey: "create-control",
    })).ok, true);
    const token = (await readFile(tokenPath, "utf8")).trim();
    const response = await fetch(`${owner.lease.endpoint}/sessions/session-control/actions/cancel`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "cancel-once",
      },
      body: JSON.stringify({ expectedRevision: 0 }),
    });
    assert.equal(response.status, 200);

    const replay = owner.journal.replay("session-control", 0);
    assert.equal(replay.status, "ok");
    assert.equal(replay.events.length, 1);
    assert.deepEqual(replay.events[0]?.data, {
      sessionId: "session-control",
      revision: 1,
      state: "cancelled",
    });
  } finally {
    await owner?.stop().catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("50k hot-journal overwrites retain constant bounded work", () => {
  const capacity = 10_000;
  const journal = new BoundedEventJournal({ capacity });
  const fillStarted = performance.now();
  for (let id = 1; id <= capacity; id += 1) journal.publish("session-scale", "run.updated", { id });
  const fillPerEvent = (performance.now() - fillStarted) / capacity;

  const overwriteCount = 50_000;
  const overwriteStarted = performance.now();
  for (let id = 1; id <= overwriteCount; id += 1) journal.publish("session-scale", "run.updated", { id });
  const overwriteElapsed = performance.now() - overwriteStarted;
  const overwritePerEvent = overwriteElapsed / overwriteCount;

  assert.equal(journal.stats.retainedEvents, capacity);
  assert.ok(
    overwritePerEvent <= Math.max(fillPerEvent * 20, 0.05),
    `hot journal overwrite slope regressed: fill=${fillPerEvent.toFixed(4)}ms/event overwrite=${overwritePerEvent.toFixed(4)}ms/event total=${overwriteElapsed.toFixed(1)}ms`,
  );
});

test("20k durable SSE events keep a bounded hot view and clean up 100 reconnects", { timeout: 120_000 }, async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-durable-sse-20k-"));
  const leasePath = join(rootDir, "owner.json");
  const tokenPath = join(rootDir, "server.token");
  let owner;
  try {
    owner = await startPersistentRuntimeOwner({
      rootDir,
      leasePath,
      tokenPath,
      journal: new BoundedEventJournal({ capacity: 64 }),
    });
    for (let revision = 1; revision <= 20_000; revision += 1) {
      owner.journal.publish("session-soak", "run.updated", { revision });
    }
    assert.equal(owner.journal.stats.retainedEvents, 64);
    const token = (await readFile(tokenPath, "utf8")).trim();

    const expired = await readSse(owner.lease.endpoint, token, "session-soak", 18_999);
    assert.equal(expired.status, 409);
    assert.equal(expired.body.error.code, "event_cursor_expired");
    assert.equal(expired.body.error.oldestAvailableId, 19_001);
    assert.equal(expired.body.error.newestId, 20_000);

    const ahead = await readSse(owner.lease.endpoint, token, "session-soak", 20_001);
    assert.equal(ahead.status, 409);
    assert.equal(ahead.body.error.code, "event_cursor_expired");
    assert.equal(ahead.body.error.oldestAvailableId, 19_001);
    assert.equal(ahead.body.error.newestId, 20_000);

    const replay = await readSse(owner.lease.endpoint, token, "session-soak", 19_998);
    assert.deepEqual(replay.ids, [19_999, 20_000]);

    for (let reconnect = 0; reconnect < 100; reconnect += 1) {
      const controller = new AbortController();
      const response = await fetch(`${owner.lease.endpoint}/sessions/session-soak/events`, {
        headers: { authorization: `Bearer ${token}`, "last-event-id": "20000" },
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      controller.abort();
    }
    for (let attempt = 0; attempt < 50 && owner.journal.stats.activeSubscriptions > 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(owner.journal.stats.activeSubscriptions, 0);
    assert.equal(owner.journal.stats.subscriberSessions, 0);

    await owner.stop();
    owner = await startPersistentRuntimeOwner({
      rootDir,
      leasePath,
      tokenPath,
      journal: new BoundedEventJournal({ capacity: 64 }),
    });
    assert.equal(owner.journal.publish("session-soak", "run.updated", { revision: 20_001 }).id, 20_001);
    const afterRestart = await readSse(owner.lease.endpoint, token, "session-soak", 19_999);
    assert.deepEqual(afterRestart.ids, [20_000, 20_001]);
  } finally {
    await owner?.stop().catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true });
  }
});
