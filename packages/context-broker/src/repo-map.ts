import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ContextBrokerError, GitCommandError, type RepoMap, type RepoMapEntry } from "./types.js";

const EXCLUDED_SEGMENTS = new Set([".git", "node_modules", "dist", "build"]);
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
const COMMIT_LINE_PATTERN = /^[a-f0-9]{7,40}\s/;
const ZERO_SHA = "0".repeat(40);
const execFile = promisify(execFileCallback);

type RawRepoMapEntry = Omit<RepoMapEntry, "hotspotScore">;

function isNodeErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function splitLines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isExcludedPath(filePath: string): boolean {
  return filePath.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const length = Math.min(buffer.length, 8_000);

  for (let index = 0; index < length; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }

  return false;
}

function countLogicalLines(buffer: Buffer): number {
  if (buffer.length === 0) {
    return 0;
  }

  let count = 0;

  for (const byte of buffer) {
    if (byte === 10) {
      count += 1;
    }
  }

  return buffer[buffer.length - 1] === 10 ? count : count + 1;
}

async function runGit(rootDir: string, args: readonly string[]): Promise<string> {
  const command = ["git", ...args];

  try {
    const { stdout } = await execFile("git", [...args], {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });

    return stdout;
  } catch (error) {
    throw new GitCommandError(command, { cause: error });
  }
}

export async function getRepoMapCacheToken(rootDir: string): Promise<string> {
  try {
    return (await runGit(rootDir, ["rev-parse", "HEAD"])).trim();
  } catch (error) {
    if (error instanceof GitCommandError) {
      return ZERO_SHA;
    }

    throw error;
  }
}

function parseLastModified(output: string): ReadonlyMap<string, string> {
  const lastModified = new Map<string, string>();
  let currentTimestamp: string | undefined;

  for (const line of output.split(/\r?\n/u)) {
    if (line.length === 0) {
      continue;
    }

    if (ISO_TIMESTAMP_PATTERN.test(line)) {
      currentTimestamp = line;
      continue;
    }

    if (currentTimestamp !== undefined && !lastModified.has(line)) {
      lastModified.set(line, currentTimestamp);
    }
  }

  return lastModified;
}

function parseChangeFrequency(output: string): ReadonlyMap<string, number> {
  const frequencies = new Map<string, number>();

  for (const line of output.split(/\r?\n/u)) {
    if (line.length === 0 || COMMIT_LINE_PATTERN.test(line)) {
      continue;
    }

    frequencies.set(line, (frequencies.get(line) ?? 0) + 1);
  }

  return frequencies;
}

async function getLastModifiedFallback(
  rootDir: string,
  filePath: string,
  gitHeadSha: string,
): Promise<string> {
  if (gitHeadSha === ZERO_SHA) {
    return new Date(0).toISOString();
  }

  const output = await runGit(rootDir, ["log", "-1", "--format=%cI", "--", filePath]);
  const timestamp = output.trim();

  return timestamp.length > 0 ? timestamp : new Date(0).toISOString();
}

async function readRepoMapEntry(
  rootDir: string,
  filePath: string,
  gitHeadSha: string,
  lastModifiedMap: ReadonlyMap<string, string>,
  changeFrequencyMap: ReadonlyMap<string, number>,
): Promise<RawRepoMapEntry | undefined> {
  let buffer: Buffer;

  try {
    buffer = await readFile(path.join(rootDir, filePath));
  } catch (error) {
    if (isNodeErrorWithCode(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw new ContextBrokerError(`Failed to read tracked file: ${filePath}`, { cause: error });
  }

  if (isBinaryBuffer(buffer)) {
    return undefined;
  }

  return {
    path: filePath,
    lastModified:
      lastModifiedMap.get(filePath) ??
      (await getLastModifiedFallback(rootDir, filePath, gitHeadSha)),
    lineCount: countLogicalLines(buffer),
    changeFrequency: changeFrequencyMap.get(filePath) ?? 0,
  };
}

export async function generateRepoMap(rootDir: string): Promise<RepoMap> {
  const generatedAt = new Date().toISOString();
  const [gitHeadSha, trackedFilesOutput] = await Promise.all([
    getRepoMapCacheToken(rootDir),
    runGit(rootDir, ["ls-files"]),
  ]);
  const [lastModifiedOutput, changeFrequencyOutput] =
    gitHeadSha === ZERO_SHA
      ? ["", ""]
      : await Promise.all([
          runGit(rootDir, ["log", "--format=%cI", "--name-only", "--no-renames", "--"]),
          runGit(rootDir, ["log", "--oneline", "--name-only", "--no-renames", "--"]),
        ]);

  const trackedFiles = splitLines(trackedFilesOutput).filter((filePath) => !isExcludedPath(filePath));
  const lastModifiedMap = parseLastModified(lastModifiedOutput);
  const changeFrequencyMap = parseChangeFrequency(changeFrequencyOutput);
  const rawEntries: RawRepoMapEntry[] = [];

  for (const filePath of trackedFiles) {
    const entry = await readRepoMapEntry(
      rootDir,
      filePath,
      gitHeadSha,
      lastModifiedMap,
      changeFrequencyMap,
    );

    if (entry !== undefined) {
      rawEntries.push(entry);
    }
  }

  const maxChangeFrequency = rawEntries.reduce(
    (maxFrequency, entry) => Math.max(maxFrequency, entry.changeFrequency),
    0,
  );

  const entries = rawEntries
    .map<RepoMapEntry>((entry) => ({
      ...entry,
      hotspotScore: maxChangeFrequency === 0 ? 0 : entry.changeFrequency / maxChangeFrequency,
    }))
    .sort(
      (left, right) =>
        right.hotspotScore - left.hotspotScore ||
        right.changeFrequency - left.changeFrequency ||
        left.path.localeCompare(right.path),
    );

  const totalLines = entries.reduce((sum, entry) => sum + entry.lineCount, 0);

  return {
    rootDir,
    generatedAt,
    gitHeadSha,
    entries,
    totalFiles: entries.length,
    totalLines,
  };
}
