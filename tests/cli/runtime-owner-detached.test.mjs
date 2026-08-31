import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import {
  RuntimeOwnerClient,
  probeRuntimeOwner,
  processStartIdentity,
  readRuntimeOwnerLease,
  startPersistentRuntimeOwner,
} from "../../apps/unclecode-server/src/index.ts";
import {
  runtimeOwnerServiceEnvironment,
  spawnDetachedRuntimeOwner,
} from "../../apps/unclecode-cli/src/runtime-owner-launcher.ts";

async function processesForLease(leasePath) {
  const child = spawn("ps", ["ax", "-o", "pid=,command="], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`ps exited ${code}`)));
  });
  return output.split("\n")
    .filter(line => line.includes("runtime-owner-service") && line.includes(leasePath))
    .map(line => Number.parseInt(line.trim().split(/\s+/, 1)[0], 10))
    .filter(Number.isFinite);
}

async function waitForNoLeaseProcess(leasePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let pids = await processesForLease(leasePath);
  while (pids.length > 0 && Date.now() <= deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
    pids = await processesForLease(leasePath);
  }
  return pids;
}

function waitForExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try { process.kill(pid, 0); }
      catch { resolve(); return; }
      if (Date.now() > deadline) { reject(new Error(`process ${pid} remained alive`)); return; }
      // Once the detached owner exits this poll can be the only live handle.
      // Keep it referenced so Node does not abandon the pending assertion.
      setTimeout(poll, 20);
    };
    poll();
  });
}

async function stopFixtureProcess(fixture) {
  fixture.lines.close();
  if (fixture.child.exitCode !== null || fixture.child.signalCode !== null) return;
  const exited = new Promise(resolve => fixture.child.once("exit", resolve));
  fixture.child.kill("SIGKILL");
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`fixture ${fixture.child.pid} did not exit`)), 2_000)),
  ]);
}

async function stopOwnersForHome(home) {
  const leasePath = join(home, ".unclecode", "runtime-owner-v1.json");
  const lease = await readRuntimeOwnerLease(leasePath);
  const pids = lease ? [lease.pid] : await processesForLease(leasePath);
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch { continue; }
    try {
      await waitForExit(pid, 2_000);
    } catch {
      try { process.kill(pid, "SIGKILL"); } catch {}
      await waitForExit(pid, 2_000);
    }
  }
}

async function startClientFixture(home, envOverrides = {}, workspace = process.cwd()) {
  const fixture = new URL("../../scripts/runtime-qa/runtime-owner-client-fixture.mjs", import.meta.url);
  const child = spawn(process.execPath, ["--import", "tsx", fixture.pathname, workspace], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      GEMINI_API_KEY: "test-only-key",
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errors = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => errors.push(chunk));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    const ready = await new Promise((resolve, reject) => {
      const onExit = (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`fixture exited before ready (${code ?? signal}): ${errors.join("")}`));
      };
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        reject(new Error(`fixture timeout: ${errors.join("")}`));
      // Source-mode cold starts compile the complete owner graph. Production
      // uses built JS, but this process contract must remain deterministic on a
      // cold CI worker as well.
      }, 90_000);
      timer.unref();
      child.once("exit", onExit);
      lines.once("line", line => {
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve(JSON.parse(line));
      });
    });
    return { child, lines, ready };
  } catch (error) {
    await stopFixtureProcess({ child, lines }).catch(() => undefined);
    await stopOwnersForHome(home).catch(() => undefined);
    throw error;
  }
}

test("detached owner survives first TUI death and preserves endpoint, session, and revision", async () => {
  const home = await mkdtemp(join(tmpdir(), "unclecode-owner-detach-"));
  let fixture;
  try {
    fixture = await startClientFixture(home);
    const { child, lines, ready } = fixture;
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
  } finally {
    if (fixture) await stopFixtureProcess(fixture).catch(() => undefined);
    await stopOwnersForHome(home);
  }
});

test("simultaneous first clients converge on one detached owner", async () => {
  const home = await mkdtemp(join(tmpdir(), "unclecode-owner-race-"));
  const settled = await Promise.allSettled([startClientFixture(home), startClientFixture(home)]);
  const fixtures = settled.filter(result => result.status === "fulfilled").map(result => result.value);
  try {
    const failure = settled.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    const [first, second] = fixtures;
    assert.ok(first && second);
    assert.equal(first.ready.lease.pid, second.ready.lease.pid);
    assert.equal(first.ready.lease.ownerId, second.ready.lease.ownerId);
    assert.equal(first.ready.lease.endpoint, second.ready.lease.endpoint);
    assert.notEqual(first.ready.sessionId, second.ready.sessionId);
    await Promise.all([stopFixtureProcess(first), stopFixtureProcess(second)]);
    assert.equal(await probeRuntimeOwner(first.ready.lease), true);
    process.kill(first.ready.lease.pid, "SIGTERM");
    await waitForExit(first.ready.lease.pid);
    await assert.rejects(readFile(join(home, ".unclecode", "runtime-owner-v1.json"), "utf8"));
  } finally {
    await Promise.all(fixtures.map(fixture => stopFixtureProcess(fixture).catch(() => undefined)));
    await stopOwnersForHome(home);
  }
});

test("owner service environment forwards runtime config but drops unrelated secrets", () => {
  const env = runtimeOwnerServiceEnvironment({
    HOME: "/safe/home", PATH: "/bin", UNCLECODE_DATA_ROOT: "/data",
    OPENAI_API_KEY: "provider-key", RANDOM_APP_SECRET: "must-not-cross-boundary",
    npm_config_proxy: "http://package-manager-only.invalid",
    PROXY_AUTH_TOKEN: "must-not-cross-boundary",
  });
  assert.equal(env.HOME, "/safe/home");
  assert.equal(env.OPENAI_API_KEY, "provider-key");
  assert.equal(env.RANDOM_APP_SECRET, undefined);
  assert.equal(env.npm_config_proxy, undefined);
  assert.equal(env.PROXY_AUTH_TOKEN, undefined);
});

test("owner service environment forwards every documented provider proxy key", () => {
  const env = runtimeOwnerServiceEnvironment({
    HTTPS_PROXY: "http://upper-https.proxy",
    https_proxy: "http://lower-https.proxy",
    HTTP_PROXY: "http://upper-http.proxy",
    http_proxy: "http://lower-http.proxy",
    ALL_PROXY: "socks5://upper-all.proxy",
    all_proxy: "socks5://lower-all.proxy",
    NO_PROXY: ".upper.internal",
    no_proxy: ".lower.internal",
  });

  assert.deepEqual(env, {
    HTTPS_PROXY: "http://upper-https.proxy",
    https_proxy: "http://lower-https.proxy",
    HTTP_PROXY: "http://upper-http.proxy",
    http_proxy: "http://lower-http.proxy",
    ALL_PROXY: "socks5://upper-all.proxy",
    all_proxy: "socks5://lower-all.proxy",
    NO_PROXY: ".upper.internal",
    no_proxy: ".lower.internal",
  });
});

test("detached owner propagates proxy settings into a native provider request", async () => {
  const home = await mkdtemp(join(tmpdir(), "unclecode-owner-proxy-"));
  const observed = [];
  const proxy = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      observed.push({ url: req.url, body: JSON.parse(body || "{}") });
      const response = JSON.stringify({
        candidates: [{ content: { parts: [{ text: "OWNER_PROXY_OK" }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(response),
      });
      res.end(response);
    });
  });
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  let fixture;
  try {
    const address = proxy.address();
    assert.equal(typeof address, "object");
    fixture = await startClientFixture(home, {
      UNCLECODE_WORK_ENGINE: "native",
      UNCLECODE_RUNTIME_OWNER_PROVIDER_PROMPT: "route through detached proxy",
      GEMINI_API_BASE_URL: "http://provider.invalid/v1beta",
      HTTP_PROXY: `http://127.0.0.1:${address.port}`,
      http_proxy: "",
      NO_PROXY: "",
      no_proxy: "",
      RANDOM_APP_SECRET: "must-not-cross-boundary",
    }, home);

    assert.equal(fixture.ready.providerText, "OWNER_PROXY_OK");
    assert.equal(observed.length, 1);
    assert.match(observed[0].url, /^http:\/\/provider\.invalid\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
    assert.match(
      observed[0].body.contents?.[0]?.parts?.[0]?.text ?? "",
      /User request:\nroute through detached proxy/,
    );
  } finally {
    if (fixture) await stopFixtureProcess(fixture).catch(() => undefined);
    await stopOwnersForHome(home);
    await new Promise(resolve => proxy.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("timed-out detached owner startup reaps the exact spawned service", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-timeout-"));
  const leasePath = join(root, "owner.json");
  await assert.rejects(
    spawnDetachedRuntimeOwner({ leasePath, tokenPath: join(root, "owner.token"), timeoutMs: -1 }),
    /Timed out waiting/,
  );
  const leakedPids = await waitForNoLeaseProcess(leasePath);
  try {
    assert.deepEqual(leakedPids, []);
  } finally {
    for (const pid of leakedPids) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
});

test("detached owner spawn errors reject promptly without publishing a lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-spawn-error-"));
  const leasePath = join(root, "owner.json");
  await assert.rejects(
    spawnDetachedRuntimeOwner({
      leasePath,
      tokenPath: join(root, "owner.token"),
      timeoutMs: 1_000,
      spawnProcess: (_command, args, options) => spawn("/definitely/missing/unclecode-owner", args, options),
    }),
    /Failed to spawn detached runtime owner/,
  );
  await assert.rejects(readFile(leasePath, "utf8"));
});

function flagValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function spawnLeaseChild(args, options, {
  foreignOwner = false,
  foreignStart = false,
  foreignBoot = false,
  replaceAfterPublish = false,
  hang = false,
} = {}) {
  const leasePath = flagValue(args, "--lease-path");
  const tokenPath = flagValue(args, "--token-path");
  const ownerId = flagValue(args, "--owner-id") ?? "fixture-owner";
  const bootId = flagValue(args, "--boot-id") ?? "fixture-boot";
  const child = spawn(process.execPath, ["-e", hang
    ? "setInterval(() => {}, 1 << 30)"
    : "setTimeout(() => process.exit(23), 30)"], options);
  const writeLease = (overrides = {}) => {
    writeFileSync(leasePath, JSON.stringify({
      version: 1,
      protocol: "unclecode-runtime-owner/1",
      ownerId: foreignOwner ? "foreign-owner" : ownerId,
      pid: child.pid,
      bootId: foreignBoot ? "foreign-boot" : bootId,
      processStartId: foreignStart ? "foreign-process-start" : "fixture-process-start",
      endpoint: "http://127.0.0.1:49999",
      tokenPath,
      startedAt: Date.now(),
      ...overrides,
    }));
  };
  writeLease();
  if (replaceAfterPublish) {
    writeLease({
      ownerId: "replacement-owner",
      processStartId: "replacement-process-start",
    });
  }
  return child;
}

function spawnLeaseThenExit(args, options, identity = {}) {
  return spawnLeaseChild(args, options, identity);
}

async function rejectDetachedStartup(input, pattern) {
  await assert.rejects(spawnDetachedRuntimeOwner(input), pattern);
}

function fixtureOwnerOptions(root, extras = {}) {
  return {
    leasePath: join(root, "owner.json"),
    tokenPath: join(root, "owner.token"),
    // Starting the fixture Node process can exceed one second on a loaded CI
    // runner. Keep this comfortably below the product's 60s startup budget
    // while still testing that the observed exit wins over timeout.
    timeoutMs: 5_000,
    resolveProcessStartIdentity: async () => "fixture-process-start",
    ...extras,
  };
}

test("early owner exit removes only its exact owner and process-start lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-early-exit-"));
  const leasePath = join(root, "owner.json");
  const seen = {};
  let fixtureChild;
  await assert.rejects(
    spawnDetachedRuntimeOwner({
      leasePath,
      tokenPath: join(root, "owner.token"),
      timeoutMs: 5_000,
      resolveProcessStartIdentity: async () => {
        assert.ok(fixtureChild, "fixture child should exist before identity resolution");
        if (fixtureChild.exitCode === null && fixtureChild.signalCode === null) {
          await new Promise((resolve, reject) => {
            fixtureChild.once("exit", resolve);
            fixtureChild.once("error", reject);
          });
        }
        return "fixture-process-start";
      },
      spawnProcess: (_command, args, options) => {
        seen.ownerId = flagValue(args, "--owner-id");
        seen.bootId = flagValue(args, "--boot-id");
        fixtureChild = spawnLeaseThenExit(args, options);
        return fixtureChild;
      },
    }),
    /exited before publishing a healthy lease \(23\)/,
  );
  assert.equal(typeof seen.ownerId, "string");
  assert.ok(seen.ownerId.length > 0);
  assert.equal(typeof seen.bootId, "string");
  await assert.rejects(readFile(leasePath, "utf8"));
});

test("failed startup preserves a same-PID lease with foreign owner or process-start identity", async () => {
  for (const identity of [{ foreignOwner: true }, { foreignStart: true }, { foreignBoot: true }]) {
    const root = await mkdtemp(join(tmpdir(), "unclecode-owner-aba-"));
    const leasePath = join(root, "owner.json");
    await rejectDetachedStartup({
      ...fixtureOwnerOptions(root),
      spawnProcess: (_command, args, options) => spawnLeaseThenExit(args, options, identity),
    }, /exited before publishing a healthy lease \(23\)/);
    const retained = JSON.parse(await readFile(leasePath, "utf8"));
    if (identity.foreignOwner) assert.equal(retained.ownerId, "foreign-owner");
    if (identity.foreignStart) assert.equal(retained.processStartId, "foreign-process-start");
    if (identity.foreignBoot) assert.equal(retained.bootId, "foreign-boot");
  }
});

test("early owner exit preserves a same-PID replacement lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-replace-exit-"));
  const leasePath = join(root, "owner.json");
  await rejectDetachedStartup({
    ...fixtureOwnerOptions(root),
    spawnProcess: (_command, args, options) => spawnLeaseChild(args, options, { replaceAfterPublish: true }),
  }, /exited before publishing a healthy lease \(23\)/);
  const retained = JSON.parse(await readFile(leasePath, "utf8"));
  assert.equal(retained.ownerId, "replacement-owner");
  assert.equal(retained.processStartId, "replacement-process-start");
});

test("timed-out unhealthy startup removes only its exact owner lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-unhealthy-"));
  const leasePath = join(root, "owner.json");
  let child;
  try {
    await rejectDetachedStartup({
      ...fixtureOwnerOptions(root, { timeoutMs: 250 }),
      spawnProcess: (_command, args, options) => {
        child = spawnLeaseChild(args, options, { hang: true });
        return child;
      },
    }, /Timed out waiting/);
    await assert.rejects(readFile(leasePath, "utf8"));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("timed-out startup preserves a same-PID foreign or replacement lease", async () => {
  for (const identity of [
    { foreignOwner: true },
    { foreignStart: true },
    { foreignBoot: true },
    { replaceAfterPublish: true },
  ]) {
    const root = await mkdtemp(join(tmpdir(), "unclecode-owner-timeout-aba-"));
    const leasePath = join(root, "owner.json");
    let child;
    try {
      await rejectDetachedStartup({
        ...fixtureOwnerOptions(root, { timeoutMs: 250 }),
        spawnProcess: (_command, args, options) => {
          child = spawnLeaseChild(args, options, { ...identity, hang: true });
          return child;
        },
      }, /Timed out waiting/);
      const retained = JSON.parse(await readFile(leasePath, "utf8"));
      if (identity.foreignOwner) assert.equal(retained.ownerId, "foreign-owner");
      if (identity.foreignStart) assert.equal(retained.processStartId, "foreign-process-start");
      if (identity.foreignBoot) assert.equal(retained.bootId, "foreign-boot");
      if (identity.replaceAfterPublish) {
        assert.equal(retained.ownerId, "replacement-owner");
        assert.equal(retained.processStartId, "replacement-process-start");
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
});

test("published runtime owner lease includes a real process-start identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-publish-start-"));
  const leasePath = join(root, "owner.json");
  const owner = await startPersistentRuntimeOwner({
    rootDir: root,
    leasePath,
    tokenPath: join(root, "owner.token"),
    ownerId: "published-owner",
    bootId: "published-boot",
  });
  t.after(() => owner.stop());
  const published = await readRuntimeOwnerLease(leasePath);
  assert.equal(published?.ownerId, "published-owner");
  assert.equal(published.bootId, "published-boot");
  assert.equal(typeof published.processStartId, "string");
  assert.ok(published.processStartId.length > 0);
  assert.equal(published.processStartId, await processStartIdentity(published.pid));
});
