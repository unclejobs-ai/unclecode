import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");
const builtCliEntrypoint = path.join(
  workspaceRoot,
  "apps/unclecode-cli/dist/index.js",
);

function makeTempWorkspace() {
  return mkdtempSync(path.join(tmpdir(), "unclecode-performance-"));
}

function initializeGitRepo(cwd) {
  const initResult = spawnSync("git", ["init"], { cwd, encoding: "utf8" });
  assert.equal(initResult.status, 0, initResult.stderr);

  assert.equal(
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd,
      encoding: "utf8",
    }).status,
    0,
  );
  assert.equal(
    spawnSync("git", ["config", "user.name", "Test User"], {
      cwd,
      encoding: "utf8",
    }).status,
    0,
  );

  writeFileSync(path.join(cwd, "README.md"), "# perf workspace\n", "utf8");
  assert.equal(
    spawnSync("git", ["add", "README.md"], { cwd, encoding: "utf8" }).status,
    0,
  );
  assert.equal(
    spawnSync("git", ["commit", "-m", "init"], {
      cwd,
      encoding: "utf8",
    }).status,
    0,
  );
}

function seedSession({ cwd, sessionStoreRoot, sessionId }) {
  const script = `
    import { createSessionStore } from '@unclecode/session-store';
    const store = createSessionStore({ rootDir: ${JSON.stringify(sessionStoreRoot)} });
    const ref = { projectPath: ${JSON.stringify(cwd)}, sessionId: ${JSON.stringify(sessionId)} };
    await store.appendCheckpoint(ref, { type: 'state', state: 'idle' });
    await store.appendCheckpoint(ref, { type: 'metadata', metadata: { model: 'gpt-5.4' } });
    await store.appendCheckpoint(ref, { type: 'task_summary', summary: 'Perf probe', timestamp: '2026-04-05T00:00:00.000Z' });
    await store.appendCheckpoint(ref, { type: 'mode', mode: 'coordinator' });
  `;

  const result = spawnSync(
    "node",
    [
      "--conditions=source",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ],
    { cwd: workspaceRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
}

test("built unclecode cli emits measurable performance probes within declared budgets", () => {
  const cwd = makeTempWorkspace();
  const sessionStoreRoot = path.join(cwd, ".state");

  try {
    initializeGitRepo(cwd);
    seedSession({ cwd, sessionStoreRoot, sessionId: "session-perf" });

    const env = {
      ...process.env,
      OPENAI_API_KEY: "sk-test-123",
      UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
    };

    const doctorResult = spawnSync(
      "node",
      [builtCliEntrypoint, "doctor", "--verbose", "--json"],
      { cwd, encoding: "utf8", env },
    );
    assert.equal(doctorResult.status, 0, doctorResult.stderr);
    const doctorReport = JSON.parse(doctorResult.stdout);
    assert.equal(doctorReport.command, "doctor");
    assert.ok(
      doctorReport.metrics.totalMs <= doctorReport.thresholds.totalMsBudget,
    );
    assert.ok(
      doctorReport.metrics.configMs <= doctorReport.thresholds.configMsBudget,
    );

    const resumeResult = spawnSync(
      "node",
      [builtCliEntrypoint, "resume", "session-perf", "--verbose", "--json"],
      { cwd, encoding: "utf8", env },
    );
    assert.equal(resumeResult.status, 0, resumeResult.stderr);
    const resumeReport = JSON.parse(resumeResult.stdout);
    assert.equal(resumeReport.command, "resume");
    assert.ok(
      resumeReport.metrics.resumeMs <= resumeReport.thresholds.resumeMsBudget,
    );

    const researchResult = spawnSync(
      "node",
      [
        builtCliEntrypoint,
        "research",
        "run",
        "--json",
        "summarize",
        "current",
        "workspace",
      ],
      { cwd, encoding: "utf8", env },
    );
    assert.equal(researchResult.status, 0, researchResult.stderr);
    const researchReport = JSON.parse(researchResult.stdout);
    assert.equal(researchReport.command, "research.run");
    assert.equal(researchReport.status, "completed");
    assert.ok(
      researchReport.metrics.firstEventMs <=
        researchReport.thresholds.firstEventMsBudget,
    );
    assert.ok(
      researchReport.metrics.totalMs <= researchReport.thresholds.totalMsBudget,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
