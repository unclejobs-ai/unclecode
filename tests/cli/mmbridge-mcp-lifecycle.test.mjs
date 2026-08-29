import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runMmbridgeMcpHealthCheck,
  runMmbridgeMcpTool,
} from "../../apps/unclecode-cli/src/mmbridge-mcp.ts";

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForFile(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return readFileSync(filePath, "utf8").trim();
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

function configureMmbridge(root, serverPath) {
  writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({
    mcpServers: {
      mmbridge: {
        type: "stdio",
        command: process.execPath,
        args: [serverPath],
      },
    },
  }));
}

function writeInheritedPipeServer(root) {
  const serverPath = path.join(root, "inherited-pipe-server.mjs");
  const descendantPath = path.join(root, "inherited-pipe-descendant.mjs");
  const leaderPidPath = path.join(root, "leader.pid");
  const descendantPidPath = path.join(root, "descendant.pid");
  const descendantReadyPath = path.join(root, "descendant.ready");
  const serverReadyPath = path.join(root, "server.ready");
  writeFileSync(descendantPath, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(descendantReadyPath)}, "ready");
setInterval(() => {}, 1000);
`);
  chmodSync(descendantPath, 0o755);
  writeFileSync(serverPath, `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
writeFileSync(${JSON.stringify(leaderPidPath)}, String(process.pid));
const descendant = spawn(process.execPath, [${JSON.stringify(descendantPath)}], {
  stdio: ["ignore", "inherit", "inherit"],
});
writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
const readyTimer = setInterval(() => {
  if (!existsSync(${JSON.stringify(descendantReadyPath)})) return;
  clearInterval(readyTimer);
  writeFileSync(${JSON.stringify(serverReadyPath)}, "ready");
  process.exit(0);
}, 10);
`);
  chmodSync(serverPath, 0o755);
  return { serverPath, leaderPidPath, descendantPidPath, serverReadyPath };
}

function writeBufferServer(root, name, body) {
  const serverPath = path.join(root, `${name}.mjs`);
  const pidPath = path.join(root, `${name}.pid`);
  writeFileSync(serverPath, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
${body}
`);
  chmodSync(serverPath, 0o755);
  return { serverPath, pidPath };
}

function deadlineFailure(message, timeoutMs = 2_000) {
  let timer;
  return {
    promise: new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
    clear() {
      if (timer) clearTimeout(timer);
    },
  };
}

test("mmbridge settles an inherited-pipe descendant after the server leader exits", {
  skip: process.platform === "win32" ? "POSIX process groups only" : false,
  timeout: 5_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-mmbridge-pipes-"));
  let leaderPid;
  let descendantPid;
  let settlementTimer;
  try {
    const fixture = writeInheritedPipeServer(root);
    configureMmbridge(root, fixture.serverPath);
    const invocation = runMmbridgeMcpTool({
      workspaceRoot: root,
      toolName: "mmbridge_doctor",
      args: {},
      timeoutMs: 0,
    });
    leaderPid = Number(await waitForFile(fixture.leaderPidPath));
    await waitForFile(fixture.serverReadyPath);
    descendantPid = Number(await waitForFile(fixture.descendantPidPath));
    await waitForProcessExit(leaderPid);

    await assert.rejects(
      Promise.race([
        invocation,
        new Promise((_, reject) => {
          settlementTimer = setTimeout(
            () => reject(new Error("mmbridge waited for inherited output pipes to close")),
            1_500,
          );
        }),
      ]),
      /mmbridge MCP process exited early/,
    );
    assert.equal(processExists(leaderPid), false, "the server leader must remain reaped");
    assert.equal(processExists(descendantPid), false, "the inherited-pipe descendant must be terminated");
  } finally {
    if (settlementTimer) clearTimeout(settlementTimer);
    if (leaderPid && processExists(leaderPid)) process.kill(leaderPid, "SIGKILL");
    if (descendantPid && processExists(descendantPid)) process.kill(descendantPid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("mmbridge rejects and redacts an unterminated stdout buffer overflow", {
  timeout: 5_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-mmbridge-stdout-"));
  let pid;
  const deadline = deadlineFailure("mmbridge did not reject its stdout buffer overflow");
  try {
    const fixture = writeBufferServer(root, "stdout-overflow", `
process.stderr.write("api_key=stdout-secret\\n");
process.stdout.write("x".repeat(2 * 1024 * 1024));
process.stdin.resume();
setInterval(() => {}, 1000);
`);
    configureMmbridge(root, fixture.serverPath);
    const invocation = runMmbridgeMcpTool({
      workspaceRoot: root,
      toolName: "mmbridge_doctor",
      args: {},
      timeoutMs: 0,
    });
    pid = Number(await waitForFile(fixture.pidPath));

    let failure;
    await assert.rejects(Promise.race([invocation, deadline.promise]), (error) => {
      failure = error;
      return /stdout buffer exceeded/.test(error?.message);
    });
    assert.doesNotMatch(failure.message, /stdout-secret/);
    assert.match(failure.message, /api_key=\*\*\*/);
    assert.equal(processExists(pid), false, "stdout overflow must settle the server process");
  } finally {
    deadline.clear();
    if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("mmbridge rejects an oversized newline-delimited frame", {
  timeout: 5_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-mmbridge-frame-"));
  let pid;
  const deadline = deadlineFailure("mmbridge did not reject its oversized frame");
  try {
    const fixture = writeBufferServer(root, "frame-overflow", `
process.stdout.write("x".repeat(768 * 1024) + "\\n");
process.stdin.resume();
setInterval(() => {}, 1000);
`);
    configureMmbridge(root, fixture.serverPath);
    const invocation = runMmbridgeMcpTool({
      workspaceRoot: root,
      toolName: "mmbridge_doctor",
      args: {},
      timeoutMs: 0,
    });
    pid = Number(await waitForFile(fixture.pidPath));

    await assert.rejects(
      Promise.race([invocation, deadline.promise]),
      /MCP frame exceeded/,
    );
    assert.equal(processExists(pid), false, "frame overflow must settle the server process");
  } finally {
    deadline.clear();
    if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("mmbridge bounds and redacts stderr before reporting overflow", {
  timeout: 5_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-mmbridge-stderr-"));
  let pid;
  const deadline = deadlineFailure("mmbridge did not reject its stderr overflow");
  try {
    const fixture = writeBufferServer(root, "stderr-overflow", `
process.stderr.write("api_key=stderr-secret " + "x".repeat(300 * 1024));
process.stdin.resume();
setInterval(() => {}, 1000);
`);
    configureMmbridge(root, fixture.serverPath);
    const invocation = runMmbridgeMcpTool({
      workspaceRoot: root,
      toolName: "mmbridge_doctor",
      args: {},
      timeoutMs: 0,
    });
    pid = Number(await waitForFile(fixture.pidPath));

    let failure;
    await assert.rejects(Promise.race([invocation, deadline.promise]), (error) => {
      failure = error;
      return /stderr exceeded/.test(error?.message);
    });
    assert.doesNotMatch(failure.message, /stderr-secret/);
    assert.ok(failure.message.length < 270 * 1024, "stderr diagnostics must remain bounded");
    assert.equal(processExists(pid), false, "stderr overflow must settle the server process");
  } finally {
    deadline.clear();
    if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("mmbridge health settles an inherited-pipe descendant after leader exit", {
  skip: process.platform === "win32" ? "POSIX process groups only" : false,
  timeout: 5_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-mmbridge-health-pipes-"));
  let leaderPid;
  let descendantPid;
  const deadline = deadlineFailure("mmbridge health waited for inherited output pipes to close");
  try {
    const fixture = writeInheritedPipeServer(root);
    configureMmbridge(root, fixture.serverPath);
    const invocation = runMmbridgeMcpHealthCheck({ workspaceRoot: root, timeoutMs: 0 });
    leaderPid = Number(await waitForFile(fixture.leaderPidPath));
    await waitForFile(fixture.serverReadyPath);
    descendantPid = Number(await waitForFile(fixture.descendantPidPath));
    await waitForProcessExit(leaderPid);

    const result = await Promise.race([invocation, deadline.promise]);
    assert.equal(result.reachable, false);
    assert.equal(processExists(leaderPid), false, "the health server leader must remain reaped");
    assert.equal(processExists(descendantPid), false, "health must terminate the inherited-pipe descendant");
  } finally {
    deadline.clear();
    if (leaderPid && processExists(leaderPid)) process.kill(leaderPid, "SIGKILL");
    if (descendantPid && processExists(descendantPid)) process.kill(descendantPid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [name, body] of [
  ["stdout", `process.stdout.write("x".repeat(2 * 1024 * 1024));`],
  ["frame", `process.stdout.write("x".repeat(768 * 1024) + "\\n");`],
  ["stderr", `process.stderr.write("token=health-secret " + "x".repeat(300 * 1024));`],
]) {
  test(`mmbridge health bounds ${name} and hides overflow diagnostics`, { timeout: 5_000 }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), `unclecode-mmbridge-health-${name}-`));
    let pid;
    const deadline = deadlineFailure(`mmbridge health did not reject ${name} overflow`);
    try {
      const fixture = writeBufferServer(root, `health-${name}`, `
${body}
process.stdin.resume();
setInterval(() => {}, 1000);
`);
      configureMmbridge(root, fixture.serverPath);
      const invocation = runMmbridgeMcpHealthCheck({ workspaceRoot: root, timeoutMs: 0 });
      pid = Number(await waitForFile(fixture.pidPath));

      const result = await Promise.race([invocation, deadline.promise]);
      assert.equal(result.reachable, false);
      assert.equal(result.error, "health check failed; diagnostics hidden");
      assert.doesNotMatch(JSON.stringify(result), /health-secret/);
      assert.equal(processExists(pid), false, `health ${name} overflow must settle the server process`);
    } finally {
      deadline.clear();
      if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });
}
