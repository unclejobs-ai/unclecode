import assert from "node:assert/strict";
import {
  closeSync,
  fstatSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { persistWorkShellSessionSnapshot } from "@unclecode/orchestrator";
import { recordWorkspaceTrust } from "@unclecode/plugin-host";
import { loadWorkCliBootstrap } from "../../apps/unclecode-cli/src/work-runtime-bootstrap.ts";

const PROBE_EVENT = "unclecode-work-bootstrap-cleanup-probe";

function isolatedEnv(root, home, probeKey, fdPath) {
  const originalHome = process.env.HOME;
  return {
    HOME: home,
    PATH: process.env.PATH,
    ...(process.env.CARGO_HOME
      ? { CARGO_HOME: process.env.CARGO_HOME }
      : originalHome ? { CARGO_HOME: join(originalHome, ".cargo") } : {}),
    ...(process.env.RUSTUP_HOME
      ? { RUSTUP_HOME: process.env.RUSTUP_HOME }
      : originalHome ? { RUSTUP_HOME: join(originalHome, ".rustup") } : {}),
    DEEPSEEK_API_KEY: "test-only-key",
    UNCLECODE_SESSION_STORE_ROOT: join(root, "sessions"),
    UNCLECODE_CRP: "1",
    UNCLECODE_CLEANUP_PROBE_KEY: probeKey,
    UNCLECODE_CLEANUP_FD_PATH: fdPath,
  };
}

test("owner bootstrap failure after plugin loading closes plugin listeners, timers, and file descriptors exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-bootstrap-cleanup-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const pluginDir = join(workspace, ".unclecode", "plugins");
  const probeKey = `__unclecodeCleanupProbe${Date.now()}${Math.random()}`;
  const fdPath = join(root, "plugin-open-fd");
  const listenerBaseline = process.listenerCount(PROBE_EVENT);
  const env = isolatedEnv(root, home, probeKey, fdPath);
  const sessionId = "post-load-cleanup-failure";
  await mkdir(pluginDir, { recursive: true });
  await mkdir(home);
  await persistWorkShellSessionSnapshot({
    cwd: workspace,
    env,
    sessionId,
    model: "deepseek-chat",
    mode: "standard",
    state: "idle",
    summary: "Cleanup failure fixture",
  });
  await writeFile(join(pluginDir, "cleanup-probe.mjs"), [
    'import { closeSync, openSync } from "node:fs";',
    "export default ({ workspaceRoot, env }) => {",
    "  const listener = () => {};",
    `  process.on(${JSON.stringify(PROBE_EVENT)}, listener);`,
    "  const timer = setInterval(() => {",
    "    env.UNCLECODE_CLEANUP_TIMER_TICKS = String(Number(env.UNCLECODE_CLEANUP_TIMER_TICKS ?? '0') + 1);",
    "  }, 2);",
    "  timer.unref();",
    "  const fd = openSync(env.UNCLECODE_CLEANUP_FD_PATH, 'w');",
    "  env.UNCLECODE_CLEANUP_FD = String(fd);",
    "  globalThis[env.UNCLECODE_CLEANUP_PROBE_KEY] = { listener, timer, fd };",
    "  env.UNCLECODE_CLEANUP_PLUGIN_LOADED = '1';",
    "  return { dispose() {",
    "    env.UNCLECODE_CLEANUP_DISPOSED = String(Number(env.UNCLECODE_CLEANUP_DISPOSED ?? '0') + 1);",
    `    process.off(${JSON.stringify(PROBE_EVENT)}, listener);`,
    "    clearInterval(timer);",
    "    closeSync(fd);",
    "  } };",
    "};",
    "",
  ].join("\n"));
  recordWorkspaceTrust(workspace, home);
  await writeFile(join(home, ".unclecode", "agentops"), "blocks the lifecycle database directory");

  try {
    await assert.rejects(
      loadWorkCliBootstrap({
        argv: [
          "--cwd",
          workspace,
          "--provider",
          "deepseek",
          "--model",
          "deepseek-chat",
          "--session-id",
          sessionId,
        ],
        env,
        userHomeDir: home,
      }),
      /Unable to resume safely: context integrity validation failed/,
    );

    assert.equal(env.UNCLECODE_CLEANUP_PLUGIN_LOADED, "1", "the failure must occur after plugin load");
    assert.equal(env.UNCLECODE_CLEANUP_DISPOSED, "1");
    assert.equal(process.listenerCount(PROBE_EVENT), listenerBaseline);
    assert.throws(() => fstatSync(Number(env.UNCLECODE_CLEANUP_FD)), { code: "EBADF" });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const ticksAfterFailure = env.UNCLECODE_CLEANUP_TIMER_TICKS;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(env.UNCLECODE_CLEANUP_TIMER_TICKS, ticksAfterFailure, "plugin timer must stop after cleanup");
  } finally {
    const probe = globalThis[probeKey];
    if (probe) {
      process.off(PROBE_EVENT, probe.listener);
      clearInterval(probe.timer);
      try { closeSync(probe.fd); } catch {}
      delete globalThis[probeKey];
    }
    await rm(root, { recursive: true, force: true });
  }
});
