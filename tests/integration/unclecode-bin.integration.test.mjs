import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");
const binEntrypoint = path.join(workspaceRoot, "bin/unclecode.cjs");

test("root bin wrapper exposes unclecode version", () => {
  const result = spawnSync("node", [binEntrypoint, "--version"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^0\.1\.0$/);
});
