import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { open as openFile, unlink as unlinkFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LOCK_RETRY_MS = 50;
const LOCK_WAIT_MS = 60_000;
const LOCK_STALE_MS = 5 * 60_000;

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function lockIsStale(lockPath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    const pid = typeof parsed === "object" && parsed !== null && "pid" in parsed ? parsed.pid : undefined;
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
      if (!processIsAlive(pid)) return true;
    }
    return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    try {
      return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

async function acquireLock(filePath: string, label: string): Promise<FileHandle> {
  const lockPath = `${filePath}.lock`;
  mkdirSync(path.dirname(filePath), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    let handle: FileHandle;
    try {
      handle = await openFile(lockPath, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (lockIsStale(lockPath)) {
        throw new Error(
          `The ${label} credential lock is stale: ${lockPath}. Remove it after confirming no ${label} process is refreshing credentials.`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the ${label} credential lock: ${lockPath}`);
      }
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      return handle;
    } catch (error) {
      await handle.close();
      try {
        await unlinkFile(lockPath);
      } catch (unlinkError) {
        if (errorCode(unlinkError) !== "ENOENT") {
          throw new AggregateError([error, unlinkError], `Failed to initialize the ${label} credential lock`);
        }
      }
      throw error;
    }
  }
}

/** Cross-process mutual exclusion on `<filePath>.lock` (O_EXCL create, pid-stamped). */
export async function withCredentialFileLock<T>(filePath: string, label: string, fn: () => Promise<T>): Promise<T> {
  const handle = await acquireLock(filePath, label);
  try {
    return await fn();
  } finally {
    await handle.close();
    try {
      await unlinkFile(`${filePath}.lock`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

/** Write JSON through a mode-600 temp file and rename, so readers never see a partial file. */
export function writeCredentialFileAtomically(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temp file may not have been created or may already have been renamed.
    }
    throw error;
  }
}
