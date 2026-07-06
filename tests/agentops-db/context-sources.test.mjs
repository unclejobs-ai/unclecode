import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGENTOPS_SCHEMA_VERSION,
  createAgentOpsStore,
} from "@unclecode/agentops-db";

const tempHomes = [];

function makeHome() {
  const home = join(tmpdir(), `unclecode-crp-${process.pid}-${tempHomes.length}`);
  tempHomes.push(home);
  rmSync(home, { recursive: true, force: true });
  return home;
}

test.afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function seedProject(store) {
  return store.addProject({ id: "proj_crp", name: "CRP Test", repoPath: "/repos/crp" });
}

test("schema version bumps to 2 for context_sources table", () => {
  assert.equal(AGENTOPS_SCHEMA_VERSION, 2);
});

test("upsertContextSource round-trips through selectContextSources", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  const project = seedProject(store);

  store.upsertContextSource({
    id: "ws-1",
    projectId: project.id,
    category: "workspace-guidance",
    label: "AGENTS.md guidance",
    content: "Use rg for search.",
    reason: "workspace guidance summary",
    salience: 0.8,
    tokenEstimate: 50,
  });

  const result = store.selectContextSources({
    projectId: project.id,
    tokenBudget: 1000,
    turnIndex: 1,
  });

  assert.equal(result.selected.length, 1);
  const record = result.selected[0];
  assert.equal(record.id, "ws-1");
  assert.equal(record.category, "workspace-guidance");
  assert.equal(record.label, "AGENTS.md guidance");
  assert.equal(record.salience, 0.8);
  assert.equal(record.tokenEstimate, 50);
  assert.equal(result.totalTokens, 50);
  assert.equal(result.heldBack.length, 0);
});

test("upsert is idempotent — same id updates, not duplicates", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  const project = seedProject(store);

  store.upsertContextSource({
    id: "mem-1",
    projectId: project.id,
    category: "memory",
    label: "v1",
    reason: "test",
    tokenEstimate: 10,
  });
  store.upsertContextSource({
    id: "mem-1",
    projectId: project.id,
    category: "memory",
    label: "v2",
    reason: "test updated",
    tokenEstimate: 20,
  });

  const counts = store.countContextSourcesByCategory(project.id);
  assert.equal(counts.get("memory"), 1);

  const result = store.selectContextSources({
    projectId: project.id,
    tokenBudget: 1000,
    turnIndex: 1,
  });
  assert.equal(result.selected[0].label, "v2");
  assert.equal(result.selected[0].tokenEstimate, 20);
});

test("selectContextSources ranks by salience desc", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  const project = seedProject(store);

  store.upsertContextSource({
    id: "low", projectId: project.id, category: "runtime",
    label: "low salience", reason: "t", salience: 0.2, tokenEstimate: 10,
  });
  store.upsertContextSource({
    id: "high", projectId: project.id, category: "workspace",
    label: "high salience", reason: "t", salience: 0.9, tokenEstimate: 10,
  });
  store.upsertContextSource({
    id: "mid", projectId: project.id, category: "bridge",
    label: "mid salience", reason: "t", salience: 0.5, tokenEstimate: 10,
  });

  const result = store.selectContextSources({
    projectId: project.id,
    tokenBudget: 1000,
    turnIndex: 1,
  });

  assert.deepEqual(
    result.selected.map((r) => r.id),
    ["high", "mid", "low"],
  );
});

test("budget controller holds back sources that exceed remaining budget", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  const project = seedProject(store);

  // Budget = 50. First source (salience 0.9) costs 30 → included (30/50).
  // Second (salience 0.5) costs 30 → 30+30=60 > 50 → held back.
  store.upsertContextSource({
    id: "big", projectId: project.id, category: "workspace",
    label: "big", reason: "t", salience: 0.9, tokenEstimate: 30,
  });
  store.upsertContextSource({
    id: "extra", projectId: project.id, category: "bridge",
    label: "extra", reason: "t", salience: 0.5, tokenEstimate: 30,
  });

  const result = store.selectContextSources({
    projectId: project.id,
    tokenBudget: 50,
    turnIndex: 1,
  });

  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].id, "big");
  assert.equal(result.heldBack.length, 1);
  assert.equal(result.heldBack[0].id, "extra");
});

test("top-ranked source is always included even if it alone exceeds budget", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  const project = seedProject(store);

  store.upsertContextSource({
    id: "huge", projectId: project.id, category: "workspace",
    label: "huge", reason: "t", salience: 0.99, tokenEstimate: 500,
  });

  const result = store.selectContextSources({
    projectId: project.id,
    tokenBudget: 100,
    turnIndex: 1,
  });

  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].id, "huge");
});

test("included_in_model = false sources go to heldBack", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  const project = seedProject(store);

  store.upsertContextSource({
    id: "held", projectId: project.id, category: "loop-trail",
    label: "local only", reason: "t", salience: 0.9, tokenEstimate: 10,
    includedInModel: false,
  });

  const result = store.selectContextSources({
    projectId: project.id,
    tokenBudget: 1000,
    turnIndex: 1,
  });

  assert.equal(result.selected.length, 0);
  assert.equal(result.heldBack.length, 1);
  assert.equal(result.heldBack[0].id, "held");
});

test("expired sources are pruned and excluded from selection", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  const project = seedProject(store);

  const pastIso = new Date(Date.now() - 1000).toISOString();
  store.upsertContextSource({
    id: "expired", projectId: project.id, category: "runtime",
    label: "gone", reason: "t", tokenEstimate: 10, expiresAt: pastIso,
  });
  store.upsertContextSource({
    id: "alive", projectId: project.id, category: "workspace",
    label: "here", reason: "t", tokenEstimate: 10,
  });

  const pruned = store.pruneExpiredContextSources();
  assert.equal(pruned, 1);

  const result = store.selectContextSources({
    projectId: project.id,
    tokenBudget: 1000,
    turnIndex: 1,
  });
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].id, "alive");
});

test("markContextSourceTurnSeen updates turn_last_seen", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  const project = seedProject(store);

  store.upsertContextSource({
    id: "ws-1", projectId: project.id, category: "workspace",
    label: "x", reason: "t", tokenEstimate: 10,
  });

  store.markContextSourceTurnSeen(["ws-1"], 7);

  const result = store.selectContextSources({
    projectId: project.id,
    tokenBudget: 1000,
    turnIndex: 8,
  });
  assert.equal(result.selected[0].turnLastSeen, 7);
});

test("categoryFilter narrows selection", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  const project = seedProject(store);

  store.upsertContextSource({
    id: "ws", projectId: project.id, category: "workspace",
    label: "x", reason: "t", salience: 0.9, tokenEstimate: 10,
  });
  store.upsertContextSource({
    id: "br", projectId: project.id, category: "bridge",
    label: "y", reason: "t", salience: 0.9, tokenEstimate: 10,
  });

  const result = store.selectContextSources({
    projectId: project.id,
    tokenBudget: 1000,
    turnIndex: 1,
    categoryFilter: ["workspace"],
  });
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].id, "ws");
});

// ── Context Inspector actions (pin/unpin/forget/include) ─────────────

test("pinContextSource sets salience to 1.0", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  const project = seedProject(store);
  store.upsertContextSource({
    id: "src-1", projectId: project.id, category: "workspace",
    label: "x", reason: "t", salience: 0.3, tokenEstimate: 10,
  });
  store.pinContextSource("src-1");
  const result = store.selectContextSources({
    projectId: project.id, tokenBudget: 1000, turnIndex: 1,
  });
  assert.equal(result.selected[0].salience, 1.0);
});

test("unpinContextSource restores default salience", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  const project = seedProject(store);
  store.upsertContextSource({
    id: "src-1", projectId: project.id, category: "workspace",
    label: "x", reason: "t", salience: 1.0, tokenEstimate: 10,
  });
  store.unpinContextSource("src-1");
  const result = store.selectContextSources({
    projectId: project.id, tokenBudget: 1000, turnIndex: 1,
  });
  assert.equal(result.selected[0].salience, 0.5);
});

test("forgetContextSource moves source to heldBack", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  const project = seedProject(store);
  store.upsertContextSource({
    id: "src-1", projectId: project.id, category: "workspace",
    label: "x", reason: "t", salience: 0.9, tokenEstimate: 10,
  });
  store.forgetContextSource("src-1");
  const result = store.selectContextSources({
    projectId: project.id, tokenBudget: 1000, turnIndex: 1,
  });
  assert.equal(result.selected.length, 0);
  assert.equal(result.heldBack.length, 1);
  assert.equal(result.heldBack[0].id, "src-1");
});

test("includeContextSource restores held-back source", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  const project = seedProject(store);
  store.upsertContextSource({
    id: "src-1", projectId: project.id, category: "workspace",
    label: "x", reason: "t", salience: 0.9, tokenEstimate: 10,
    includedInModel: false,
  });
  store.includeContextSource("src-1");
  const result = store.selectContextSources({
    projectId: project.id, tokenBudget: 1000, turnIndex: 1,
  });
  assert.equal(result.selected.length, 1);
  assert.equal(result.heldBack.length, 0);
});
