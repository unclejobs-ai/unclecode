import { runRustCommandSync } from "./rust-command.js";
import { type RepoMap } from "./types.js";

const ZERO_SHA = "0".repeat(40);

export async function getRepoMapCacheToken(rootDir: string): Promise<string> {
  const token = runRustCommandSync(["rust", "context", "repo-map-token", rootDir], rootDir).trim();

  return token.length > 0 ? token : ZERO_SHA;
}

export async function generateRepoMap(rootDir: string): Promise<RepoMap> {
  const parsed = JSON.parse(
    runRustCommandSync(["rust", "context", "repo-map", rootDir], rootDir),
  ) as unknown;

  if (!isRepoMap(parsed)) {
    throw new Error("Rust repo map command returned an invalid payload.");
  }

  return parsed;
}

function isRepoMap(value: unknown): value is RepoMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    rootDir?: unknown;
    generatedAt?: unknown;
    gitHeadSha?: unknown;
    entries?: unknown;
    totalFiles?: unknown;
    totalLines?: unknown;
  };

  return (
    typeof candidate.rootDir === "string" &&
    typeof candidate.generatedAt === "string" &&
    typeof candidate.gitHeadSha === "string" &&
    Array.isArray(candidate.entries) &&
    typeof candidate.totalFiles === "number" &&
    typeof candidate.totalLines === "number" &&
    candidate.entries.every(isRepoMapEntry)
  );
}

function isRepoMapEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    path?: unknown;
    lastModified?: unknown;
    lineCount?: unknown;
    changeFrequency?: unknown;
    hotspotScore?: unknown;
  };

  return (
    typeof candidate.path === "string" &&
    typeof candidate.lastModified === "string" &&
    typeof candidate.lineCount === "number" &&
    typeof candidate.changeFrequency === "number" &&
    typeof candidate.hotspotScore === "number"
  );
}
