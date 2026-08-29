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
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

type OwnerLock = {
  readonly pid: number;
  readonly bootId: string;
  readonly claimId: string;
  readonly processStartId: string;
  readonly claimedAt: number;
};

const execFileAsync = promisify(execFile);
const LOCK_WRITE_GRACE_MS = 250;

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

export async function processStartIdentity(pid: number): Promise<string | null> {
  if (!isPidAlive(pid)) return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(/\s+/);
    const startTicks = fields[19];
    if (startTicks) return `proc:${startTicks}`;
  } catch {}
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="]);
    const started = stdout.trim().replace(/\s+/g, " ");
    return started ? `ps:${started}` : null;
  } catch {
    return null;
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
    await handle.close();
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
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

async function removeDeadLock(
  lockPath: string,
  bootId: string,
  identity: (pid: number) => Promise<string | null>,
  now: number,
): Promise<void> {
  try {
    const stat = await lstat(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    const ageMs = Math.max(0, now - stat.mtimeMs);
    let raw: string;
    try {
      raw = await readFile(lockPath, "utf8");
    } catch {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      if (ageMs >= LOCK_WRITE_GRACE_MS) await unlinkLockIfUnchanged(lockPath, stat, raw);
      return;
    }
    if (!isRecord(value)) {
      if (ageMs >= LOCK_WRITE_GRACE_MS) await unlinkLockIfUnchanged(lockPath, stat, raw);
      return;
    }
    const lock = value as Partial<OwnerLock>;
    const validShape = Number.isSafeInteger(lock.pid)
      && Number(lock.pid) > 0
      && typeof lock.claimId === "string"
      && lock.claimId.length > 0
      && typeof lock.processStartId === "string"
      && lock.processStartId.length > 0
      && typeof lock.claimedAt === "number"
      && Number.isFinite(lock.claimedAt);
    const actualStartId = validShape ? await identity(Number(lock.pid)) : null;
    if (
      !validShape
      || lock.bootId !== bootId
      || actualStartId === null
      || actualStartId !== lock.processStartId
    ) {
      await unlinkLockIfUnchanged(lockPath, stat, raw);
    }
  } catch {
    // The next bounded retry revalidates the lock identity.
  }
}

async function unlinkLockIfUnchanged(
  lockPath: string,
  observedStat: Awaited<ReturnType<typeof lstat>>,
  observedRaw: string,
): Promise<void> {
  try {
    const currentStat = await lstat(lockPath);
    if (
      !currentStat.isFile()
      || currentStat.isSymbolicLink()
      || currentStat.dev !== observedStat.dev
      || currentStat.ino !== observedStat.ino
      || await readFile(lockPath, "utf8") !== observedRaw
    ) return;
    await unlink(lockPath);
  } catch {
    // Another claimant changed or removed the path. Its claim wins.
  }
}

export async function ensureRuntimeOwner(input: {
  readonly leasePath: string;
  readonly lockPath: string;
  readonly bootId?: string | undefined;
  readonly health: (lease: RuntimeOwnerLease) => Promise<boolean>;
  readonly startOwner: () => Promise<RuntimeOwnerLease>;
  readonly timeoutMs?: number | undefined;
  readonly resolveProcessStartIdentity?: ((pid: number) => Promise<string | null>) | undefined;
}): Promise<RuntimeOwnerLease> {
  const bootId = input.bootId ?? currentBootIdentity();
  // A first caller can cold-start the full owner graph while every concurrent
  // caller waits on its atomic claim. Bound that wait above the launcher's
  // own startup window so a follower cannot time out before the claimant.
  const deadline = Date.now() + (input.timeoutMs ?? 75_000);
  await mkdir(dirname(input.lockPath), { recursive: true, mode: 0o700 });
  const resolveIdentity = input.resolveProcessStartIdentity ?? processStartIdentity;
  const claimantStartId = await resolveIdentity(process.pid);
  if (!claimantStartId) throw new Error("Cannot establish the runtime owner claimant process identity.");

  while (Date.now() <= deadline) {
    const existing = await readRuntimeOwnerLease(input.leasePath);
    if (existing && await isAttachable(existing, bootId, input.health)) return existing;

    let lock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      lock = await open(input.lockPath, "wx", 0o600);
      await lock.writeFile(JSON.stringify({
        pid: process.pid,
        bootId,
        claimId: randomUUID(),
        processStartId: claimantStartId,
        claimedAt: Date.now(),
      } satisfies OwnerLock));
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
      await removeDeadLock(input.lockPath, bootId, resolveIdentity, Date.now());
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
