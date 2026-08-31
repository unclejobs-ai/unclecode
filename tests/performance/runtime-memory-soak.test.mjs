import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const soakScript = fileURLToPath(
  new URL("../../scripts/runtime-qa/runtime-memory-soak.mjs", import.meta.url),
);

test("runtime owner churn leaves heap, handles, descriptors, sessions, and subscribers bounded", {
  timeout: 120_000,
}, async context => {
  const child = spawn(process.execPath, [
    "--expose-gc",
    "--disable-warning=ExperimentalWarning",
    "--conditions=source",
    "--import",
    "tsx",
    soakScript,
  ], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, `memory soak failed\n${stderr}\n${stdout}`);

  const lines = stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.length > 0, "memory soak did not emit a report");
  const report = JSON.parse(lines.at(-1));
  assert.equal(report.ok, true);
  assert.equal(report.gcAvailable, true, "focused soak must run with deterministic forced GC");
  assert.equal(report.owner.created, report.configuration.ownerSessions);
  assert.equal(report.owner.disposed, report.owner.created);
  assert.ok(report.owner.retainedBeforeStop <= report.configuration.maxRetainedSessions);
  assert.equal(report.owner.retainedAfterStop, 0);
  assert.equal(report.owner.activeEngineSubscribersAfterStop, 0);
  assert.equal(report.sse.reconnects, report.configuration.sseReconnects);
  assert.equal(report.sse.statsAfterReconnects.activeSubscriptions, 0);
  assert.equal(report.sse.statsAfterReconnects.subscriberSessions, 0);
  assert.ok(report.cache.currentSize <= report.cache.maxEntries);
  assert.ok(report.cache.retainedBytesEstimate <= report.cache.maxRetainedBytes);
  assert.ok(report.cache.telemetryReads > 0);
  assert.equal(report.usage.events, report.configuration.usageEvents);
  assert.equal(report.usage.inputTokens, report.configuration.usageEvents * 3);
  assert.equal(report.pluginReload.publiclyCallable, true);
  assert.equal(report.pluginReload.exercised, true);
  assert.equal(report.pluginReload.reloads, report.configuration.pluginReloads);
  assert.equal(report.pluginReload.disposedRegistrations, report.pluginReload.reloads);
  assert.equal(report.pluginReload.lifecycle.active.registrationCount, 1);
  assert.equal(report.pluginReload.lifecycle.active.pendingCleanupCount, 0);
  assert.equal(report.pluginReload.lifecycle.unloaded.registrationCount, 0);
  assert.deepEqual(report.pluginReload.lifecycle.disposed, {
    status: "disposed",
    registrationCount: 0,
    pendingCleanupCount: 0,
    registrations: [],
    truncated: false,
  });
  assert.deepEqual(report.cleanup, {
    ownerStopped: true,
    endpointClosed: true,
    leaseRemoved: true,
    tempRootRemoved: true,
    tempDatabaseRemoved: true,
  });
  assert.ok(report.deltas.heapUsedBytes <= report.bounds.maxHeapGrowthBytes);
  if (report.deltas.activeHandles !== null) {
    assert.ok(report.deltas.activeHandles <= report.bounds.maxActiveHandleGrowth);
  }
  if (report.deltas.fileDescriptors !== null) {
    assert.ok(report.deltas.fileDescriptors <= report.bounds.maxFileDescriptorGrowth);
  }
  context.diagnostic(JSON.stringify({
    subprocessExitCode: exitCode,
    heapBefore: report.before.heapUsedBytes,
    heapAfter: report.after.heapUsedBytes,
    heapDelta: report.deltas.heapUsedBytes,
    handlesBefore: report.before.activeHandles,
    handlesAfter: report.after.activeHandles,
    handlesDelta: report.deltas.activeHandles,
    fdBefore: report.before.fileDescriptors,
    fdAfter: report.after.fileDescriptors,
    fdDelta: report.deltas.fileDescriptors,
    retainedSessions: report.owner.retainedBeforeStop,
    peakEngineSubscribers: report.owner.peakEngineSubscribers,
    cleanup: report.cleanup,
  }));
});
