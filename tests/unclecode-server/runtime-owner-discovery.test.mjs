import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from "node:fs/promises";
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
    processStartId: "fixture-process-start",
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
    ensureRuntimeOwner({
      leasePath, lockPath, bootId: "boot-test", health, startOwner,
      resolveProcessStartIdentity: async () => "fixture-process-start",
    }),
    ensureRuntimeOwner({
      leasePath, lockPath, bootId: "boot-test", health, startOwner,
      resolveProcessStartIdentity: async () => "fixture-process-start",
    }),
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

test("a live identity-matched owner survives a transient health timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-transient-health-"));
  const leasePath = join(root, "runtime-owner.json");
  const lockPath = join(root, "runtime-owner.lock");
  await writeFile(leasePath, `${JSON.stringify(lease())}\n`);
  let healthChecks = 0;
  let starts = 0;

  const result = await ensureRuntimeOwner({
    leasePath,
    lockPath,
    bootId: "boot-test",
    timeoutMs: 1_000,
    resolveProcessStartIdentity: async () => "fixture-process-start",
    health: async () => {
      healthChecks += 1;
      return healthChecks >= 3;
    },
    startOwner: async () => {
      starts += 1;
      return lease({ ownerId: "replacement-must-not-start" });
    },
  });

  assert.equal(result.ownerId, "owner-1");
  assert.equal(starts, 0, "a timeout cannot replace the exact live owner process");
  assert.equal(healthChecks, 3);
});

test("a live owner survives an indeterminate process identity lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-indeterminate-identity-"));
  const leasePath = join(root, "runtime-owner.json");
  const lockPath = join(root, "runtime-owner.lock");
  await writeFile(leasePath, `${JSON.stringify(lease())}\n`);
  let identityCalls = 0;
  let starts = 0;

  const result = await ensureRuntimeOwner({
    leasePath, lockPath, bootId: "boot-test", timeoutMs: 1_000,
    resolveProcessStartIdentity: async () => {
      identityCalls += 1;
      if (identityCalls === 1) return "claimant-start";
      if (identityCalls === 2) return null;
      return "fixture-process-start";
    },
    health: async candidate => candidate.ownerId === "owner-1",
    startOwner: async () => { starts += 1; return lease({ ownerId: "duplicate" }); },
  });

  assert.equal(result.ownerId, "owner-1");
  assert.equal(starts, 0);
});

test("persistent indeterminate identity fails closed without starting a second owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-indeterminate-timeout-"));
  const leasePath = join(root, "runtime-owner.json");
  const lockPath = join(root, "runtime-owner.lock");
  await writeFile(leasePath, `${JSON.stringify(lease())}\n`);
  let identityCalls = 0;
  let starts = 0;

  await assert.rejects(ensureRuntimeOwner({
    leasePath, lockPath, bootId: "boot-test", timeoutMs: 30,
    resolveProcessStartIdentity: async () => {
      identityCalls += 1;
      return identityCalls === 1 ? "claimant-start" : null;
    },
    health: async () => false,
    startOwner: async () => { starts += 1; return lease({ ownerId: "duplicate" }); },
  }), /Timed out attaching/);
  assert.equal(starts, 0);
});

test("identity-matched owner with foreign health times out without replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-foreign-health-"));
  const leasePath = join(root, "runtime-owner.json");
  const lockPath = join(root, "runtime-owner.lock");
  await writeFile(leasePath, `${JSON.stringify(lease())}\n`);
  let starts = 0;

  await assert.rejects(ensureRuntimeOwner({
    leasePath, lockPath, bootId: "boot-test", timeoutMs: 30,
    resolveProcessStartIdentity: async () => "fixture-process-start",
    health: async () => false,
    startOwner: async () => { starts += 1; return lease({ ownerId: "duplicate" }); },
  }), /Timed out attaching/);
  assert.equal(starts, 0, "a live exact process cannot be replaced by a foreign endpoint response");
});

test("an indeterminate live lock identity is preserved until its owner publishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-lock-indeterminate-"));
  const leasePath = join(root, "runtime-owner.json");
  const lockPath = join(root, "runtime-owner.lock");
  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    bootId: "boot-test",
    claimId: "live-indeterminate-claim",
    processStartId: "fixture-process-start",
    claimedAt: Date.now(),
  }), { mode: 0o600 });
  const published = lease({ ownerId: "published-after-indeterminate" });
  let identityCalls = 0;
  let starts = 0;
  const publish = setTimeout(() => {
    void writeFile(leasePath, `${JSON.stringify(published)}\n`, { mode: 0o600 });
  }, 40);
  try {
    const result = await ensureRuntimeOwner({
      leasePath, lockPath, bootId: "boot-test", timeoutMs: 1_000,
      resolveProcessStartIdentity: async () => {
        identityCalls += 1;
        if (identityCalls === 1) return "claimant-start";
        if (identityCalls === 2) return null;
        return "fixture-process-start";
      },
      health: async candidate => candidate.ownerId === published.ownerId,
      startOwner: async () => { starts += 1; return lease({ ownerId: "duplicate" }); },
    });
    assert.equal(result.ownerId, published.ownerId);
    assert.equal(starts, 0);
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).claimId, "live-indeterminate-claim");
  } finally {
    clearTimeout(publish);
  }
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

test("an old claim from the same live process start is never stolen by age", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-live-slow-"));
  const leasePath = join(root, "runtime-owner.json");
  const lockPath = join(root, "runtime-owner.lock");
  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    bootId: "boot-test",
    claimId: "slow-live-claim",
    processStartId: "same-live-start",
    claimedAt: Date.now() - 120_000,
  }), { mode: 0o600 });
  let starts = 0;
  const published = lease({ ownerId: "slow-live-owner", processStartId: "same-live-start" });
  const publish = setTimeout(() => {
    void writeFile(leasePath, `${JSON.stringify(published)}\n`, { mode: 0o600 });
  }, 40);
  try {
    const result = await ensureRuntimeOwner({
      leasePath, lockPath, bootId: "boot-test", timeoutMs: 1_000,
      resolveProcessStartIdentity: async () => "same-live-start",
      health: async candidate => candidate.ownerId === published.ownerId,
      startOwner: async () => { starts += 1; return lease({ ownerId: "duplicate" }); },
    });
    assert.equal(result.ownerId, published.ownerId);
    assert.equal(starts, 0);
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).claimId, "slow-live-claim");
  } finally {
    clearTimeout(publish);
  }
});

test("stale-lock cleanup revalidates identity before unlinking a replacement claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-lock-revalidate-"));
  const leasePath = join(root, "runtime-owner.json");
  const lockPath = join(root, "runtime-owner.lock");
  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    bootId: "boot-test",
    claimId: "stale-claim",
    processStartId: "stale-start",
    claimedAt: Date.now(),
  }), { mode: 0o600 });
  const replacementLock = {
    pid: process.pid,
    bootId: "boot-test",
    claimId: "replacement-live-claim",
    processStartId: "replacement-start",
    claimedAt: Date.now(),
  };
  const published = lease({
    ownerId: "replacement-live-owner",
    processStartId: "replacement-start",
  });
  let identityCalls = 0;
  let starts = 0;
  const result = await ensureRuntimeOwner({
    leasePath, lockPath, bootId: "boot-test", timeoutMs: 1_000,
    resolveProcessStartIdentity: async () => {
      identityCalls += 1;
      if (identityCalls === 1) return "claimant-start";
      if (identityCalls === 2) {
        await writeFile(lockPath, JSON.stringify(replacementLock), { mode: 0o600 });
        await writeFile(leasePath, `${JSON.stringify(published)}\n`, { mode: 0o600 });
        return "different-from-stale";
      }
      return "replacement-start";
    },
    health: async candidate => candidate.ownerId === published.ownerId,
    startOwner: async () => { starts += 1; return lease({ ownerId: "duplicate" }); },
  });
  assert.equal(result.ownerId, published.ownerId);
  assert.equal(starts, 0);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).claimId, replacementLock.claimId);
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
