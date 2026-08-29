import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { RuntimeOwnerClient, probeRuntimeOwner } from "../../apps/unclecode-server/src/index.ts";
import { runtimeOwnerServiceEnvironment } from "../../apps/unclecode-cli/src/runtime-owner-launcher.ts";

function waitForExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try { process.kill(pid, 0); }
      catch { resolve(); return; }
      if (Date.now() > deadline) { reject(new Error(`process ${pid} remained alive`)); return; }
      setTimeout(poll, 20).unref();
    };
    poll();
  });
}

async function startClientFixture(home) {
  const fixture = new URL("../../scripts/runtime-qa/runtime-owner-client-fixture.mjs", import.meta.url);
  const child = spawn(process.execPath, ["--import", "tsx", fixture.pathname, process.cwd()], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, GEMINI_API_KEY: "test-only-key" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errors = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => errors.push(chunk));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const ready = await new Promise((resolve, reject) => {
    const onExit = (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited before ready (${code ?? signal}): ${errors.join("")}`));
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`fixture timeout: ${errors.join("")}`));
    }, 20_000);
    timer.unref();
    child.once("exit", onExit);
    lines.once("line", line => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(JSON.parse(line));
    });
  });
  return { child, lines, ready };
}

test("detached owner survives first TUI death and preserves endpoint, session, and revision", async () => {
  const home = await mkdtemp(join(tmpdir(), "unclecode-owner-detach-"));
  const { child, lines, ready } = await startClientFixture(home);
  const { lease, sessionId, revision } = ready;
  assert.notEqual(lease.pid, child.pid, "client and owner must be different OS processes");
  assert.equal(await probeRuntimeOwner(lease), true);

  child.kill("SIGKILL");
  await new Promise(resolve => child.once("exit", resolve));
  lines.close();
  assert.equal(await probeRuntimeOwner(lease), true, "owner must survive terminal/SSH-like client death");
  const reattached = await RuntimeOwnerClient.connect(lease);
  const state = await reattached.readEngineState(sessionId);
  assert.equal(state.ok, true);
  assert.equal(state.revision, revision);
  assert.equal(state.state.mode, "deep");

  const next = await reattached.invokeEngineMethod({
    sessionId, method: "setMode", args: ["standard"], expectedRevision: revision,
    idempotencyKey: "reattached-mode",
  });
  assert.equal(next.ok, true);
  assert.equal(next.revision > revision, true);
  assert.equal(reattached.lease.pid, lease.pid);
  assert.equal(reattached.lease.endpoint, lease.endpoint);

  process.kill(lease.pid, "SIGTERM");
  await waitForExit(lease.pid);
  await assert.rejects(readFile(join(home, ".unclecode", "runtime-owner-v1.json"), "utf8"));
});

test("simultaneous first clients converge on one detached owner", async () => {
  const home = await mkdtemp(join(tmpdir(), "unclecode-owner-race-"));
  const [first, second] = await Promise.all([startClientFixture(home), startClientFixture(home)]);
  assert.equal(first.ready.lease.pid, second.ready.lease.pid);
  assert.equal(first.ready.lease.ownerId, second.ready.lease.ownerId);
  assert.equal(first.ready.lease.endpoint, second.ready.lease.endpoint);
  assert.notEqual(first.ready.sessionId, second.ready.sessionId);
  first.child.kill("SIGKILL");
  second.child.kill("SIGKILL");
  await Promise.all([
    new Promise(resolve => first.child.once("exit", resolve)),
    new Promise(resolve => second.child.once("exit", resolve)),
  ]);
  first.lines.close();
  second.lines.close();
  assert.equal(await probeRuntimeOwner(first.ready.lease), true);
  process.kill(first.ready.lease.pid, "SIGTERM");
  await waitForExit(first.ready.lease.pid);
  await assert.rejects(readFile(join(home, ".unclecode", "runtime-owner-v1.json"), "utf8"));
});

test("owner service environment forwards runtime config but drops unrelated secrets", () => {
  const env = runtimeOwnerServiceEnvironment({
    HOME: "/safe/home", PATH: "/bin", UNCLECODE_DATA_ROOT: "/data",
    OPENAI_API_KEY: "provider-key", RANDOM_APP_SECRET: "must-not-cross-boundary",
  });
  assert.equal(env.HOME, "/safe/home");
  assert.equal(env.OPENAI_API_KEY, "provider-key");
  assert.equal(env.RANDOM_APP_SECRET, undefined);
});
