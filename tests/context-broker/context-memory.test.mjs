import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listProjectBridgeLines,
  listScopedMemoryEntries,
  listScopedMemoryLines,
  promoteScopedMemory,
  publishContextBridge,
  writeScopedMemory,
} from "../../packages/context-broker/src/index.ts";

function createLineageHarness() {
  const records = new Map();
  const recordInputs = [];
  const invalidated = [];
  const rolledBack = [];
  let expiryRuns = 0;
  const adapter = {
    record(input) {
      recordInputs.push(input);
      const record = { ...input, createdAt: "2026-07-13T00:00:00.000Z" };
      if (input.supersedesMemoryId) {
        const predecessor = records.get(input.supersedesMemoryId);
        if (predecessor?.state === "active") {
          records.set(
            input.supersedesMemoryId,
            { ...predecessor, state: "superseded" },
          );
        }
      }
      records.set(record.memoryId, record);
      return record;
    },
    invalidate(memoryId) {
      const current = records.get(memoryId);
      if (!current) throw new Error(`missing lineage: ${memoryId}`);
      const invalid = { ...current, state: "superseded" };
      records.set(memoryId, invalid);
      invalidated.push(memoryId);
      return invalid;
    },
    rollbackPromotion(memoryId) {
      const current = records.get(memoryId);
      if (!current) throw new Error(`missing lineage: ${memoryId}`);
      records.set(memoryId, { ...current, state: "superseded" });
      if (current.supersedesMemoryId) {
        const predecessor = records.get(current.supersedesMemoryId);
        if (predecessor?.state === "superseded") {
          records.set(
            current.supersedesMemoryId,
            { ...predecessor, state: "active" },
          );
        }
      }
      rolledBack.push(memoryId);
    },
    expire() {
      expiryRuns += 1;
      return 0;
    },
    get(memoryId) {
      return records.get(memoryId);
    },
    isActive(memoryId) {
      return records.get(memoryId)?.state === "active";
    },
  };
  return {
    adapter,
    records,
    recordInputs,
    invalidated,
    rolledBack,
    expiryRuns: () => expiryRuns,
  };
}

test("context-broker exports project bridge and scoped memory helpers", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-context-broker-memory-"));
  const rootDir = path.join(cwd, ".state");
  const env = { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir };

  const bridge = await publishContextBridge({
    cwd,
    env,
    summary: "Summarized work-shell runtime state",
    source: "work-shell",
    target: "session-center",
    kind: "summary",
  });

  await writeScopedMemory({
    scope: "session",
    cwd,
    env,
    sessionId: "work-ctx-1",
    summary: "Session remembers the latest runtime split.",
  });

  const bridgeLines = await listProjectBridgeLines(cwd, env);
  const sessionLines = await listScopedMemoryLines({
    scope: "session",
    cwd,
    env,
    sessionId: "work-ctx-1",
  });

  assert.match(bridge.line, /work-shell/);
  assert.ok(bridgeLines.some((line) => /runtime state/.test(line)));
  assert.ok(sessionLines.some((line) => /latest runtime split/.test(line)));
});

test("durable context helpers retract bridge and scoped memory writes", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-context-broker-retract-"));
  const env = { ...process.env, UNCLECODE_SESSION_STORE_ROOT: path.join(cwd, ".state") };
  const bridge = await publishContextBridge({
    cwd,
    env,
    summary: "Interrupted bridge",
    source: "work-shell",
    target: "project-context",
    kind: "summary",
  });
  const memory = await writeScopedMemory({
    scope: "session",
    cwd,
    env,
    sessionId: "interrupted-session",
    summary: "Interrupted memory",
  });

  await bridge.rollback();
  await memory.rollback();

  assert.deepEqual(await listProjectBridgeLines(cwd, env), []);
  assert.deepEqual(await listScopedMemoryEntries({
    scope: "session",
    cwd,
    env,
    sessionId: "interrupted-session",
  }), []);
});

test("listScopedMemoryEntries preserves scope, citation id, and timestamp metadata", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-context-broker-entries-"));
  const rootDir = path.join(cwd, ".state");
  const env = { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir };

  await writeScopedMemory({
    scope: "session",
    cwd,
    env,
    sessionId: "work-ctx-entries",
    summary: "Session remembers the latest runtime split.",
  });

  const entries = await listScopedMemoryEntries({
    scope: "session",
    cwd,
    env,
    sessionId: "work-ctx-entries",
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.scope, "session");
  assert.match(entries[0]?.memoryId ?? "", /^memory:session:/);
  assert.ok(entries[0]?.timestamp.length > 0);
});

test("memory promotion requires submitted packet lineage", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-context-memory-proof-"));
  const env = { ...process.env, UNCLECODE_SESSION_STORE_ROOT: path.join(cwd, ".state") };
  const lineage = createLineageHarness();

  await assert.rejects(
    () => promoteScopedMemory({
      scope: "session",
      cwd,
      env,
      sessionId: "proof-session",
      summary: "fact",
      sourceId: "assistant-summary",
      turnId: "turn-1",
      confidence: 0.9,
      lineage: lineage.adapter,
    }),
    /submitted packet receipt required/i,
  );
  assert.deepEqual(lineage.recordInputs, []);
  assert.deepEqual(await listScopedMemoryEntries({
    scope: "session",
    cwd,
    env,
    sessionId: "proof-session",
  }), []);
});

test("memory promotion records provenance before exposing content", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-context-memory-promote-"));
  const env = { ...process.env, UNCLECODE_SESSION_STORE_ROOT: path.join(cwd, ".state") };
  const lineage = createLineageHarness();
  const promoted = await promoteScopedMemory({
    scope: "session",
    cwd,
    env,
    sessionId: "promote-session",
    summary: "Lineage-backed fact",
    sourceId: "assistant-summary",
    turnId: "turn-2",
    packetReceiptId: "receipt-2",
    confidence: 0.9,
    supersedesMemoryId: "memory-previous",
    lineage: lineage.adapter,
  });

  assert.deepEqual(lineage.recordInputs, [{
    memoryId: promoted.memoryId,
    sourceId: "assistant-summary",
    originTurnId: "turn-2",
    originPacketReceiptId: "receipt-2",
    supersedesMemoryId: "memory-previous",
    state: "active",
    confidence: 0.9,
  }]);
  const entries = await listScopedMemoryEntries({
    scope: "session",
    cwd,
    env,
    sessionId: "promote-session",
    lineage: lineage.adapter,
  });
  assert.equal(entries[0]?.memoryId, promoted.memoryId);
  assert.equal(entries[0]?.summary, "Lineage-backed fact");
  assert.equal(lineage.expiryRuns(), 1);
});

test("cancelled memory promotion removes content and restores its predecessor", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-context-memory-cancel-"));
  const env = { ...process.env, UNCLECODE_SESSION_STORE_ROOT: path.join(cwd, ".state") };
  const lineage = createLineageHarness();
  lineage.records.set("memory-previous", {
    memoryId: "memory-previous",
    sourceId: "assistant-summary",
    originTurnId: "turn-1",
    originPacketReceiptId: "receipt-1",
    state: "active",
    confidence: 0.8,
    createdAt: "2026-07-13T00:00:00.000Z",
  });
  const promoted = await promoteScopedMemory({
    scope: "session",
    cwd,
    env,
    sessionId: "cancel-session",
    summary: "Interrupted promotion",
    sourceId: "assistant-summary",
    turnId: "turn-2",
    packetReceiptId: "receipt-2",
    confidence: 0.9,
    supersedesMemoryId: "memory-previous",
    lineage: lineage.adapter,
  });

  await promoted.rollback();

  assert.equal(lineage.records.get(promoted.memoryId)?.state, "superseded");
  assert.equal(lineage.records.get("memory-previous")?.state, "active");
  assert.deepEqual(await listScopedMemoryEntries({
    scope: "session",
    cwd,
    env,
    sessionId: "cancel-session",
    lineage: lineage.adapter,
  }), []);
});

test("memory promotion restores its predecessor when content persistence fails", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-context-memory-rollback-"));
  const blockedRoot = path.join(cwd, "blocked-root");
  writeFileSync(blockedRoot, "not a directory");
  const env = { ...process.env, UNCLECODE_SESSION_STORE_ROOT: blockedRoot };
  const lineage = createLineageHarness();
  lineage.records.set("memory-previous", {
    memoryId: "memory-previous",
    sourceId: "assistant-summary",
    originTurnId: "turn-2",
    originPacketReceiptId: "receipt-2",
    state: "active",
    confidence: 0.8,
    createdAt: "2026-07-13T00:00:00.000Z",
  });

  await assert.rejects(
    () => promoteScopedMemory({
      scope: "session",
      cwd,
      env,
      sessionId: "rollback-session",
      summary: "Must not become visible",
      sourceId: "assistant-summary",
      turnId: "turn-3",
      packetReceiptId: "receipt-3",
      confidence: 0.9,
      supersedesMemoryId: "memory-previous",
      lineage: lineage.adapter,
    }),
  );
  assert.equal(lineage.recordInputs.length, 1);
  assert.deepEqual(lineage.rolledBack, [lineage.recordInputs[0].memoryId]);
  assert.equal(lineage.records.get(lineage.recordInputs[0].memoryId)?.state, "superseded");
  assert.equal(lineage.records.get("memory-previous")?.state, "active");
});
