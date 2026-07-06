import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAgentOpsStore } from "@unclecode/agentops-db";
import {
  createBridgeProvider,
  createBuiltinProviderRegistry,
  createLoopTrailProvider,
  createMemoryProvider,
  createRuntimeProvider,
  createWorkspaceGuidanceProvider,
  contextSourceToPacketItem,
  selectContextPacketFromStore,
} from "@unclecode/context-broker";

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = join(tmpdir(), `unclecode-crp-${prefix}-${process.pid}-${tempDirs.length}`);
  tempDirs.push(dir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

test.afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore() {
  const home = makeTempDir("home");
  const store = createAgentOpsStore({ home });
  store.addProject({ id: "proj_test", name: "Test", repoPath: "/repos/test" });
  return store;
}

// ── RuntimeProvider ──────────────────────────────────────────────────

test("RuntimeProvider upserts trace lines with recency-based salience", async () => {
  const store = makeStore();
  const provider = createRuntimeProvider();
  provider.pushTraceLine("first trace line");
  provider.pushTraceLine("second trace line");
  provider.pushTraceLine("third trace line");

  const touched = await provider.sync({
    store,
    projectId: "proj_test",
    cwd: "/repos/test",
    sessionId: "s1",
  });

  assert.equal(touched.length, 3);
  const result = store.selectContextSources({
    projectId: "proj_test",
    tokenBudget: 10000,
    turnIndex: 1,
  });
  // Newest (third) should rank highest. Labels are truncated to 120 chars
  // but these are short enough to pass through intact.
  assert.equal(result.selected[0].label, "third trace line");
  assert.equal(result.selected[1].label, "second trace line");
  assert.equal(result.selected[2].label, "first trace line");
  // Salience should be descending
  assert.ok(result.selected[0].salience >= result.selected[1].salience);
  assert.ok(result.selected[1].salience >= result.selected[2].salience);
});

test("RuntimeProvider caps buffer at MAX_TRACE", async () => {
  const store = makeStore();
  const provider = createRuntimeProvider();
  for (let i = 0; i < 20; i += 1) {
    provider.pushTraceLine(`line ${i}`);
  }
  await provider.sync({
    store, projectId: "proj_test", cwd: "/repos/test", sessionId: "s1",
  });
  const result = store.selectContextSources({
    projectId: "proj_test", tokenBudget: 10000, turnIndex: 1,
  });
  // Should only have last 12
  assert.equal(result.selected.length, 12);
  // Oldest should be line 8 (20-12=8)
  const labels = result.selected.map((r) => r.label);
  assert.ok(labels.some((l) => l.startsWith("line 8")));
  assert.ok(!labels.some((l) => l.startsWith("line 7")));
});

test("RuntimeProvider.clearTrace empties buffer", async () => {
  const store = makeStore();
  const provider = createRuntimeProvider();
  provider.pushTraceLine("a");
  provider.pushTraceLine("b");
  provider.clearTrace();
  const touched = await provider.sync({
    store, projectId: "proj_test", cwd: "/repos/test", sessionId: "s1",
  });
  assert.equal(touched.length, 0);
});

// ── MemoryProvider ───────────────────────────────────────────────────

test("MemoryProvider upserts scoped memory lines", async () => {
  const store = makeStore();
  const fakeListMemory = async (input) => {
    if (input.scope === "session") return ["session mem · fresh", "session mem 2"];
    if (input.scope === "project") return ["project mem · recent"];
    return [];
  };
  const provider = createMemoryProvider(fakeListMemory);
  const touched = await provider.sync({
    store, projectId: "proj_test", cwd: "/repos/test", sessionId: "s1",
  });
  assert.equal(touched.length, 3);
  const result = store.selectContextSources({
    projectId: "proj_test", tokenBudget: 10000, turnIndex: 1,
  });
  assert.equal(result.selected.length, 3);
  assert.equal(result.selected[0].category, "memory");
});

// ── LoopTrailProvider ────────────────────────────────────────────────

test("LoopTrailProvider handles empty .omo directory gracefully", async () => {
  const cwd = makeTempDir("omo-empty");
  const store = makeStore();
  const provider = createLoopTrailProvider();
  const touched = await provider.sync({
    store, projectId: "proj_test", cwd, sessionId: "s1",
  });
  // No .omo dir → empty snapshot → no rows
  assert.equal(touched.length, 0);
});

test("LoopTrailProvider upserts goals + holds back excluded artifacts", async () => {
  const cwd = makeTempDir("omo-full");
  // Simulate an OMO loop trail session with an active goal
  const sessionDir = join(cwd, ".omo", "ulw-loop", "session-1");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "goals.json"),
    JSON.stringify({
      sessionId: "session-1",
      activeGoalId: "g1",
      goals: [
        {
          id: "g1",
          summary: "Ship the feature",
          status: "in_progress",
          successCriteria: [
            { id: "c1", summary: "Tests pass", status: "pending" },
          ],
        },
      ],
    }),
  );
  // Excluded artifact
  mkdirSync(join(sessionDir, "evidence"), { recursive: true });
  writeFileSync(join(sessionDir, "ledger.jsonl"), '{"event":"start"}\n');

  const store = makeStore();
  const provider = createLoopTrailProvider();
  const touched = await provider.sync({
    store, projectId: "proj_test", cwd, sessionId: "s1",
  });

  // 1 goal + 1 criterion (included) + excluded artifacts
  assert.ok(touched.length >= 2);
  const result = store.selectContextSources({
    projectId: "proj_test", tokenBudget: 10000, turnIndex: 1,
  });
  const included = result.selected.filter((r) => r.category === "loop-trail");
  const heldBack = result.heldBack.filter((r) => r.category === "loop-trail");
  assert.ok(included.length >= 1);
  assert.ok(heldBack.length >= 1);
  // Held back must never leak .omo/ path in label
  for (const item of heldBack) {
    assert.equal(item.label.includes(".omo"), false, `label leaked path: ${item.label}`);
  }
});

// ── Registry ─────────────────────────────────────────────────────────

test("createBuiltinProviderRegistry registers all 5 providers", () => {
  const store = makeStore();
  const fakeListMemory = async () => [];
  const registry = createBuiltinProviderRegistry(store, "proj_test", fakeListMemory);
  const providerIds = registry.listProviders().map((p) => p.providerId);
  assert.deepEqual(
    [...providerIds].sort(),
    ["bridge", "loop-trail", "memory", "runtime", "workspace-guidance"],
  );
});

test("registry.syncAll runs memory + runtime providers (deterministic subset)", async () => {
  // We don't run workspace-guidance here because it shells out to the Rust
  // binary which may not be built in the test environment. Memory + runtime
  // are pure-TS and deterministic.
  const store = makeStore();
  const { ContextProviderRegistry } = await import("@unclecode/context-broker");
  const registry = new ContextProviderRegistry(store, "proj_test");
  const fakeListMemory = async () => ["mem line"];
  const { createMemoryProvider, createRuntimeProvider } = await import("@unclecode/context-broker");
  registry.register(createMemoryProvider(fakeListMemory));
  const runtime = createRuntimeProvider();
  registry.register(runtime);
  runtime.pushTraceLine("trace line");

  const touched = await registry.syncAll({
    cwd: "/repos/test",
    sessionId: "s1",
  });
  assert.ok(touched.length >= 2);
  assert.ok(touched.includes("context-memory-1"));
  assert.ok(touched.includes("runtime-trace-1"));
});

// ── Selector ─────────────────────────────────────────────────────────

test("selectContextPacketFromStore produces a ContextPacketView", async () => {
  const store = makeStore();
  // Seed sources directly (bypass providers that need Rust/filesystem).
  store.upsertContextSource({
    id: "mem-1", projectId: "proj_test", category: "memory",
    label: "important memory", content: "remember this",
    reason: "scoped memory", salience: 0.8, tokenEstimate: 30,
  });
  store.upsertContextSource({
    id: "rt-1", projectId: "proj_test", category: "runtime",
    label: "important trace", content: "trace event",
    reason: "live work-shell trace", salience: 0.6, tokenEstimate: 20,
  });

  const packet = selectContextPacketFromStore({
    store,
    projectId: "proj_test",
    tokenBudget: 10000,
    turnIndex: 1,
  });

  assert.equal(packet.version, 1);
  assert.ok(packet.included.length >= 2);
  assert.ok(packet.sourceCounts.included >= 2);
  assert.ok(packet.tokenEstimate > 0);
  // All included items should have valid categories
  for (const item of packet.included) {
    assert.ok(typeof item.category === "string");
    assert.ok(typeof item.label === "string");
  }
});

test("contextSourceToPacketItem maps fields correctly", () => {
  const record = {
    id: "test-1",
    projectId: "p",
    category: "workspace-guidance",
    label: "Test Label",
    content: "Test content",
    reason: "test reason",
    sha256: null,
    salience: 0.8,
    tokenEstimate: 42,
    includedInModel: true,
    turnLastSeen: 5,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
  };
  const item = contextSourceToPacketItem(record);
  assert.equal(item.id, "test-1");
  assert.equal(item.category, "workspace-guidance");
  assert.equal(item.label, "Test Label");
  assert.equal(item.reason, "test reason");
  assert.equal(item.preview, "Test content");
  assert.equal(item.tokenEstimate, 42);
});

test("selectContextPacketFromStore respects token budget", async () => {
  const store = makeStore();
  // Upsert sources that together exceed a small budget
  store.upsertContextSource({
    id: "big1", projectId: "proj_test", category: "workspace",
    label: "big source 1", reason: "t", salience: 0.9, tokenEstimate: 100,
  });
  store.upsertContextSource({
    id: "big2", projectId: "proj_test", category: "bridge",
    label: "big source 2", reason: "t", salience: 0.5, tokenEstimate: 100,
  });

  const packet = selectContextPacketFromStore({
    store,
    projectId: "proj_test",
    tokenBudget: 150, // only fits one 100-token source
    turnIndex: 1,
  });

  assert.equal(packet.included.length, 1);
  assert.equal(packet.excluded.length, 1);
  assert.equal(packet.included[0].id, "big1");
});

test("selectContextPacketFromStore marks turn_last_seen", async () => {
  const store = makeStore();
  store.upsertContextSource({
    id: "ws-1", projectId: "proj_test", category: "workspace",
    label: "x", reason: "t", tokenEstimate: 10,
  });

  selectContextPacketFromStore({
    store, projectId: "proj_test", tokenBudget: 1000, turnIndex: 42,
  });

  const result = store.selectContextSources({
    projectId: "proj_test", tokenBudget: 1000, turnIndex: 43,
  });
  assert.equal(result.selected[0].turnLastSeen, 42);
});
