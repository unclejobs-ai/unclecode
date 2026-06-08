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

test("built unclecode cli exposes the Rust-native work tool surface via --tools", () => {
  const result = spawnSync("node", [builtCliEntrypoint, "work", "--tools"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Available Rust-native work tools:/);
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
  assert.match(result.stdout, /Choose openai, anthropic, or gemini/);
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

test("built unclecode cli tui --smoke verifies runtime action wiring", () => {
  const result = spawnSync("node", [builtCliEntrypoint, "tui", "--smoke"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Work shell TUI smoke OK/);
  assert.match(result.stdout, /MCP inspect action connected/);
  assert.match(result.stdout, /Work context status action connected/);
  assert.match(result.stdout, /History resume action connected/);
});

test("built unclecode cli center uses the Rust-native center surface", () => {
  const result = spawnSync("node", [builtCliEntrypoint, "center"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /UncleCode Center/);
  assert.match(result.stdout, /runtime: rust-native/);
});

test("built unclecode cli center --help forwards to Rust-native center help", () => {
  const result = spawnSync("node", [builtCliEntrypoint, "center", "--help"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: unclecode center/);
  assert.match(result.stdout, /Rust-native session center/);
});
