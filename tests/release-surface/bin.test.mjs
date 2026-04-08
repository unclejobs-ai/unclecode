import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");
const binEntrypoint = path.join(workspaceRoot, "bin/unclecode.cjs");

test("release surface exposes UncleCode help and version from the root bin", () => {
  const versionResult = spawnSync("node", [binEntrypoint, "--version"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const helpResult = spawnSync("node", [binEntrypoint, "--help"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(versionResult.status, 0, versionResult.stderr);
  assert.equal(helpResult.status, 0, helpResult.stderr);
  assert.match(versionResult.stdout.trim(), /^0\.1\.0$/);
  assert.match(helpResult.stdout, /UncleCode workspace shell/i);
  assert.doesNotMatch(helpResult.stdout, /claw-dev/i);
});
