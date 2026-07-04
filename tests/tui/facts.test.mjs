import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getGitBranch, getGitStatus } from "../../packages/tui/src/facts.ts";

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
