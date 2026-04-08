import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");
const binEntrypoint = path.join(workspaceRoot, "bin/unclecode.cjs");

test("bin/unclecode.cjs can launch the built work runtime from an external cwd", () => {
  const externalCwd = mkdtempSync(path.join(tmpdir(), "unclecode-bin-work-"));

  try {
    const result = spawnSync("node", [binEntrypoint, "work", "--help"], {
      cwd: externalCwd,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /UncleCode Work/);
    assert.match(result.stdout, /unclecode work/);
  } finally {
    rmSync(externalCwd, { recursive: true, force: true });
  }
});
