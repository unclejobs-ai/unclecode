import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getGitBranch, getGitStatus, readGitFacts } from "../../packages/tui/src/facts.ts";

test("git facts fall back to an explicit no-git-repo label outside a repository", () => {
  const outside = mkdtempSync(path.join(tmpdir(), "unclecode-facts-"));
  try {
    assert.equal(getGitBranch(outside), "no git repo");
    assert.equal(getGitStatus(outside), "no git repo");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("git facts stay informative inside a repository", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const branch = getGitBranch(repoRoot);
  assert.notEqual(branch, "no git repo");
  assert.ok(branch.length > 0);
  const status = getGitStatus(repoRoot);
  assert.notEqual(status, "no git repo");
  assert.match(status, /^clean$|modified$/);
});

test("git facts cache hits within the TTL, refreshes after expiry, and evicts old workspaces", () => {
  let reads = 0;
  const readStatus = (cwd) => {
    reads += 1;
    return `## ${path.basename(cwd)}\n`;
  };
  const cacheRoot = path.join(tmpdir(), `unclecode-facts-cache-${process.pid}`);
  const firstCwd = path.join(cacheRoot, "workspace-0");

  const first = readGitFacts(firstCwd, 10_000, readStatus);
  const hit = readGitFacts(firstCwd, 10_500, readStatus);
  assert.strictEqual(hit, first, "a fresh workspace lookup must reuse the cached facts object");
  assert.equal(reads, 1);

  const refreshed = readGitFacts(firstCwd, 11_000, readStatus);
  assert.notStrictEqual(refreshed, first, "the TTL boundary must invalidate the cached facts");
  assert.equal(reads, 2);

  for (let index = 1; index <= 32; index += 1) {
    readGitFacts(path.join(cacheRoot, `workspace-${index}`), 11_000, readStatus);
  }
  assert.equal(reads, 34);

  const reloaded = readGitFacts(firstCwd, 11_500, readStatus);
  assert.notStrictEqual(reloaded, refreshed, "workspace churn must evict the oldest retained facts");
  assert.equal(reads, 35, "the cache must retain no more than 32 workspaces");
});
