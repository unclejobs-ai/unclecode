import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PathContainmentError, searchDir } from "@unclecode/orchestrator";

/**
 * Regression — searchDir must refuse paths that escape the workspace root.
 * Without containment, a model that emits `path: "../../etc"` or an absolute
 * path can drive `rg` to read arbitrary filesystem locations under the
 * agent's privilege. Codex review (2026-04-29) flagged this as HIGH-confidence
 * sandbox escape at packages/orchestrator/src/aci/search.ts:89.
 */

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "uc-search-containment-"));
  mkdirSync(join(root, "inside"), { recursive: true });
  writeFileSync(join(root, "inside", "ok.txt"), "hello target\n");
  return root;
}

test("searchDir rejects parent-traversal paths that escape the workspace", async () => {
  const root = makeWorkspace();
  try {
    await assert.rejects(
      () => searchDir({ cwd: root, query: "hello", path: "../../" }),
      (error) => error instanceof PathContainmentError,
      "searchDir must reject `../../` traversal — model-driven escape",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("searchDir rejects absolute paths that target locations outside the workspace", async () => {
  const root = makeWorkspace();
  try {
    await assert.rejects(
      () => searchDir({ cwd: root, query: "root:", path: "/etc" }),
      (error) => error instanceof PathContainmentError,
      "searchDir must reject absolute paths — sandbox boundary",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("searchDir rejects deeper traversal even when the prefix is workspace-relative", async () => {
  const root = makeWorkspace();
  try {
    await assert.rejects(
      () => searchDir({ cwd: root, query: "hello", path: "inside/../../" }),
      (error) => error instanceof PathContainmentError,
      "searchDir must reject mixed traversal segments",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("searchDir accepts a workspace-relative subdirectory and returns results", async () => {
  const root = makeWorkspace();
  try {
    const result = await searchDir({ cwd: root, query: "hello", path: "inside" });
    assert.equal(typeof result.totalHits, "number");
    assert.ok(result.totalHits >= 1, "search inside the workspace must still work after containment");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("searchDir treats model-supplied query string as a literal pattern, not a ripgrep flag", async () => {
  // Regression — without the "--" sentinel before input.query in the rg argv,
  // ripgrep's clap parser interprets a leading "--..." token as a flag.
  // A malicious model could pass query:"--follow" to re-enable symlink
  // traversal during the search and read content outside the workspace.
  // Codex/Kimi review (2026-04-29) flagged this. The fix lives in
  // packages/orchestrator/src/aci/search.ts (args array).
  const root = makeWorkspace();
  try {
    // The literal string "--follow" appears nowhere in the fixture, so a
    // correctly-quoted query must return zero matches and must not throw a
    // ripgrep-flag-rejection error.
    const result = await searchDir({ cwd: root, query: "--follow", path: "." });
    assert.equal(result.totalHits, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("searchDir accepts the implicit cwd path (.) without a containment violation", async () => {
  const root = makeWorkspace();
  try {
    const result = await searchDir({ cwd: root, query: "hello" });
    assert.equal(typeof result.totalHits, "number");
    assert.ok(result.totalHits >= 1, "default path '.' must match the workspace root itself");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
