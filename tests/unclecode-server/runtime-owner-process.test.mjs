import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RuntimeOwnerClient } from "../../apps/unclecode-server/src/runtime-owner-client.ts";
import { LiveRuntimeEngineRegistry } from "../../apps/unclecode-server/src/runtime-engine-rpc.ts";
import { startPersistentRuntimeOwner } from "../../apps/unclecode-server/src/runtime-owner.ts";

async function startFixture(root, leasePath, tokenPath) {
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning", "--conditions=source", "--import", "tsx",
    "scripts/runtime-qa/runtime-owner-fixture.mjs", root, leasePath, tokenPath,
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  const lease = await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline >= 0) resolve(JSON.parse(output.slice(0, newline)));
    });
    child.once("exit", (code) => reject(new Error(`owner exited before ready (${code})`)));
    child.stderr.on("data", (chunk) => { output += String(chunk); });
  });
  return { child, lease };
}

async function stopFixture(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("two processes attach to one owner revision and owner survives client detach", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-process-"));
  const leasePath = join(root, "runtime-owner.json");
  const tokenPath = join(root, "owner.token");
  await writeFile(tokenPath, "x".repeat(64));
  await chmod(tokenPath, 0o600);
  const fixture = await startFixture(root, leasePath, tokenPath);
  t.after(() => stopFixture(fixture.child));

  const [first, second] = await Promise.all([
    RuntimeOwnerClient.connect(fixture.lease),
    RuntimeOwnerClient.connect(fixture.lease),
  ]);
  assert.equal(first.lease.pid, second.lease.pid);
  assert.equal(first.lease.endpoint, second.lease.endpoint);
  const initial = (await first.readProjection()).runs.find((run) => run.id === "live-1");
  assert.equal(initial?.revision, 0);

  const engineState = await first.readEngineState("live-1");
  assert.equal(engineState.ok, true);
  assert.equal(engineState.revision, 0);
  const enginePause = await first.invokeEngineMethod({
    sessionId: "live-1",
    method: "requestTurnPause",
    expectedRevision: 0,
    idempotencyKey: "engine-pause",
  });
  const engineReplay = await second.invokeEngineMethod({
    sessionId: "live-1",
    method: "requestTurnPause",
    expectedRevision: 0,
    idempotencyKey: "engine-pause",
  });
  assert.equal(enginePause.ok, true);
  assert.deepEqual(engineReplay, enginePause);

  const request = { sessionId: "live-1", action: "resume", expectedRevision: 1, idempotencyKey: "same-resume" };
  const accepted = await first.control(request);
  const replay = await second.control(request);
  assert.deepEqual(replay, accepted);
  assert.equal(accepted.ok, true);
  assert.equal((await second.readProjection()).runs.find((run) => run.id === "live-1")?.revision, 2);

  const [created, replayed] = await Promise.all([
    first.createRuntimeSession({ sessionId: "workspace-b", projectPath: "/workspace/b", provider: "deepseek", idempotencyKey: "create-workspace-b" }),
    second.createRuntimeSession({ sessionId: "workspace-b", projectPath: "/workspace/b", provider: "deepseek", idempotencyKey: "create-workspace-b" }),
  ]);
  assert.deepEqual(replayed, created);
  assert.equal(created.ok, true);
  assert.deepEqual((await first.listRuntimeSessions()).map(item => item.sessionId), ["live-1", "workspace-b"]);
  const attached = await second.attachRuntimeSession("workspace-b");
  assert.equal(attached.ok, true);
  assert.equal(attached.session.projectPath, "/workspace/b");
  assert.equal(attached.engine.revision, 0);
  const changedB = await first.invokeEngineMethod({ sessionId: "workspace-b", method: "setMode", args: ["deep"], expectedRevision: 0, idempotencyKey: "workspace-b-deep" });
  assert.equal(changedB.ok, true);
  assert.equal((await second.readEngineState("live-1")).revision, 2, "workspace B revisions must not affect live-1");

  assert.equal(fixture.child.exitCode, null, "detaching request clients must not stop the owner");
});

test("owner restart discovers a real checkpoint and marks interrupted work non-resumable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-restart-"));
  const sessionDir = join(root, "project", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "crashed.checkpoint.json"), JSON.stringify({
    sessionId: "crashed",
    projectPath: "/workspace/project",
    eventCount: 7,
    updatedAt: new Date().toISOString(),
    state: "running",
    metadata: { qualityProfile: "deep", currentStage: "critic", iteration: 2 },
    agentConsole: {
      workGraph: {
        id: "graph-crashed",
        qualityProfile: "deep",
        currentStage: "critic",
        gateStatus: "unproven",
        iteration: 2,
        nodes: [],
      },
    },
  }));
  const leasePath = join(root, "runtime-owner.json");
  const tokenPath = join(root, "owner.token");
  await writeFile(tokenPath, "y".repeat(64));
  await chmod(tokenPath, 0o600);
  const fixture = await startFixture(root, leasePath, tokenPath);
  t.after(() => stopFixture(fixture.child));
  const client = await RuntimeOwnerClient.connect(fixture.lease);
  const recovered = (await client.readProjection()).runs.find((run) => run.id === "crashed");
  assert.equal(recovered?.state, "failed");
  assert.equal(recovered?.quality.profile, "deep");
  assert.equal(recovered?.quality.stage, "critic");
  assert.equal(recovered?.quality.iteration, 2);
});

test("lease publication failure closes the listener, watcher, and attached engines", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-publish-failure-"));
  const leasePath = join(root, "lease-is-a-directory");
  const tokenParent = join(root, "token-parent");
  await mkdir(leasePath);
  await mkdir(tokenParent, { mode: 0o700 });
  let disposed = false;
  const engines = new LiveRuntimeEngineRegistry();
  engines.attach("attached", {
    getState: () => ({}),
    subscribe: () => () => {},
  }, {
    projectPath: root,
    dispose: () => { disposed = true; },
  });
  await assert.rejects(startPersistentRuntimeOwner({
    rootDir: root,
    leasePath,
    tokenPath: join(tokenParent, "server.token"),
    engines,
  }));
  assert.equal(disposed, true);
  assert.deepEqual(engines.list(), []);
});
