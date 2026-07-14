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

function seedSubmittedReceipt(store, id = "receipt-memory", turnId = "turn-memory") {
  store.recordContextPacketPreview({
    id,
    projectId: "proj_crp",
    sessionId: `session-${id}`,
    packetId: `packet-${id}`,
    profile: "build",
    tokenEstimateState: "exact",
    tokenEstimate: 1,
    sourceCount: 0,
    sourceRefs: [],
  });
  return store.submitContextPacketReceipt({
    receiptId: id,
    projectId: "proj_crp",
    sessionId: `session-${id}`,
    turnId,
  });
}

test("schema version bumps to 8 for memory lineage", () => {
  assert.equal(AGENTOPS_SCHEMA_VERSION, 8);
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

// ── Context packet receipts (lifecycle ledger) ───────────────────────

test("packet receipt lifecycle records one submitted receipt per turn", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  store.addProject({ id: "project-1", name: "Receipt Project", repoPath: "/repos/receipt" });

  const receipt = store.recordContextPacketPreview({
    id: "receipt-1",
    projectId: "project-1",
    sessionId: "session-1",
    packetId: "crp-1",
    profile: "build",
    tokenEstimate: 1200,
    tokenEstimateState: "estimated",
    sourceCount: 1,
    sourceRefs: [{ sourceId: "AGENTS.md", category: "workspace-guidance", salience: 1, includedInModel: true }],
  });
  assert.equal(receipt.state, "previewed");
  const submitted = store.submitContextPacketReceipt({
    receiptId: receipt.id,
    projectId: "project-1",
    sessionId: "session-1",
    turnId: "turn-1",
  });
  assert.equal(submitted.state, "submitted");
  assert.equal(submitted.turnId, "turn-1");

  assert.throws(
    () => store.submitContextPacketReceipt({ receiptId: "receipt-2", projectId: "project-1", sessionId: "session-1", turnId: "turn-1" }),
    /submitted receipt already exists/i,
  );
});

test("packet receipts never persist raw source content", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  store.addProject({ id: "project-1", name: "Receipt Project", repoPath: "/repos/receipt" });

  store.recordContextPacketPreview({
    id: "receipt-safe",
    projectId: "project-1",
    sessionId: "session-safe",
    packetId: "crp-safe",
    profile: "build",
    tokenEstimateState: "unknown",
    sourceCount: 1,
    sourceRefs: [{ sourceId: "secret-source", category: "system", salience: 1, includedInModel: true }],
  });

  assert.throws(
    () =>
      store.recordContextPacketPreview({
        id: "receipt-unsafe",
        projectId: "project-1",
        sessionId: "session-unsafe",
        packetId: "crp-unsafe",
        profile: "build",
        tokenEstimateState: "unknown",
        sourceCount: 1,
        sourceRefs: [
          {
            sourceId: "secret-source",
            category: "system",
            salience: 1,
            includedInModel: true,
            content: "sk-leakedsecretvalue123",
          },
        ],
      }),
    /unsupported source ref key/i,
  );

  const db = new DatabaseSync(store.paths.dbPath);
  try {
    const raw = db.prepare("SELECT source_refs_json FROM context_packet_receipts WHERE id = ?").get("receipt-safe");
    assert.doesNotMatch(String(raw.source_refs_json), /content|sk-[A-Za-z0-9]/);
  } finally {
    db.close();
  }
});

test("packet receipt transitions only allow previewed rows", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  store.addProject({ id: "project-1", name: "Receipt Project", repoPath: "/repos/receipt" });

  const preview = store.recordContextPacketPreview({
    id: "receipt-guard",
    projectId: "project-1",
    sessionId: "session-guard",
    packetId: "crp-guard",
    profile: "build",
    tokenEstimateState: "exact",
    tokenEstimate: 10,
    sourceCount: 0,
    sourceRefs: [],
  });
  assert.equal(store.getActiveContextPacketPreview("project-1", "session-guard")?.id, preview.id);

  const submitted = store.submitContextPacketReceipt({
    receiptId: preview.id,
    projectId: "project-1",
    sessionId: "session-guard",
    turnId: "turn-guard",
  });
  assert.equal(submitted.state, "submitted");
  assert.equal(store.getActiveContextPacketPreview("project-1", "session-guard"), undefined);

  assert.throws(
    () =>
      store.submitContextPacketReceipt({
        receiptId: preview.id,
        projectId: "project-1",
        sessionId: "session-guard",
        turnId: "turn-guard-2",
      }),
    /not submittable/i,
  );
  assert.throws(
    () => store.invalidateContextPacketReceipt("project-1", preview.id),
    /not invalidatable/i,
  );

  const replacePreview = store.recordContextPacketPreview({
    id: "receipt-replace",
    projectId: "project-1",
    sessionId: "session-guard",
    packetId: "crp-guard-2",
    profile: "build",
    tokenEstimateState: "unknown",
    sourceCount: 0,
    sourceRefs: [],
    replacesReceiptId: preview.id,
  });
  const invalidated = store.invalidateContextPacketReceipt("project-1", replacePreview.id);
  assert.equal(invalidated.state, "invalidated");
  assert.equal(store.getContextPacketReceipt("project-1", replacePreview.id)?.state, "invalidated");
});

test("packet receipt replacesReceiptId rejects cross-project predecessors", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  store.addProject({ id: "project-a", name: "Project A", repoPath: "/repos/a" });
  store.addProject({ id: "project-b", name: "Project B", repoPath: "/repos/b" });

  store.recordContextPacketPreview({
    id: "receipt-a",
    projectId: "project-a",
    sessionId: "session-shared",
    packetId: "crp-a",
    profile: "build",
    tokenEstimateState: "unknown",
    sourceCount: 0,
    sourceRefs: [],
  });

  assert.throws(
    () =>
      store.recordContextPacketPreview({
        id: "receipt-b",
        projectId: "project-b",
        sessionId: "session-shared",
        packetId: "crp-b",
        profile: "build",
        tokenEstimateState: "unknown",
        sourceCount: 0,
        sourceRefs: [],
        replacesReceiptId: "receipt-a",
      }),
    /missing or out of scope/i,
  );
});

test("packet receipt replacesReceiptId rejects cross-session predecessors", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  store.addProject({ id: "project-1", name: "Receipt Project", repoPath: "/repos/receipt" });

  store.recordContextPacketPreview({
    id: "receipt-session-a",
    projectId: "project-1",
    sessionId: "session-a",
    packetId: "crp-session-a",
    profile: "build",
    tokenEstimateState: "unknown",
    sourceCount: 0,
    sourceRefs: [],
  });

  assert.throws(
    () =>
      store.recordContextPacketPreview({
        id: "receipt-session-b",
        projectId: "project-1",
        sessionId: "session-b",
        packetId: "crp-session-b",
        profile: "build",
        tokenEstimateState: "unknown",
        sourceCount: 0,
        sourceRefs: [],
        replacesReceiptId: "receipt-session-a",
      }),
    /missing or out of scope/i,
  );

  assert.throws(
    () =>
      store.recordContextPacketPreview({
        id: "receipt-missing",
        projectId: "project-1",
        sessionId: "session-b",
        packetId: "crp-missing",
        profile: "build",
        tokenEstimateState: "unknown",
        sourceCount: 0,
        sourceRefs: [],
        replacesReceiptId: "does-not-exist",
      }),
    /missing or out of scope/i,
  );
});

test("upgraded v5 databases apply receipt and suggestion migrations", () => {
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
      (2, 'add_context_sources', '${timestamp}'),
      (3, 'scope_context_sources_by_project', '${timestamp}'),
      (4, 'add_context_source_badges', '${timestamp}'),
      (5, 'add_context_source_metadata', '${timestamp}');

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      config_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.close();

  const store = createAgentOpsStore({ home });
  try {
    assert.equal(AGENTOPS_SCHEMA_VERSION, 8);
    const upgraded = new DatabaseSync(store.paths.dbPath);
    try {
      const version = upgraded.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get();
      assert.equal(version.version, 8);
      const table = upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_packet_receipts'")
        .get();
      assert.equal(table?.name, "context_packet_receipts");
    } finally {
      upgraded.close();
    }
  } finally {
    store.close();
  }
});

// ── Context optimizer suggestions ───────────────────────────────────

test("suggestions resolve once and stale only while proposed for their receipt", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  store.addProject({ id: "project-1", name: "Suggestion Project", repoPath: "/repos/suggestion" });
  const contentSentinel = "SECRET RAW CONTEXT MUST NOT PERSIST";
  for (const [receiptId, sessionId] of [["receipt-1", "session-1"], ["receipt-2", "session-2"]]) {
    store.recordContextPacketPreview({
      id: receiptId,
      projectId: "project-1",
      sessionId,
      packetId: `packet-${receiptId}`,
      profile: "build",
      tokenEstimateState: "unknown",
      sourceCount: 0,
      sourceRefs: [],
    });
  }

  const rejected = store.addContextPolicySuggestion({
    id: "suggestion-z-rejected",
    packetReceiptId: "receipt-1",
    sourceId: "trace-1",
    action: "hold-back",
    reasonCode: "duplicate-fingerprint",
    reasonText: "Duplicate runtime trace.",
    estimatedTokenSaving: 450,
    createdAt: "2026-07-13T00:00:01.000Z",
  });
  const stale = store.addContextPolicySuggestion({
    id: "suggestion-a-stale",
    packetReceiptId: "receipt-1",
    sourceId: "history-1",
    action: "summarize",
    reasonCode: "stale-condensed-history",
    reasonText: "Condensed history is stale.",
    createdAt: "2026-07-13T00:00:01.000Z",
    content: contentSentinel,
  });
  const accepted = store.addContextPolicySuggestion({
    id: "suggestion-accepted",
    packetReceiptId: "receipt-2",
    sourceId: "rules",
    action: "keep",
    reasonCode: "mandatory-guidance",
    reasonText: "Mandatory guidance remains active.",
    createdAt: "2026-07-13T00:00:03.000Z",
  });
  store.addContextPolicySuggestion({
    id: "suggestion-unrelated",
    packetReceiptId: "receipt-2",
    sourceId: "trace-2",
    action: "keep",
    reasonCode: "mandatory-guidance",
    reasonText: "Mandatory guidance remains active.",
    createdAt: "2026-07-13T00:00:04.000Z",
  });

  assert.equal(rejected.status, "proposed");
  assert.equal(stale.estimatedTokenSaving, undefined);
  assert.deepEqual(
    store.listContextPolicySuggestions("receipt-1").map((suggestion) => suggestion.id),
    ["suggestion-a-stale", "suggestion-z-rejected"],
  );
  const resolved = store.resolveContextPolicySuggestion(rejected.id, "rejected");
  assert.equal(resolved.status, "rejected");
  assert.equal(typeof resolved.resolvedAt, "string");
  assert.throws(
    () => store.resolveContextPolicySuggestion(rejected.id, "accepted"),
    /already resolved/i,
  );
  assert.equal(store.resolveContextPolicySuggestion(accepted.id, "accepted").status, "accepted");
  assert.throws(
    () => store.resolveContextPolicySuggestion("suggestion-unrelated", "stale"),
    /unsupported context policy resolution/i,
  );

  // Suggestions are generated only after submission, and submitted receipts
  // are terminal. The lifecycle caller explicitly stales their remaining
  // proposals when a newer packet or accepted mutation supersedes them.
  assert.equal(store.markContextPolicySuggestionsStale("receipt-1"), 1);
  assert.equal(store.markContextPolicySuggestionsStale("receipt-1"), 0);
  assert.deepEqual(
    store.listContextPolicySuggestions("receipt-1").map(({ id, status }) => ({ id, status })),
    [
      { id: "suggestion-a-stale", status: "stale" },
      { id: "suggestion-z-rejected", status: "rejected" },
    ],
  );
  assert.equal(
    store.listContextPolicySuggestions("receipt-2").find(({ id }) => id === "suggestion-unrelated")?.status,
    "proposed",
  );
  assert.throws(
    () => store.addContextPolicySuggestion({
      id: "suggestion-orphan",
      packetReceiptId: "receipt-missing",
      sourceId: "trace-orphan",
      action: "hold-back",
      reasonCode: "duplicate-fingerprint",
      reasonText: "Orphan suggestion.",
    }),
    /foreign key constraint failed/i,
  );
  const rawDb = new DatabaseSync(store.paths.dbPath);
  try {
    const raw = rawDb.prepare("SELECT * FROM context_policy_suggestions WHERE id = ?").get("suggestion-a-stale");
    assert.doesNotMatch(JSON.stringify(raw), new RegExp(contentSentinel));
  } finally {
    rawDb.close();
  }
});
test("suggestion batches roll back every row when one insert fails", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  store.addProject({ id: "project-1", name: "Batch Project", repoPath: "/repos/batch" });
  store.recordContextPacketPreview({
    id: "receipt-batch",
    projectId: "project-1",
    sessionId: "session-batch",
    packetId: "packet-batch",
    profile: "build",
    tokenEstimateState: "unknown",
    sourceCount: 0,
    sourceRefs: [],
  });
  const suggestion = {
    id: "suggestion-duplicate",
    packetReceiptId: "receipt-batch",
    sourceId: "trace-1",
    action: "keep",
    reasonCode: "mandatory-guidance",
    reasonText: "Mandatory guidance remains active.",
  };

  try {
    assert.throws(
      () => store.addContextPolicySuggestions([
        suggestion,
        { ...suggestion, sourceId: "trace-2" },
      ]),
      /unique constraint failed/i,
    );
    assert.deepEqual(store.listContextPolicySuggestions("receipt-batch"), []);
  } finally {
    store.close();
  }
});


test("v7 migration adds context_policy_suggestions for upgraded databases", () => {
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
      (2, 'add_context_sources', '${timestamp}'),
      (3, 'scope_context_sources_by_project', '${timestamp}'),
      (4, 'add_context_source_badges', '${timestamp}'),
      (5, 'add_context_source_metadata', '${timestamp}'),
      (6, 'add_context_packet_receipts', '${timestamp}');
    CREATE TABLE context_packet_receipts (id TEXT PRIMARY KEY);
  `);
  db.close();

  const store = createAgentOpsStore({ home });
  try {
    assert.equal(AGENTOPS_SCHEMA_VERSION, 8);
    const upgraded = new DatabaseSync(store.paths.dbPath);
    try {
      const version = upgraded.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get();
      assert.equal(version.version, 8);
      const table = upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_policy_suggestions'")
        .get();
      assert.equal(table?.name, "context_policy_suggestions");
      const index = upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_context_policy_suggestions_receipt_status'")
        .get();
      assert.equal(index?.name, "idx_context_policy_suggestions_receipt_status");
    } finally {
      upgraded.close();
    }
  } finally {
    store.close();
  }
});

test("memory lineage atomically supersedes one active predecessor", () => {
  const store = createAgentOpsStore({ home: makeHome() });
  seedProject(store);
  const receipt = seedSubmittedReceipt(store);
  const oldMemory = store.recordMemoryLineage({
    memoryId: "memory-old",
    sourceId: "source-a",
    originTurnId: "turn-old",
    originPacketReceiptId: receipt.id,
    state: "active",
    confidence: 0.8,
  });

  const nextMemory = store.recordMemoryLineage({
    memoryId: "memory-new",
    sourceId: "source-a",
    originTurnId: "turn-new",
    originPacketReceiptId: receipt.id,
    supersedesMemoryId: oldMemory.memoryId,
    state: "active",
    confidence: 0.9,
  });

  assert.equal(store.getMemoryLineage(oldMemory.memoryId)?.state, "superseded");
  assert.equal(nextMemory.state, "active");
  assert.deepEqual(store.listActiveMemoryLineage().map((record) => record.memoryId), ["memory-new"]);
  store.close();
});

test("memory lineage promotion rollback restores its active predecessor atomically", () => {
  const store = createAgentOpsStore({ home: makeHome() });
  seedProject(store);
  const receipt = seedSubmittedReceipt(store);
  store.recordMemoryLineage({
    memoryId: "memory-rollback-old",
    sourceId: "source-a",
    originTurnId: "turn-old",
    originPacketReceiptId: receipt.id,
    state: "active",
    confidence: 0.8,
  });
  store.recordMemoryLineage({
    memoryId: "memory-rollback-new",
    sourceId: "source-a",
    originTurnId: "turn-new",
    originPacketReceiptId: receipt.id,
    supersedesMemoryId: "memory-rollback-old",
    state: "active",
    confidence: 0.9,
  });

  store.rollbackMemoryLineagePromotion("memory-rollback-new");

  assert.equal(store.getMemoryLineage("memory-rollback-old")?.state, "active");
  assert.equal(store.getMemoryLineage("memory-rollback-new")?.state, "superseded");
  assert.deepEqual(
    store.listActiveMemoryLineage().map((record) => record.memoryId),
    ["memory-rollback-old"],
  );
  store.close();
});

test("memory lineage replacement rolls back predecessor transition when insert fails", () => {
  const store = createAgentOpsStore({ home: makeHome() });
  seedProject(store);
  const receipt = seedSubmittedReceipt(store);
  store.recordMemoryLineage({
    memoryId: "memory-old",
    sourceId: "source-a",
    originTurnId: "turn-old",
    originPacketReceiptId: receipt.id,
    state: "active",
    confidence: 0.8,
  });
  store.recordMemoryLineage({
    memoryId: "memory-duplicate",
    sourceId: "source-a",
    originTurnId: "turn-existing",
    originPacketReceiptId: receipt.id,
    state: "active",
    confidence: 0.7,
  });

  assert.throws(
    () => store.recordMemoryLineage({
      memoryId: "memory-duplicate",
      sourceId: "source-a",
      originTurnId: "turn-new",
      originPacketReceiptId: receipt.id,
      supersedesMemoryId: "memory-old",
      state: "active",
      confidence: 0.9,
    }),
    /unique constraint failed/i,
  );
  assert.equal(store.getMemoryLineage("memory-old")?.state, "active");
  store.close();
});

test("memory lineage expiry is inclusive and preserves terminal states", () => {
  const store = createAgentOpsStore({ home: makeHome() });
  seedProject(store);
  const receipt = seedSubmittedReceipt(store);
  for (const [memoryId, expiresAt] of [
    ["memory-before", "2026-07-13T00:00:00.000Z"],
    ["memory-boundary", "2026-07-13T00:00:01.000Z"],
    ["memory-after", "2026-07-13T00:00:02.000Z"],
  ]) {
    store.recordMemoryLineage({
      memoryId,
      sourceId: memoryId,
      originTurnId: `turn-${memoryId}`,
      originPacketReceiptId: receipt.id,
      state: "active",
      confidence: 0.5,
      expiresAt,
    });
  }
  store.supersedeMemoryLineage("memory-before");

  assert.equal(store.expireMemoryLineage(new Date("2026-07-13T00:00:01.000Z")), 1);
  assert.equal(store.getMemoryLineage("memory-before")?.state, "superseded");
  assert.equal(store.getMemoryLineage("memory-boundary")?.state, "expired");
  assert.equal(store.getMemoryLineage("memory-after")?.state, "active");
  store.close();
});

test("memory lineage rejects missing and terminal transitions without mutation", () => {
  const store = createAgentOpsStore({ home: makeHome() });
  seedProject(store);
  const receipt = seedSubmittedReceipt(store);
  store.recordMemoryLineage({
    memoryId: "memory-terminal",
    sourceId: "source-a",
    originTurnId: "turn-old",
    originPacketReceiptId: receipt.id,
    state: "active",
    confidence: 0.8,
  });
  store.supersedeMemoryLineage("memory-terminal");

  assert.throws(() => store.supersedeMemoryLineage("memory-missing"), /not found/i);
  assert.throws(() => store.supersedeMemoryLineage("memory-terminal"), /not active/i);
  assert.throws(
    () => store.recordMemoryLineage({
      memoryId: "memory-from-missing",
      sourceId: "source-a",
      originTurnId: "turn-new",
      originPacketReceiptId: receipt.id,
      supersedesMemoryId: "memory-missing",
      state: "active",
      confidence: 0.9,
    }),
    /predecessor not found/i,
  );
  assert.throws(
    () => store.recordMemoryLineage({
      memoryId: "memory-from-terminal",
      sourceId: "source-a",
      originTurnId: "turn-new",
      originPacketReceiptId: receipt.id,
      supersedesMemoryId: "memory-terminal",
      state: "active",
      confidence: 0.9,
    }),
    /predecessor is not active/i,
  );
  assert.equal(store.getMemoryLineage("memory-terminal")?.state, "superseded");
  assert.equal(store.getMemoryLineage("memory-from-missing"), undefined);
  assert.equal(store.getMemoryLineage("memory-from-terminal"), undefined);
  store.close();
});

test("memory lineage rejects invalid provenance metadata and expanded-year timestamps", () => {
  const store = createAgentOpsStore({ home: makeHome() });
  seedProject(store);
  const receipt = seedSubmittedReceipt(store);
  const base = {
    memoryId: "memory-invalid",
    sourceId: "source-a",
    originTurnId: "turn-invalid",
    originPacketReceiptId: receipt.id,
    state: "active",
    confidence: 0.5,
  };

  assert.throws(
    () => store.recordMemoryLineage({ ...base, originPacketReceiptId: "receipt-missing" }),
    /foreign key constraint failed/i,
  );
  assert.throws(() => store.recordMemoryLineage({ ...base, state: "unknown" }), /unknown memory lineage state/i);
  assert.throws(() => store.recordMemoryLineage({ ...base, confidence: 1.1 }), /confidence/i);
  assert.throws(
    () => store.recordMemoryLineage({ ...base, expiresAt: "+010000-01-01T00:00:00.000Z" }),
    /fixed-width UTC ISO timestamp/i,
  );
  assert.throws(
    () => store.expireMemoryLineage(new Date("+010000-01-01T00:00:00.000Z")),
    /fixed-width UTC ISO timestamp/i,
  );
  assert.equal(store.getMemoryLineage(base.memoryId), undefined);
  store.close();
});

test("memory lineage lists active records deterministically without content fields", () => {
  const store = createAgentOpsStore({ home: makeHome() });
  seedProject(store);
  const receipt = seedSubmittedReceipt(store);
  for (const memoryId of ["memory-b", "memory-a"]) {
    store.recordMemoryLineage({
      memoryId,
      sourceId: memoryId,
      originTurnId: `turn-${memoryId}`,
      originPacketReceiptId: receipt.id,
      state: "active",
      confidence: 0.5,
      createdAt: "2026-07-13T00:00:00.000Z",
    });
  }

  const active = store.listActiveMemoryLineage();
  assert.deepEqual(active.map((record) => record.memoryId), ["memory-a", "memory-b"]);
  assert.deepEqual(Object.keys(active[0]).sort(), [
    "confidence",
    "createdAt",
    "memoryId",
    "originPacketReceiptId",
    "originTurnId",
    "sourceId",
    "state",
  ]);
  store.close();
});

test("project lineage listing includes orphaned receipts without crossing projects", () => {
  const home = makeHome();
  const store = createAgentOpsStore({ home });
  store.addProject({ id: "project-a", name: "Project A", repoPath: "/project-a" });
  store.addProject({ id: "project-b", name: "Project B", repoPath: "/project-b" });
  store.recordContextPacketPreview({
    id: "receipt-project-b",
    projectId: "project-b",
    sessionId: "session-b",
    packetId: "packet-b",
    profile: "build",
    tokenEstimateState: "unknown",
    sourceCount: 0,
    sourceRefs: [],
  });
  store.recordMemoryLineage({
    memoryId: "memory-project-b",
    sourceId: "source-b",
    originTurnId: "turn-b",
    originPacketReceiptId: "receipt-project-b",
    state: "active",
    confidence: 0.5,
  });
  const dbPath = store.paths.dbPath;
  store.close();

  const rawDb = new DatabaseSync(dbPath);
  rawDb.exec("PRAGMA foreign_keys = OFF");
  rawDb.prepare(`
    INSERT INTO memory_lineage (
      memory_id,
      source_id,
      origin_turn_id,
      origin_packet_receipt_id,
      state,
      confidence,
      created_at
    ) VALUES (?, ?, ?, ?, 'active', 0.5, ?)
  `).run(
    "memory-orphan",
    "source-orphan",
    "turn-orphan",
    "receipt-missing",
    "2026-07-13T00:00:00.000Z",
  );
  rawDb.close();

  const reopened = createAgentOpsStore({ home });
  assert.deepEqual(
    reopened.listActiveMemoryLineage("project-a").map((record) => record.memoryId),
    ["memory-orphan"],
  );
  assert.deepEqual(
    reopened.listActiveMemoryLineage("project-b").map((record) => record.memoryId),
    ["memory-orphan", "memory-project-b"],
  );
  reopened.close();
});

test("v8 migration adds memory lineage for upgraded v7 databases", () => {
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
      (2, 'add_context_sources', '${timestamp}'),
      (3, 'scope_context_sources_by_project', '${timestamp}'),
      (4, 'add_context_source_badges', '${timestamp}'),
      (5, 'add_context_source_metadata', '${timestamp}'),
      (6, 'add_context_packet_receipts', '${timestamp}'),
      (7, 'add_context_policy_suggestions', '${timestamp}');
    CREATE TABLE context_packet_receipts (id TEXT PRIMARY KEY);
  `);
  db.close();

  const store = createAgentOpsStore({ home });
  try {
    const upgraded = new DatabaseSync(store.paths.dbPath);
    try {
      const version = upgraded.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get();
      assert.equal(version.version, 8);
      const columns = upgraded.prepare("PRAGMA table_info(memory_lineage)").all().map((row) => row.name);
      assert.deepEqual(columns, [
        "memory_id",
        "source_id",
        "origin_turn_id",
        "origin_packet_receipt_id",
        "supersedes_memory_id",
        "state",
        "confidence",
        "created_at",
        "expires_at",
      ]);
      const foreignKeys = upgraded.prepare("PRAGMA foreign_key_list(memory_lineage)").all()
        .map((row) => ({
          from: row.from,
          table: row.table,
          to: row.to,
          onDelete: row.on_delete,
        }))
        .sort((left, right) => left.from.localeCompare(right.from));
      assert.deepEqual(foreignKeys, [
        {
          from: "origin_packet_receipt_id",
          table: "context_packet_receipts",
          to: "id",
          onDelete: "RESTRICT",
        },
        {
          from: "supersedes_memory_id",
          table: "memory_lineage",
          to: "memory_id",
          onDelete: "SET NULL",
        },
      ]);
      const stateIndex = upgraded.prepare(
        "PRAGMA index_xinfo('idx_memory_lineage_state_created')",
      ).all().filter((row) => row.key === 1).map((row) => [row.name, row.desc]);
      assert.deepEqual(stateIndex, [["state", 0], ["created_at", 1]]);
      const sourceIndex = upgraded.prepare(
        "PRAGMA index_xinfo('idx_memory_lineage_source')",
      ).all().filter((row) => row.key === 1).map((row) => [row.name, row.desc]);
      assert.deepEqual(sourceIndex, [["source_id", 0], ["state", 0]]);
    } finally {
      upgraded.close();
    }
  } finally {
    store.close();
  }
});
