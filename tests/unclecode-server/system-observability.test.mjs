import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BoundedEventJournal,
  createControlRoomProjection,
  LiveRuntimeEngineRegistry,
  LiveRuntimeControlRegistry,
  readPersistentRuntime,
  startPersistentRuntimeOwner,
} from "@unclecode/server";

function fakeEngine(label) {
  const listeners = new Set();
  return {
    getState: () => ({
      label,
      mode: "standard",
      isBusy: false,
      queuePaused: false,
      model: "test-model",
      uiLocale: "en",
      agentConsole: {},
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    interruptTurn: () => false,
    getTurnLifecycle: () => ({ state: "idle" }),
  };
}

function sessionObservability(index, probe) {
  return {
    provider: {
      provider: `provider-${index}`,
      model: `model-${index}`,
      configured: true,
      authentication: index % 2 === 0 ? "unverified" : "missing",
      liveProbe: "not-run",
      observedAt: 100 + index,
    },
    mcpServers: [{
      name: `mcp-${index}`,
      transport: "stdio",
      configured: true,
      authentication: "unverified",
      liveProbe: "not-run",
      observedAt: 100 + index,
    }],
    plugins: {
      status: "active",
      registrationCount: 1,
      pendingCleanupCount: 0,
      registrations: [{
        name: `plugin-${index}`,
        source: "workspace",
        trustLane: "workspace-trusted",
        hookCount: 2,
      }],
      truncated: false,
    },
    // A live probe is deliberately not part of the owner callback contract.
    probe,
  };
}

test("engine observability is bounded at source and does not touch leases or call probes", async () => {
  let probeCalls = 0;
  let snapshotReads = 0;
  const registry = new LiveRuntimeEngineRegistry({ maxIdleSessions: 512 });
  for (let index = 0; index < 300; index += 1) {
    registry.attach(`session-${index}`, fakeEngine(index), {
      projectPath: `/private/workspace-${index}`,
      readObservability: () => {
        snapshotReads += 1;
        return sessionObservability(index, () => { probeCalls += 1; });
      },
    });
  }

  const before = registry.systemSnapshot();
  const after = registry.systemSnapshot();
  assert.equal(before.engines.attachedSessions, 300);
  assert.equal(before.engines.observedSessions, 256);
  assert.equal(before.engines.scanTruncated, true);
  assert.equal(before.engines.clientLeaseProtectedSessionsObserved, 0);
  assert.equal(after.engines.clientLeaseProtectedSessionsObserved, 0);
  assert.equal(before.providers.length, 32);
  assert.equal(before.mcpServers.length, 64);
  assert.equal(before.pluginHosts.length, 64);
  assert.equal(snapshotReads, 512);
  assert.equal(probeCalls, 0);
  assert.doesNotMatch(JSON.stringify(before), /private\/workspace/);

  await registry.disposeAll();
  const disposed = registry.systemSnapshot();
  assert.equal(disposed.engines.attachedSessions, 0);
  assert.equal(disposed.cleanup.length, 128);
  assert.ok(disposed.cleanup.every(item => item.status === "completed"));
});

test("failed observability callbacks remain visible as bounded counters", async () => {
  const registry = new LiveRuntimeEngineRegistry();
  registry.attach("callback-failed", fakeEngine("failed"), {
    projectPath: "/workspace",
    readObservability() {
      throw new Error("secret callback failure");
    },
  });
  registry.attach("mcp-unavailable", fakeEngine("mcp"), {
    projectPath: "/workspace",
    readObservability: () => ({ mcpConfigurationStatus: "unavailable" }),
  });

  const snapshot = registry.systemSnapshot();
  assert.equal(snapshot.engines.observabilityCallbackFailures, 1);
  assert.equal(snapshot.engines.mcpConfigurationUnavailableObserved, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret callback failure/);
  await registry.disposeAll();
});

test("cleanup inventory prioritizes unresolved identities and counts pending rows omitted by its bound", async () => {
  const releases = [];
  const registry = new LiveRuntimeEngineRegistry({ maxIdleSessions: 256, teardownTimeoutMs: 1_000 });
  for (let index = 0; index < 140; index += 1) {
    registry.attach(`pending-${index}`, fakeEngine(index), {
      projectPath: "/workspace",
      dispose: () => new Promise(resolve => { releases.push(resolve); }),
    });
  }
  const disposing = registry.disposeAll();
  await new Promise(resolve => setImmediate(resolve));
  const pending = registry.systemSnapshot();
  assert.equal(pending.cleanup.length, 128);
  assert.ok(pending.cleanup.every(item => item.status === "pending"));
  assert.equal(pending.engines.pendingTeardowns, 140);
  assert.equal(pending.engines.unlistedPendingTeardowns, 12);
  assert.equal(pending.engines.cleanupEntriesDropped, 12);

  for (const release of releases) release();
  await disposing;
});

test("unique unresolved session factories are bounded before invocation while same-session creates coalesce", async () => {
  let factoryCalls = 0;
  const releaseFactories = [];
  const registry = new LiveRuntimeEngineRegistry({
    createSession(input) {
      factoryCalls += 1;
      return new Promise(resolve => {
        releaseFactories.push(() => resolve({
          engine: fakeEngine(input.sessionId),
          projectPath: input.projectPath,
        }));
      });
    },
  });
  let firstCreate;
  let overflowCreate;
  const initialCreates = [];
  try {
    for (let index = 0; index < 257; index += 1) {
      const creating = registry.create({
        sessionId: `pending-${index}`,
        projectPath: `/workspace/${index}`,
        idempotencyKey: `create-${index}`,
      });
      initialCreates.push(creating);
      if (index === 0) firstCreate = creating;
      if (index === 256) overflowCreate = creating;
    }
    assert.equal(factoryCalls, 256, "factory admission must stop before invoking an overflowing factory");
    for (let index = 257; index < 20_000; index += 1) {
      registry.create({
        sessionId: `pending-${index}`,
        projectPath: `/workspace/${index}`,
        idempotencyKey: `create-${index}`,
      });
    }

    const sameSessionCreate = registry.create({
      sessionId: "pending-0",
      projectPath: "/workspace/0",
      idempotencyKey: "same-session-create",
    });
    assert.equal(sameSessionCreate, firstCreate, "a saturated registry still coalesces the existing session factory");
    assert.equal(factoryCalls, 256, "20k unique requests must not grow factory work beyond the bound");
    assert.equal(registry.systemSnapshot().engines.pendingCreations, 256);
    const overflow = await overflowCreate;
    assert.equal(overflow.ok, false);
    assert.equal(overflow.code, "invalid_action");
  } finally {
    for (const release of releaseFactories) release();
    await Promise.allSettled(initialCreates);
    await registry.disposeAll();
  }
});

test("disposeAll cannot be repopulated by a factory that resolves after shutdown begins", async () => {
  let resolveFactory;
  let disposeCalls = 0;
  const registry = new LiveRuntimeEngineRegistry({
    createSession: () => new Promise(resolve => { resolveFactory = resolve; }),
  });
  const creating = registry.create({
    sessionId: "late",
    projectPath: "/workspace",
    idempotencyKey: "late-create",
  });
  await new Promise(resolve => setImmediate(resolve));
  const disposing = registry.disposeAll();
  resolveFactory({
    engine: fakeEngine("late"),
    projectPath: "/workspace",
    dispose() { disposeCalls += 1; },
  });

  await disposing;
  const result = await creating;
  assert.equal(result.ok, false);
  assert.equal(disposeCalls, 1);
  assert.equal(registry.systemSnapshot().engines.attachedSessions, 0);
  assert.equal((await registry.create({
    sessionId: "after",
    projectPath: "/workspace",
    idempotencyKey: "after-dispose",
  })).ok, false);
});

test("disposeAll drains late factory cleanup and aggregates its failure after an attached teardown fails", async () => {
  let resolveFactory;
  let lateDisposeCalls = 0;
  const registry = new LiveRuntimeEngineRegistry({
    createSession: () => new Promise(resolve => { resolveFactory = resolve; }),
  });
  registry.attach("attached", fakeEngine("attached"), {
    projectPath: "/workspace",
    dispose() { throw new Error("attached cleanup failed"); },
  });
  const creating = registry.create({
    sessionId: "late",
    projectPath: "/workspace",
    idempotencyKey: "late-create-after-failure",
  });
  await new Promise(resolve => setImmediate(resolve));

  const disposalOutcome = registry.disposeAll().then(
    () => ({ status: "fulfilled" }),
    error => ({ status: "rejected", error }),
  );
  const earlyOutcome = await Promise.race([
    disposalOutcome,
    new Promise(resolve => setImmediate(() => resolve({ status: "pending" }))),
  ]);
  assert.equal(earlyOutcome.status, "pending", "an earlier teardown failure cannot skip a pending factory");

  resolveFactory({
    engine: fakeEngine("late"),
    projectPath: "/workspace",
    dispose() {
      lateDisposeCalls += 1;
      throw new Error("late cleanup failed");
    },
  });
  const createResult = await creating;
  const outcome = await disposalOutcome;

  assert.equal(createResult.ok, false);
  assert.equal(lateDisposeCalls, 1);
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.error.message, /attached cleanup failed/);
  assert.match(outcome.error.message, /late cleanup failed/);
  assert.equal(registry.systemSnapshot().engines.pendingCreations, 0);
  assert.equal(registry.systemSnapshot().engines.pendingTeardowns, 0);
});

test("a never-resolving session disposer times out instead of hanging owner teardown", async () => {
  const registry = new LiveRuntimeEngineRegistry({ teardownTimeoutMs: 25 });
  registry.attach("hung", fakeEngine("hung"), {
    projectPath: "/workspace",
    dispose: () => new Promise(() => {}),
  });
  const startedAt = Date.now();
  await assert.rejects(registry.disposeAll(), /timed out/i);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(registry.systemSnapshot().engines.attachedSessions, 0);
  assert.equal(registry.systemSnapshot().cleanup.at(-1).status, "failed");
});

test("System projection whitelists, bounds, and redacts every backend inventory", () => {
  const secret = "token=super-secret";
  const projection = createControlRoomProjection({
    generatedAt: 200,
    sessions: [],
    system: {
      memory: {
        rssBytes: 10,
        heapTotalBytes: 20,
        heapUsedBytes: 8,
        externalBytes: 3,
        arrayBuffersBytes: 2,
        rawHeapDump: secret,
      },
      resources: {
        activeCount: 90,
        byType: Array.from({ length: 40 }, (_, index) => ({ type: `Timer-${index}-${secret}`, count: index + 1 })),
        userCpuMicros: 4,
        systemCpuMicros: 5,
        maxRssKilobytes: 6,
        rawHandles: [secret],
      },
      journal: {
        retainedEvents: 7,
        activeSubscriptions: 8,
        subscriberSessions: 9,
        replayWatermarks: 10,
      },
      engines: {
        attachedSessions: 11,
        activeMutationsObserved: 12,
        pendingCreations: 13,
        pendingTeardowns: 14,
        clientLeaseProtectedSessionsObserved: 15,
        teardownFailuresRetained: 16,
      },
      providers: Array.from({ length: 40 }, (_, index) => ({
        provider: `provider-${index}-${secret}`,
        model: `model-${index}`,
        configured: true,
        authentication: "unverified",
        liveProbe: "not-run",
        observedAt: index,
        apiKey: secret,
      })),
      mcpServers: Array.from({ length: 80 }, (_, index) => ({
        name: `mcp-${index}-${secret}`,
        transport: "stdio",
        configured: true,
        authentication: "unverified",
        liveProbe: "not-run",
        observedAt: index,
        command: secret,
      })),
      pluginHosts: Array.from({ length: 80 }, (_, index) => ({
        sessionId: `session-${index}-${secret}`,
        status: "active",
        registrationCount: 1,
        pendingCleanupCount: 0,
        registrations: [{
          name: `plugin-${index}-${secret}`,
          source: "workspace",
          trustLane: "workspace-trusted",
          hookCount: 2,
          hooks: [secret],
        }],
        truncated: false,
      })),
      cleanup: Array.from({ length: 180 }, (_, index) => ({
        kind: "runtime-session",
        identity: `session-${index}-${secret}`,
        status: "failed",
        recordedAt: index,
        error: secret,
      })),
      caches: [{
        name: `cache-${secret}`,
        hits: 2,
        misses: 1,
        evictions: 0,
        byteEvictions: 0,
        invalidations: 0,
        currentSize: 1,
        maxEntries: 2,
        maxRetainedBytes: 20,
        retainedBytesEstimate: 10,
      }],
    },
  });

  assert.deepEqual(projection.bounds.system, {
    activeResourceTypes: 32,
    engineSessions: 256,
    providers: 32,
    mcpServers: 64,
    pluginHosts: 64,
    pluginsPerHost: 64,
    cleanup: 128,
    caches: 32,
  });
  assert.equal(projection.system.providers.length, 32);
  assert.deepEqual(projection.system.evidenceSources, {
    owner: "unavailable",
    cacheTelemetry: "unavailable",
  });
  assert.equal(projection.system.mcpServers.length, 64);
  assert.equal(projection.system.pluginHosts.length, 64);
  assert.equal(projection.system.cleanup.length, 128);
  assert.equal(projection.system.resources.byType.length, 32);
  assert.equal(projection.system.providers[0].authentication, "unverified");
  assert.equal(projection.system.providers[0].liveProbe, "not-run");
  assert.equal("apiKey" in projection.system.providers[0], false);
  assert.equal("command" in projection.system.mcpServers[0], false);
  assert.equal("hooks" in projection.system.pluginHosts[0].registrations[0], false);
  assert.equal("error" in projection.system.cleanup[0], false);
  assert.doesNotMatch(JSON.stringify(projection.system), /super-secret/);
});

test("failed owner and cache evidence reads project unavailable instead of healthy-empty", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-system-unavailable-"));
  try {
    const source = await readPersistentRuntime(
      rootDir,
      new LiveRuntimeControlRegistry(),
      () => { throw new Error("secret cache failure"); },
      () => { throw new Error("secret owner failure"); },
    );
    const projection = createControlRoomProjection(source);
    assert.deepEqual(projection.system.evidenceSources, {
      owner: "unavailable",
      cacheTelemetry: "unavailable",
    });
    assert.deepEqual(projection.system.caches, []);
    assert.doesNotMatch(JSON.stringify(projection.system), /secret/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("repeated control-room GET reads recorded evidence without running a child probe", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-system-observability-"));
  const projectPath = join(rootDir, "workspace");
  const tokenPath = join(rootDir, "server.token");
  let probeCalls = 0;
  let snapshotReads = 0;
  let owner;
  try {
    owner = await startPersistentRuntimeOwner({
      rootDir,
      leasePath: join(rootDir, "owner.json"),
      tokenPath,
      async createSession(request) {
        return {
          engine: fakeEngine(request.sessionId),
          projectPath: request.projectPath,
          readObservability() {
            snapshotReads += 1;
            return sessionObservability(1, () => { probeCalls += 1; });
          },
        };
      },
    });
    await owner.engines.create({ sessionId: "observed", projectPath, idempotencyKey: "create-observed" });
    const token = (await readFile(tokenPath, "utf8")).trim();
    const headers = { authorization: `Bearer ${token}` };
    const first = await fetch(`${owner.lease.endpoint}/control-room`, { headers }).then(response => response.json());
    const second = await fetch(`${owner.lease.endpoint}/control-room`, { headers }).then(response => response.json());

    assert.equal(first.system.providers[0].liveProbe, "not-run");
    assert.equal(second.system.providers[0].liveProbe, "not-run");
    assert.equal(snapshotReads, 2);
    assert.equal(probeCalls, 0);
    assert.equal(first.system.engines.clientLeaseProtectedSessionsObserved, 0);
    assert.equal(second.system.engines.clientLeaseProtectedSessionsObserved, 0);
    assert.ok(first.system.memory.rssBytes > 0);
    assert.equal(first.system.journal.retainedEvents, 0);
  } finally {
    await owner?.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("owner projects existing cache telemetry with engine and journal stats", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-system-cache-"));
  const journal = new BoundedEventJournal({ capacity: 8 });
  let owner;
  try {
    journal.publish("session", "run.updated", { revision: 1 });
    owner = await startPersistentRuntimeOwner({
      rootDir,
      leasePath: join(rootDir, "owner.json"),
      tokenPath: join(rootDir, "server.token"),
      journal,
      readCacheTelemetry: () => [{
        name: "provider-cache",
        hits: 3,
        misses: 1,
        evictions: 0,
        byteEvictions: 0,
        invalidations: 0,
        currentSize: 1,
        maxEntries: 4,
        maxRetainedBytes: 1_024,
        retainedBytesEstimate: 128,
      }],
    });
    const token = (await readFile(join(rootDir, "server.token"), "utf8")).trim();
    const projection = await fetch(`${owner.lease.endpoint}/control-room`, {
      headers: { authorization: `Bearer ${token}` },
    }).then(response => response.json());
    assert.equal(projection.system.caches[0].hitRate, 0.75);
    assert.equal(projection.system.journal.retainedEvents, 1);
    assert.equal(projection.system.engines.attachedSessions, 0);
  } finally {
    await owner?.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});
