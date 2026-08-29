import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RUNTIME_OWNER_PROTOCOL,
  ensureRuntimeOwner,
  readRuntimeOwnerLease,
} from "../../apps/unclecode-server/src/runtime-owner-discovery.ts";
import { ensureServerToken } from "../../apps/unclecode-server/src/index.ts";

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

test("stale empty and truncated discovery locks are recovered", async () => {
  for (const [name, body] of [["empty", ""], ["truncated", "{\"pid\":"]]) {
    const root = await mkdtemp(join(tmpdir(), `unclecode-owner-${name}-`));
    const leasePath = join(root, "runtime-owner.json");
    const lockPath = join(root, "runtime-owner.lock");
    await writeFile(lockPath, body, { mode: 0o600 });
    const old = new Date(Date.now() - 5_000);
    await utimes(lockPath, old, old);
    const replacement = lease({ ownerId: `owner-${name}` });
    const result = await ensureRuntimeOwner({
      leasePath, lockPath, bootId: "boot-test",
      resolveProcessStartIdentity: async () => "claimant-start",
      health: async candidate => candidate.ownerId === replacement.ownerId,
      startOwner: async () => replacement,
    });
    assert.equal(result.ownerId, replacement.ownerId);
  }
});

test("a live reused PID cannot preserve a lock from another process start", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-pid-reuse-"));
  const leasePath = join(root, "runtime-owner.json");
  const lockPath = join(root, "runtime-owner.lock");
  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    bootId: "boot-test",
    claimId: "old-claim",
    processStartId: "old-process-start",
    claimedAt: Date.now(),
  }), { mode: 0o600 });
  const replacement = lease({ ownerId: "owner-after-pid-reuse" });
  const result = await ensureRuntimeOwner({
    leasePath, lockPath, bootId: "boot-test",
    resolveProcessStartIdentity: async () => "current-process-start",
    health: async candidate => candidate.ownerId === replacement.ownerId,
    startOwner: async () => replacement,
  });
  assert.equal(result.ownerId, replacement.ownerId);
});

test("server token creation rejects symlinks and insecure legacy permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-token-"));
  const secureParent = join(root, "secure");
  const target = join(root, "target-token");
  await writeFile(target, "x".repeat(64), { mode: 0o600 });
  await chmod(root, 0o700);
  await mkdir(secureParent, { mode: 0o700 });
  await symlink(target, join(secureParent, "server.token"));
  assert.throws(() => ensureServerToken(join(secureParent, "server.token")), /regular file/);

  const insecureParent = join(root, "insecure");
  await mkdir(insecureParent, { mode: 0o755 });
  assert.equal(ensureServerToken(join(insecureParent, "server.token")).length, 64);

  const validParent = join(root, "valid");
  await mkdir(validParent, { mode: 0o700 });
  const tokenPath = join(validParent, "server.token");
  const token = ensureServerToken(tokenPath);
  assert.equal(token.length, 64);
  await chmod(tokenPath, 0o644);
  assert.throws(() => ensureServerToken(tokenPath), /permissions must be 0600/);
});
