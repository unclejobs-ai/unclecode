import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  assembleContextPacket,
  defaultRepoMapCache,
  estimateTokens,
  getTokenBudget,
} from "@unclecode/context-broker";

const worktreeDir = new URL("../../", import.meta.url).pathname;

describe("context packet utilities", () => {
  it("estimates tokens using a four-character heuristic", () => {
    assert.equal(estimateTokens("hello"), 2);
    assert.equal(estimateTokens(""), 0);
  });

  it("returns the expected default token budgets", () => {
    assert.deepEqual(getTokenBudget("default"), {
      maxTokens: 60000,
      reservedForTools: 10000,
      reservedForSystem: 5000,
    });
    assert.deepEqual(getTokenBudget("search"), {
      maxTokens: 100000,
      reservedForTools: 5000,
      reservedForSystem: 5000,
    });
    assert.deepEqual(getTokenBudget("ultrawork"), {
      maxTokens: 80000,
      reservedForTools: 8000,
      reservedForSystem: 4000,
    });
  });

  it("assembles a valid context packet", async () => {
    const packet = await assembleContextPacket({
      rootDir: worktreeDir,
      mode: "default",
    });

    assert.equal(typeof packet.id, "string");
    assert.ok(packet.id.length > 0);
    assert.match(packet.gitHeadSha, /^[a-f0-9]{40}$/);
    assert.equal(packet.repoMap.rootDir, worktreeDir);
    assert.ok(Array.isArray(packet.changedFiles));
    assert.ok(Array.isArray(packet.policySignals));
    assert.ok(packet.includedContents instanceof Map);
    assert.ok(packet.tokenEstimate >= 0);
    assert.equal(packet.provenance.mode, "default");
    assert.equal(packet.provenance.trigger, "auto");
  });

  it("adds policy-relevant signals for risky paths", async () => {
    const packet = await assembleContextPacket({
      rootDir: worktreeDir,
      mode: "default",
    });

    assert.ok(packet.policySignals.includes("dependency-manifest-change"));
  });

  it("assembles a packet for a git repo with no commits and no tracked files", async () => {
    const emptyRepoDir = mkdtempSync(path.join(os.tmpdir(), "unclecode-empty-packet-"));

    execFileSync("git", ["init"], { cwd: emptyRepoDir, encoding: "utf8" });

    const packet = await assembleContextPacket({
      rootDir: emptyRepoDir,
      mode: "default",
    });

    assert.equal(packet.gitHeadSha, "0".repeat(40));
    assert.equal(packet.freshness.status, "fresh");
    assert.equal(packet.repoMap.totalFiles, 0);
  });

  it("assembles a packet for a git repo with staged files before the first commit", async () => {
    const stagedRepoDir = mkdtempSync(path.join(os.tmpdir(), "unclecode-staged-packet-"));

    execFileSync("git", ["init"], { cwd: stagedRepoDir, encoding: "utf8" });
    writeFileSync(path.join(stagedRepoDir, "notes.txt"), "hello\nworld\n", "utf8");
    execFileSync("git", ["add", "notes.txt"], { cwd: stagedRepoDir, encoding: "utf8" });

    const packet = await assembleContextPacket({
      rootDir: stagedRepoDir,
      mode: "default",
    });

    assert.equal(packet.gitHeadSha, "0".repeat(40));
    assert.equal(packet.freshness.status, "fresh");
    assert.equal(packet.repoMap.totalFiles, 1);
  });

  it("refreshes the cached repo map when tracked content changes at the same HEAD", async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), "unclecode-same-head-cache-"));

    execFileSync("git", ["init"], { cwd: repoDir, encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, encoding: "utf8" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir, encoding: "utf8" });
    writeFileSync(path.join(repoDir, "notes.txt"), "line one\n", "utf8");
    execFileSync("git", ["add", "notes.txt"], { cwd: repoDir, encoding: "utf8" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, encoding: "utf8" });

    const before = defaultRepoMapCache.snapshot();
    const cleanPacket = await assembleContextPacket({ rootDir: repoDir, mode: "default" });

    writeFileSync(path.join(repoDir, "notes.txt"), "line one\nline two\n", "utf8");

    const firstDirtyPacket = await assembleContextPacket({ rootDir: repoDir, mode: "default" });

    writeFileSync(path.join(repoDir, "notes.txt"), "line one\nline two\nline three\n", "utf8");

    const secondDirtyPacket = await assembleContextPacket({ rootDir: repoDir, mode: "default" });
    const reusedDirtyPacket = await assembleContextPacket({ rootDir: repoDir, mode: "default" });
    const after = defaultRepoMapCache.snapshot();

    assert.equal(firstDirtyPacket.gitHeadSha, cleanPacket.gitHeadSha);
    assert.equal(secondDirtyPacket.gitHeadSha, cleanPacket.gitHeadSha);
    assert.equal(secondDirtyPacket.repoMap.gitHeadSha, cleanPacket.gitHeadSha);
    assert.equal(cleanPacket.repoMap.entries[0]?.lineCount, 1);
    assert.equal(firstDirtyPacket.repoMap.entries[0]?.lineCount, 2);
    assert.equal(secondDirtyPacket.repoMap.entries[0]?.lineCount, 3);
    assert.equal(reusedDirtyPacket.repoMap.entries[0]?.lineCount, 3);
    assert.equal(secondDirtyPacket.freshness.status, "fresh");
    assert.equal(after.misses - before.misses, 3);
    assert.equal(after.hits - before.hits, 1);
    assert.equal(after.invalidations - before.invalidations, 2);
  });
});
