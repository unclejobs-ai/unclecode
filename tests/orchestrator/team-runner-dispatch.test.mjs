import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { startTeamRun } from "@unclecode/orchestrator";
import { readTeamCheckpoints, verifyTeamRunChain } from "@unclecode/session-store";

// Place tmp dirs inside the workspace so spawned worker scripts can resolve
// @unclecode/* via node_modules. /tmp would break Node module resolution.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function fakeWorkerScript() {
  return `#!/usr/bin/env node
import { TeamBinding, readBindingFromEnv } from "@unclecode/orchestrator";

const args = process.argv.slice(2);
function arg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}
const workerId = arg("--worker-id") ?? "w?";
const persona = arg("--persona") ?? "coder";

const bind = readBindingFromEnv();
if (!bind) {
  process.stderr.write("missing run env\\n");
  process.exit(2);
}
const binding = new TeamBinding({ ...bind, role: "worker" });

binding.publish({
  type: "team_step",
  runId: binding.runId,
  workerId,
  stepIndex: 0,
  timestamp: new Date().toISOString(),
});

process.stdout.write(\`WORKER_ID=\${workerId} persona=\${persona} OK\\n\`);
process.exit(0);
`;
}

function makeRun() {
  const dataRoot = mkdtempSync(join(PROJECT_ROOT, ".test-tmp-dispatch-"));
  return dataRoot;
}

test("dispatch spawns N workers, publishes running+accepted, chain verifies", async () => {
  const dataRoot = makeRun();
  try {
    const workerPath = join(dataRoot, "fake-worker.mjs");
    writeFileSync(workerPath, fakeWorkerScript(), { mode: 0o755 });

    const handle = startTeamRun({
      dataRoot,
      objective: "dispatch test",
      persona: "coder",
      lanes: 3,
      gate: "warn",
      runtime: "local",
      workspaceRoot: dataRoot,
      createdBy: "tests",
    });
    handle.start();

    const result = await handle.dispatch({
      workerCommand: { command: process.execPath, args: ["--import=tsx", workerPath] },
      workers: [
        { workerId: "w1", persona: "coder", task: "task-1" },
        { workerId: "w2", persona: "coder", task: "task-2" },
        { workerId: "w3", persona: "coder", task: "task-3" },
      ],
      perWorkerTimeoutMs: 30_000,
    });

    handle.release();

    assert.equal(result.status, "accepted");
    assert.equal(result.outcomes.length, 3);
    for (const outcome of result.outcomes) {
      assert.equal(outcome.status, "completed");
      assert.equal(outcome.exitCode, 0);
      assert.match(outcome.stdout, /OK/);
    }

    const checkpoints = readTeamCheckpoints(handle.runRoot);
    const teamSteps = checkpoints.flatMap((cp) =>
      cp.type === "team_step" ? [cp] : [],
    );
    const teamRuns = checkpoints.flatMap((cp) =>
      cp.type === "team_run" ? [cp] : [],
    );

    assert.equal(teamSteps.length, 3, "one team_step per worker");
    const workerIds = new Set(teamSteps.map((s) => s.workerId));
    assert.deepEqual([...workerIds].sort(), ["w1", "w2", "w3"]);

    const statuses = teamRuns.map((c) => c.status);
    assert.ok(statuses.includes("started"), "started present");
    assert.ok(statuses.includes("running"), "running present (dispatch begin)");
    assert.ok(statuses.includes("accepted"), "accepted present (dispatch end)");

    const chain = verifyTeamRunChain(handle.runRoot);
    assert.equal(chain.ok, true, "chain verifies after concurrent worker appends");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("dispatch reports errored when a worker exits non-zero", async () => {
  const dataRoot = makeRun();
  try {
    const workerPath = join(dataRoot, "failing-worker.mjs");
    writeFileSync(
      workerPath,
      `#!/usr/bin/env node
process.stderr.write("simulated failure\\n");
process.exit(7);
`,
      { mode: 0o755 },
    );

    const handle = startTeamRun({
      dataRoot,
      objective: "fail test",
      persona: "coder",
      lanes: 1,
      gate: "warn",
      runtime: "local",
      workspaceRoot: dataRoot,
      createdBy: "tests",
    });
    handle.start();

    const result = await handle.dispatch({
      workerCommand: { command: process.execPath, args: [workerPath] },
      workers: [{ workerId: "w1", persona: "coder", task: "x" }],
      perWorkerTimeoutMs: 10_000,
    });
    handle.release();

    assert.equal(result.status, "errored");
    assert.equal(result.outcomes[0].status, "failed");
    assert.equal(result.outcomes[0].exitCode, 7);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("dispatch sweeps stale locks before launching workers", async () => {
  const dataRoot = makeRun();
  try {
    const workerPath = join(dataRoot, "fake-worker.mjs");
    writeFileSync(workerPath, fakeWorkerScript(), { mode: 0o755 });

    const handle = startTeamRun({
      dataRoot,
      objective: "sweep test",
      persona: "coder",
      lanes: 1,
      gate: "warn",
      runtime: "local",
      workspaceRoot: dataRoot,
      createdBy: "tests",
    });
    handle.start();

    const locksDir = join(handle.runRoot, "locks");
    mkdirSync(locksDir, { recursive: true });
    const stalePath = join(locksDir, "deadbeef.lock");
    writeFileSync(stalePath, `ghost:99:${Date.now()}`);

    const result = await handle.dispatch({
      workerCommand: { command: process.execPath, args: ["--import=tsx", workerPath] },
      workers: [{ workerId: "w1", persona: "coder", task: "t" }],
      perWorkerTimeoutMs: 30_000,
    });
    handle.release();

    assert.equal(result.status, "accepted");
    assert.ok(result.sweep.swept >= 1, "sweepStaleLocks removed dead-pid lock");
    assert.equal(existsSync(stalePath), false, "stale lock file deleted");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
