import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGENTOPS_SCHEMA_VERSION,
  createAgentOpsStore,
  defaultAgentOpsPaths,
  readAgentOpsHome,
} from "@unclecode/agentops-db";

const tempHomes = [];

function makeHome() {
  const home = join(tmpdir(), `unclecode-agentops-${String(process.pid)}-${String(tempHomes.length)}`);
  tempHomes.push(home);
  rmSync(home, { recursive: true, force: true });
  return home;
}

test.afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

test("AgentOps DB initializes, records a completed run, and reads a dashboard summary", () => {
  const home = makeHome();
  const paths = defaultAgentOpsPaths(home);
  const store = createAgentOpsStore({ home });

  try {
    const project = store.addProject({ id: "unclecode", name: "UncleCode", repoPath: "/repos/unclecode" });
    const task = store.addTask({
      id: "task_ship",
      projectId: project.id,
      title: "Ship AgentOps DB",
      status: "active",
      priority: 1,
    });
    const run = store.recordRun({
      id: "run_completed",
      taskId: task.id,
      projectId: project.id,
      runKey: "phase-2-smoke",
      workerKind: "codex",
      command: "npm run check",
      cwd: "/repos/unclecode",
      status: "completed",
      exitCode: 0,
      startedAt: "2026-06-08T01:00:00.000Z",
      finishedAt: "2026-06-08T01:02:00.000Z",
      summary: "AgentOps DB package smoke passed.",
    });
    const lane = store.addLane({
      id: "lane_completed",
      runId: run.id,
      name: "executor",
      workerKind: "codex",
      status: "completed",
      startedAt: "2026-06-08T01:00:00.000Z",
      finishedAt: "2026-06-08T01:02:00.000Z",
      summary: "Executor lane completed.",
    });
    store.addEvent({
      id: "event_completed",
      projectId: project.id,
      taskId: task.id,
      runId: run.id,
      laneId: lane.id,
      eventType: "lane.completed",
      message: "Executor lane completed with code 0.",
      metadataJson: '{"exitCode":0}',
    });
    store.addVerification({
      id: "verification_check",
      runId: run.id,
      command: "npm run check",
      kind: "typecheck",
      status: "passed",
      outputPath: join(paths.artifactsDir, "run_completed.check.txt"),
      startedAt: "2026-06-08T01:01:00.000Z",
      finishedAt: "2026-06-08T01:02:00.000Z",
    });
    store.addArtifact({
      id: "artifact_check",
      projectId: project.id,
      taskId: task.id,
      runId: run.id,
      laneId: lane.id,
      artifactType: "output",
      title: "Check output",
      pathOrUrl: join(paths.artifactsDir, "run_completed.output.txt"),
      sha256: "a".repeat(64),
    });
  } finally {
    store.close();
  }

  const homeSummary = readAgentOpsHome({ home, now: "2026-06-08T12:00:00.000Z" });

  assert.equal(existsSync(paths.dbPath), true);
  assert.equal(existsSync(paths.artifactsDir), true);
  assert.equal(homeSummary.schemaVersion, AGENTOPS_SCHEMA_VERSION);
  assert.equal(homeSummary.completedToday.length, 1);
  assert.equal(homeSummary.projectSummaries[0]?.projectId, "unclecode");
  assert.equal(homeSummary.projectSummaries[0]?.completedTodayCount, 1);
  assert.equal(homeSummary.completedToday[0]?.artifactLinks[0]?.title, "Check output");

  const db = new DatabaseSync(paths.dbPath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM lanes").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM verifications").get().count, 1);
  } finally {
    db.close();
  }
});

test("AgentOps DB rejects missing project run writes without creating artifacts", () => {
  const home = makeHome();
  const paths = defaultAgentOpsPaths(home);
  const store = createAgentOpsStore({ home });

  try {
    assert.throws(
      () =>
        store.addTask({
          id: "task_missing",
          projectId: "missing",
          title: "Missing project task",
        }),
      /Unknown project: missing/,
    );
    assert.throws(
      () =>
        store.startRun({
          projectId: "missing",
          workerKind: "codex",
          command: "npm test",
        }),
      /Unknown project: missing/,
    );
  } finally {
    store.close();
  }

  const homeSummary = readAgentOpsHome({ home, now: "2026-06-08T12:00:00.000Z" });

  assert.equal(homeSummary.projectSummaries.length, 0);
  assert.equal(homeSummary.needsAttention.length, 0);
  assert.equal(homeSummary.activeRuns.length, 0);
  assert.equal(homeSummary.completedToday.length, 0);
  assert.equal(existsSync(paths.artifactsDir), true);
  assert.equal(readFileSync(paths.dbPath).length > 0, true);
});
