import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const ADMISSION_RECORD_VERSION = 1;
const MAX_ADMISSION_RECORD_BYTES = 1_024;

// Legacy bootstrap only: this bounded atomic record carries the accepted
// session revision across owner crashes. It intentionally contains no
// idempotency receipts; the owner-opened Task 10 ledger is their durable truth
// and can migrate this record with max(checkpoint, admission revision).

export type RuntimeAdmissionRef = {
  readonly projectPath: string;
  readonly sessionId: string;
};

export type RuntimeAdmissionReservation = {
  readonly revision: number;
  readonly bytes: number;
};

type RuntimeAdmissionRecord = {
  readonly version: typeof ADMISSION_RECORD_VERSION;
  readonly kind: "revision_reserved";
  readonly sessionKey: string;
  readonly revision: number;
};

function sessionKey(ref: RuntimeAdmissionRef): string {
  return createHash("sha256")
    .update(ref.projectPath)
    .update("\0")
    .update(ref.sessionId)
    .digest("hex");
}

function admissionDirectory(rootDir: string): string {
  return join(rootDir, "runtime-owner-v1", "admissions");
}

export function runtimeAdmissionRecordPath(rootDir: string, ref: RuntimeAdmissionRef): string {
  return join(admissionDirectory(rootDir), `${sessionKey(ref)}.json`);
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseRecord(value: unknown, expectedSessionKey: string): RuntimeAdmissionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return record.version === ADMISSION_RECORD_VERSION
    && record.kind === "revision_reserved"
    && record.sessionKey === expectedSessionKey
    && validRevision(record.revision)
    ? record as RuntimeAdmissionRecord
    : undefined;
}

async function statRegularFile(path: string): Promise<Stats | undefined> {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink() ? stat : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readRuntimeAdmissionRevision(input: {
  readonly rootDir: string;
} & RuntimeAdmissionRef): Promise<number> {
  const path = runtimeAdmissionRecordPath(input.rootDir, input);
  const stat = await statRegularFile(path);
  if (!stat || stat.size > MAX_ADMISSION_RECORD_BYTES) return 0;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parseRecord(parsed, sessionKey(input))?.revision ?? 0;
  } catch {
    return 0;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function persistRuntimeAdmissionRevision(input: {
  readonly rootDir: string;
  readonly revision: number;
  readonly signal?: AbortSignal | undefined;
} & RuntimeAdmissionRef): Promise<RuntimeAdmissionReservation> {
  if (!validRevision(input.revision)) throw new TypeError("Runtime admission revision must be a non-negative safe integer.");
  input.signal?.throwIfAborted();
  const directory = admissionDirectory(input.rootDir);
  const targetPath = runtimeAdmissionRecordPath(input.rootDir, input);
  const currentRevision = await readRuntimeAdmissionRevision(input);
  if (input.revision < currentRevision) {
    throw new Error(`Runtime admission revision cannot regress from ${currentRevision} to ${input.revision}.`);
  }
  if (input.revision === currentRevision) {
    const existing = await statRegularFile(targetPath);
    if (existing) return { revision: currentRevision, bytes: existing.size };
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  input.signal?.throwIfAborted();
  const key = sessionKey(input);
  const temporaryPath = join(directory, `.${key}.${process.pid}.${randomUUID()}.tmp`);
  const body = `${JSON.stringify({
    version: ADMISSION_RECORD_VERSION,
    kind: "revision_reserved",
    sessionKey: key,
    revision: input.revision,
  } satisfies RuntimeAdmissionRecord)}\n`;
  const bytes = Buffer.byteLength(body);
  const file = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await file.writeFile(body, "utf8");
    await file.sync();
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await file.close();
  try {
    // Timeout aborts fence a late writer before the only operation that can
    // replace the durable revision. This prevents an old timed-out write from
    // regressing a newer admission after the arbiter releases its tail.
    input.signal?.throwIfAborted();
    await rename(temporaryPath, targetPath);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return { revision: input.revision, bytes };
}
