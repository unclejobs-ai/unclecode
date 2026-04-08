import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");
const builtCliEntrypoint = path.join(
  workspaceRoot,
  "apps/unclecode-cli/dist/index.js",
);
const builtWorkEntrypoint = path.join(
  workspaceRoot,
  "dist-work/apps/unclecode-cli/src/work-entry.js",
);
const staleBuiltRootWorkIndex = path.join(
  workspaceRoot,
  "dist-work/src/index.js",
);
const staleBuiltRootWorkRuntime = path.join(
  workspaceRoot,
  "dist-work/src/work-shell-runtime.js",
);

test("built work packaging exposes only the app-owned work entrypoint", () => {
  assert.equal(existsSync(builtWorkEntrypoint), true);
  assert.equal(existsSync(staleBuiltRootWorkIndex), false);
  assert.equal(existsSync(staleBuiltRootWorkRuntime), false);
});

test("built unclecode cli exposes the real work entrypoint via --tools", () => {
  const result = spawnSync("node", [builtCliEntrypoint, "work", "--tools"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Available tools:/);
  assert.match(result.stdout, /list_files/);
  assert.match(result.stdout, /read_file/);
});

test("built unclecode cli forwards work --help to the real assistant entrypoint", () => {
  const result = spawnSync("node", [builtCliEntrypoint, "work", "--help"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /UncleCode Work/);
  assert.match(
    result.stdout,
    /Choose openai-api, openai-codex, anthropic, or gemini/,
  );
  assert.match(result.stdout, /--reasoning/);
});

test("built unclecode cli forwards tui --help to the real assistant entrypoint", () => {
  const result = spawnSync("node", [builtCliEntrypoint, "tui", "--help"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /UncleCode Work/);
  assert.match(result.stdout, /--reasoning/);
});
