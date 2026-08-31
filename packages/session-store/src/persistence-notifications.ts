import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { runRustCommandSync } from "./rust-command.js";

const NOTICE_DIRECTORY = "notifications";
const NOTICE_FILE = /^session-[a-f0-9]{20}\.notice\.json$/u;
const SESSION_ID = /^[A-Za-z0-9._-]{1,256}$/u;
const MAX_NOTICE_BYTES = 4 * 1024;
const MAX_NOTICE_FILES = 256;

export type SessionPersistenceNotice = {
  readonly version: 1;
  readonly sessionId: string;
  readonly revision: number;
};

export type SessionPersistenceNoticeWatcher = {
  readonly stop: () => void;
};

export function getSessionPersistenceNoticeDir(rootDir: string): string {
  return join(resolve(rootDir), NOTICE_DIRECTORY);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noticeFileName(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 20);
  return `session-${digest}.notice.json`;
}

function readNotice(name: string, contents: string): SessionPersistenceNotice | undefined {
  try {
    if (Buffer.byteLength(contents) < 2 || Buffer.byteLength(contents) > MAX_NOTICE_BYTES) {
      return undefined;
    }
    const parsed = JSON.parse(contents) as unknown;
    if (
      !isRecord(parsed)
      || parsed.version !== 1
      || typeof parsed.sessionId !== "string"
      || !SESSION_ID.test(parsed.sessionId)
      || name !== noticeFileName(parsed.sessionId)
      || !Number.isSafeInteger(parsed.revision)
      || Number(parsed.revision) < 1
    ) {
      return undefined;
    }
    return {
      version: 1,
      sessionId: parsed.sessionId,
      revision: Number(parsed.revision),
    };
  } catch {
    return undefined;
  }
}

function scanNotices(rootDir: string): SessionPersistenceNotice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      runRustCommandSync(
        ["rust", "session", "scan-notices", rootDir],
        process.cwd(),
      ),
    ) as unknown;
  } catch {
    return [];
  }
  const items = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.notices)
      ? parsed.notices
      : undefined;
  if (!items || items.length > MAX_NOTICE_FILES) return [];
  const notices: SessionPersistenceNotice[] = [];
  for (const item of items) {
    if (
      !isRecord(item)
      || typeof item.name !== "string"
      || !NOTICE_FILE.test(item.name)
      || typeof item.contents !== "string"
    ) {
      continue;
    }
    const notice = readNotice(item.name, item.contents);
    if (notice) notices.push(notice);
  }
  return notices;
}

type DirectoryIdentity = {
  readonly device: number | bigint;
  readonly inode: number | bigint;
};

async function realDirectoryIdentity(path: string): Promise<DirectoryIdentity | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    return { device: stat.dev, inode: stat.ino };
  } catch {
    return undefined;
  }
}

/**
 * Watches the Rust persistence owner's durable latest-revision receipts.
 * Every signal triggers a bounded full rescan, so rename coalescing and missed
 * individual notifications cannot lose the authoritative latest revision.
 */
export async function watchSessionPersistenceNotices(input: {
  readonly rootDir: string;
  readonly onNotice: (notice: SessionPersistenceNotice) => void | Promise<void>;
}): Promise<SessionPersistenceNoticeWatcher> {
  const rootDir = resolve(input.rootDir);
  const parentDir = dirname(rootDir);
  const noticeDir = getSessionPersistenceNoticeDir(rootDir);
  if (!(await realDirectoryIdentity(parentDir))) {
    throw new Error("Session persistence notification parent is unavailable or unsafe.");
  }

  const watchers = new Map<string, FSWatcher>();
  const revisions = new Map<string, number>();
  let stopped = false;
  let scanning = false;
  let rescanRequested = false;

  async function attach(path: string): Promise<void> {
    if (stopped || watchers.has(path) || !(await realDirectoryIdentity(path))) return;
    const watcher = watch(path, { persistent: true }, () => {
      void scheduleScan();
    });
    watcher.on("error", () => {
      watcher.close();
      watchers.delete(path);
      void scheduleScan();
    });
    watchers.set(path, watcher);
  }

  async function scan(): Promise<void> {
    await attach(rootDir);
    await attach(noticeDir);
    // The Rust owner opens the root and notification directory with O_NOFOLLOW,
    // enumerates the stable directory descriptor, and opens every receipt with
    // openat(O_NOFOLLOW). Unsupported platforms and unsafe paths fail closed.
    for (const notice of scanNotices(rootDir)) {
      const previous = revisions.get(notice.sessionId) ?? 0;
      if (notice.revision <= previous) continue;
      await input.onNotice(notice);
      revisions.set(notice.sessionId, notice.revision);
    }
  }

  async function scheduleScan(): Promise<void> {
    if (stopped) return;
    rescanRequested = true;
    if (scanning) return;
    scanning = true;
    try {
      while (rescanRequested && !stopped) {
        rescanRequested = false;
        await scan();
      }
    } finally {
      scanning = false;
    }
  }

  await attach(parentDir);
  await scheduleScan();
  return {
    stop() {
      stopped = true;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
