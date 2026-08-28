import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

test("the platform sandbox denies out-of-worktree writes and direct network", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") t.skip("unsupported test platform");
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

  const result = await runContainedEvolutionCommand({
    cwd: workspace,
    workspaceRoot: workspace,
    command: process.execPath,
    args: [script, outside, String(address.port)],
    environment: { PATH: process.env.PATH ?? "" },
    timeoutMs: 3_000,
    maxOutputBytes: 4_096,
  });

  assert.equal(result.status, "completed", result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { wrote: false, connected: false });
  assert.equal(existsSync(outside), false);
  assert.equal(connections, 0);
});

for (const termination of ["timeout", "cancelled"]) test(`${termination} terminates the owned process group and awaits descendants`, async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") t.skip("unsupported test platform");
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

  const result = await runContainedEvolutionCommand({
    cwd: workspace,
    workspaceRoot: workspace,
    command: process.execPath,
    args: [script],
    environment: { PATH: process.env.PATH ?? "" },
    timeoutMs: termination === "timeout" ? 150 : 3_000,
    maxOutputBytes: 4_096,
    signal: controller.signal,
  });
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
