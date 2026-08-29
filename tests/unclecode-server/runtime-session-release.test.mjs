import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RuntimeOwnerClient,
  probeRuntimeOwner,
  startPersistentRuntimeOwner,
} from "../../apps/unclecode-server/src/index.ts";

function idleEngine() {
  return {
    getState: () => ({ isBusy: false, turnLifecycle: { state: "completed" } }),
    getTurnLifecycle: () => ({ state: "completed" }),
    subscribe: () => () => {},
  };
}

async function waitUntil(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test("authenticated runtime session release is idempotent and disposes once", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-runtime-release-"));
  const projectPath = join(rootDir, "workspace");
  let owner;
  let disposals = 0;
  try {
    owner = await startPersistentRuntimeOwner({
      rootDir,
      leasePath: join(rootDir, "owner.json"),
      tokenPath: join(rootDir, "server.token"),
      async createSession() {
        return {
          engine: idleEngine(),
          projectPath,
          dispose() { disposals += 1; },
        };
      },
    });
    const client = await RuntimeOwnerClient.connect(owner.lease);
    const created = await client.createRuntimeSession({
      sessionId: "release-once",
      projectPath,
      idempotencyKey: "create-release-once",
    });
    assert.equal(created.ok, true);
    assert.equal((await client.attachRuntimeSession("release-once")).ok, true);

    assert.deepEqual(await client.releaseRuntimeSession("release-once"), {
      ok: true,
      released: true,
    });
    assert.deepEqual(await client.releaseRuntimeSession("release-once"), {
      ok: true,
      released: false,
    });
    assert.equal(disposals, 1);
    assert.equal((await client.readEngineState("release-once")).ok, false);
  } finally {
    await owner?.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("an owner stops when its exact discovery lease is removed", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-runtime-lease-watch-"));
  const leasePath = join(rootDir, "owner.json");
  let owner;
  try {
    owner = await startPersistentRuntimeOwner({
      rootDir,
      leasePath,
      tokenPath: join(rootDir, "server.token"),
      leaseWatchIntervalMs: 25,
    });
    assert.equal(await probeRuntimeOwner(owner.lease), true);

    await unlink(leasePath);

    assert.equal(
      await waitUntil(async () => !await probeRuntimeOwner(owner.lease)),
      true,
      "an undiscoverable owner must close its listener instead of becoming an orphan",
    );
  } finally {
    await owner?.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});
