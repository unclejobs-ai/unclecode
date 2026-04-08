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
    assert.match(result.stdout, /Research status/i);
    assert.match(result.stdout, /No active research run/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
