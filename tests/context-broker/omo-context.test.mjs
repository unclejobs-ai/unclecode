import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadOmoContextSnapshot } from "../../packages/context-broker/src/omo-context.ts";

function makeRoot() {
  return mkdtempSync(path.join(tmpdir(), "unclecode-omo-context-"));
}

function writeSession(root, sessionId, goals) {
  const sessionDir = path.join(root, ".omo", "ulw-loop", sessionId);
  mkdirSync(path.join(sessionDir, "evidence"), { recursive: true });
  writeFileSync(path.join(sessionDir, "goals.json"), JSON.stringify(goals, null, 2), "utf8");
  writeFileSync(path.join(sessionDir, "ledger.jsonl"), "RAW_LEDGER_SENTINEL_DO_NOT_SHOW\n", "utf8");
  writeFileSync(
    path.join(sessionDir, "evidence", "C001.txt"),
    "RAW_EVIDENCE_SENTINEL_DO_NOT_SHOW\n",
    "utf8",
  );
  return sessionDir;
}

function activeGoals(title = "Ship context packet metadata") {
  return {
    version: 1,
    activeGoalId: "G001-context",
    goals: [
      {
        id: "G001-context",
        title,
        objective: "Summarize OMO state without exposing raw audit artifacts.",
        status: "in_progress",
        successCriteria: [
          {
            id: "C001",
            scenario: "adapter reports safe goal and criterion summaries",
            userModel: "edge",
            expectedEvidence: ".omo/ulw-loop/session/evidence/C001.txt",
            capturedEvidence: null,
            status: "pending",
          },
        ],
      },
    ],
  };
}

test("loadOmoContextSnapshot returns empty metadata when no OMO state exists", async () => {
  // Given: a repo root without .omo/ulw-loop state.
  const root = makeRoot();

  // When: OMO context is loaded.
  const snapshot = await loadOmoContextSnapshot(root);

  // Then: the snapshot is empty and does not warn.
  assert.equal(snapshot.sourceLabel, ".omo/ulw-loop");
  assert.deepEqual(snapshot.included, []);
  assert.deepEqual(snapshot.excluded, []);
  assert.deepEqual(snapshot.warnings, []);
});

test("loadOmoContextSnapshot summarizes one active session without leaking raw ledger or evidence", async () => {
  // Given: one active OMO session containing raw ledger and evidence sentinel text.
  const root = makeRoot();
  writeSession(root, "active-a", activeGoals());

  // When: OMO context is loaded.
  const snapshot = await loadOmoContextSnapshot(root);

  // Then: safe goal and criterion summaries are included.
  assert.ok(
    snapshot.included.some(
      (item) =>
        item.kind === "omo-goal" &&
        item.sessionId === "active-a" &&
        item.goalId === "G001-context" &&
        item.status === "in_progress" &&
        /Ship context packet metadata/.test(item.summary),
    ),
  );
  assert.ok(
    snapshot.included.some(
      (item) =>
        item.kind === "omo-criterion" &&
        item.sessionId === "active-a" &&
        item.goalId === "G001-context" &&
        item.criterionId === "C001" &&
        item.status === "pending" &&
        /safe goal and criterion summaries/.test(item.summary),
    ),
  );

  // Then: raw ledger/evidence artifacts are represented only as exclusions.
  assert.ok(
    snapshot.excluded.some(
      (item) => item.path.endsWith("active-a/ledger.jsonl") && /raw OMO ledger/i.test(item.reason),
    ),
  );
  assert.ok(
    snapshot.excluded.some(
      (item) => item.path.endsWith("active-a/evidence/C001.txt") && /raw OMO evidence/i.test(item.reason),
    ),
  );
  assert.doesNotMatch(JSON.stringify(snapshot), /RAW_LEDGER_SENTINEL_DO_NOT_SHOW/);
  assert.doesNotMatch(JSON.stringify(snapshot), /RAW_EVIDENCE_SENTINEL_DO_NOT_SHOW/);
});

test("loadOmoContextSnapshot warns when multiple active sessions are present", async () => {
  // Given: two active OMO sessions.
  const root = makeRoot();
  writeSession(root, "active-a", activeGoals("First active goal"));
  writeSession(root, "active-b", activeGoals("Second active goal"));

  // When: OMO context is loaded.
  const snapshot = await loadOmoContextSnapshot(root);

  // Then: the ambiguity is surfaced without dumping every active session into the next packet.
  assert.ok(
    snapshot.warnings.some(
      (warning) => /multiple active OMO sessions/i.test(warning) && /active-a/.test(warning) && /active-b/.test(warning),
    ),
  );
  assert.deepEqual(snapshot.included, []);
});

test("loadOmoContextSnapshot omits completed and blocked historical goals", async () => {
  // Given: historical OMO sessions with stale final states plus one live session.
  const root = makeRoot();
  writeSession(root, "completed", {
    version: 1,
    activeGoalId: "G-done",
    goals: [
      {
        id: "G-done",
        title: "Old completed work",
        status: "complete",
        successCriteria: [{ id: "C001", scenario: "stale completed criterion", status: "pass" }],
      },
    ],
  });
  writeSession(root, "blocked", {
    version: 1,
    activeGoalId: "G-blocked",
    goals: [
      {
        id: "G-blocked",
        title: "Old blocked work",
        status: "blocked",
        successCriteria: [{ id: "C001", scenario: "stale blocked criterion", status: "pass" }],
      },
    ],
  });
  writeSession(root, "live", activeGoals("Live context goal"));

  // When: OMO context is loaded.
  const snapshot = await loadOmoContextSnapshot(root);

  // Then: only the live active goal contributes context summaries.
  assert.ok(snapshot.included.some((item) => item.sessionId === "live"));
  assert.ok(!snapshot.included.some((item) => item.sessionId === "completed"));
  assert.ok(!snapshot.included.some((item) => item.sessionId === "blocked"));
});

test("loadOmoContextSnapshot warns on malformed goals JSON without leaking raw artifacts", async () => {
  // Given: a malformed OMO session with raw artifacts present.
  const root = makeRoot();
  const sessionDir = path.join(root, ".omo", "ulw-loop", "bad-session");
  mkdirSync(path.join(sessionDir, "evidence"), { recursive: true });
  writeFileSync(path.join(sessionDir, "goals.json"), "{ not valid json", "utf8");
  writeFileSync(path.join(sessionDir, "ledger.jsonl"), "RAW_LEDGER_SENTINEL_DO_NOT_SHOW\n", "utf8");
  writeFileSync(
    path.join(sessionDir, "evidence", "C001.txt"),
    "RAW_EVIDENCE_SENTINEL_DO_NOT_SHOW\n",
    "utf8",
  );

  // When: OMO context is loaded.
  const snapshot = await loadOmoContextSnapshot(root);

  // Then: malformed state is reported and raw artifacts are still excluded by path only.
  assert.deepEqual(snapshot.included, []);
  assert.ok(
    snapshot.warnings.some(
      (warning) => /malformed OMO goals JSON/i.test(warning) && /bad-session/.test(warning),
    ),
  );
  assert.ok(snapshot.excluded.some((item) => item.path.endsWith("bad-session/ledger.jsonl")));
  assert.ok(snapshot.excluded.some((item) => item.path.endsWith("bad-session/evidence/C001.txt")));
  assert.doesNotMatch(JSON.stringify(snapshot), /RAW_LEDGER_SENTINEL_DO_NOT_SHOW/);
  assert.doesNotMatch(JSON.stringify(snapshot), /RAW_EVIDENCE_SENTINEL_DO_NOT_SHOW/);
});
