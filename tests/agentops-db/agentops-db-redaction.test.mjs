import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAgentOpsStore, defaultAgentOpsPaths } from "@unclecode/agentops-db";

const tempHomes = [];

const FORBIDDEN_SECRETS = [
  "sk-secret123456",
  "abcdefgh12345678",
  "github_pat_secret123456",
  "taskSecret123456",
  "sk-taskurl123456",
  "ghp_secret123456",
  "hunter2token",
  "sk-output123456",
  "ghp_lane123456",
  "event-secret",
  "eventSecret123456",
  "sk-event123456",
  "github_pat_verify123456",
  "ghp_verify123456",
  "github_pat_artifact123456",
  "sk-url123456",
  "postgres://agent:supersecret@db.example/prod",
  "AKIAIOSFODNN7EXAMPLE",
  "ya29.a0AfH6SMBsecretToken",
  "-----BEGIN PRIVATE KEY-----",
];

function makeHome() {
  const home = join(tmpdir(), `unclecode-agentops-redaction-${String(process.pid)}-${String(tempHomes.length)}`);
  tempHomes.push(home);
  rmSync(home, { recursive: true, force: true });
  return home;
}

test.afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

test("AgentOps DB redacts secrets before storing operational text", () => {
  const home = makeHome();
  const paths = defaultAgentOpsPaths(home);
  const store = createAgentOpsStore({ home });

  try {
    const project = store.addProject({
      id: "unclecode",
      name: "UncleCode",
      repoPath: "https://example.test/repo.git?access_token=github_pat_secret123456",
    });
    const task = store.addTask({
      id: "task_secret",
      projectId: project.id,
      title: "Investigate Bearer taskSecret123456",
      description: "DATABASE_URL=postgres://agent:supersecret@db.example/prod",
      sourceUrl: "https://example.test/issue?token=sk-taskurl123456",
    });
    const run = store.recordRun({
      id: "run_secret",
      taskId: task.id,
      projectId: project.id,
      runKey: "secret-smoke",
      workerKind: "codex",
      command: "OPENAI_API_KEY=sk-secret123456 curl -H 'Authorization: Bearer abcdefgh12345678'",
      cwd: "/tmp/work?token=ghp_secret123456",
      status: "failed",
      exitCode: 1,
      startedAt: "2026-06-08T01:00:00.000Z",
      finishedAt: "2026-06-08T01:01:00.000Z",
      summary: "github_pat_secret123456 caused failure",
      nextAction: "rotate PASSWORD=hunter2token and oauth token ya29.a0AfH6SMBsecretToken",
    });
    const lane = store.addLane({
      id: "lane_secret",
      runId: run.id,
      name: "Bearer laneSecret123456",
      workerKind: "codex",
      status: "failed",
      outputPath: join(paths.artifactsDir, "OPENAI_API_KEY=sk-output123456.log"),
      summary: "TOKEN=ghp_lane123456",
    });
    store.addEvent({
      id: "event_secret",
      projectId: project.id,
      taskId: task.id,
      runId: run.id,
      laneId: lane.id,
      eventType: "SECRET=event-secret",
      message: "Bearer eventSecret123456",
      metadataJson:
        '{"apiKey":"sk-event123456","aws":"AKIAIOSFODNN7EXAMPLE","pem":"-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----"}',
    });
    store.addVerification({
      id: "verification_secret",
      runId: run.id,
      command: "CREDENTIAL=github_pat_verify123456",
      kind: "test",
      status: "failed",
      outputPath: "https://example.test/verify.log?oauth=ghp_verify123456",
    });
    store.addArtifact({
      id: "artifact_secret",
      projectId: project.id,
      taskId: task.id,
      runId: run.id,
      laneId: lane.id,
      artifactType: "output",
      title: "SECRET=github_pat_artifact123456",
      pathOrUrl: "https://example.test/output.log?token=sk-url123456",
      sha256: "b".repeat(64),
    });
  } finally {
    store.close();
  }

  const db = new DatabaseSync(paths.dbPath);
  try {
    const persisted = JSON.stringify({
      projects: db.prepare("SELECT name, repo_path FROM projects").all(),
      tasks: db.prepare("SELECT title, description, source_url FROM tasks").all(),
      runs: db.prepare("SELECT command, cwd, summary, next_action FROM runs").all(),
      lanes: db.prepare("SELECT name, output_path, summary FROM lanes").all(),
      events: db.prepare("SELECT event_type, message, metadata_json FROM events").all(),
      verifications: db.prepare("SELECT command, output_path FROM verifications").all(),
      artifacts: db.prepare("SELECT title, path_or_url FROM artifacts").all(),
    });

    assert.match(persisted, /\[REDACTED\]/);
    for (const secret of FORBIDDEN_SECRETS) {
      assert.equal(persisted.includes(secret), false, secret);
    }
  } finally {
    db.close();
  }
});
