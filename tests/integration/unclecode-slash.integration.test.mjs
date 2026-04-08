import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");
const builtCliEntrypoint = path.join(
  workspaceRoot,
  "apps/unclecode-cli/dist/index.js",
);

test("built unclecode cli maps /help to the shell help surface", () => {
  const result = spawnSync("node", [builtCliEntrypoint, "/help"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: unclecode/);
  assert.match(result.stdout, /research/);
});

test("built unclecode cli maps /mode status to the mode command surface", () => {
  const result = spawnSync("node", [builtCliEntrypoint, "/mode status"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active mode:/);
  assert.match(result.stdout, /Source:/);
});

test("built unclecode cli also routes unquoted slash commands split across argv tokens", () => {
  const result = spawnSync("node", [builtCliEntrypoint, "/mode", "status"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active mode:/);
  assert.match(result.stdout, /Source:/);
});
