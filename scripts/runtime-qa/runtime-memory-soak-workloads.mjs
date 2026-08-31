import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";

import { createRepoMapCache } from "../../packages/context-broker/src/repo-map-cache.ts";
import { PluginHost } from "../../packages/plugin-host/src/index.ts";
import { openRuntimeLedger } from "../../apps/unclecode-server/src/runtime-ledger.ts";

export async function exerciseCache(cacheWrites) {
  const cache = createRepoMapCache({ maxEntries: 8, maxRetainedBytes: 8 * 1024 });
  for (let index = 0; index < cacheWrites; index += 1) {
    const rootDir = `/soak/repo-${String(index % 32)}`;
    const gitHeadSha = `head-${String(index)}`;
    await cache.load({
      rootDir,
      gitHeadSha,
      loader: async () => ({
        rootDir,
        generatedAt: "2026-08-29T00:00:00.000Z",
        gitHeadSha,
        entries: [{
          path: `src/file-${String(index)}.ts`,
          lastModified: "2026-08-29T00:00:00.000Z",
          lineCount: index,
          changeFrequency: 1,
          hotspotScore: 1,
        }],
        totalFiles: 1,
        totalLines: index,
      }),
    });
  }
  const snapshot = cache.snapshot();
  assert.ok(snapshot.currentSize <= snapshot.maxEntries);
  assert.ok(snapshot.retainedBytesEstimate <= snapshot.maxRetainedBytes);
  return snapshot;
}

export function exerciseUsageLedger(directory, usageEvents) {
  const dbPath = join(directory, "usage-ledger.sqlite");
  const ledger = openRuntimeLedger({ dbPath });
  try {
    for (let index = 0; index < usageEvents; index += 1) {
      const recorded = ledger.recordUsage({
        sessionId: "memory-soak",
        eventId: `usage-${String(index)}`,
        mainId: "main",
        agentId: `agent-${String(index % 64)}`,
        route: { provider: "openai", model: "gpt-5.6-sol" },
        counters: {
          inputTokens: 3,
          outputTokens: 2,
          cacheReadTokens: 1,
          cacheWriteTokens: 1,
          cacheSavingsUsd: 0.001,
          costUsd: 0.002,
        },
      });
      assert.equal(recorded.kind, "recorded");
    }
    assert.equal(ledger.recordUsage({
      sessionId: "memory-soak",
      eventId: "usage-0",
      mainId: "main",
      agentId: "agent-0",
      route: { provider: "openai", model: "gpt-5.6-sol" },
      counters: {
        inputTokens: 3,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheWriteTokens: 1,
        cacheSavingsUsd: 0.001,
        costUsd: 0.002,
      },
    }).kind, "duplicate");
    const totals = ledger.snapshotUsageTotals("memory-soak");
    assert.equal(totals.session.inputTokens, usageEvents * 3);
    assert.equal(totals.byAgent.length, Math.min(64, usageEvents));
    assert.equal(totals.byRoute.length, 1);
    return {
      events: usageEvents,
      inputTokens: totals.session.inputTokens,
      agents: totals.byAgent.length,
      routes: totals.byRoute.length,
      dbBytes: statSync(dbPath).size,
    };
  } finally {
    ledger.close();
  }
}

export async function exercisePluginReload(pluginReloads) {
  const prototype = PluginHost.prototype;
  const candidates = [
    "reload",
    "reloadEntries",
    "reloadFromDisk",
    "unload",
    "dispose",
    "getLifecycleSnapshot",
  ];
  const publicMethods = candidates.filter(name => typeof prototype[name] === "function");
  const publiclyCallable = typeof prototype.unload === "function"
    && typeof prototype.dispose === "function"
    && typeof prototype.getLifecycleSnapshot === "function";
  if (!publiclyCallable) {
    return {
      publiclyCallable: false,
      exercised: false,
      publicMethods,
      reloads: 0,
      disposedRegistrations: 0,
      reason: "PluginHost exposes load operations but no complete unload/dispose lifecycle.",
    };
  }

  const host = new PluginHost();
  let disposedRegistrations = 0;
  let activeLifecycle;
  let unloadedLifecycle;
  try {
    for (let index = 0; index < pluginReloads; index += 1) {
      await host.loadEntries("/memory-soak", [{
        name: "memory-soak-reload",
        entry: () => ({
          runStarted() {},
          dispose() {
            disposedRegistrations += 1;
          },
        }),
      }], {});
      assert.equal(host.list().length, 1, "plugin replacement must not retain old registrations");
    }
    activeLifecycle = host.getLifecycleSnapshot();
    assert.equal(activeLifecycle.status, "active");
    assert.equal(activeLifecycle.registrationCount, 1);
    assert.equal(activeLifecycle.pendingCleanupCount, 0);
    assert.equal(await host.unload("memory-soak-reload", "memory"), true);
    assert.equal(host.list().length, 0);
    unloadedLifecycle = host.getLifecycleSnapshot();
    assert.equal(unloadedLifecycle.registrationCount, 0);
    assert.equal(unloadedLifecycle.pendingCleanupCount, 0);
  } finally {
    await host.dispose();
  }
  const disposedLifecycle = host.getLifecycleSnapshot();
  assert.equal(disposedLifecycle.status, "disposed");
  assert.equal(disposedLifecycle.registrationCount, 0);
  assert.equal(disposedLifecycle.pendingCleanupCount, 0);
  assert.equal(disposedRegistrations, pluginReloads);
  return {
    publiclyCallable: true,
    exercised: true,
    publicMethods,
    reloads: pluginReloads,
    disposedRegistrations,
    lifecycle: { active: activeLifecycle, unloaded: unloadedLifecycle, disposed: disposedLifecycle },
    reason: "Repeated same-name registration exercised replacement cleanup, then unload and host disposal.",
  };
}
