import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RUNTIME_OWNER_PROTOCOL,
  ensureRuntimeOwner,
  readRuntimeOwnerLease,
} from "../../apps/unclecode-server/src/runtime-owner-discovery.ts";

function lease(overrides = {}) {
  return {
    version: 1,
    protocol: RUNTIME_OWNER_PROTOCOL,
    ownerId: "owner-1",
    pid: process.pid,
    bootId: "boot-test",
    endpoint: "http://127.0.0.1:43123",
    tokenPath: "/tmp/token-reference",
    startedAt: 100,
    ...overrides,
  };
}

test("simultaneous clients start exactly one runtime owner and attach to the same lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-race-"));
  const leasePath = join(root, "runtime-owner.json");
  const lockPath = join(root, "runtime-owner.lock");
  let starts = 0;
  const health = async (candidate) => candidate.ownerId === "owner-1";
  const startOwner = async () => {
    starts += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return lease();
  };

  const [first, second] = await Promise.all([
    ensureRuntimeOwner({ leasePath, lockPath, bootId: "boot-test", health, startOwner }),
    ensureRuntimeOwner({ leasePath, lockPath, bootId: "boot-test", health, startOwner }),
  ]);

  assert.equal(starts, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(await readRuntimeOwnerLease(leasePath), first);
});

test("stale boot, dead pid, incompatible protocol, and foreign endpoint never attach", async () => {
  const cases = [
    lease({ bootId: "old-boot" }),
    lease({ pid: 999_999_999 }),
    lease({ protocol: "foreign/9" }),
    lease({ endpoint: "http://192.0.2.10:17677" }),
  ];
  for (const [index, stale] of cases.entries()) {
    const root = await mkdtemp(join(tmpdir(), `unclecode-owner-stale-${index}-`));
    const leasePath = join(root, "runtime-owner.json");
    const lockPath = join(root, "runtime-owner.lock");
    await writeFile(leasePath, `${JSON.stringify(stale)}\n`);
    let starts = 0;
    const replacement = lease({ ownerId: `replacement-${index}`, endpoint: `http://127.0.0.1:${44000 + index}` });
    const result = await ensureRuntimeOwner({
      leasePath,
      lockPath,
      bootId: "boot-test",
      health: async (candidate) => candidate.ownerId.startsWith("replacement-"),
      startOwner: async () => { starts += 1; return replacement; },
    });
    assert.equal(starts, 1);
    assert.equal(result.ownerId, replacement.ownerId);
  }
});

test("a live compatible lease with failed identity health is replaced, never trusted by port alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-foreign-port-"));
  const leasePath = join(root, "runtime-owner.json");
  const lockPath = join(root, "runtime-owner.lock");
  await writeFile(leasePath, `${JSON.stringify(lease())}\n`);
  let starts = 0;
  const replacement = lease({ ownerId: "owner-2", endpoint: "http://127.0.0.1:43124" });

  const result = await ensureRuntimeOwner({
    leasePath,
    lockPath,
    bootId: "boot-test",
    health: async (candidate) => candidate.ownerId === "owner-2",
    startOwner: async () => { starts += 1; return replacement; },
  });

  assert.equal(starts, 1);
  assert.equal(result.ownerId, "owner-2");
});
