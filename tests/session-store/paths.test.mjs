import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getProjectDir, getProjectMemoryPath, getSessionPaths } from "../../packages/session-store/src/paths.ts";

test("session-store path derivation is backed by Rust opaque ids", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "unclecode-session-paths-"));
  try {
    const ref = {
      projectPath: process.cwd(),
      sessionId: `session-with-sk-proj-${"a".repeat(30)}`,
    };
    const paths = getSessionPaths({ rootDir }, ref);

    assert.equal(paths.projectDir, getProjectDir(rootDir, ref.projectPath));
    assert.equal(paths.projectMemoryDbPath, getProjectMemoryPath({ rootDir }, ref.projectPath));
    assert.match(paths.eventLogPath, /session-[a-f0-9]{20}\.events\.jsonl$/);
    assert.match(paths.checkpointPath, /session-[a-f0-9]{20}\.checkpoint\.json$/);
    assert.match(paths.researchArtifactsDir, /research-artifacts/);
    assert.doesNotMatch(paths.eventLogPath, /sk-proj-/);
    assert.doesNotMatch(paths.researchArtifactsDir, /sk-proj-/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
