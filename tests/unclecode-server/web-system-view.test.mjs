import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SystemView } from "../../apps/godness-web/src/SystemView.jsx";
import {
  deriveSystemHealth,
  normalizeSystemProjection,
  resolveControlRoomView,
} from "../../apps/godness-web/src/system-view.js";

const copy = {
  systemOwner: "Runtime owner",
  ownerEvidence: "Owner evidence",
  cacheEvidence: "Cache evidence",
  systemNominal: "Nominal",
  providerHealth: "Providers",
  mcpHealth: "MCP servers",
  pluginHosts: "Plugin hosts",
  pluginRegistrations: "Registrations",
  providers: "Provider evidence",
  mcpServers: "MCP evidence",
  pluginLifecycle: "Plugin lifecycle",
  pluginHost: "Host",
  pendingCleanup: "Pending cleanup",
  configuredEmpty: "Configured empty",
  truncated: "bounded",
  memoryResources: "Memory and resources",
  heapUsed: "Heap used", heapTotal: "Heap total", externalMemory: "External memory",
  activeResources: "Active resources",
  cpuTime: "CPU time", maxRss: "Peak RSS",
  caches: "Caches",
  hits: "hits",
  misses: "misses",
  hitRate: "hit rate",
  entries: "entries",
  bytes: "bytes",
  sourceUnavailable: "Source unavailable",
  engineCounters: "Engine counters",
  journalCounters: "Journal counters",
  attachedSessions: "Attached sessions",
  observedSessions: "Observed sessions",
  activeMutations: "Active mutations", clientLeases: "Client leases",
  pendingCreations: "Pending creations",
  pendingTeardowns: "Pending teardowns",
  teardownFailures: "Teardown failures", cleanupDropped: "Cleanup dropped", unlistedTeardowns: "Unlisted teardowns",
  callbackFailures: "Callback failures", mcpUnavailable: "MCP unavailable",
  retainedEvents: "Retained events",
  activeSubscriptions: "Active subscriptions",
  subscriberSessions: "Subscriber sessions",
  replayWatermarks: "Replay watermarks",
  cleanup: "Cleanup",
  diagnostics: "Diagnostics",
  external: "External",
  source: "Source",
  hook: "Hook",
  error: "Error",
  diagnosticRecorded: "Bounded diagnostic recorded",
  systemStatuses: {
    available: "available", unavailable: "unavailable", degraded: "degraded",
    configured: "configured", notConfigured: "not configured",
    authenticated: "authenticated", missing: "missing", unverified: "unverified",
    passed: "passed", failed: "failed", "not-run": "not run",
    active: "active", disposing: "disposing", disposed: "disposed",
    pending: "pending", completed: "completed",
  },
  systemReasons: {
    owner: "owner unavailable", cacheTelemetry: "cache unavailable", callbacks: "callback failed",
    mcpConfiguration: "MCP unavailable", providers: "provider attention", mcpServers: "MCP attention",
    pluginHosts: "plugin attention", cleanup: "cleanup failed",
  },
};

const system = {
  evidenceSources: { owner: "available", cacheTelemetry: "available" },
  memory: { rssBytes: 8_388_608, heapTotalBytes: 4_194_304, heapUsedBytes: 2_097_152, externalBytes: 2, arrayBuffersBytes: 1 },
  resources: { activeCount: 2, byType: [{ type: "TCPServerWrap", count: 1 }], userCpuMicros: 2_000, systemCpuMicros: 1_000, maxRssKilobytes: 10 },
  journal: { retainedEvents: 7, activeSubscriptions: 1, subscriberSessions: 1, replayWatermarks: 2 },
  engines: { attachedSessions: 1, observedSessions: 1, pendingCreations: 0, pendingTeardowns: 0, observabilityCallbackFailures: 0, mcpConfigurationUnavailableObserved: 0 },
  providers: [{ provider: "openai", model: "gpt-5.6", configured: true, authentication: "authenticated", liveProbe: "not-run", observedAt: 1 }],
  mcpServers: [{ name: "context", transport: "stdio", configured: true, authentication: "unverified", liveProbe: "not-run", observedAt: 1 }],
  pluginHosts: [{
    sessionId: "session-1",
    status: "active",
    registrationCount: 1,
    pendingCleanupCount: 0,
    registrations: [{ name: "reviewer", source: "workspace", trustLane: "workspace-trusted", hookCount: 2 }],
    truncated: false,
  }],
  cleanup: [{ kind: "plugin-host", identity: "host-1", status: "completed", recordedAt: 4 }],
  caches: [{ name: "repo-map", hits: 3, misses: 1, currentSize: 2, maxEntries: 8, retainedBytesEstimate: 1024, maxRetainedBytes: 4096 }],
};

test("System render uses pluginHosts and exposes the complete bounded evidence hierarchy", () => {
  const markup = renderToStaticMarkup(createElement(SystemView, {
    projection: { system },
    run: { system: { diagnostics: [{
      dedupeKey: "token=must-not-render",
      pluginId: "/private/plugin",
      hook: "raw-hook",
      error: "api_key=must-not-render",
      source: "workspace",
      trust: "workspace-trusted",
    }] } },
    copy,
  }));

  assert.match(markup, /Runtime owner/);
  assert.match(markup, /Provider evidence/);
  assert.match(markup, /MCP evidence/);
  assert.match(markup, /Plugin lifecycle/);
  assert.match(markup, /Memory and resources/);
  assert.match(markup, /repo-map/);
  assert.match(markup, /Engine counters/);
  assert.match(markup, /Journal counters/);
  assert.match(markup, /plugin-host/);
  assert.match(markup, /Bounded diagnostic recorded/);
  assert.doesNotMatch(markup, /session-1/);
  assert.doesNotMatch(markup, /must-not-render|\/private\/plugin|raw-hook/);
});

test("System normalization fails unavailable/degraded honestly and strips paths and tokens", () => {
  const unavailable = normalizeSystemProjection({ evidenceSources: { owner: "unavailable" } });
  assert.deepEqual(deriveSystemHealth(unavailable), { overall: "unavailable", owner: "unavailable", reasons: ["owner"] });

  const degraded = normalizeSystemProjection({
    ...system,
    evidenceSources: { owner: "available", cacheTelemetry: "unavailable" },
    engines: { ...system.engines, observabilityCallbackFailures: 2 },
    cleanup: [{ kind: "runtime-session", identity: "/tmp/token=super-secret", status: "failed", recordedAt: 1 }],
    caches: [{ ...system.caches[0], name: "./private/cache token=super-secret" }],
  });
  assert.equal(deriveSystemHealth(degraded).overall, "degraded");
  assert.equal(degraded.cleanup[0].identity, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(degraded), /super-secret|\/tmp\/|\.\/private/);
});

test("System remains the active global view when there are zero runs", () => {
  assert.equal(resolveControlRoomView("Runs", false), "System");
  assert.equal(resolveControlRoomView("Quality", false), "System");
  assert.equal(resolveControlRoomView("Runs", true), "Runs");
});
