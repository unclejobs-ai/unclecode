import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

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

test("schema version bumps to 5 for context source metadata", () => {
  assert.equal(AGENTOPS_SCHEMA_VERSION, 5);
});

test("v3 migration purges legacy context source text instead of preserving possible secrets", () => {
  const home = makeHome();
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(join(home, "agentops.db"));
  const timestamp = new Date().toISOString();
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations (version, name, applied_at) VALUES
      (1, 'initial_schema', '${timestamp}'),
      (2, 'add_context_sources', '${timestamp}');

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      config_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO projects (id, name, repo_path, created_at, updated_at)
      VALUES ('proj_crp', 'CRP Test', '/repos/crp', '${timestamp}', '${timestamp}');

    CREATE TABLE context_sources (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      category      TEXT NOT NULL,
      label         TEXT NOT NULL,
      content       TEXT,
      reason        TEXT NOT NULL,
      sha256        TEXT,
      salience      REAL NOT NULL DEFAULT 0.5,
      token_estimate INTEGER NOT NULL DEFAULT 0,
      included_in_model INTEGER NOT NULL DEFAULT 1,
      turn_last_seen INTEGER,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      expires_at    TEXT
    );
  `);
  db.prepare(
    `INSERT INTO context_sources (
      id, project_id, category, label, content, reason, sha256,
      salience, token_estimate, included_in_model, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "legacy-secret",
    "proj_crp",
    "runtime",
    "OPENAI_API_KEY=sk-legacysecret123456",
    "AIzaSyDabcdefghijklmnopqrstuvwx123456789 and https://google.test/?key=AIzaSyDabcdefghijklmnopqrstuvwx123456789",
    "Bearer legacytokensecret123456",
    "abc123",
    0.9,
    10,
    1,
    timestamp,
    timestamp,
  );
  db.close();

  const store = createAgentOpsStore({ home });
  const result = store.selectContextSources({
    projectId: "proj_crp",
    tokenBudget: 1000,
    turnIndex: 1,
  });
  const record = result.selected[0];

  assert.equal(record.id, "legacy-secret");
  assert.equal(record.label, "[REDACTED_MIGRATED_CONTEXT]");
  assert.equal(record.content, null);
  assert.equal(record.reason, "[REDACTED_MIGRATED_CONTEXT]");
  assert.doesNotMatch(JSON.stringify(record), /sk-legacysecret|AIza|legacytoken|key=/);
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

test("context source identity and mutations are scoped by project", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  const projectA = seedProject(store);
  const projectB = store.addProject({ id: "proj_other", name: "Other", repoPath: "/repos/other" });

  store.upsertContextSource({
    id: "shared-id",
    projectId: projectA.id,
    category: "memory",
    label: "project A",
    reason: "test",
    salience: 0.4,
    tokenEstimate: 10,
  });
  store.upsertContextSource({
    id: "shared-id",
    projectId: projectB.id,
    category: "memory",
    label: "project B",
    reason: "test",
    salience: 0.7,
    tokenEstimate: 10,
  });

  store.pinContextSource(projectA.id, "shared-id");
  store.forgetContextSource(projectA.id, "shared-id");
  store.markContextSourceTurnSeen(projectA.id, ["shared-id"], 9);

  const resultA = store.selectContextSources({
    projectId: projectA.id,
    tokenBudget: 1000,
    turnIndex: 10,
  });
  const resultB = store.selectContextSources({
    projectId: projectB.id,
    tokenBudget: 1000,
    turnIndex: 10,
  });

  assert.equal(resultA.selected.length, 0);
  assert.equal(resultA.heldBack[0].label, "project A");
  assert.equal(resultA.heldBack[0].salience, 1.0);
  assert.equal(resultA.heldBack[0].turnLastSeen, 9);
  assert.equal(resultB.selected[0].label, "project B");
  assert.equal(resultB.selected[0].salience, 0.7);
  assert.equal(resultB.selected[0].includedInModel, true);
  assert.equal(resultB.selected[0].turnLastSeen, null);
});

test("upsertContextSource redacts secrets before persistence and selection", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  const project = seedProject(store);

  store.upsertContextSource({
    id: "secret-src",
    projectId: project.id,
    category: "runtime",
    label: "GOOGLE_API_KEY: AIzaSyDabcdefghijklmnopqrstuvwx123456789",
    content: "Bearer abcdefghijklmnop and https://user:pass@example.test/path?token=secret and https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSyDabcdefghijklmnopqrstuvwx123456789",
    reason: "saw ghp_abcdefghijklmnopqrstuvwxyz123456 and bare AIzaSyDabcdefghijklmnopqrstuvwx123456789",
    tokenEstimate: 10,
  });

  const result = store.selectContextSources({
    projectId: project.id,
    tokenBudget: 1000,
    turnIndex: 1,
  });
  const record = result.selected[0];

  assert.equal(record.label, "GOOGLE_API_KEY: [REDACTED]");
  assert.equal(record.content, "Bearer [REDACTED] and https://[REDACTED]@example.test/path?token=[REDACTED] and https://generativelanguage.googleapis.com/v1beta/models?key=[REDACTED]");
  assert.equal(record.reason, "saw [REDACTED] and bare [REDACTED]");
  assert.doesNotMatch(JSON.stringify(record), /AIza|abcdefghijklmnop|user:pass|ghp_/);
});

test("provider upserts preserve user forget and pin state", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  const project = seedProject(store);

  store.upsertContextSource({
    id: "src-1", projectId: project.id, category: "workspace",
    label: "first", reason: "provider", salience: 0.4, tokenEstimate: 10,
  });
  store.pinContextSource(project.id, "src-1");
  store.forgetContextSource(project.id, "src-1");

  store.upsertContextSource({
    id: "src-1", projectId: project.id, category: "workspace",
    label: "refreshed", reason: "provider refresh", salience: 0.2, tokenEstimate: 20,
  });

  const result = store.selectContextSources({
    projectId: project.id, tokenBudget: 1000, turnIndex: 1,
  });

  assert.equal(result.selected.length, 0);
  assert.equal(result.heldBack.length, 1);
  assert.equal(result.heldBack[0].id, "src-1");
  assert.equal(result.heldBack[0].label, "refreshed");
  assert.equal(result.heldBack[0].salience, 1.0);
  assert.equal(result.heldBack[0].tokenEstimate, 20);
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

  store.markContextSourceTurnSeen(project.id, ["ws-1"], 7);

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
  store.pinContextSource(project.id, "src-1");
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
  store.unpinContextSource(project.id, "src-1");
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
  store.forgetContextSource(project.id, "src-1");
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
  store.includeContextSource(project.id, "src-1");
  const result = store.selectContextSources({
    projectId: project.id, tokenBudget: 1000, turnIndex: 1,
  });
  assert.equal(result.selected.length, 1);
  assert.equal(result.heldBack.length, 0);
});
