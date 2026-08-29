import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  opendir,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type {
  QualityGateStatus,
  QualityHarnessStage,
  QualityProfile,
} from "@unclecode/contracts";

const MAX_FILES = 1_024;
const MAX_DIRECTORIES = 2_048;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 65_536;
const READ_CHUNK_BYTES = 64 * 1024;
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

type JsonRecord = Record<string, unknown>;

export type SccV3ImportWarning = {
  readonly code: "orphan_artifact";
  readonly runId?: string;
  readonly message: string;
};

export type SccV3ImportReceiptPlan = {
  readonly schema: "unclecode.scc-v3-import-receipt/v1";
  readonly store: "agentops-db";
  readonly target: string;
  readonly idempotencyKey: string;
  readonly sourceFingerprint: string;
  readonly onExisting: "skip-identical";
  readonly onCollision: "reject";
};

export type SccV3ArtifactPlan = {
  readonly source: string;
  readonly target: string;
  readonly bytes: number;
  readonly sha256: string;
};

export type SccV3PlannedRecord = {
  readonly store: "session-store" | "agentops-db";
  readonly record:
    | "checkpoint"
    | "event-summary"
    | "run"
    | "artifact-index"
    | "verification";
  readonly target: string;
  readonly count: number;
};

export type SccV3ImportRunPlan = {
  readonly runId: string;
  readonly status: "active" | "completed";
  readonly quality: {
    readonly profile: QualityProfile;
    readonly currentStage: QualityHarnessStage;
    readonly gateStatus: QualityGateStatus;
    readonly iteration: number;
    readonly refineCount: number;
    readonly pivotCount: number;
    readonly independentVerification: boolean;
  };
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly artifacts: readonly SccV3ArtifactPlan[];
  readonly plannedRecords: readonly SccV3PlannedRecord[];
};

export type SccV3ImportReport = {
  readonly schema: "unclecode.scc-v3-import-plan/v1";
  readonly mode: "dry-run";
  readonly source: ".data";
  readonly destination: ".unclecode";
  readonly receipt: SccV3ImportReceiptPlan;
  readonly sourceFingerprintBefore: string;
  readonly sourceFingerprintAfter: string;
  readonly sourceUnchanged: boolean;
  readonly scanned: {
    readonly files: number;
    readonly directories: number;
    readonly bytes: number;
  };
  readonly runs: readonly SccV3ImportRunPlan[];
  readonly warnings: readonly SccV3ImportWarning[];
};

export type PlanSccV3ImportOptions = {
  readonly sourceRoot: string;
  readonly workspaceRoot: string;
};

type ScannedFile = {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
};

type TreeSnapshot = {
  readonly files: readonly ScannedFile[];
  readonly directories: number;
  readonly bytes: number;
  readonly fingerprint: string;
};

type MutableRun = {
  runId: string;
  state?: JsonRecord;
  stateSha256?: string;
  status: "active" | "completed";
  eventCount: number;
  eventCounts: Map<string, number>;
  artifactPaths: Set<string>;
};

type RecordBudget = { count: number };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(record: JsonRecord | undefined, key: string): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function stringField(
  record: JsonRecord | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validateRunId(value: unknown, origin: string): string {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    throw new Error(`Invalid SCC v3 run id in ${origin}.`);
  }
  return value;
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

function consumeRecord(budget: RecordBudget): void {
  budget.count += 1;
  if (budget.count > MAX_RECORDS) {
    throw new Error(
      `SCC v3 source exceeds the ${MAX_RECORDS} record dry-run limit.`,
    );
  }
}

function noFollowFlags(): number {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
}

async function openNoFollow(absolutePath: string): Promise<FileHandle> {
  try {
    return await open(absolutePath, noFollowFlags());
  } catch (error) {
    if (
      isRecord(error) &&
      (error.code === "ELOOP" || error.code === "EMLINK")
    ) {
      throw new Error("SCC v3 dry-run refuses symbolic links in .data.");
    }
    throw error;
  }
}

async function hashRegularFile(
  absolutePath: string,
): Promise<{ bytes: number; sha256: string }> {
  const handle = await openNoFollow(absolutePath);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(
        "SCC v3 dry-run supports regular files and directories only.",
      );
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(
        `SCC v3 source contains a file larger than ${MAX_FILE_BYTES} bytes.`,
      );
    }
    const hash = createHash("sha256");
    let bytes = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAX_FILE_BYTES) {
        throw new Error(
          `SCC v3 source contains a file larger than ${MAX_FILE_BYTES} bytes.`,
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function readScannedFile(file: ScannedFile): Promise<Buffer> {
  const handle = await openNoFollow(file.absolutePath);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      throw new Error(
        `SCC v3 source changed during dry-run: ${file.relativePath}.`,
      );
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAX_FILE_BYTES) {
        throw new Error(
          `SCC v3 source changed during dry-run: ${file.relativePath}.`,
        );
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const content = Buffer.concat(chunks, bytes);
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (bytes !== file.bytes || sha256 !== file.sha256) {
      throw new Error(
        `SCC v3 source changed during dry-run: ${file.relativePath}.`,
      );
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function scanTree(sourceRoot: string): Promise<TreeSnapshot> {
  const files: ScannedFile[] = [];
  let directories = 0;
  let bytes = 0;

  const pendingDirectories = [sourceRoot];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    if (!directory) break;
    directories += 1;
    if (directories > MAX_DIRECTORIES) {
      throw new Error(
        `SCC v3 source exceeds the ${MAX_DIRECTORIES} directory dry-run limit.`,
      );
    }
    const directoryStat = await lstat(directory);
    if (directoryStat.isSymbolicLink()) {
      throw new Error("SCC v3 dry-run refuses symbolic links in .data.");
    }
    if (!directoryStat.isDirectory()) {
      throw new Error(
        "SCC v3 dry-run supports regular files and directories only.",
      );
    }
    const directoryHandle = await opendir(directory);
    try {
      while (true) {
        const entry = await directoryHandle.read();
        if (entry === null) break;
        const absolutePath = resolve(directory, entry.name);
        if (!isContained(sourceRoot, absolutePath)) {
          throw new Error("SCC v3 source entry escapes .data containment.");
        }
        if (entry.isSymbolicLink()) {
          throw new Error("SCC v3 dry-run refuses symbolic links in .data.");
        }
        if (entry.isDirectory()) {
          if (directories + pendingDirectories.length >= MAX_DIRECTORIES) {
            throw new Error(
              `SCC v3 source exceeds the ${MAX_DIRECTORIES} directory dry-run limit.`,
            );
          }
          pendingDirectories.push(absolutePath);
          continue;
        }
        if (!entry.isFile()) {
          throw new Error(
            "SCC v3 dry-run supports regular files and directories only.",
          );
        }
        if (files.length >= MAX_FILES) {
          throw new Error(
            `SCC v3 source exceeds the ${MAX_FILES} file dry-run limit.`,
          );
        }
        const hashed = await hashRegularFile(absolutePath);
        bytes += hashed.bytes;
        if (bytes > MAX_TOTAL_BYTES) {
          throw new Error(
            `SCC v3 source exceeds the ${MAX_TOTAL_BYTES} byte dry-run limit.`,
          );
        }
        files.push({
          absolutePath,
          relativePath: relative(sourceRoot, absolutePath).split(sep).join("/"),
          bytes: hashed.bytes,
          sha256: hashed.sha256,
        });
      }
    } finally {
      await directoryHandle.close().catch(() => undefined);
    }
  }
  files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const fingerprint = createHash("sha256")
    .update(
      files
        .map((file) => `${file.relativePath}\0${file.bytes}\0${file.sha256}`)
        .join("\n"),
    )
    .digest("hex");
  return { files, directories, bytes, fingerprint };
}

async function readJson(
  file: ScannedFile,
  budget: RecordBudget,
): Promise<JsonRecord> {
  const text = (await readScannedFile(file)).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Malformed SCC v3 JSON record: ${file.relativePath}.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `SCC v3 JSON record must be an object: ${file.relativePath}.`,
    );
  }
  consumeRecord(budget);
  return parsed;
}

async function visitJsonLines(
  file: ScannedFile,
  budget: RecordBudget,
  visit: (record: JsonRecord) => void,
): Promise<void> {
  const text = (await readScannedFile(file)).toString("utf8");
  let lineStart = 0;
  let lineNumber = 0;
  for (let cursor = 0; cursor <= text.length; cursor += 1) {
    if (cursor < text.length && text.charCodeAt(cursor) !== 10) continue;
    lineNumber += 1;
    const lineEnd =
      cursor > lineStart && text.charCodeAt(cursor - 1) === 13
        ? cursor - 1
        : cursor;
    const line = text.slice(lineStart, lineEnd);
    lineStart = cursor + 1;
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(
        `Malformed SCC v3 JSONL record: ${file.relativePath}:${lineNumber}.`,
      );
    }
    if (!isRecord(parsed)) {
      throw new Error(
        `SCC v3 JSONL record must be an object: ${file.relativePath}:${lineNumber}.`,
      );
    }
    consumeRecord(budget);
    visit(parsed);
  }
}

function validateOptionalNonNegativeInteger(
  record: JsonRecord,
  key: string,
  origin: string,
): void {
  const value = record[key];
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `SCC v3 ${key} must be a non-negative integer in ${origin}.`,
    );
  }
}

function validateState(state: JsonRecord, origin: string): void {
  for (const key of [
    "cycle_count",
    "max_cycles",
    "reviewer_count",
    "refine_count",
    "pivot_count",
    "critical_count",
  ]) {
    validateOptionalNonNegativeInteger(state, key, origin);
  }
  const phase = state.current_phase;
  if (
    phase !== undefined &&
    (typeof phase !== "string" ||
      !["plan", "do", "check", "act"].includes(phase.toLowerCase()))
  ) {
    throw new Error(`SCC v3 current_phase is invalid in ${origin}.`);
  }
  for (const key of ["domain", "check_verdict", "ended_at"]) {
    const value = state[key];
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`SCC v3 ${key} must be a string in ${origin}.`);
    }
  }
  if (state.artifacts !== undefined) {
    if (!isRecord(state.artifacts)) {
      throw new Error(`SCC v3 artifacts must be an object in ${origin}.`);
    }
    for (const value of Object.values(state.artifacts)) {
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(
          `SCC v3 artifact references must be non-empty strings in ${origin}.`,
        );
      }
    }
  }
}

function stageFor(state: JsonRecord | undefined): QualityHarnessStage {
  switch (stringField(state, "current_phase")?.toLowerCase()) {
    case "plan":
      return "plan";
    case "do":
      return "work";
    case "check":
      return "critic";
    case "act":
      return "promote";
    default:
      return "explore";
  }
}

function independentVerification(state: JsonRecord | undefined): boolean {
  return numberField(state, "reviewer_count") > 0;
}

function gateFor(state: JsonRecord | undefined): QualityGateStatus {
  const stage = stageFor(state);
  const independentlyReviewed = independentVerification(state);
  if ((stage === "critic" || stage === "promote") && !independentlyReviewed)
    return "unproven";
  if (numberField(state, "critical_count") > 0) return "block";
  const verdict = stringField(state, "check_verdict")?.toUpperCase();
  if (verdict === "PASS" || verdict === "APPROVED" || verdict === "PROCEED")
    return "proceed";
  if (verdict === "NEEDS_IMPROVEMENT" || verdict === "REFINE") return "refine";
  if (verdict === "PIVOT" || verdict === "PLAN_DEFECT") return "pivot";
  if (verdict === "BLOCK" || verdict === "FAIL" || verdict === "REJECTED")
    return "block";
  return stage === "critic" || stage === "promote" ? "unproven" : "proceed";
}

function profileFor(state: JsonRecord | undefined): QualityProfile {
  const domain = stringField(state, "domain")?.toLowerCase();
  if (
    domain === "creator" ||
    domain === "harness" ||
    domain === "skill" ||
    domain === "prompt"
  )
    return "creator";
  if (
    numberField(state, "max_cycles") >= 4 ||
    numberField(state, "reviewer_count") >= 3
  )
    return "deep";
  return "standard";
}

function resolveLegacyArtifact(sourceRoot: string, reference: string): string {
  const normalized = reference.replaceAll("\\", "/");
  if (
    isAbsolute(reference) ||
    /^[a-zA-Z]:\//u.test(normalized) ||
    normalized.startsWith("//")
  ) {
    const absolute = resolve(reference);
    if (!isContained(sourceRoot, absolute)) {
      throw new Error("SCC v3 artifact reference escapes .data containment.");
    }
    return absolute;
  }
  const withoutDataPrefix = normalized.startsWith(".data/")
    ? normalized.slice(".data/".length)
    : normalized;
  const candidate = resolve(sourceRoot, withoutDataPrefix);
  if (!isContained(sourceRoot, candidate)) {
    throw new Error("SCC v3 artifact reference escapes .data containment.");
  }
  return candidate;
}

function sortedEventCounts(
  counts: ReadonlyMap<string, number>,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function artifactTarget(runId: string, sourcePath: string): string {
  return `.unclecode/artifacts/${runId}/${sourcePath}`;
}

function receiptFor(sourceFingerprint: string): SccV3ImportReceiptPlan {
  const digest = createHash("sha256")
    .update("unclecode.scc-v3-import-receipt/v1\0")
    .update(sourceFingerprint)
    .digest("hex");
  return {
    schema: "unclecode.scc-v3-import-receipt/v1",
    store: "agentops-db",
    target: `migration:scc-v3:${digest}`,
    idempotencyKey: `scc-v3:${digest}`,
    sourceFingerprint,
    onExisting: "skip-identical",
    onCollision: "reject",
  };
}

function assertNoTargetCollisions(runs: readonly SccV3ImportRunPlan[]): void {
  const targets = new Map<string, string>();
  const register = (namespace: string, target: string, owner: string): void => {
    const key = `${namespace}\0${target.normalize("NFC").toLowerCase()}`;
    const existing = targets.get(key);
    if (existing && existing !== owner) {
      throw new Error(
        `SCC v3 import target collision between ${existing} and ${owner}.`,
      );
    }
    targets.set(key, owner);
  };
  for (const run of runs) {
    for (const record of run.plannedRecords) {
      register(record.store, record.target, run.runId);
    }
    for (const artifact of run.artifacts) {
      register("artifact", artifact.target, `${run.runId}:${artifact.source}`);
    }
  }
}

/**
 * Inspect an SCC v3 `.data` tree and return the records UncleCode would create.
 * This API intentionally has no apply mode and performs no destination writes.
 */
export async function planSccV3Import(
  options: PlanSccV3ImportOptions,
): Promise<SccV3ImportReport> {
  const requestedSource = resolve(options.sourceRoot);
  const sourceStat = await lstat(requestedSource);
  if (sourceStat.isSymbolicLink())
    throw new Error("SCC v3 dry-run refuses a symbolic link source root.");
  if (!sourceStat.isDirectory())
    throw new Error("SCC v3 source root must be a directory.");
  const sourceRoot = await realpath(requestedSource);
  const workspaceRoot = resolve(options.workspaceRoot);
  if (sourceRoot === workspaceRoot || isContained(sourceRoot, workspaceRoot)) {
    throw new Error(
      "UncleCode workspace destination cannot be inside the SCC v3 .data source.",
    );
  }

  const before = await scanTree(sourceRoot);
  const filesByPath = new Map(
    before.files.map((file) => [file.relativePath, file]),
  );
  const runs = new Map<string, MutableRun>();
  const warnings: SccV3ImportWarning[] = [];
  const recordBudget: RecordBudget = { count: 0 };

  function getRun(runId: string): MutableRun {
    const existing = runs.get(runId);
    if (existing) return existing;
    const created: MutableRun = {
      runId,
      status: "active",
      eventCount: 0,
      eventCounts: new Map(),
      artifactPaths: new Set(),
    };
    runs.set(runId, created);
    return created;
  }

  for (const file of before.files) {
    if (
      !/^state\/pdca-(?:active|last-completed)\.json$/u.test(file.relativePath)
    )
      continue;
    const state = await readJson(file, recordBudget);
    const runId = validateRunId(state.run_id, file.relativePath);
    validateState(state, file.relativePath);
    const run = getRun(runId);
    if (run.stateSha256 && run.stateSha256 !== file.sha256) {
      throw new Error(`Conflicting state records map to SCC v3 run ${runId}.`);
    }
    run.state = state;
    run.stateSha256 = file.sha256;
    if (
      file.relativePath.endsWith("last-completed.json") ||
      stringField(state, "ended_at")
    )
      run.status = "completed";
    const artifactMap = isRecord(state.artifacts) ? state.artifacts : {};
    for (const reference of Object.values(artifactMap)) {
      if (typeof reference !== "string" || reference.length === 0) {
        throw new Error(
          `SCC v3 artifact references must be non-empty strings in ${file.relativePath}.`,
        );
      }
      const absolute = resolveLegacyArtifact(sourceRoot, reference);
      const relativeArtifactPath = relative(sourceRoot, absolute)
        .split(sep)
        .join("/");
      const artifactFile = filesByPath.get(relativeArtifactPath);
      if (!artifactFile) {
        throw new Error(
          `SCC v3 artifact reference does not identify a scanned regular file in ${file.relativePath}.`,
        );
      }
      run.artifactPaths.add(artifactFile.relativePath);
    }
  }

  for (const file of before.files) {
    if (
      !file.relativePath.startsWith("events/") ||
      !file.relativePath.endsWith(".jsonl")
    )
      continue;
    await visitJsonLines(file, recordBudget, (event) => {
      const runId = validateRunId(event.run_id, file.relativePath);
      const type = event.type;
      if (typeof type !== "string" || type.length === 0) {
        throw new Error(
          `SCC v3 event type must be a non-empty string in ${file.relativePath}.`,
        );
      }
      const run = getRun(runId);
      run.eventCount += 1;
      run.eventCounts.set(type, (run.eventCounts.get(type) ?? 0) + 1);
    });
  }

  const metricsByDirectory = new Map<string, string>();
  for (const file of before.files) {
    if (!/^cycles\/[^/]+\/metrics\.json$/u.test(file.relativePath)) continue;
    const metrics = await readJson(file, recordBudget);
    const runId = validateRunId(metrics.run_id, file.relativePath);
    getRun(runId);
    metricsByDirectory.set(dirname(file.relativePath), runId);
  }
  for (const file of before.files) {
    if (
      !file.relativePath.startsWith("cycles/") ||
      !/\.(?:md|json)$/u.test(file.relativePath)
    )
      continue;
    const runId = metricsByDirectory.get(dirname(file.relativePath));
    if (runId) {
      getRun(runId).artifactPaths.add(file.relativePath);
    } else if (runs.size === 1) {
      [...runs.values()][0]?.artifactPaths.add(file.relativePath);
    } else {
      warnings.push({
        code: "orphan_artifact",
        message:
          "A cycle artifact without a run identifier was omitted from the dry-run plan.",
      });
    }
  }

  const runPlans = [...runs.values()]
    .sort((left, right) => left.runId.localeCompare(right.runId))
    .map((run): SccV3ImportRunPlan => {
      const artifacts = [...run.artifactPaths]
        .sort((left, right) => left.localeCompare(right))
        .flatMap((path): SccV3ArtifactPlan[] => {
          const file = filesByPath.get(path);
          return file
            ? [
                {
                  source: path,
                  target: artifactTarget(run.runId, path),
                  bytes: file.bytes,
                  sha256: file.sha256,
                },
              ]
            : [];
        });
      const independentlyReviewed = independentVerification(run.state);
      return {
        runId: run.runId,
        status: run.status,
        quality: {
          profile: profileFor(run.state),
          currentStage: stageFor(run.state),
          gateStatus: gateFor(run.state),
          iteration: Math.max(1, numberField(run.state, "cycle_count")),
          refineCount: numberField(run.state, "refine_count"),
          pivotCount: numberField(run.state, "pivot_count"),
          independentVerification: independentlyReviewed,
        },
        eventCounts: sortedEventCounts(run.eventCounts),
        artifacts,
        plannedRecords: [
          {
            store: "session-store",
            record: "checkpoint",
            target: `session:${run.runId}`,
            count: 1,
          },
          {
            store: "session-store",
            record: "event-summary",
            target: `session:${run.runId}:events`,
            count: run.eventCount,
          },
          {
            store: "agentops-db",
            record: "run",
            target: `run:${run.runId}`,
            count: 1,
          },
          {
            store: "agentops-db",
            record: "artifact-index",
            target: `run:${run.runId}:artifacts`,
            count: artifacts.length,
          },
          {
            store: "agentops-db",
            record: "verification",
            target: `run:${run.runId}:quality`,
            count: independentlyReviewed ? 1 : 0,
          },
        ],
      };
    });

  assertNoTargetCollisions(runPlans);

  const after = await scanTree(sourceRoot);
  if (before.fingerprint !== after.fingerprint) {
    throw new Error("SCC v3 source changed during dry-run.");
  }
  return {
    schema: "unclecode.scc-v3-import-plan/v1",
    mode: "dry-run",
    source: ".data",
    destination: ".unclecode",
    receipt: receiptFor(before.fingerprint),
    sourceFingerprintBefore: before.fingerprint,
    sourceFingerprintAfter: after.fingerprint,
    sourceUnchanged: before.fingerprint === after.fingerprint,
    scanned: {
      files: before.files.length,
      directories: before.directories,
      bytes: before.bytes,
    },
    runs: runPlans,
    warnings,
  };
}
