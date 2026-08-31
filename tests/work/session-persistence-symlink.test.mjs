import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { persistWorkShellSessionSnapshot } from "@unclecode/orchestrator";
import { watchSessionPersistenceNotices } from "@unclecode/session-store";

function opaqueId(value, prefix) {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function projectDirectory(sessionStoreRoot, workspaceRoot) {
  return path.join(sessionStoreRoot, "projects", opaqueId(realpathSync(workspaceRoot), "project"));
}

function persist(workspaceRoot, sessionStoreRoot, sessionId) {
  return persistWorkShellSessionSnapshot({
    cwd: workspaceRoot,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
    sessionId,
    model: "gpt-5.6-sol",
    mode: "build",
    state: "idle",
    summary: "Persist safely",
    entries: [],
  });
}

async function assertOutsideUnchanged(outside) {
  assert.equal(await readFile(path.join(outside, "sentinel.txt"), "utf8"), "keep\n");
  assert.deepEqual(await readdir(outside), ["sentinel.txt"]);
}

async function waitForFifoReader(fifo, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      if (error.code !== "ENXIO" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

test("actual Work Shell persistence refuses a symlinked session root", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "unclecode-session-root-link-"));
  const workspaceRoot = path.join(parent, "workspace");
  const sessionStoreRoot = path.join(parent, "state");
  const outside = path.join(parent, "outside");
  await mkdir(workspaceRoot);
  await mkdir(outside);
  await writeFile(path.join(outside, "sentinel.txt"), "keep\n");
  await symlink(outside, sessionStoreRoot);
  try {
    await assert.rejects(
      persist(workspaceRoot, sessionStoreRoot, "root-link-session"),
      /symbolic-link|symlink|unsafe|refus/iu,
    );
    await assertOutsideUnchanged(outside);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("actual Work Shell persistence refuses a symlinked notification directory", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "unclecode-session-notice-link-"));
  const workspaceRoot = path.join(parent, "workspace");
  const sessionStoreRoot = path.join(parent, "state");
  const outside = path.join(parent, "outside");
  await mkdir(workspaceRoot);
  await mkdir(sessionStoreRoot);
  await mkdir(outside);
  await writeFile(path.join(outside, "sentinel.txt"), "keep\n");
  await symlink(outside, path.join(sessionStoreRoot, "notifications"));
  try {
    await assert.rejects(
      persist(workspaceRoot, sessionStoreRoot, "notice-link-session"),
      /symbolic-link|symlink|unsafe|refus/iu,
    );
    await assertOutsideUnchanged(outside);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("actual Work Shell persistence refuses a nested sessions-directory symlink", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "unclecode-session-nested-link-"));
  const workspaceRoot = path.join(parent, "workspace");
  const sessionStoreRoot = path.join(parent, "state");
  const outside = path.join(parent, "outside");
  await mkdir(workspaceRoot);
  await mkdir(projectDirectory(sessionStoreRoot, workspaceRoot), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, "sentinel.txt"), "keep\n");
  await symlink(outside, path.join(projectDirectory(sessionStoreRoot, workspaceRoot), "sessions"));
  try {
    await assert.rejects(
      persist(workspaceRoot, sessionStoreRoot, "nested-link-session"),
      /symbolic-link|symlink|unsafe|refus/iu,
    );
    await assertOutsideUnchanged(outside);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("actual Work Shell persistence cannot be redirected by a sessions-directory swap", {
  skip: process.platform === "win32" ? "requires a Unix FIFO race barrier" : false,
}, async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "unclecode-session-swap-"));
  const workspaceRoot = path.join(parent, "workspace");
  const sessionStoreRoot = path.join(parent, "state");
  const outside = path.join(parent, "outside");
  const sessionId = "directory-swap-session";
  await mkdir(workspaceRoot);
  await mkdir(outside);
  await writeFile(path.join(outside, "sentinel.txt"), "keep\n");
  await persist(workspaceRoot, sessionStoreRoot, sessionId);

  const sessionDirectory = path.join(projectDirectory(sessionStoreRoot, workspaceRoot), "sessions");
  const parkedDirectory = `${sessionDirectory}.parked`;
  const eventLog = path.join(sessionDirectory, `${opaqueId(sessionId, "session")}.events.jsonl`);
  await rm(eventLog);
  execFileSync("mkfifo", [eventLog]);
  const received = [];
  const watcher = await watchSessionPersistenceNotices({
    rootDir: sessionStoreRoot,
    onNotice(notice) { received.push(notice); },
  });
  let fifoWriter;
  try {
    assert.deepEqual(received.map((notice) => notice.revision), [4]);
    // Attach the rejection assertion before releasing the FIFO barrier. The
    // hardened persistence path rejects the non-file event log immediately
    // after the writer connects, before this test can complete the directory
    // swap and attach a later rejection handler.
    const rejected = assert.rejects(
      persist(workspaceRoot, sessionStoreRoot, sessionId),
      /symbolic-link|symlink|unsafe|refus/iu,
    );
    fifoWriter = await waitForFifoReader(eventLog);
    await rename(sessionDirectory, parkedDirectory);
    await symlink(outside, sessionDirectory);
    // Closing the connected writer releases either implementation shape: the
    // current regular-file check has already rejected the FIFO, while a reader
    // waiting for bytes observes EOF without a racy EPIPE write.
    await fifoWriter.close();
    fifoWriter = undefined;

    await rejected;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(received.map((notice) => notice.revision), [4]);
    await assertOutsideUnchanged(outside);
  } finally {
    await fifoWriter?.close().catch(() => undefined);
    watcher.stop();
    await rm(parent, { recursive: true, force: true });
  }
});
