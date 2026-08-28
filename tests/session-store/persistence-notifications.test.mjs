import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getSessionPersistenceNoticeDir,
  watchSessionPersistenceNotices,
} from "@unclecode/session-store";

function noticeFile(sessionId) {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 20);
  return `session-${digest}.notice.json`;
}

async function writeNotice(rootDir, sessionId, revision) {
  const directory = getSessionPersistenceNoticeDir(rootDir);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, noticeFile(sessionId)),
    JSON.stringify({ version: 1, sessionId, revision }),
    "utf8",
  );
}

async function waitFor(assertion, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return assertion();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

test("notification watcher rescans durable latest revisions and recovers after restart", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "unclecode-notice-watch-"));
  const rootDir = path.join(parent, "sessions");
  const sessionId = "session-notice-1";
  await writeNotice(rootDir, sessionId, 5);
  const first = [];
  const watcher = await watchSessionPersistenceNotices({
    rootDir,
    onNotice(notice) { first.push(notice); },
  });
  try {
    assert.deepEqual(first.map((notice) => notice.revision), [5]);
    await writeNotice(rootDir, sessionId, 7);
    await waitFor(() => assert.deepEqual(first.map((notice) => notice.revision), [5, 7]));
    await writeNotice(rootDir, sessionId, 6);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(first.map((notice) => notice.revision), [5, 7]);
  } finally {
    watcher.stop();
  }

  await writeNotice(rootDir, sessionId, 9);
  const replayed = [];
  const restarted = await watchSessionPersistenceNotices({
    rootDir,
    onNotice(notice) { replayed.push(notice); },
  });
  try {
    assert.deepEqual(replayed, [{ version: 1, sessionId, revision: 9 }]);
  } finally {
    restarted.stop();
    await rm(parent, { recursive: true, force: true });
  }
});

test("notification watcher ignores malformed, oversized, misnamed, and symlink receipts", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "unclecode-notice-bounds-"));
  const rootDir = path.join(parent, "sessions");
  const directory = getSessionPersistenceNoticeDir(rootDir);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "not-a-notice.json"), JSON.stringify({ version: 1, sessionId: "escape", revision: 1 }));
  await writeFile(path.join(directory, noticeFile("malformed")), "{broken");
  await writeFile(path.join(directory, noticeFile("oversized")), "x".repeat(4 * 1024 + 1));
  await writeFile(
    path.join(directory, noticeFile("different-session")),
    JSON.stringify({ version: 1, sessionId: "spoofed-session", revision: 41 }),
  );
  const outside = path.join(parent, "outside.json");
  await writeFile(outside, JSON.stringify({ version: 1, sessionId: "symlinked", revision: 99 }));
  await symlink(outside, path.join(directory, noticeFile("symlinked")));
  await writeNotice(rootDir, "session-good", 3);

  const received = [];
  const watcher = await watchSessionPersistenceNotices({
    rootDir,
    onNotice(notice) { received.push(notice); },
  });
  try {
    assert.deepEqual(received, [{ version: 1, sessionId: "session-good", revision: 3 }]);
  } finally {
    watcher.stop();
    await rm(parent, { recursive: true, force: true });
  }
});

test("notification watcher refuses a symlinked notification directory", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "unclecode-notice-dir-link-"));
  const rootDir = path.join(parent, "sessions");
  const outside = path.join(parent, "outside");
  await mkdir(rootDir, { recursive: true });
  await writeNotice(outside, "outside-session", 17);
  await symlink(getSessionPersistenceNoticeDir(outside), getSessionPersistenceNoticeDir(rootDir));

  const received = [];
  const watcher = await watchSessionPersistenceNotices({
    rootDir,
    onNotice(notice) { received.push(notice); },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(received, []);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(
        getSessionPersistenceNoticeDir(outside),
        noticeFile("outside-session"),
      ), "utf8")),
      { version: 1, sessionId: "outside-session", revision: 17 },
    );
  } finally {
    watcher.stop();
    await rm(parent, { recursive: true, force: true });
  }
});

test("notification watcher refuses a symlinked session root", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "unclecode-notice-root-link-"));
  const outside = path.join(parent, "outside");
  const rootDir = path.join(parent, "sessions");
  await writeNotice(outside, "outside-root-session", 23);
  await symlink(outside, rootDir);

  const received = [];
  const watcher = await watchSessionPersistenceNotices({
    rootDir,
    onNotice(notice) { received.push(notice); },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(received, []);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(
        getSessionPersistenceNoticeDir(outside),
        noticeFile("outside-root-session"),
      ), "utf8")),
      { version: 1, sessionId: "outside-root-session", revision: 23 },
    );
  } finally {
    watcher.stop();
    await rm(parent, { recursive: true, force: true });
  }
});
