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

function makeTempWorkspace() {
  return mkdtempSync(path.join(tmpdir(), "unclecode-slash-surfaces-"));
}

test("built unclecode cli maps /doctor to the doctor surface", () => {
  const cwd = makeTempWorkspace();
  try {
    const result = spawnSync("node", [builtCliEntrypoint, "/doctor"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        UNCLECODE_SESSION_STORE_ROOT: path.join(cwd, ".state"),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Doctor report/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("built unclecode cli maps /sessions to the sessions surface", () => {
  const cwd = makeTempWorkspace();
  try {
    const result = spawnSync("node", [builtCliEntrypoint, "/sessions"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        UNCLECODE_SESSION_STORE_ROOT: path.join(cwd, ".state"),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No resumable sessions found|Sessions/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("built unclecode cli maps /research status and /mcp list to their surfaces", () => {
  const cwd = makeTempWorkspace();
  try {
    const researchResult = spawnSync(
      "node",
      [builtCliEntrypoint, "/research status"],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          UNCLECODE_SESSION_STORE_ROOT: path.join(cwd, ".state"),
        },
      },
    );
    assert.equal(researchResult.status, 0, researchResult.stderr);
    assert.match(researchResult.stdout, /Research status/);

    const mcpResult = spawnSync("node", [builtCliEntrypoint, "/mcp list"], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(mcpResult.status, 0, mcpResult.stderr);
    assert.match(mcpResult.stdout, /MCP servers/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("built unclecode cli maps /work --tools to the real assistant entrypoint", () => {
  const result = spawnSync("node", [builtCliEntrypoint, "/work", "--tools"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Available tools:/);
  assert.match(result.stdout, /read_file/);
});
