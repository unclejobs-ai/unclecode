import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  return mkdtempSync(path.join(tmpdir(), "unclecode-cli-"));
}

test("built unclecode cli can persist and report the active mode", () => {
  const cwd = makeTempWorkspace();

  try {
    const setResult = spawnSync(
      "node",
      [builtCliEntrypoint, "mode", "set", "ultrawork"],
      {
        cwd,
        encoding: "utf8",
      },
    );

    assert.equal(setResult.status, 0, setResult.stderr);
    assert.match(setResult.stdout, /Active mode saved:\s+ultrawork/i);

    const savedConfig = JSON.parse(
      readFileSync(path.join(cwd, ".unclecode", "config.json"), "utf8"),
    );
    assert.equal(savedConfig.mode, "ultrawork");

    const statusResult = spawnSync(
      "node",
      [builtCliEntrypoint, "mode", "status"],
      {
        cwd,
        encoding: "utf8",
      },
    );

    assert.equal(statusResult.status, 0, statusResult.stderr);
    assert.match(statusResult.stdout, /Active mode:\s+ultrawork/i);
    assert.match(statusResult.stdout, /Source:\s+project config/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("built unclecode cli doctor reports subsystem readiness", () => {
  const cwd = makeTempWorkspace();
  const sessionStoreRoot = path.join(cwd, ".state");

  try {
    const result = spawnSync("node", [builtCliEntrypoint, "doctor"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: cwd,
        OPENAI_AUTH_TOKEN: "",
        OPENAI_API_KEY: "sk-test-123",
        UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Doctor report/i);
    assert.match(result.stdout, /Mode\s+PASS\s+default/i);
    assert.match(result.stdout, /Auth\s+PASS\s+api-key-env/i);
    assert.match(result.stdout, /Runtime\s+PASS\s+local available/i);
    assert.match(result.stdout, /Session store\s+PASS/i);
    assert.match(result.stdout, /MCP host\s+PASS\s+\d+ servers; transports/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("built unclecode cli doctor --verbose prints latency counters", () => {
  const cwd = makeTempWorkspace();
  const sessionStoreRoot = path.join(cwd, ".state");

  try {
    const result = spawnSync(
      "node",
      [builtCliEntrypoint, "doctor", "--verbose"],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: cwd,
          OPENAI_AUTH_TOKEN: "",
          OPENAI_API_KEY: "sk-test-123",
          UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Latency counters/i);
    assert.match(result.stdout, /configMs=\d+/i);
    assert.match(result.stdout, /authMs=\d+/i);
    assert.match(result.stdout, /runtimeMs=\d+/i);
    assert.match(result.stdout, /sessionStoreMs=\d+/i);
    assert.match(result.stdout, /mcpMs=\d+/i);
    assert.match(result.stdout, /totalMs=\d+/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("built unclecode cli setup prints actionable readiness guidance", () => {
  const cwd = makeTempWorkspace();
  const sessionStoreRoot = path.join(cwd, ".state");

  try {
    const result = spawnSync("node", [builtCliEntrypoint, "setup"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: cwd,
        UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Setup guide/i);
    assert.match(result.stdout, /Auth: missing/i);
    assert.match(result.stdout, /unclecode auth login --browser/i);
    assert.match(result.stdout, /unclecode auth login --api-key/i);
    assert.match(result.stdout, /OPENAI_API_KEY/i);
    assert.match(result.stdout, /Session store:/i);
    assert.match(result.stdout, /Next steps:/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
