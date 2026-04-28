/**
 * Team run store — RUN_ID-bound persistence for multi-agent team mode.
 *
 * One RUN_ID resolves to .data/team-runs/<runId>/{manifest.json, checkpoints.ndjson,
 * workers/<id>/, reviews/}. Append-only NDJSON log with sha256 chain (each line's
 * lineHash = sha256(prevLineHash || canonicalJSON(line)). Advisory flock prevents
 * two coordinators from writing to the same run.
 *
 * Cross-process visibility comes from the filesystem; live IPC (UDS socket) is
 * a Phase C.2 add-on that mirrors but does not replace this cold log.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type {
  PersonaId,
  TeamRunManifest,
  TeamRunCheckpoint,
  TeamRunStatus,
  TeamStepCheckpoint,
} from "@unclecode/contracts";

const TEAM_RUNS_DIRNAME = "team-runs";
const MANIFEST_FILENAME = "manifest.json";
const CHECKPOINTS_FILENAME = "checkpoints.ndjson";
const TIP_FILENAME = ".tip";
const LOCK_FILENAME = ".lock";
const WORKERS_DIRNAME = "workers";
const REVIEWS_DIRNAME = "reviews";
const ZERO_HASH = "0".repeat(64);

export type TeamRunRef = {
  readonly runId: string;
  readonly runRoot: string;
};

export type TeamCheckpoint = TeamRunCheckpoint | TeamStepCheckpoint;

export type AppendableTeamCheckpoint =
  | (Omit<TeamRunCheckpoint, "prevTipHash" | "lineHash"> & { prevTipHash?: string })
  | (Omit<TeamStepCheckpoint, "prevTipHash" | "lineHash"> & { prevTipHash?: string });

export type CreateTeamRunInput = {
  readonly dataRoot: string;
  readonly runId?: string;
  readonly objective: string;
  readonly persona: PersonaId;
  readonly lanes: number;
  readonly gate: TeamRunManifest["gate"];
  readonly runtime: TeamRunManifest["runtime"];
  readonly workspaceRoot: string;
  readonly createdBy: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly codeState?: TeamRunManifest["codeState"];
};

export type ChainVerification = {
  readonly ok: boolean;
  readonly verifiedLines: number;
  readonly brokenAt?: number;
  readonly expectedHash?: string;
  readonly actualHash?: string;
};

export function getTeamRunsRoot(dataRoot: string): string {
  return join(dataRoot, TEAM_RUNS_DIRNAME);
}

export function getTeamRunRoot(dataRoot: string, runId: string): string {
  return join(getTeamRunsRoot(dataRoot), runId);
}

export function generateRunId(): string {
  const ts = Date.now();
  const rand = createHash("sha256")
    .update(`${ts}-${Math.random()}-${process.pid}`)
    .digest("hex")
    .slice(0, 6);
  return `tr_${ts}_${rand}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
  );
  return `{${parts.join(",")}}`;
}

function hashLine(prevHash: string, line: Record<string, unknown>): string {
  return createHash("sha256")
    .update(prevHash)
    .update(canonicalJson(line))
    .digest("hex");
}

export function createTeamRun(input: CreateTeamRunInput): TeamRunRef {
  const runId = input.runId ?? generateRunId();
  const runRoot = getTeamRunRoot(input.dataRoot, runId);

  if (existsSync(runRoot)) {
    throw new Error(`Team run already exists at ${runRoot}`);
  }

  mkdirSync(runRoot, { recursive: true });
  mkdirSync(join(runRoot, WORKERS_DIRNAME), { recursive: true });
  mkdirSync(join(runRoot, REVIEWS_DIRNAME), { recursive: true });

  const manifest: TeamRunManifest = {
    runId,
    objective: input.objective,
    persona: input.persona,
    lanes: input.lanes,
    gate: input.gate,
    runtime: input.runtime,
    createdAt: Date.now(),
    createdBy: input.createdBy,
    workspaceRoot: input.workspaceRoot,
    ...(input.codeState !== undefined ? { codeState: input.codeState } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
  };
  writeFileSync(join(runRoot, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
  writeFileSync(join(runRoot, CHECKPOINTS_FILENAME), "");

  return { runId, runRoot };
}

export function readTeamRunManifest(runRoot: string): TeamRunManifest {
  const path = join(runRoot, MANIFEST_FILENAME);
  if (!existsSync(path)) {
    throw new Error(`Team run manifest missing at ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as TeamRunManifest;
}

function getCurrentTipHash(runRoot: string, checkpointsPath: string): string {
  const tipPath = join(runRoot, TIP_FILENAME);
  if (existsSync(tipPath)) {
    const cached = readFileSync(tipPath, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(cached)) {
      return cached;
    }
  }
  if (!existsSync(checkpointsPath)) {
    return ZERO_HASH;
  }
  const content = readFileSync(checkpointsPath, "utf8");
  if (content.length === 0) {
    return ZERO_HASH;
  }
  const lines = content.split("\n").filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  if (!last) {
    return ZERO_HASH;
  }
  try {
    const parsed = JSON.parse(last) as { lineHash?: string };
    const recovered = typeof parsed.lineHash === "string" ? parsed.lineHash : ZERO_HASH;
    if (recovered !== ZERO_HASH) {
      writeFileSync(tipPath, recovered);
    }
    return recovered;
  } catch {
    return ZERO_HASH;
  }
}

export function appendTeamCheckpoint(
  runRoot: string,
  checkpoint: AppendableTeamCheckpoint,
): TeamCheckpoint {
  const checkpointsPath = join(runRoot, CHECKPOINTS_FILENAME);
  const prevTipHash = getCurrentTipHash(runRoot, checkpointsPath);

  if (
    typeof checkpoint.prevTipHash === "string"
    && checkpoint.prevTipHash !== prevTipHash
  ) {
    throw new Error(
      `prevTipHash mismatch: expected ${prevTipHash}, got ${checkpoint.prevTipHash}`,
    );
  }

  const withoutLineHash = { ...checkpoint, prevTipHash } as Record<string, unknown>;
  const lineHash = hashLine(prevTipHash, withoutLineHash);
  const finalCheckpoint = { ...withoutLineHash, lineHash } as TeamCheckpoint;
  appendFileSync(checkpointsPath, `${JSON.stringify(finalCheckpoint)}\n`);
  writeFileSync(join(runRoot, TIP_FILENAME), lineHash);
  return finalCheckpoint;
}

export function readTeamCheckpoints(runRoot: string): ReadonlyArray<TeamCheckpoint> {
  const checkpointsPath = join(runRoot, CHECKPOINTS_FILENAME);
  if (!existsSync(checkpointsPath)) {
    return [];
  }
  const content = readFileSync(checkpointsPath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TeamCheckpoint);
}

export function verifyTeamRunChain(runRoot: string): ChainVerification {
  const checkpointsPath = join(runRoot, CHECKPOINTS_FILENAME);
  if (!existsSync(checkpointsPath)) {
    return { ok: true, verifiedLines: 0 };
  }
  const lines = readFileSync(checkpointsPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);

  let prevHash = ZERO_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index] ?? "";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lineText) as Record<string, unknown>;
    } catch {
      return { ok: false, verifiedLines: index, brokenAt: index };
    }
    const recordedHash = typeof parsed.lineHash === "string" ? parsed.lineHash : "";
    const recordedPrev = typeof parsed.prevTipHash === "string" ? parsed.prevTipHash : "";
    const { lineHash: _omit, ...withoutLineHash } = parsed;
    const expected = hashLine(recordedPrev, withoutLineHash);
    if (expected !== recordedHash || recordedPrev !== prevHash) {
      return {
        ok: false,
        verifiedLines: index,
        brokenAt: index,
        expectedHash: expected,
        actualHash: recordedHash,
      };
    }
    prevHash = recordedHash;
  }
  return { ok: true, verifiedLines: lines.length };
}

export function lockTeamRun(runRoot: string, holder: string): () => void {
  const lockPath = join(runRoot, LOCK_FILENAME);
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    const existing = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : "(unknown)";
    throw new Error(
      `Team run already locked by ${existing.trim() || "another coordinator"}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  writeFileSync(fd, `${holder} pid=${process.pid} ts=${Date.now()}`);
  closeSync(fd);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone
    }
  };
}

export function getRunStatusFromCheckpoints(
  checkpoints: ReadonlyArray<TeamCheckpoint>,
): TeamRunStatus | undefined {
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const entry = checkpoints[index];
    if (entry?.type === "team_run") {
      return entry.status;
    }
  }
  return undefined;
}
