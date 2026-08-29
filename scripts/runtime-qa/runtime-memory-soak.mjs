import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { probeRuntimeOwner } from "../../apps/unclecode-server/src/runtime-owner-client.ts";
import { readRuntimeOwnerLease } from "../../apps/unclecode-server/src/runtime-owner-discovery.ts";
import { startPersistentRuntimeOwner } from "../../apps/unclecode-server/src/runtime-owner.ts";
import {
  collectRuntimeMetrics,
  createFakeEngine,
  metricDelta,
  openAndCloseSse,
  readAuthenticatedJson,
} from "./runtime-memory-soak-fixtures.mjs";
import {
  exerciseCache,
  exercisePluginReload,
  exerciseUsageLedger,
} from "./runtime-memory-soak-workloads.mjs";

const DEFAULTS = Object.freeze({
  ownerSessions: 768,
  sseReconnects: 128,
  cacheWrites: 1_500,
  usageEvents: 2_500,
  pluginReloads: 512,
  maxRetainedSessions: 256,
  maxHeapGrowthBytesWithGc: 32 * 1024 * 1024,
  maxHeapGrowthBytesWithoutGc: 96 * 1024 * 1024,
  maxActiveHandleGrowth: 4,
  maxFileDescriptorGrowth: 4,
});

export async function runRuntimeMemorySoak(configuration = {}) {
  const config = { ...DEFAULTS, ...configuration };
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-runtime-memory-soak-"));
  const leasePath = join(rootDir, "runtime-owner.json");
  const usageDbPath = join(rootDir, "usage-ledger.sqlite");
  const counters = {
    created: 0,
    disposed: 0,
    activeEngineSubscribers: 0,
    peakEngineSubscribers: 0,
  };
  const cleanup = {
    ownerStopped: false,
    endpointClosed: false,
    leaseRemoved: false,
    tempRootRemoved: false,
    tempDatabaseRemoved: false,
  };
  let owner;
  let cache;
  let usage;
  let pluginReload;
  let retainedBeforeStop = 0;
  let sseStatsBeforeStop;
  let cacheTelemetryReads = 0;
  const before = await collectRuntimeMetrics();

  try {
    pluginReload = await exercisePluginReload(config.pluginReloads);
    cache = await exerciseCache(config.cacheWrites);
    usage = exerciseUsageLedger(rootDir, config.usageEvents);
    owner = await startPersistentRuntimeOwner({
      rootDir: join(rootDir, "owner-root"),
      leasePath,
      tokenPath: join(rootDir, "server.token"),
      readCacheTelemetry: () => {
        cacheTelemetryReads += 1;
        return [cache];
      },
      async createSession(input) {
        counters.created += 1;
        return {
          engine: createFakeEngine(input.sessionId, counters),
          projectPath: input.projectPath,
          dispose() {
            counters.disposed += 1;
          },
        };
      },
    });
    for (let index = 0; index < config.ownerSessions; index += 1) {
      const created = await owner.engines.create({
        sessionId: `soak-${String(index)}`,
        projectPath: join(rootDir, "workspaces", String(index)),
        idempotencyKey: `create-${String(index)}`,
      });
      assert.equal(created.ok, true, `owner session ${String(index)} must be created`);
    }
    await owner.engines.settleTeardowns();
    retainedBeforeStop = owner.engines.list().length;
    assert.ok(retainedBeforeStop <= config.maxRetainedSessions);

    const token = (await readFile(join(rootDir, "server.token"), "utf8")).trim();
    const projection = await readAuthenticatedJson(owner.lease.endpoint, token, "/control-room");
    assert.equal(projection.system.caches[0].name, cache.name);
    assert.ok(cacheTelemetryReads > 0);
    for (let reconnect = 0; reconnect < config.sseReconnects; reconnect += 1) {
      await openAndCloseSse(owner.lease.endpoint, token, `soak-${String(reconnect)}`);
    }
    for (let attempt = 0; attempt < 64 && owner.journal.stats.activeSubscriptions > 0; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    sseStatsBeforeStop = owner.journal.stats;
    assert.equal(sseStatsBeforeStop.activeSubscriptions, 0);
    assert.equal(sseStatsBeforeStop.subscriberSessions, 0);
  } finally {
    const lease = owner?.lease;
    try {
      await owner?.stop();
      if (lease) {
        cleanup.ownerStopped = true;
        cleanup.leaseRemoved = await readRuntimeOwnerLease(leasePath) === null;
        cleanup.endpointClosed = !await probeRuntimeOwner(lease);
        assert.equal(cleanup.leaseRemoved, true);
        assert.equal(cleanup.endpointClosed, true);
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
      cleanup.tempRootRemoved = !existsSync(rootDir);
      cleanup.tempDatabaseRemoved = !existsSync(usageDbPath);
      assert.equal(cleanup.tempRootRemoved, true);
      assert.equal(cleanup.tempDatabaseRemoved, true);
    }
  }

  assert.equal(counters.activeEngineSubscribers, 0);
  assert.equal(counters.disposed, counters.created);
  const after = await collectRuntimeMetrics();
  const deltas = {
    heapUsedBytes: after.heapUsedBytes - before.heapUsedBytes,
    activeHandles: metricDelta(after.activeHandles, before.activeHandles),
    fileDescriptors: metricDelta(after.fileDescriptors, before.fileDescriptors),
  };
  const maxHeapGrowthBytes = typeof globalThis.gc === "function"
    ? config.maxHeapGrowthBytesWithGc
    : config.maxHeapGrowthBytesWithoutGc;
  assert.ok(deltas.heapUsedBytes <= maxHeapGrowthBytes);
  if (deltas.activeHandles !== null) {
    assert.ok(deltas.activeHandles <= config.maxActiveHandleGrowth);
  }
  if (deltas.fileDescriptors !== null) {
    assert.ok(deltas.fileDescriptors <= config.maxFileDescriptorGrowth);
  }

  return {
    ok: true,
    gcAvailable: typeof globalThis.gc === "function",
    configuration: config,
    before,
    after,
    deltas,
    bounds: {
      maxHeapGrowthBytes,
      maxActiveHandleGrowth: config.maxActiveHandleGrowth,
      maxFileDescriptorGrowth: config.maxFileDescriptorGrowth,
    },
    owner: {
      created: counters.created,
      disposed: counters.disposed,
      retainedBeforeStop,
      retainedAfterStop: 0,
      activeEngineSubscribersAfterStop: counters.activeEngineSubscribers,
      peakEngineSubscribers: counters.peakEngineSubscribers,
    },
    sse: { reconnects: config.sseReconnects, statsAfterReconnects: sseStatsBeforeStop },
    cache: { ...cache, telemetryReads: cacheTelemetryReads },
    usage,
    pluginReload,
    cleanup,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  runRuntimeMemorySoak()
    .then(report => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
