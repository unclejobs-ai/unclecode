import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { hostname, platform, uptime } from "node:os";
import { dirname, isAbsolute } from "node:path";

export const RUNTIME_OWNER_PROTOCOL = "unclecode-runtime-owner/1" as const;

export type RuntimeOwnerLease = {
  readonly version: 1;
  readonly protocol: typeof RUNTIME_OWNER_PROTOCOL;
  readonly ownerId: string;
  readonly pid: number;
  readonly bootId: string;
  readonly endpoint: string;
  /** Reference only. The bearer token itself never enters the discovery file. */
  readonly tokenPath: string;
  readonly startedAt: number;
  readonly sessionId?: string | undefined;
  readonly projectPath?: string | undefined;
};

type OwnerLock = { readonly pid: number; readonly bootId: string; readonly claimId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1")
      && url.username === ""
      && url.password === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function currentBootIdentity(): string {
  // Linux exposes an exact boot UUID. The fallback is stable across processes
  // on the same boot (minute rounding absorbs scheduling skew around startup).
  try {
    const value = requireBootId("/proc/sys/kernel/random/boot_id");
    if (value) return value;
  } catch {
    // macOS and other Unix hosts use the monotonic-uptime fallback below.
  }
  const bootMinute = Math.floor((Date.now() - uptime() * 1_000) / 60_000);
  return `${platform()}:${hostname()}:${bootMinute}`;
}

function requireBootId(path: string): string | undefined {
  // Kept synchronous-free at module load: process.getBuiltinModule works in
  // every supported Node version and avoids a top-level asynchronous cache.
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const value = fs.readFileSync(path, "utf8").trim();
  return value.length > 0 ? value : undefined;
}

function parseLease(value: unknown): RuntimeOwnerLease | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== 1
    || value.protocol !== RUNTIME_OWNER_PROTOCOL
    || typeof value.ownerId !== "string"
    || value.ownerId.trim().length === 0
    || typeof value.pid !== "number"
    || !Number.isSafeInteger(value.pid)
    || value.pid <= 0
    || typeof value.bootId !== "string"
    || value.bootId.length === 0
    || typeof value.endpoint !== "string"
    || !isLoopbackEndpoint(value.endpoint)
    || typeof value.tokenPath !== "string"
    || !isAbsolute(value.tokenPath)
    || typeof value.startedAt !== "number"
    || !Number.isFinite(value.startedAt)
  ) return null;
  if (value.sessionId !== undefined && (typeof value.sessionId !== "string" || value.sessionId.length === 0)) return null;
  if (value.projectPath !== undefined && (typeof value.projectPath !== "string" || !isAbsolute(value.projectPath))) return null;
  return value as RuntimeOwnerLease;
}

export async function readRuntimeOwnerLease(path: string): Promise<RuntimeOwnerLease | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) return null;
    return parseLease(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

export async function publishRuntimeOwnerLease(path: string, lease: RuntimeOwnerLease): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

async function isAttachable(
  lease: RuntimeOwnerLease | null,
  bootId: string,
  health: (lease: RuntimeOwnerLease) => Promise<boolean>,
): Promise<boolean> {
  return Boolean(
    lease
    && lease.bootId === bootId
    && isPidAlive(lease.pid)
    && await health(lease).catch(() => false),
  );
}

async function removeDeadLock(lockPath: string, bootId: string): Promise<void> {
  try {
    const value: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (!isRecord(value)) return;
    const lock = value as Partial<OwnerLock>;
    if (lock.bootId !== bootId || !isPidAlive(Number(lock.pid))) {
      await unlink(lockPath).catch(() => undefined);
    }
  } catch {
    // A claimant may still be writing its tiny lock record. Waiters retry
    // rather than deleting an identity they cannot prove stale.
  }
}

export async function ensureRuntimeOwner(input: {
  readonly leasePath: string;
  readonly lockPath: string;
  readonly bootId?: string | undefined;
  readonly health: (lease: RuntimeOwnerLease) => Promise<boolean>;
  readonly startOwner: () => Promise<RuntimeOwnerLease>;
  readonly timeoutMs?: number | undefined;
}): Promise<RuntimeOwnerLease> {
  const bootId = input.bootId ?? currentBootIdentity();
  const deadline = Date.now() + (input.timeoutMs ?? 10_000);
  await mkdir(dirname(input.lockPath), { recursive: true, mode: 0o700 });

  while (Date.now() <= deadline) {
    const existing = await readRuntimeOwnerLease(input.leasePath);
    if (existing && await isAttachable(existing, bootId, input.health)) return existing;

    let lock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      lock = await open(input.lockPath, "wx", 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, bootId, claimId: randomUUID() } satisfies OwnerLock));
      await lock.sync();

      const raced = await readRuntimeOwnerLease(input.leasePath);
      if (raced && await isAttachable(raced, bootId, input.health)) return raced;

      const started = parseLease(await input.startOwner());
      if (!started) throw new Error("Runtime owner returned an incompatible discovery lease.");
      if (started.bootId !== bootId) throw new Error("Runtime owner boot identity does not match this host boot.");
      if (!await input.health(started)) throw new Error("Runtime owner failed its identity health check.");
      await publishRuntimeOwnerLease(input.leasePath, started);
      return started;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeDeadLock(input.lockPath, bootId);
      await new Promise((resolve) => setTimeout(resolve, 5));
    } finally {
      if (lock) {
        await unlink(input.lockPath).catch(() => undefined);
        await lock.close().catch(() => undefined);
      }
    }
  }
  throw new Error("Timed out attaching to the persistent UncleCode runtime owner.");
}
