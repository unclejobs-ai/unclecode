import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { stopRuntimeOwnersUnder } from "../../scripts/runtime-qa/runtime-owner-cleanup.mjs";
import { runWithRuntimeHome } from "../../scripts/runtime-qa/tui-suite-smokes.mjs";

test("isolated TUI smoke reaps its runtime owner before the next smoke", async () => {
  const events = [];
  const tmp = path.join("", "tmp", "runtime-qa");
  const result = await runWithRuntimeHome(
    tmp,
    "real-use",
    async () => {
      events.push("run");
      return "ok";
    },
    {
      runTmuxCommand: async (args) => events.push(["tmux", ...args]),
      stopOwners: async (home) => events.push(["stop", home]),
      extraOwnerRoots: [path.join(tmp, "explicit-session-store")],
    },
  );

  assert.equal(result, "ok");
  assert.deepEqual(events, [
    ["tmux", "set-environment", "-g", "HOME", path.join(tmp, "runtime-homes", "real-use")],
    ["tmux", "set-environment", "-g", "USERPROFILE", path.join(tmp, "runtime-homes", "real-use")],
    [
      "tmux",
      "set-environment",
      "-g",
      "UNCLECODE_SESSION_STORE_ROOT",
      path.join(tmp, "runtime-homes", "real-use", ".unclecode", "state"),
    ],
    "run",
    ["stop", path.join(tmp, "runtime-homes", "real-use")],
    ["stop", path.join(tmp, "explicit-session-store")],
  ]);
});

test("isolated TUI smoke reaps its runtime owner after a failed smoke", async () => {
  const stopped = [];
  const failure = new Error("smoke failed");
  await assert.rejects(
    runWithRuntimeHome(
      "/tmp/runtime-qa",
      "failed",
      async () => { throw failure; },
      {
        runTmuxCommand: async () => {},
        stopOwners: async (home) => stopped.push(home),
        extraOwnerRoots: [path.join("/tmp/runtime-qa", "explicit-session-store")],
      },
    ),
    failure,
  );
  assert.deepEqual(stopped, [
    path.join("/tmp/runtime-qa", "runtime-homes", "failed"),
    path.join("/tmp/runtime-qa", "explicit-session-store"),
  ]);
});

test("runtime owner cleanup does not mistake transient null identity for exit", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "uc-runtime-cleanup-null-"));
  try {
    const leaseDirectory = path.join(root, ".unclecode");
    mkdirSync(leaseDirectory, { recursive: true });
    writeFileSync(path.join(leaseDirectory, "runtime-owner-v1.json"), JSON.stringify({
      pid: 4242,
      bootId: "boot",
      processStartId: "start",
    }));
    const signals = [];
    let identityReads = 0;
    let aliveReads = 0;
    await stopRuntimeOwnersUnder(root, {
      currentBootIdentity: () => "boot",
      processStartIdentity: async () => identityReads++ === 0 ? "start" : null,
      isPidAlive: () => aliveReads++ < 2,
      kill: (pid, signal) => signals.push([pid, signal]),
      timeoutMs: 50,
      pollMs: 0,
    });

    assert.deepEqual(signals, [[4242, "SIGTERM"]]);
    assert.ok(identityReads >= 2, "cleanup must keep observing through an indeterminate identity");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime owner cleanup fails closed on a persistently indeterminate live lease", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "uc-runtime-cleanup-fail-closed-"));
  try {
    const leaseDirectory = path.join(root, ".unclecode");
    mkdirSync(leaseDirectory, { recursive: true });
    writeFileSync(path.join(leaseDirectory, "runtime-owner-v1.json"), JSON.stringify({
      pid: 4343,
      bootId: "boot",
      processStartId: "start",
    }));
    const signals = [];
    await assert.rejects(stopRuntimeOwnersUnder(root, {
      currentBootIdentity: () => "boot",
      processStartIdentity: async () => null,
      isPidAlive: () => true,
      kill: (pid, signal) => signals.push([pid, signal]),
      timeoutMs: 5,
      pollMs: 0,
    }), /live but indeterminate lease identity/);
    assert.deepEqual(signals, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime owner cleanup accepts normal exit between liveness and an indeterminate identity", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "uc-runtime-cleanup-exit-race-"));
  try {
    const leaseDirectory = path.join(root, ".unclecode");
    mkdirSync(leaseDirectory, { recursive: true });
    writeFileSync(path.join(leaseDirectory, "runtime-owner-v1.json"), JSON.stringify({
      pid: 4444,
      bootId: "boot",
      processStartId: "start",
    }));
    const signals = [];
    let identityReads = 0;
    let exited = false;
    await stopRuntimeOwnersUnder(root, {
      currentBootIdentity: () => "boot",
      processStartIdentity: async () => {
        identityReads += 1;
        if (identityReads === 1) return "start";
        exited = true;
        return null;
      },
      isPidAlive: () => !exited,
      kill: (pid, signal) => signals.push([pid, signal]),
      timeoutMs: 1,
      pollMs: 0,
    });
    assert.deepEqual(signals, [[4444, "SIGTERM"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime owner cleanup never SIGKILLs a reused PID", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "uc-runtime-cleanup-pid-reuse-"));
  try {
    const leaseDirectory = path.join(root, ".unclecode");
    mkdirSync(leaseDirectory, { recursive: true });
    writeFileSync(path.join(leaseDirectory, "runtime-owner-v1.json"), JSON.stringify({
      pid: 4545,
      bootId: "boot",
      processStartId: "start",
    }));
    const signals = [];
    let identityReads = 0;
    await stopRuntimeOwnersUnder(root, {
      currentBootIdentity: () => "boot",
      processStartIdentity: async () => identityReads++ === 0 ? "start" : "reused",
      isPidAlive: () => true,
      kill: (pid, signal) => signals.push([pid, signal]),
      timeoutMs: 0,
      pollMs: 0,
    });
    assert.deepEqual(signals, [[4545, "SIGTERM"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
