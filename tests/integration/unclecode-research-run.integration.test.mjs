import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  return mkdtempSync(path.join(tmpdir(), "unclecode-research-"));
}

function initializeGitRepo(cwd) {
  const initResult = spawnSync("git", ["init"], { cwd, encoding: "utf8" });
  assert.equal(initResult.status, 0, initResult.stderr);

  const configEmail = spawnSync(
    "git",
    ["config", "user.email", "test@example.com"],
    {
      cwd,
      encoding: "utf8",
    },
  );
  assert.equal(configEmail.status, 0, configEmail.stderr);

  const configName = spawnSync("git", ["config", "user.name", "Test User"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(configName.status, 0, configName.stderr);

  const writeFileResult = spawnSync(
    "node",
    [
      "--eval",
      "require('node:fs').writeFileSync('README.md', '# temp research workspace\\n')",
    ],
    { cwd, encoding: "utf8" },
  );
  assert.equal(writeFileResult.status, 0, writeFileResult.stderr);

  const addResult = spawnSync("git", ["add", "README.md"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(addResult.status, 0, addResult.stderr);

  const commitResult = spawnSync("git", ["commit", "-m", "init"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(commitResult.status, 0, commitResult.stderr);
}

test("built unclecode cli can run a linear research pass and write an artifact", () => {
  const cwd = makeTempWorkspace();
  const sessionStoreRoot = path.join(cwd, ".state");

  try {
    initializeGitRepo(cwd);

    const runResult = spawnSync(
      "node",
      [
        builtCliEntrypoint,
        "research",
        "run",
        "summarize",
        "current",
        "workspace",
      ],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
        },
      },
    );

    assert.equal(runResult.status, 0, runResult.stderr);
    assert.match(runResult.stdout, /Research completed/i);
    assert.match(runResult.stdout, /Session: research-/i);
    assert.match(runResult.stdout, /Artifact: .*research\.md/i);

    const artifactMatch = runResult.stdout.match(/Artifact: (.*research\.md)/);
    assert.ok(artifactMatch, "artifact path should be printed");
    const artifactPath = artifactMatch[1];

    assert.ok(
      existsSync(artifactPath),
      `artifact should exist: ${artifactPath}`,
    );
    const artifactBody = readFileSync(artifactPath, "utf8");
    assert.match(artifactBody, /# UncleCode Research Report/);
    assert.match(artifactBody, /Prompt: summarize current workspace/);
    assert.match(artifactBody, /## Findings/);
    assert.match(artifactBody, /## Recommended Next Steps/);

    const ledgerPath = path.join(cwd, ".unclecode", "research-runs.jsonl");
    assert.ok(existsSync(ledgerPath), `ledger should exist: ${ledgerPath}`);
    const ledgerBody = readFileSync(ledgerPath, "utf8");
    assert.match(ledgerBody, /"sessionId":"research-/);
    assert.match(ledgerBody, /"prompt":"summarize current workspace"/);
    assert.match(ledgerBody, /"status":"completed"/);

    const statusResult = spawnSync(
      "node",
      [builtCliEntrypoint, "research", "status"],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
        },
      },
    );

    assert.equal(statusResult.status, 0, statusResult.stderr);
    assert.match(statusResult.stdout, /Research status/i);
    assert.match(statusResult.stdout, /Last run: research-/i);
    assert.match(statusResult.stdout, /State: idle/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
