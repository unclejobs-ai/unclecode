import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");
const builtCliEntrypoint = path.join(
  workspaceRoot,
  "apps/unclecode-cli/dist/index.js",
);

test("built unclecode cli reports that no research run is active yet", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-research-status-"));

  try {
    const result = spawnSync(
      "node",
      [builtCliEntrypoint, "research", "status"],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          UNCLECODE_SESSION_STORE_ROOT: path.join(cwd, ".state"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Work context status/i);
    assert.match(result.stdout, /No Work context refresh yet/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("built unclecode work repl exposes context status commands", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-work-context-repl-"));

  try {
    const result = spawnSync(
      "node",
      [builtCliEntrypoint, "work", "--engine", "native"],
      {
        cwd,
        input: "/context\n/research status\n/exit\n",
        encoding: "utf8",
        env: {
          ...process.env,
          UNCLECODE_SESSION_STORE_ROOT: path.join(cwd, ".state"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /UncleCode ·/);
    assert.match(result.stdout, /Work context status/);
    assert.match(result.stdout, /No Work context refresh yet/);
    assert.doesNotMatch(
      result.stdout,
      /Unknown command: \/(context|research status)/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
