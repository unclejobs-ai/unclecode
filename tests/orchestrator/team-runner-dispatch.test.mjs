import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import {
  buildWindowsTreeKillArgs,
  listTeamRuns,
  startTeamRun,
  waitForWindowsTreeKill,
} from "@unclecode/orchestrator";
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

async function waitForFile(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return readFileSync(filePath, "utf8").trim();
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

test("Windows worker termination targets the entire descendant tree", () => {
  assert.deepEqual(buildWindowsTreeKillArgs(4321), ["/PID", "4321", "/T", "/F"]);
});

test("Windows worker termination awaits taskkill completion", async () => {
  let invoked;
  let taskkillClosed = false;
  const promise = waitForWindowsTreeKill(4321, (command, args) => {
    invoked = { command, args };
    const taskkill = new EventEmitter();
    setTimeout(() => {
      taskkillClosed = true;
      taskkill.emit("close", 0);
    }, 25);
    return taskkill;
  });
  await sleep(5);
  assert.equal(taskkillClosed, false);
  await promise;
  assert.deepEqual(invoked, {
    command: "taskkill",
    args: ["/PID", "4321", "/T", "/F"],
  });
  assert.equal(taskkillClosed, true);
});

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

test("worktree isolation keeps concurrent worker edits separate and returns patches", async () => {
  const repoRoot = mkdtempSync(join(PROJECT_ROOT, ".test-tmp-worktree-"));
  const isolationRoot = join(
    dirname(repoRoot),
    `.${basename(repoRoot)}-unclecode-worktrees`,
  );
  const dataRoot = join(repoRoot, ".data");
  const workerPath = join(repoRoot, "isolated-worker.mjs");
  try {
    writeFileSync(join(repoRoot, ".gitignore"), ".data/\n");
    writeFileSync(
      workerPath,
      `import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
const args = process.argv.slice(2);
const workerId = args[args.indexOf("--worker-id") + 1];
writeFileSync("collision.txt", workerId);
await sleep(workerId === "w1" ? 80 : 20);
process.stdout.write(\`\${workerId}:\${readFileSync("collision.txt", "utf8")}\\n\`);
`,
    );
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync(
      "git",
      ["-c", "user.name=UncleCode Tests", "-c", "user.email=tests@unclecode.local", "commit", "-qm", "fixture"],
      { cwd: repoRoot },
    );

    const handle = startTeamRun({
      dataRoot,
      runId: "tr_isolated",
      objective: "isolated collision test",
      persona: "coder",
      lanes: 2,
      gate: "warn",
      runtime: "local",
      isolation: "worktree",
      workspaceRoot: repoRoot,
      createdBy: "tests",
    });
    handle.start();

    let result;
    try {
      result = await handle.dispatch({
        workerCommand: { command: process.execPath, args: [workerPath] },
        workers: [
          { workerId: "w1", persona: "coder", task: "write one", runtime: "openai" },
          { workerId: "w2", persona: "coder", task: "write two", runtime: "openai" },
        ],
        perWorkerTimeoutMs: 30_000,
      });
    } finally {
      handle.release();
    }

    assert.equal(result.status, "accepted");
    assert.equal(existsSync(join(repoRoot, "collision.txt")), false, "parent workspace stays untouched");
    for (const outcome of result.outcomes) {
      assert.equal(outcome.isolation, "worktree");
      assert.match(outcome.stdout, new RegExp(`${outcome.workerId}:${outcome.workerId}`));
      assert.ok(outcome.changePatchPath, `${outcome.workerId} returns a patch artifact`);
      assert.match(readFileSync(outcome.changePatchPath, "utf8"), /collision\.txt/);
    }
  } finally {
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: repoRoot });
    } catch {
      // The repository may not have been initialized if fixture setup failed.
    }
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(isolationRoot, { recursive: true, force: true });
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

test("worker timeout kills descendant processes before returning", {
  skip: process.platform === "win32",
  timeout: 8_000,
}, async () => {
  const dataRoot = makeRun();
  let workerPid;
  let descendantPid;
  try {
    const workerPidPath = join(dataRoot, "worker.pid");
    const descendantPidPath = join(dataRoot, "descendant.pid");
    const workerTermPath = join(dataRoot, "worker.term");
    const descendantTermPath = join(dataRoot, "descendant.term");
    const readyPath = join(dataRoot, "worker.ready");
    const descendantPath = join(dataRoot, "stubborn-descendant.mjs");
    const workerPath = join(dataRoot, "worker-with-descendant.mjs");
    writeFileSync(
      descendantPath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));
process.on("SIGTERM", () => writeFileSync(${JSON.stringify(descendantTermPath)}, "term"));
setInterval(() => {}, 1_000);
`,
      { mode: 0o755 },
    );
    writeFileSync(
      workerPath,
      `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
writeFileSync(${JSON.stringify(workerPidPath)}, String(process.pid));
process.on("SIGTERM", () => writeFileSync(${JSON.stringify(workerTermPath)}, "term"));
spawn(process.execPath, [${JSON.stringify(descendantPath)}], {
  stdio: "ignore",
});
const readyTimer = setInterval(() => {
  if (existsSync(${JSON.stringify(descendantPidPath)})) {
    writeFileSync(${JSON.stringify(readyPath)}, "ready");
    clearInterval(readyTimer);
  }
}, 10);
setInterval(() => {}, 1_000);
`,
      { mode: 0o755 },
    );

    const handle = startTeamRun({
      dataRoot,
      objective: "timeout descendant test",
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
      workers: [{ workerId: "w1", persona: "coder", task: "timeout" }],
      perWorkerTimeoutMs: 600,
    });
    handle.release();

    await waitForFile(readyPath);
    workerPid = Number(await waitForFile(workerPidPath));
    descendantPid = Number(await waitForFile(descendantPidPath));
    assert.equal(result.outcomes[0].status, "killed");
    assert.equal(readFileSync(workerTermPath, "utf8"), "term");
    assert.equal(readFileSync(descendantTermPath, "utf8"), "term");
    assert.equal(processExists(workerPid), false);
    assert.equal(processExists(descendantPid), false);
  } finally {
    if (workerPid && processExists(workerPid)) process.kill(workerPid, "SIGKILL");
    if (descendantPid && processExists(descendantPid)) process.kill(descendantPid, "SIGKILL");
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

test("listTeamRuns is backed by Rust and returns recorded run directories", () => {
  const dataRoot = makeRun();
  try {
    const first = startTeamRun({
      dataRoot,
      objective: "list first",
      persona: "coder",
      lanes: 1,
      gate: "warn",
      runtime: "local",
      workspaceRoot: dataRoot,
      createdBy: "tests",
      runId: "tr_100",
    });
    const second = startTeamRun({
      dataRoot,
      objective: "list second",
      persona: "coder",
      lanes: 1,
      gate: "warn",
      runtime: "local",
      workspaceRoot: dataRoot,
      createdBy: "tests",
      runId: "tr_200",
    });
    first.release();
    second.release();

    assert.deepEqual(
      listTeamRuns(dataRoot).map((run) => run.runId),
      ["tr_100", "tr_200"],
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
