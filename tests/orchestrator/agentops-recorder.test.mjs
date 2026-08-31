import { rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";

import { createAgentOpsRecorder } from "../../packages/orchestrator/src/agentops-recorder.ts";

const tempHomes = [];

function makeTempHome() {
  const home = join(
    tmpdir(),
    `unclecode-recorder-test-${String(process.pid)}-${String(tempHomes.length)}`,
  );
  tempHomes.push(home);
  rmSync(home, { recursive: true, force: true });
  return home;
}

test.afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

test("createAgentOpsRecorder: healthy=true, writes project + run + events to temp DB", () => {
  const home = makeTempHome();
  const workspaceRoot = "/tmp/test-workspace";

  const recorder = createAgentOpsRecorder({
    workspaceRoot,
    command: "unclecode work --test",
    sessionId: "test-session-1",
    home,
  });

  assert.equal(recorder.healthy, true, "recorder should be healthy");
  assert.ok(recorder.dbPath !== undefined, "dbPath should be set");
  assert.ok(
    existsSync(recorder.dbPath),
    `DB file should exist at ${recorder.dbPath}`,
  );

  recorder.recordTurn({
    prompt: "Fix the failing test",
    status: "completed",
    summary: "Test turn",
  });

  recorder.finish("completed");

  // Verify DB contents
  const db = new DatabaseSync(recorder.dbPath);
  try {
    const projectCount = db
      .prepare("SELECT COUNT(*) AS count FROM projects")
      .get().count;
    const runCount = db
      .prepare("SELECT COUNT(*) AS count FROM runs")
      .get().count;
    const eventCount = db
      .prepare("SELECT COUNT(*) AS count FROM events")
      .get().count;

    assert.equal(projectCount, 1, "should have 1 project");
    assert.equal(runCount, 1, "should have 1 run");
    assert.ok(eventCount >= 2, `should have >= 2 events (run.started + prompt.turn), got ${eventCount}`);

    const run = db.prepare("SELECT * FROM runs LIMIT 1").get();
    assert.equal(run.worker_kind, "work-shell");
    assert.equal(run.command, "unclecode work --test");
    assert.equal(run.status, "completed");

    const events = db
      .prepare("SELECT event_type FROM events ORDER BY rowid")
      .all();
    assert.equal(events[0]?.event_type, "run.started");
    assert.equal(events[1]?.event_type, "prompt.turn");
  } finally {
    db.close();
  }
});

test("createAgentOpsRecorder: persists turnId with packet receipt evidence", () => {
  const home = makeTempHome();
  const workspaceRoot = "/tmp/test-workspace-turnid";
  const recorder = createAgentOpsRecorder({
    workspaceRoot,
    command: "unclecode work --test",
    sessionId: "test-session-turnid",
    home,
  });

  assert.equal(recorder.healthy, true);
  recorder.recordTurn({
    prompt: "inspect auth",
    status: "completed",
    summary: "Lifecycle turn",
    turnId: "turn-session-1-2",
    contextReceiptId: "preview-9",
    packetId: "packet-lifecycle-2",
  });
  recorder.finish("completed");

  const db = new DatabaseSync(recorder.dbPath);
  try {
    const event = db
      .prepare("SELECT metadata_json FROM events WHERE event_type = ? ORDER BY rowid DESC LIMIT 1")
      .get("prompt.turn");
    assert.ok(event?.metadata_json);
    const metadata = JSON.parse(event.metadata_json);
    assert.equal(metadata.turnId, "turn-session-1-2");
    assert.equal(metadata.contextReceiptId, "preview-9");
    assert.equal(metadata.packetId, "packet-lifecycle-2");
    assert.equal(metadata.status, "completed");
  } finally {
    db.close();
  }
});

test("createAgentOpsRecorder: non-blocking — unwritable path returns healthy=false, recordTurn/finish do not throw", () => {
  // /dev/null is a file, not a dir — mkdirSync on /dev/null/x throws
  const recorder = createAgentOpsRecorder({
    workspaceRoot: "/tmp/irrelevant",
    home: "/dev/null/agentops-impossible",
  });

  assert.equal(recorder.healthy, false, "recorder should be unhealthy");

  // Must not throw
  assert.doesNotThrow(() => {
    recorder.recordTurn({ prompt: "test", status: "completed" });
  });
  assert.doesNotThrow(() => {
    recorder.finish("completed");
  });
});

test("createAgentOpsRecorder: prompt is redacted and truncated before storage", () => {
  const home = makeTempHome();
  const workspaceRoot = "/tmp/test-workspace-redact";

  const recorder = createAgentOpsRecorder({ workspaceRoot, home });

  const sensitivePrompt = `Bearer sk-abc123456789xyz Fix this ${"a".repeat(300)}`;
  recorder.recordTurn({ prompt: sensitivePrompt, status: "completed" });
  recorder.finish("completed");

  const db = new DatabaseSync(recorder.dbPath);
  try {
    const event = db
      .prepare("SELECT message FROM events WHERE event_type = 'prompt.turn' LIMIT 1")
      .get();
    assert.ok(event !== undefined, "prompt.turn event should exist");
    assert.ok(
      event.message.length <= 200,
      `message should be truncated to <= 200 chars, got ${event.message.length}`,
    );
    assert.doesNotMatch(
      event.message,
      /sk-abc123456789xyz/,
      "API key token should be redacted",
    );
  } finally {
    db.close();
  }
});

test("createAgentOpsRecorder: finish with unknown status maps to 'completed' or 'failed'", () => {
  const home = makeTempHome();
  const recorder = createAgentOpsRecorder({
    workspaceRoot: "/tmp/test-finish-status",
    home,
  });

  recorder.finish("error-code-42");

  const db = new DatabaseSync(recorder.dbPath);
  try {
    const run = db.prepare("SELECT status FROM runs LIMIT 1").get();
    assert.ok(
      run.status === "completed" || run.status === "failed",
      `status should be 'completed' or 'failed', got '${run.status}'`,
    );
  } finally {
    db.close();
  }
});

test("createAgentOpsRecorder: records bounded evolution metadata without candidate content", () => {
  const home = makeTempHome();
  const recorder = createAgentOpsRecorder({ workspaceRoot: "/tmp/test-evolution-event", home });
  recorder.recordEvolutionProposal({
    id: "evolution-1",
    runId: "quality-run-1",
    candidateId: "candidate-1",
    state: "pr-ready",
    creatorId: "creator-1",
    evaluatorId: "evaluator-1",
    attestorId: "attestor-1",
    humanApproval: "pending",
    stale: false,
    hashes: { candidateArtifact: "sha256:candidate", suite: "sha256:suite" },
    artifactRefs: [".unclecode/artifacts/quality-run-1/evolution-proposal.json"],
    cleanupStatus: "retained",
    summary: `Bearer sk-evolution-secret ${"x".repeat(1_000)}`,
  });
  recorder.finish("completed");

  const db = new DatabaseSync(recorder.dbPath);
  try {
    const event = db.prepare(
      "SELECT message, metadata_json FROM events WHERE event_type = 'evolution.proposed' LIMIT 1",
    ).get();
    assert.ok(event);
    assert.ok(event.message.length <= 240);
    assert.doesNotMatch(event.message, /sk-evolution-secret/);
    const metadata = JSON.parse(event.metadata_json);
    assert.equal(metadata.state, "pr-ready");
    assert.equal(metadata.humanApproval, "pending");
    assert.equal(metadata.cleanupStatus, "retained");
    assert.equal(metadata.rawCandidateOutput, undefined);
    assert.ok(JSON.stringify(metadata).length < 4_000);
  } finally {
    db.close();
  }
});
