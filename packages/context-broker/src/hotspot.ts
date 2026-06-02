import { runRustCommandSync } from "./rust-command.js";
import { type RepoMap, type RepoMapEntry } from "./types.js";

export function detectHotspots(repoMap: RepoMap, topN = 10): RepoMapEntry[] {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "context", "hotspots", String(topN)],
      repoMap.rootDir,
      JSON.stringify(repoMap),
    ),
  ) as unknown;

  if (!Array.isArray(parsed) || !parsed.every(isRepoMapEntry)) {
    throw new Error("Rust hotspot command returned an invalid payload.");
  }

  return parsed;
}

export async function summarizeDiff(rootDir: string, sinceSha: string): Promise<readonly string[]> {
  const parsed = JSON.parse(
    runRustCommandSync(["rust", "context", "diff", rootDir, sinceSha], rootDir),
  ) as unknown;

  if (!Array.isArray(parsed) || !parsed.every((path) => typeof path === "string")) {
    throw new Error("Rust diff command returned an invalid payload.");
  }

  return parsed;
}

function isRepoMapEntry(value: unknown): value is RepoMapEntry {
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
