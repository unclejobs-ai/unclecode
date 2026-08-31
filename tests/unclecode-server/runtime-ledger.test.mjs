import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  canonicalMutationFingerprint,
  openRuntimeLedger,
} from "../../apps/unclecode-server/src/runtime-ledger.ts";

const tempDirectories = [];

function makeLedgerPath() {
  const directory = join(
    tmpdir(),
    `unclecode-runtime-ledger-${String(process.pid)}-${String(tempDirectories.length)}`,
  );
  tempDirectories.push(directory);
  rmSync(directory, { recursive: true, force: true });
  return join(directory, "owner.db");
}

function ledgerBytes(dbPath) {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
    .filter((path) => existsSync(path))
    .reduce((total, path) => total + statSync(path).size, 0);
}

test.afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mutation admission is atomic, canonical, durable, and detects changed fingerprints", () => {
  const dbPath = makeLedgerPath();
  let ledger = openRuntimeLedger({ dbPath });

  const first = ledger.admitMutation({
    sessionId: "session-a",
    domain: "queue",
    idempotencyKey: "enqueue-1",
    fingerprint: { command: "build", options: { clean: true, priority: 2 } },
  });
  assert.deepEqual(first, { kind: "admitted", acceptedRevision: 1 });

  assert.deepEqual(
    ledger.admitMutation({
      sessionId: "session-a",
      domain: "queue",
      idempotencyKey: "enqueue-1",
      fingerprint: { options: { priority: 2, clean: true }, command: "build" },
    }),
    { kind: "replay", status: "admitted", acceptedRevision: 1 },
  );

  ledger.completeMutation({
    sessionId: "session-a",
    domain: "queue",
    idempotencyKey: "enqueue-1",
    status: "completed",
    result: { queuePosition: 4, accepted: true },
  });
  ledger.close();

  ledger = openRuntimeLedger({ dbPath });
  assert.deepEqual(
    ledger.admitMutation({
      sessionId: "session-a",
      domain: "queue",
      idempotencyKey: "enqueue-1",
      fingerprint: { command: "build", options: { clean: true, priority: 2 } },
    }),
    {
      kind: "replay",
      status: "completed",
      acceptedRevision: 1,
      result: { accepted: true, queuePosition: 4 },
    },
  );
  assert.deepEqual(
    ledger.admitMutation({
      sessionId: "session-a",
      domain: "queue",
      idempotencyKey: "enqueue-1",
      fingerprint: { command: "test" },
    }),
    { kind: "mismatch", acceptedRevision: 1, status: "completed" },
  );
  assert.deepEqual(ledger.getSessionState("session-a"), {
    sessionId: "session-a",
    revision: 1,
    nextEventSeq: 1,
    eventLowWatermark: 1,
  });
  ledger.close();
});

test("mutation fingerprints share one bounded canonical representation", () => {
  assert.equal(
    canonicalMutationFingerprint({ action: "steer", payload: { message: "review", agentRunId: "agent-1" } }),
    canonicalMutationFingerprint({ payload: { agentRunId: "agent-1", message: "review" }, action: "steer" }),
  );
  assert.throws(
    () => canonicalMutationFingerprint({ message: "x".repeat(4_096) }),
    /fingerprint exceeds the 4096 byte limit/i,
  );
});

test("receipt lookup is non-mutating and distinguishes replay from changed reuse", () => {
  const ledger = openRuntimeLedger({ dbPath: makeLedgerPath() });
  const ref = {
    sessionId: "session-lookup",
    domain: "runtime-session",
    idempotencyKey: "control-1",
  };

  assert.deepEqual(ledger.lookupMutation({ ...ref, fingerprint: { action: "pause" } }), { kind: "miss" });
  assert.equal(ledger.getSessionState("session-lookup"), undefined, "a lookup miss cannot create revision state");
  assert.deepEqual(
    ledger.admitMutation({ ...ref, fingerprint: { action: "pause" } }),
    { kind: "admitted", acceptedRevision: 1 },
  );
  ledger.completeMutation({
    ...ref,
    status: "completed",
    result: { ok: true, revision: 1, state: "paused" },
  });
  assert.deepEqual(
    ledger.lookupMutation({ ...ref, fingerprint: { action: "pause" } }),
    {
      kind: "replay",
      status: "completed",
      acceptedRevision: 1,
      result: { ok: true, revision: 1, state: "paused" },
    },
  );
  assert.deepEqual(
    ledger.lookupMutation({ ...ref, fingerprint: { action: "resume" } }),
    { kind: "mismatch", status: "completed", acceptedRevision: 1 },
  );
  ledger.close();
});

test("legacy bootstrap revisions seed monotonically without minting receipts", () => {
  const ledger = openRuntimeLedger({ dbPath: makeLedgerPath() });

  assert.equal(ledger.seedSessionRevision("session-seed", 37), 37);
  assert.equal(ledger.seedSessionRevision("session-seed", 12), 37);
  assert.equal(ledger.seedSessionRevision("session-seed", 41), 41);
  assert.deepEqual(ledger.getSessionState("session-seed"), {
    sessionId: "session-seed",
    revision: 41,
    nextEventSeq: 1,
    eventLowWatermark: 1,
  });
  assert.deepEqual(
    ledger.admitMutation({
      sessionId: "session-seed",
      domain: "runtime-session",
      idempotencyKey: "after-bootstrap",
      fingerprint: { method: "setMode", args: ["deep"] },
    }),
    { kind: "admitted", acceptedRevision: 42 },
  );
  ledger.close();
});

test("recovery fences crash-window admissions as in_doubt until explicitly reopened", () => {
  const dbPath = makeLedgerPath();
  let ledger = openRuntimeLedger({ dbPath });
  ledger.admitMutation({
    sessionId: "session-crash",
    domain: "control",
    idempotencyKey: "pause-1",
    fingerprint: { action: "pause" },
  });
  ledger.admitMutation({
    sessionId: "session-crash",
    domain: "control",
    idempotencyKey: "cancel-1",
    fingerprint: { action: "cancel" },
  });
  ledger.completeMutation({
    sessionId: "session-crash",
    domain: "control",
    idempotencyKey: "cancel-1",
    status: "failed",
    result: { code: "provider_timeout" },
  });
  ledger.close();

  ledger = openRuntimeLedger({ dbPath });
  assert.equal(ledger.recoverInDoubt(), 1);
  assert.equal(ledger.recoverInDoubt(), 0);
  assert.deepEqual(
    ledger.admitMutation({
      sessionId: "session-crash",
      domain: "control",
      idempotencyKey: "pause-1",
      fingerprint: { action: "pause" },
    }),
    { kind: "replay", status: "in_doubt", acceptedRevision: 1 },
  );
  assert.deepEqual(
    ledger.reopenMutation({
      sessionId: "session-crash",
      domain: "control",
      idempotencyKey: "pause-1",
    }),
    { kind: "reopened", acceptedRevision: 1 },
  );
  assert.deepEqual(
    ledger.admitMutation({
      sessionId: "session-crash",
      domain: "control",
      idempotencyKey: "pause-1",
      fingerprint: { action: "pause" },
    }),
    { kind: "replay", status: "admitted", acceptedRevision: 1 },
  );
  assert.deepEqual(
    ledger.reopenMutation({
      sessionId: "session-crash",
      domain: "control",
      idempotencyKey: "cancel-1",
    }),
    { kind: "replay", status: "failed", acceptedRevision: 2, result: { code: "provider_timeout" } },
  );
  ledger.close();
});

test("usage recording is exact-once and atomically materializes every scope total", () => {
  const dbPath = makeLedgerPath();
  let ledger = openRuntimeLedger({ dbPath });
  const first = {
    sessionId: "session-usage",
    eventId: "turn-1",
    mainId: "main-a",
    agentId: "agent-a",
    route: { provider: "openai", model: "gpt-5" },
    counters: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 60,
      cacheWriteTokens: 4,
      cacheSavingsUsd: 0.03,
      costUsd: 0.08,
    },
  };
  assert.deepEqual(ledger.recordUsage(first), { kind: "recorded" });
  assert.deepEqual(ledger.recordUsage(first), { kind: "duplicate" });
  assert.deepEqual(
    ledger.recordUsage({
      ...first,
      counters: { ...first.counters, outputTokens: 21 },
    }),
    { kind: "scope_mismatch" },
  );
  assert.deepEqual(
    ledger.recordUsage({
      sessionId: "session-usage",
      eventId: "turn-2",
      mainId: "main-a",
      agentId: "agent-b",
      route: { provider: "anthropic", model: "claude-sonnet" },
      counters: {
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 5,
        cacheSavingsUsd: 0,
        costUsd: 0.12,
      },
    }),
    { kind: "recorded" },
  );
  ledger.close();

  ledger = openRuntimeLedger({ dbPath });
  assert.deepEqual(ledger.snapshotUsageTotals("session-usage"), {
    session: {
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 60,
      cacheWriteTokens: 9,
      cacheSavingsUsd: 0.03,
      costUsd: 0.2,
    },
    byMain: [
      {
        mainId: "main-a",
        totals: {
          inputTokens: 150,
          outputTokens: 30,
          cacheReadTokens: 60,
          cacheWriteTokens: 9,
          cacheSavingsUsd: 0.03,
          costUsd: 0.2,
        },
      },
    ],
    byAgent: [
      {
        agentId: "agent-a",
        totals: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 60,
          cacheWriteTokens: 4,
          cacheSavingsUsd: 0.03,
          costUsd: 0.08,
        },
      },
      {
        agentId: "agent-b",
        totals: {
          inputTokens: 50,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 5,
          cacheSavingsUsd: 0,
          costUsd: 0.12,
        },
      },
    ],
    byRoute: [
      {
        provider: "anthropic",
        model: "claude-sonnet",
        totals: {
          inputTokens: 50,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 5,
          cacheSavingsUsd: 0,
          costUsd: 0.12,
        },
      },
      {
        provider: "openai",
        model: "gpt-5",
        totals: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 60,
          cacheWriteTokens: 4,
          cacheSavingsUsd: 0.03,
          costUsd: 0.08,
        },
      },
    ],
  });
  const filtered = ledger.snapshotUsageTotals("session-usage", {
    mainIds: ["main-a"],
    agentIds: ["agent-b"],
    includeRoutes: false,
  });
  assert.deepEqual(filtered.session, {
    inputTokens: 150,
    outputTokens: 30,
    cacheReadTokens: 60,
    cacheWriteTokens: 9,
    cacheSavingsUsd: 0.03,
    costUsd: 0.2,
  });
  assert.deepEqual(filtered.byMain.map(item => item.mainId), ["main-a"]);
  assert.deepEqual(filtered.byAgent.map(item => item.agentId), ["agent-b"]);
  assert.deepEqual(filtered.byRoute, []);
  assert.deepEqual(
    ledger.snapshotUsageTotals("session-usage", {}),
    { session: filtered.session, byMain: [], byAgent: [], byRoute: [] },
  );
  assert.throws(
    () => ledger.snapshotUsageTotals("session-usage", { mainIds: Array.from({ length: 9 }, (_, index) => `main-${String(index)}`) }),
    /mainIds cannot contain more than 8/i,
  );
  assert.throws(
    () => ledger.snapshotUsageTotals("session-usage", { agentIds: ["agent-a", "agent-a"] }),
    /agentIds must not contain duplicates/i,
  );
  ledger.close();
});

test("usage total overflow rejects and rolls back the event and every materialized scope", () => {
  const ledger = openRuntimeLedger({ dbPath: makeLedgerPath() });
  const counters = (inputTokens, costUsd) => ({
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheSavingsUsd: 0,
    costUsd,
  });
  const base = {
    sessionId: "usage-overflow",
    mainId: "main",
    agentId: "agent",
    route: { provider: "test", model: "overflow" },
  };
  ledger.recordUsage({ ...base, eventId: "near-token-max", counters: counters(Number.MAX_SAFE_INTEGER - 1, 0) });
  assert.throws(
    () => ledger.recordUsage({ ...base, eventId: "token-overflow", counters: counters(2, 0) }),
    /usage total overflow/i,
  );
  assert.equal(
    ledger.recordUsage({ ...base, eventId: "token-overflow", counters: counters(1, 0) }).kind,
    "recorded",
    "the rejected event insert must roll back with its totals",
  );

  ledger.recordUsage({ ...base, sessionId: "money-overflow", eventId: "large-money", counters: counters(0, 1e308) });
  assert.throws(
    () => ledger.recordUsage({ ...base, sessionId: "money-overflow", eventId: "money-overflow", counters: counters(0, 1e308) }),
    /usage total overflow/i,
  );
  assert.equal(ledger.snapshotUsageTotals("money-overflow").session.costUsd, 1e308);
  ledger.close();
});

test("runtime event sequence survives restart and reports replay expiry after bounded retention", () => {
  const dbPath = makeLedgerPath();
  let ledger = openRuntimeLedger({ dbPath, maxEventsPerSession: 3 });
  for (let index = 1; index <= 5; index += 1) {
    assert.deepEqual(
      ledger.appendRuntimeEvent({
        sessionId: "session-events",
        type: "turn.delta",
        payload: { text: `chunk-${String(index)}` },
      }),
      { seq: index, type: "turn.delta", payload: { text: `chunk-${String(index)}` } },
    );
  }
  ledger.close();

  ledger = openRuntimeLedger({ dbPath, maxEventsPerSession: 3 });
  assert.deepEqual(
    ledger.appendRuntimeEvent({ sessionId: "session-events", type: "turn.done", payload: { ok: true } }),
    { seq: 6, type: "turn.done", payload: { ok: true } },
  );
  assert.deepEqual(ledger.replayRuntimeEvents("session-events", 3), {
    kind: "events",
    lowWatermark: 4,
    nextEventSeq: 7,
    events: [
      { seq: 4, type: "turn.delta", payload: { text: "chunk-4" } },
      { seq: 5, type: "turn.delta", payload: { text: "chunk-5" } },
      { seq: 6, type: "turn.done", payload: { ok: true } },
    ],
  });
  assert.deepEqual(ledger.replayRuntimeEvents("session-events", 2), {
    kind: "expired",
    lowWatermark: 4,
    nextEventSeq: 7,
    events: [],
  });
  assert.deepEqual(ledger.getSessionState("session-events"), {
    sessionId: "session-events",
    revision: 0,
    nextEventSeq: 7,
    eventLowWatermark: 4,
  });
  ledger.close();
});

test("unknown and future event cursors expire while the current tip remains valid", () => {
  const ledger = openRuntimeLedger({ dbPath: makeLedgerPath() });
  assert.deepEqual(ledger.replayRuntimeEvents("unknown-session", 1), {
    kind: "expired",
    lowWatermark: 1,
    nextEventSeq: 1,
    events: [],
  });
  ledger.appendRuntimeEvent({ sessionId: "cursor-session", type: "ready", payload: null });
  assert.deepEqual(ledger.replayRuntimeEvents("cursor-session", 1), {
    kind: "events",
    lowWatermark: 1,
    nextEventSeq: 2,
    events: [],
  });
  assert.deepEqual(ledger.replayRuntimeEvents("cursor-session", 2), {
    kind: "expired",
    lowWatermark: 1,
    nextEventSeq: 2,
    events: [],
  });
  ledger.close();
});

test("event low watermark never moves backward when retention is increased", () => {
  const dbPath = makeLedgerPath();
  let ledger = openRuntimeLedger({ dbPath, maxEventsPerSession: 2 });
  for (let index = 1; index <= 3; index += 1) {
    ledger.appendRuntimeEvent({ sessionId: "session-watermark", type: "delta", payload: { index } });
  }
  assert.equal(ledger.getSessionState("session-watermark")?.eventLowWatermark, 2);
  ledger.close();

  ledger = openRuntimeLedger({ dbPath, maxEventsPerSession: 100 });
  ledger.appendRuntimeEvent({ sessionId: "session-watermark", type: "done", payload: null });
  assert.deepEqual(ledger.replayRuntimeEvents("session-watermark", 0), {
    kind: "expired",
    lowWatermark: 2,
    nextEventSeq: 5,
    events: [],
  });
  ledger.close();
});

test("ledger creation enforces private directory and database permissions", () => {
  const dbPath = makeLedgerPath();
  const ledger = openRuntimeLedger({ dbPath });
  ledger.close();

  assert.equal(lstatSync(join(dbPath, "..")).mode & 0o777, 0o700);
  assert.equal(lstatSync(dbPath).mode & 0o777, 0o600);
});

test("ledger open rejects symlinked storage paths without touching their targets", () => {
  const dbPath = makeLedgerPath();
  const root = join(dbPath, "..");
  const targetDirectory = join(root, "target");
  const linkedDirectory = join(root, "linked");
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  symlinkSync(targetDirectory, linkedDirectory, "dir");
  assert.throws(
    () => openRuntimeLedger({ dbPath: join(linkedDirectory, "owner.db") }),
    /parent must be a real directory, not a symlink/,
  );
  assert.equal(existsSync(join(targetDirectory, "owner.db")), false);

  const targetFile = join(root, "target.db");
  const linkedFile = join(root, "linked.db");
  writeFileSync(targetFile, "do-not-touch", { mode: 0o600 });
  symlinkSync(targetFile, linkedFile);
  assert.throws(() => openRuntimeLedger({ dbPath: linkedFile }), /not a regular file/);
  assert.equal(readFileSync(targetFile, "utf8"), "do-not-touch");
});

test("corrupt databases fail closed and preserve the original bytes", () => {
  const dbPath = makeLedgerPath();
  mkdirSync(join(dbPath, ".."), { recursive: true, mode: 0o700 });
  chmodSync(join(dbPath, ".."), 0o700);
  const corruptBytes = Buffer.from("this is not sqlite");
  writeFileSync(dbPath, corruptBytes, { mode: 0o600 });

  assert.throws(() => openRuntimeLedger({ dbPath }), /Unable to open runtime ledger/);
  assert.deepEqual(readFileSync(dbPath), corruptBytes);
});

test("valid SQLite files owned by another application are rejected without mutation", () => {
  const dbPath = makeLedgerPath();
  mkdirSync(join(dbPath, ".."), { recursive: true, mode: 0o700 });
  const foreign = new DatabaseSync(dbPath);
  foreign.exec("CREATE TABLE foreign_data (value TEXT)");
  foreign.exec("INSERT INTO foreign_data VALUES ('keep-me')");
  foreign.close();
  const originalBytes = readFileSync(dbPath);

  assert.throws(() => openRuntimeLedger({ dbPath }), /not an UncleCode runtime ledger/);
  assert.deepEqual(readFileSync(dbPath), originalBytes);
});

test("receipt, result, and event payload byte limits reject growth before durable state changes", () => {
  const dbPath = makeLedgerPath();
  const ledger = openRuntimeLedger({
    dbPath,
    receiptFingerprintMaxBytes: 16,
    receiptResultMaxBytes: 16,
    eventPayloadMaxBytes: 16,
  });
  assert.throws(
    () =>
      ledger.admitMutation({
        sessionId: "bounded",
        domain: "queue",
        idempotencyKey: "too-large",
        fingerprint: "x".repeat(20),
      }),
    /exceeds the 16 byte limit/,
  );
  assert.equal(ledger.getSessionState("bounded"), undefined);

  ledger.admitMutation({
    sessionId: "bounded",
    domain: "queue",
    idempotencyKey: "small",
    fingerprint: "ok",
  });
  assert.throws(
    () =>
      ledger.completeMutation({
        sessionId: "bounded",
        domain: "queue",
        idempotencyKey: "small",
        status: "completed",
        result: "x".repeat(20),
      }),
    /exceeds the 16 byte limit/,
  );
  assert.deepEqual(
    ledger.admitMutation({
      sessionId: "bounded",
      domain: "queue",
      idempotencyKey: "small",
      fingerprint: "ok",
    }),
    { kind: "replay", status: "admitted", acceptedRevision: 1 },
  );

  assert.throws(
    () => ledger.appendRuntimeEvent({ sessionId: "bounded", type: "delta", payload: "x".repeat(20) }),
    /exceeds the 16 byte limit/,
  );
  assert.equal(ledger.getSessionState("bounded")?.nextEventSeq, 1);
  ledger.close();
});

test("10.5k completed receipts replay from SQLite after reopen within disk and heap bounds", { timeout: 120_000 }, (context) => {
  const dbPath = makeLedgerPath();
  const count = 10_500;
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  let ledger = openRuntimeLedger({ dbPath });
  for (let index = 0; index < count; index += 1) {
    const idempotencyKey = `receipt-${String(index)}`;
    assert.equal(
      ledger.admitMutation({
        sessionId: "session-receipts",
        domain: "queue",
        idempotencyKey,
        fingerprint: { index, action: "enqueue" },
      }).kind,
      "admitted",
    );
    ledger.completeMutation({
      sessionId: "session-receipts",
      domain: "queue",
      idempotencyKey,
      status: "completed",
      result: { index },
    });
  }
  ledger.close();

  ledger = openRuntimeLedger({ dbPath });
  for (let index = 0; index < count; index += 1) {
    assert.deepEqual(
      ledger.admitMutation({
        sessionId: "session-receipts",
        domain: "queue",
        idempotencyKey: `receipt-${String(index)}`,
        fingerprint: { action: "enqueue", index },
      }),
      { kind: "replay", status: "completed", acceptedRevision: index + 1, result: { index } },
    );
  }
  assert.equal(ledger.getSessionState("session-receipts")?.revision, count);
  ledger.close();

  const bytes = ledgerBytes(dbPath);
  const heapGrowth = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
  const elapsedMs = Math.round(performance.now() - startedAt);
  context.diagnostic(`receipt_scale elapsed_ms=${String(elapsedMs)} db_bytes=${String(bytes)} heap_growth=${String(heapGrowth)}`);
  assert.ok(bytes < 32 * 1024 * 1024, `receipt DB grew to ${String(bytes)} bytes`);
  assert.ok(heapGrowth < 192 * 1024 * 1024, `receipt heap grew by ${String(heapGrowth)} bytes`);
});

test("10k usage events ignore exact duplicates and preserve materialized vectors within bounds", { timeout: 120_000 }, (context) => {
  const dbPath = makeLedgerPath();
  const count = 10_000;
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const ledger = openRuntimeLedger({ dbPath });
  for (let index = 0; index < count; index += 1) {
    const input = {
      sessionId: "session-usage-scale",
      eventId: `usage-${String(index)}`,
      mainId: `main-${String(index % 2)}`,
      agentId: `agent-${String(index % 10)}`,
      route: index % 2 === 0
        ? { provider: "openai", model: "gpt-5" }
        : { provider: "anthropic", model: "claude-sonnet" },
      counters: {
        inputTokens: 3,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheWriteTokens: 1,
        cacheSavingsUsd: 0.5,
        costUsd: 1,
      },
    };
    assert.deepEqual(ledger.recordUsage(input), { kind: "recorded" });
    assert.deepEqual(ledger.recordUsage(input), { kind: "duplicate" });
  }
  assert.deepEqual(ledger.snapshotUsageTotals("session-usage-scale").session, {
    inputTokens: 30_000,
    outputTokens: 20_000,
    cacheReadTokens: 10_000,
    cacheWriteTokens: 10_000,
    cacheSavingsUsd: 5_000,
    costUsd: 10_000,
  });
  const snapshot = ledger.snapshotUsageTotals("session-usage-scale");
  assert.equal(snapshot.byMain.length, 2);
  assert.equal(snapshot.byAgent.length, 10);
  assert.equal(snapshot.byRoute.length, 2);
  assert.equal(snapshot.byMain[0]?.totals.inputTokens, 15_000);
  assert.equal(snapshot.byAgent[0]?.totals.outputTokens, 2_000);
  assert.equal(snapshot.byRoute[0]?.totals.costUsd, 5_000);
  ledger.close();

  const bytes = ledgerBytes(dbPath);
  const heapGrowth = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
  const elapsedMs = Math.round(performance.now() - startedAt);
  context.diagnostic(`usage_scale elapsed_ms=${String(elapsedMs)} db_bytes=${String(bytes)} heap_growth=${String(heapGrowth)}`);
  assert.ok(bytes < 32 * 1024 * 1024, `usage DB grew to ${String(bytes)} bytes`);
  assert.ok(heapGrowth < 192 * 1024 * 1024, `usage heap grew by ${String(heapGrowth)} bytes`);
});
