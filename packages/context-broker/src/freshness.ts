import { runRustCommandSync } from "./rust-command.js";
import {
  FreshnessCheckError,
  type ContextPacket,
  type FreshnessResult,
} from "./types.js";

export async function getWorktreeFingerprint(rootDir: string): Promise<{
  readonly fingerprint: string;
  readonly modifiedPaths: readonly string[];
}> {
  const parsed = JSON.parse(
    runRustCommandSync(["rust", "context", "worktree-fingerprint", rootDir], rootDir),
  ) as unknown;

  if (!isWorktreeFingerprint(parsed)) {
    throw new FreshnessCheckError("Rust worktree fingerprint command returned an invalid payload.");
  }

  return parsed;
}

export async function checkFreshness(packet: ContextPacket, rootDir: string): Promise<FreshnessResult> {
  const packetState = JSON.stringify({
    gitHeadSha: packet.gitHeadSha,
    worktreeFingerprint: packet.worktreeFingerprint,
  });
  const parsed = JSON.parse(
    runRustCommandSync(["rust", "context", "freshness", rootDir], rootDir, packetState),
  ) as unknown;

  if (!isFreshnessResult(parsed)) {
    throw new FreshnessCheckError("Rust freshness command returned an invalid payload.");
  }

  return parsed;
}

export function assertFreshContext(freshness: FreshnessResult): void {
  if (freshness.status === "fresh") {
    return;
  }

  throw new FreshnessCheckError(`Context packet freshness gate failed with status: ${freshness.status}`, {
    cause: freshness,
  });
}

function isWorktreeFingerprint(value: unknown): value is {
  readonly fingerprint: string;
  readonly modifiedPaths: readonly string[];
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as { fingerprint?: unknown; modifiedPaths?: unknown };

  return (
    typeof candidate.fingerprint === "string" &&
    Array.isArray(candidate.modifiedPaths) &&
    candidate.modifiedPaths.every((path) => typeof path === "string")
  );
}

function isFreshnessResult(value: unknown): value is FreshnessResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    status?: unknown;
    checkedAt?: unknown;
    gitHeadSha?: unknown;
    packetSha?: unknown;
    modifiedPaths?: unknown;
  };

  return (
    (candidate.status === "fresh" ||
      candidate.status === "stale" ||
      candidate.status === "unknown") &&
    typeof candidate.checkedAt === "string" &&
    typeof candidate.gitHeadSha === "string" &&
    typeof candidate.packetSha === "string" &&
    Array.isArray(candidate.modifiedPaths) &&
    candidate.modifiedPaths.every((path) => typeof path === "string")
  );
}
