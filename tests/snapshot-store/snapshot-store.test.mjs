import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureSnapshot,
  restoreSnapshot,
  readSnapshotManifest,
  listSnapshotTurns,
  pruneSnapshotsBefore,
} from "@unclecode/snapshot-store";

function setupWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "uc-snap-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "alpha");
  writeFileSync(join(dir, "src", "b.ts"), "beta");
  return dir;
}

test("captureSnapshot writes manifest + blobs and roundtrips on restore", () => {
  const dir = setupWorkspace();
  try {
    const manifest = captureSnapshot({
      workspaceRoot: dir,
      sessionId: "s1",
      turnIdx: 0,
      paths: ["src/a.ts", "src/b.ts"],
    });
    assert.equal(manifest.entries.length, 2);
    assert.equal(
      manifest.entries.find((entry) => entry.path === "src/a.ts")?.sha256,
      "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8",
    );
    writeFileSync(join(dir, "src", "a.ts"), "MUTATED");
    writeFileSync(join(dir, "src", "b.ts"), "MUTATED");
    const restored = restoreSnapshot({ workspaceRoot: dir, sessionId: "s1", turnIdx: 0 });
    assert.equal(restored.restored.length, 2);
    assert.equal(readFileSync(join(dir, "src", "a.ts"), "utf8"), "alpha");
    assert.equal(readFileSync(join(dir, "src", "b.ts"), "utf8"), "beta");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSnapshotManifest returns undefined when missing", () => {
  const dir = setupWorkspace();
  try {
    const manifest = readSnapshotManifest({ workspaceRoot: dir, sessionId: "s1", turnIdx: 99 });
    assert.equal(manifest, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listSnapshotTurns returns sorted turn ids", () => {
  const dir = setupWorkspace();
  try {
    captureSnapshot({ workspaceRoot: dir, sessionId: "s2", turnIdx: 2, paths: ["src/a.ts"] });
    captureSnapshot({ workspaceRoot: dir, sessionId: "s2", turnIdx: 0, paths: ["src/a.ts"] });
    captureSnapshot({ workspaceRoot: dir, sessionId: "s2", turnIdx: 1, paths: ["src/a.ts"] });
    const turns = listSnapshotTurns({ workspaceRoot: dir, sessionId: "s2" });
    assert.deepEqual(turns, [0, 1, 2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneSnapshotsBefore removes older turns", () => {
  const dir = setupWorkspace();
  try {
    captureSnapshot({ workspaceRoot: dir, sessionId: "s3", turnIdx: 0, paths: ["src/a.ts"] });
    captureSnapshot({ workspaceRoot: dir, sessionId: "s3", turnIdx: 1, paths: ["src/a.ts"] });
    captureSnapshot({ workspaceRoot: dir, sessionId: "s3", turnIdx: 2, paths: ["src/a.ts"] });
    const pruned = pruneSnapshotsBefore({ workspaceRoot: dir, sessionId: "s3", keepFromTurn: 2 });
    assert.equal(pruned, 2);
    const remaining = listSnapshotTurns({ workspaceRoot: dir, sessionId: "s3" });
    assert.deepEqual(remaining, [2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
