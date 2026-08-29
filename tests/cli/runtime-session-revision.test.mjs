import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSessionStore } from "../../packages/session-store/src/index.ts";
import { persistWorkShellSessionSnapshot } from "../../packages/orchestrator/src/work-shell-session.ts";
import {
  persistRuntimeAdmissionRevision,
  runtimeAdmissionRecordPath,
} from "../../apps/unclecode-server/src/runtime-admission-ledger.ts";
import {
  initializeRestoredRuntimeEngine,
  readRestoredSessionRevision,
} from "../../apps/unclecode-cli/src/runtime-session-revision.ts";

test("runtime owner restores the explicit accepted mutation revision instead of inferring from record count", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-restored-revision-"));
  const projectPath = join(rootDir, "workspace");
  const ref = { projectPath, sessionId: "restored" };
  try {
    await mkdir(projectPath);
    const store = createSessionStore({ rootDir });
    await store.appendCheckpoint(ref, { type: "state", state: "running" });
    await store.appendCheckpoint(ref, { type: "metadata", metadata: { model: "test-model" } });
    await store.appendCheckpoint(ref, { type: "state", state: "paused" });
    await store.appendCheckpoint(ref, { type: "metadata", metadata: { ownerMutationRevision: 41 } });

    assert.equal(await readRestoredSessionRevision({ rootDir, ...ref, resume: true }), 41);
    assert.equal(await readRestoredSessionRevision({ rootDir, ...ref, resume: false }), 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("Rust persist-json and JS restore round-trip the exact owner mutation revision", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-rust-owner-revision-"));
  const projectPath = join(rootDir, "workspace");
  const sessionId = "rust-roundtrip";
  try {
    await mkdir(projectPath);
    await persistWorkShellSessionSnapshot({
      cwd: projectPath,
      env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir },
      sessionId,
      model: "test-model",
      mode: "standard",
      state: "paused",
      summary: "durable owner revision",
      traceMode: "minimal",
      ownerMutationRevision: 23,
      entries: [],
    });

    assert.equal(await readRestoredSessionRevision({
      rootDir,
      projectPath,
      sessionId,
      resume: true,
    }), 23);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("owner restart binds the restored revision before initialization persists a replacement checkpoint", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-init-owner-revision-"));
  const projectPath = join(rootDir, "workspace");
  const sessionId = "restart-init";
  try {
    await mkdir(projectPath);
    await persistWorkShellSessionSnapshot({
      cwd: projectPath,
      env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir },
      sessionId,
      model: "test-model",
      mode: "standard",
      state: "running",
      summary: "before crash",
      traceMode: "minimal",
      ownerMutationRevision: 29,
      entries: [],
    });
    const restoredRevision = await readRestoredSessionRevision({
      rootDir, projectPath, sessionId, resume: true,
    });
    let boundClock;
    const engine = {
      bindRuntimeRevisionClock(clock) { boundClock = clock; },
      async initialize() {
        assert.equal(boundClock?.value, 29, "the owner clock must be bound before initialization");
        await persistWorkShellSessionSnapshot({
          cwd: projectPath,
          env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir },
          sessionId,
          model: "test-model",
          mode: "standard",
          state: "idle",
          summary: "after restart",
          traceMode: "minimal",
          ownerMutationRevision: boundClock?.value,
          entries: [],
        });
      },
    };

    const revisionClock = await initializeRestoredRuntimeEngine(engine, restoredRevision);
    assert.equal(revisionClock.value, 29);
    assert.equal(await readRestoredSessionRevision({
      rootDir, projectPath, sessionId, resume: true,
    }), 29, "initialization must not wipe the durable owner revision");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("owner restart recovers the exact admitted revision when a crash precedes the next full checkpoint", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "unclecode-admission-crash-revision-"));
  const projectPath = join(rootDir, "workspace");
  const sessionId = "crash-after-admission";
  try {
    await mkdir(projectPath);
    await persistWorkShellSessionSnapshot({
      cwd: projectPath,
      env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir },
      sessionId,
      model: "test-model",
      mode: "standard",
      state: "running",
      summary: "checkpoint before the admitted mutation",
      traceMode: "minimal",
      ownerMutationRevision: 9,
      entries: [{ role: "assistant", text: "the long execution has not checkpointed yet" }],
    });
    await persistRuntimeAdmissionRevision({ rootDir, projectPath, sessionId, revision: 10 });
    await assert.rejects(
      persistRuntimeAdmissionRevision({ rootDir, projectPath, sessionId, revision: 9 }),
      /cannot regress/i,
    );

    const ledgerStat = await stat(runtimeAdmissionRecordPath(rootDir, { projectPath, sessionId }));
    assert.ok(ledgerStat.size < 256, `the admission record must stay tiny; wrote ${ledgerStat.size} bytes`);
    assert.equal(await readRestoredSessionRevision({
      rootDir,
      projectPath,
      sessionId,
      resume: true,
    }), 10, "restart must prefer the durable admission over the stale full checkpoint");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
