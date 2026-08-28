import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runContainedEvolutionCommand } from "../../packages/orchestrator/src/evolution-sandbox.ts";

async function temporaryWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unclecode-evolution-containment-"));
  const workspace = path.join(root, "candidate");
  const scratch = path.join(root, "scratch");
  await mkdir(workspace);
  await mkdir(scratch);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, scratch };
}

async function runOnSupportedHost(t, input) {
  try {
    return await runContainedEvolutionCommand(input);
  } catch (error) {
    if (error?.code !== "EVOLUTION_SANDBOX_UNAVAILABLE") throw error;
    t.skip(`host containment unavailable: ${error.message}`);
    return undefined;
  }
}

test("an unavailable platform sandbox fails closed before command execution", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await assert.rejects(
    runContainedEvolutionCommand({
      cwd: workspace,
      workspaceRoot: workspace,
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      environment: {},
      timeoutMs: 1_000,
      maxOutputBytes: 4_096,
      platform: "win32",
    }),
    (error) => error?.code === "EVOLUTION_SANDBOX_UNAVAILABLE",
  );
});

test("macOS sandbox-exec alone is rejected because it cannot own detached descendants", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await assert.rejects(
    runContainedEvolutionCommand({
      cwd: workspace,
      workspaceRoot: workspace,
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      environment: { PATH: process.env.PATH ?? "" },
      timeoutMs: 1_000,
      maxOutputBytes: 4_096,
      platform: "darwin",
    }),
    (error) => error?.code === "EVOLUTION_SANDBOX_UNAVAILABLE"
      && /descendant|containment domain/i.test(error.message),
  );
});

test("Linux without a delegated cgroup containment domain fails closed before sandbox execution", async (t) => {
  const { root, workspace } = await temporaryWorkspace(t);
  const bin = path.join(root, "bin");
  const marker = path.join(root, "sandbox-executed");
  await mkdir(bin);
  await writeFile(path.join(bin, "bwrap"), `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`);
  await chmod(path.join(bin, "bwrap"), 0o700);
  const previousRoot = process.env.UNCLECODE_EVOLUTION_CGROUP_ROOT;
  process.env.UNCLECODE_EVOLUTION_CGROUP_ROOT = workspace;
  try {
    await assert.rejects(
      runContainedEvolutionCommand({
        cwd: workspace,
        workspaceRoot: workspace,
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        environment: { PATH: bin },
        timeoutMs: 1_000,
        maxOutputBytes: 4_096,
        platform: "linux",
      }),
      (error) => error?.code === "EVOLUTION_SANDBOX_UNAVAILABLE"
        && /cgroup|containment/i.test(error.message),
    );
    assert.equal(existsSync(marker), false);
  } finally {
    if (previousRoot === undefined) delete process.env.UNCLECODE_EVOLUTION_CGROUP_ROOT;
    else process.env.UNCLECODE_EVOLUTION_CGROUP_ROOT = previousRoot;
  }
});

test("the private evaluator TMPDIR is both writable and readable", async (t) => {
  if (process.platform !== "linux") t.skip("Linux host containment is required");
  const { workspace } = await temporaryWorkspace(t);
  const script = path.join(workspace, "scratch.mjs");
  await writeFile(script, `
    import { readFile, writeFile } from "node:fs/promises";
    const target = process.env.TMPDIR + "/round-trip.txt";
    await writeFile(target, "private-scratch");
    process.stdout.write(await readFile(target, "utf8"));
  `);

  const result = await runOnSupportedHost(t, {
    cwd: workspace,
    workspaceRoot: workspace,
    command: process.execPath,
    args: [script],
    environment: { PATH: process.env.PATH ?? "" },
    timeoutMs: 3_000,
    maxOutputBytes: 4_096,
  });
  if (!result) return;

  assert.equal(result.status, "completed", result.stderr);
  assert.equal(result.stdout, "private-scratch");
});

test("the platform sandbox denies out-of-worktree writes and direct network", async (t) => {
  if (process.platform !== "linux") t.skip("Linux host containment is required");
  const { root, workspace } = await temporaryWorkspace(t);
  const outside = path.join(root, "outside.txt");
  const script = path.join(workspace, "attempt.mjs");
  await writeFile(script, `
    import { writeFile } from "node:fs/promises";
    import net from "node:net";
    const [outside, port] = process.argv.slice(2);
    let wrote = true;
    let connected = true;
    try { await writeFile(outside, "escaped"); } catch { wrote = false; }
    await new Promise((resolve) => {
      const socket = net.connect(Number(port), "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", () => { connected = false; resolve(); });
    });
    process.stdout.write(JSON.stringify({ wrote, connected }));
  `);
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, "object");

  const result = await runOnSupportedHost(t, {
    cwd: workspace,
    workspaceRoot: workspace,
    command: process.execPath,
    args: [script, outside, String(address.port)],
    environment: { PATH: process.env.PATH ?? "" },
    timeoutMs: 3_000,
    maxOutputBytes: 4_096,
  });
  if (!result) return;

  assert.equal(result.status, "completed", result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { wrote: false, connected: false });
  assert.equal(existsSync(outside), false);
  assert.equal(connections, 0);
});

for (const termination of ["timeout", "cancelled"]) test(`${termination} terminates the owned process group and awaits descendants`, async (t) => {
  if (process.platform !== "linux") t.skip("Linux host containment is required");
  const { workspace } = await temporaryWorkspace(t);
  const script = path.join(workspace, "descendant.mjs");
  await writeFile(script, `
    import { spawn } from "node:child_process";
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 5000)"], { stdio: "ignore" });
    process.stdout.write(String(child.pid));
    setInterval(() => {}, 5000);
  `);
  const controller = new AbortController();
  const abort = termination === "cancelled"
    ? setTimeout(() => controller.abort(new Error("test cancellation")), 150)
    : undefined;

  const result = await runOnSupportedHost(t, {
    cwd: workspace,
    workspaceRoot: workspace,
    command: process.execPath,
    args: [script],
    environment: { PATH: process.env.PATH ?? "" },
    timeoutMs: termination === "timeout" ? 150 : 3_000,
    maxOutputBytes: 4_096,
    signal: controller.signal,
  });
  if (!result) return;
  if (abort) clearTimeout(abort);

  assert.equal(result.status, termination, result.stderr);
  assert.match(result.stdout, /^\d+$/);
  const descendantPid = Number(result.stdout);
  assert.throws(
    () => process.kill(descendantPid, 0),
    (error) => error?.code === "ESRCH",
    "a descendant survived after the termination result settled",
  );
});

test("timeout terminates a descendant that creates a new session", async (t) => {
  if (process.platform !== "linux") t.skip("Linux host containment is required");
  const { workspace } = await temporaryWorkspace(t);
  const script = path.join(workspace, "detached-descendant.mjs");
  await writeFile(script, `
    import { spawn } from "node:child_process";
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 5000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    process.stdout.write(String(child.pid));
    setInterval(() => {}, 5000);
  `);

  const result = await runOnSupportedHost(t, {
    cwd: workspace,
    workspaceRoot: workspace,
    command: process.execPath,
    args: [script],
    environment: { PATH: process.env.PATH ?? "" },
    timeoutMs: 150,
    maxOutputBytes: 4_096,
  });
  if (!result) return;

  assert.equal(result.status, "timeout", result.stderr);
  assert.match(result.stdout, /^\d+$/);
  const descendantPid = Number(result.stdout);
  try {
    assert.throws(
      () => process.kill(descendantPid, 0),
      (error) => error?.code === "ESRCH",
      "a detached descendant survived after the containment result settled",
    );
  } finally {
    try { process.kill(descendantPid, "SIGKILL"); } catch {}
  }
});

test("the Linux containment domain enforces an aggregate process bound", async (t) => {
  if (process.platform !== "linux") t.skip("Linux host containment is required");
  const { workspace } = await temporaryWorkspace(t);
  const script = path.join(workspace, "process-bound.mjs");
  await writeFile(script, `
    import { spawn } from "node:child_process";
    const children = [];
    let blocked = false;
    for (let index = 0; index < 128; index += 1) {
      const child = spawn("/bin/sleep", ["10"], { stdio: "ignore" });
      const outcome = await new Promise((resolve) => {
        child.once("spawn", () => resolve("spawn"));
        child.once("error", () => resolve("error"));
      });
      if (outcome === "error") { blocked = true; break; }
      children.push(child);
    }
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(children.map((child) => new Promise((resolve) => child.once("close", resolve))));
    process.stdout.write(JSON.stringify({ blocked, started: children.length }));
  `);

  const result = await runOnSupportedHost(t, {
    cwd: workspace,
    workspaceRoot: workspace,
    command: process.execPath,
    args: [script],
    environment: { PATH: process.env.PATH ?? "" },
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    maxProcesses: 24,
  });
  if (!result) return;

  assert.equal(result.status, "completed", result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.blocked, true);
  assert.ok(evidence.started < 128, `all ${evidence.started} descendants escaped the aggregate process bound`);
});

test("the Linux containment domain enforces an aggregate memory bound", async (t) => {
  if (process.platform !== "linux") t.skip("Linux host containment is required");
  const { workspace } = await temporaryWorkspace(t);
  const script = path.join(workspace, "memory-bound.mjs");
  await writeFile(script, `
    const retained = [];
    setInterval(() => {
      const chunk = Buffer.alloc(8 * 1024 * 1024, 0x5a);
      retained.push(chunk);
    }, 5);
  `);

  const result = await runOnSupportedHost(t, {
    cwd: workspace,
    workspaceRoot: workspace,
    command: process.execPath,
    args: [script],
    environment: { PATH: process.env.PATH ?? "" },
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    maxMemoryBytes: 96 * 1024 * 1024,
  });
  if (!result) return;

  assert.equal(result.status, "failed", `memory-hungry evaluator escaped the aggregate bound: ${result.stderr}`);
});
