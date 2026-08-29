import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseAgentConsoleSnapshot } from "@unclecode/contracts";
import {
  applyTraceEventToAgentConsole,
  bindRuntimeUsageRecorder,
} from "@unclecode/orchestrator";
import { openRuntimeLedger } from "../../apps/unclecode-server/src/runtime-ledger.ts";

const tempDirectories = [];

test.after(() => {
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
});

function ledgerPath() {
  const directory = mkdtempSync(join(tmpdir(), "unclecode-agent-console-usage-"));
  tempDirectories.push(directory);
  return join(directory, "runtime.sqlite");
}

function usageEvent(eventId, overrides = {}) {
  return {
    type: "usage.recorded",
    eventId,
    provider: "openai",
    model: "gpt-5.6-sol",
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: 1,
    cacheWriteTokens: 1,
    cacheSavingsUsd: 0.5,
    costUsd: 1,
    ...overrides,
  };
}

test("owner usage recorder keeps 10k exact identities out of the bounded projection across restart", { timeout: 120_000 }, (context) => {
  const dbPath = ledgerPath();
  let ledger = openRuntimeLedger({ dbPath });
  let recorder = bindRuntimeUsageRecorder({
    sessionId: "session-scale",
    ledger,
  });
  let snapshot = {
    profileId: "build",
    activity: [],
    agents: [],
    jobs: [],
  };
  const startedAt = performance.now();
  for (let index = 0; index < 10_000; index += 1) {
    snapshot = applyTraceEventToAgentConsole(
      snapshot,
      usageEvent(`usage-${String(index)}`),
      recorder,
    );
  }

  const checkpoint = JSON.stringify(snapshot);
  assert.equal(snapshot.mainUsage?.inputTokens, 30_000);
  assert.equal(snapshot.totalUsage?.costUsd, 10_000);
  assert.equal(snapshot.totalUsage?.routes?.[0]?.cacheReadTokens, 10_000);
  assert.doesNotMatch(checkpoint, /eventIds/);
  assert.ok(Buffer.byteLength(checkpoint) < 4_096, "identity count must not grow checkpoint bytes");

  const duplicate = applyTraceEventToAgentConsole(snapshot, usageEvent("usage-0"), recorder);
  assert.deepEqual(duplicate, snapshot);
  const changedPayload = applyTraceEventToAgentConsole(
    snapshot,
    usageEvent("usage-0", { costUsd: 99 }),
    recorder,
  );
  assert.strictEqual(changedPayload, snapshot);

  ledger.close();
  ledger = openRuntimeLedger({ dbPath });
  recorder = bindRuntimeUsageRecorder({ sessionId: "session-scale", ledger });
  const resumed = parseAgentConsoleSnapshot(JSON.parse(checkpoint));
  assert.ok(resumed);
  const replayedAfterRestart = applyTraceEventToAgentConsole(
    resumed,
    usageEvent("usage-9"),
    recorder,
  );
  assert.deepEqual(replayedAfterRestart, resumed);
  const appendedAfterRestart = applyTraceEventToAgentConsole(
    resumed,
    usageEvent("usage-10000"),
    recorder,
  );
  assert.equal(appendedAfterRestart.totalUsage?.costUsd, 10_001);
  assert.equal(appendedAfterRestart.mainUsage?.inputTokens, 30_003);
  assert.doesNotMatch(JSON.stringify(appendedAfterRestart), /eventIds/);
  ledger.close();

  context.diagnostic(
    `projection_bytes=${String(Buffer.byteLength(checkpoint))} elapsed_ms=${String(Math.round(performance.now() - startedAt))}`,
  );
});

test("usage projection fails closed when the owner ledger is absent or throws", () => {
  const snapshot = { profileId: "build", activity: [], agents: [], jobs: [] };
  const event = usageEvent("usage-fail-closed");
  assert.strictEqual(applyTraceEventToAgentConsole(snapshot, event), snapshot);
  assert.strictEqual(
    applyTraceEventToAgentConsole(snapshot, event, {
      recordUsage() {
        throw new Error("ledger unavailable");
      },
    }),
    snapshot,
  );
});

test("owner session total survives more settled agents than the 128-row console projection", () => {
  const dbPath = ledgerPath();
  const ledger = openRuntimeLedger({ dbPath });
  let snapshot = { profileId: "build", activity: [], agents: [], jobs: [] };
  const recorder = bindRuntimeUsageRecorder({
    sessionId: "session-many-agents",
    ledger,
    projectedAgentIds: () => snapshot.agents.map((agent) => agent.id),
  });
  for (let index = 0; index < 160; index += 1) {
    const runId = `run-${String(index)}`;
    const jobId = `job-${String(index)}`;
    snapshot = applyTraceEventToAgentConsole(snapshot, {
      type: "job.queued",
      jobId,
      jobType: "work-node",
      label: `Agent ${String(index)}`,
      queuedAt: index * 10,
    });
    snapshot = applyTraceEventToAgentConsole(snapshot, {
      type: "agent.run.started",
      runId,
      jobId,
      displayName: `Agent ${String(index)}`,
      agentType: "executor",
      startedAt: index * 10 + 1,
    });
    snapshot = applyTraceEventToAgentConsole(
      snapshot,
      usageEvent(`usage-agent-${String(index)}`, { agentRunId: runId, costUsd: 0.25 }),
      recorder,
    );
    snapshot = applyTraceEventToAgentConsole(snapshot, {
      type: "agent.run.settled",
      runId,
      jobId,
      status: "completed",
      completedAt: index * 10 + 2,
    });
  }

  assert.equal(snapshot.agents.length, 128);
  assert.equal(snapshot.agents[0]?.id, "run-32");
  assert.equal(snapshot.totalUsage?.costUsd, 40);
  assert.equal(snapshot.totalUsage?.inputTokens, 480);
  assert.doesNotMatch(JSON.stringify(snapshot), /eventIds/);
  assert.equal(ledger.snapshotUsageTotals("session-many-agents").byAgent.length, 160);
  ledger.close();
});
