import { createHash } from "node:crypto";
import { constants, watch, type FSWatcher } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const NOTICE_DIRECTORY = "notifications";
const NOTICE_FILE = /^session-[a-f0-9]{20}\.notice\.json$/u;
const SESSION_ID = /^[A-Za-z0-9._-]{1,256}$/u;
const MAX_NOTICE_BYTES = 4 * 1024;
const MAX_NOTICE_FILES = 128;

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

async function readNotice(path: string): Promise<SessionPersistenceNotice | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_NOTICE_BYTES) return undefined;
    const bytes = Buffer.alloc(Number(stat.size));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length) return undefined;
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (
      !isRecord(parsed)
      || parsed.version !== 1
      || typeof parsed.sessionId !== "string"
      || !SESSION_ID.test(parsed.sessionId)
      || basename(path) !== noticeFileName(parsed.sessionId)
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
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
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
  if (!(await isRealDirectory(parentDir))) {
    throw new Error("Session persistence notification parent is unavailable or unsafe.");
  }

  const watchers = new Map<string, FSWatcher>();
  const revisions = new Map<string, number>();
  let stopped = false;
  let scanning = false;
  let rescanRequested = false;

  async function attach(path: string): Promise<void> {
    if (stopped || watchers.has(path) || !(await isRealDirectory(path))) return;
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
    let directory;
    try {
      directory = await opendir(noticeDir);
    } catch {
      return;
    }
    let visited = 0;
    try {
      for await (const entry of directory) {
        if (visited >= MAX_NOTICE_FILES) break;
        visited += 1;
        if (!entry.isFile() || !NOTICE_FILE.test(entry.name)) continue;
        const notice = await readNotice(join(noticeDir, entry.name));
        if (!notice) continue;
        const previous = revisions.get(notice.sessionId) ?? 0;
        if (notice.revision <= previous) continue;
        await input.onNotice(notice);
        revisions.set(notice.sessionId, notice.revision);
      }
    } finally {
      await directory.close().catch(() => undefined);
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
