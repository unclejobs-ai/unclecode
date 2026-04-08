import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("built unclecode cli explains the effective config and active mode prompt injection", () => {
  const result = spawnSync(
    "node",
    [builtCliEntrypoint, "config", "explain", "--mode", "search"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        UNCLECODE_MODEL: "integration-env-model",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Source order/i);
  assert.match(result.stdout, /Active mode:\s+search/i);
  assert.match(result.stdout, /model\s*=\s*integration-env-model/i);
  assert.match(result.stdout, /winner:\s*environment/i);
  assert.match(result.stdout, /active-mode/i);
  assert.match(result.stdout, /Search/i);
});

test("built unclecode cli config explain includes plugin manifest overlays", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-config-plugin-"));
  try {
    mkdirSync(path.join(cwd, ".unclecode", "extensions"), { recursive: true });
    writeFileSync(
      path.join(cwd, ".unclecode", "extensions", "focus.json"),
      JSON.stringify({
        name: "focus-tools",
        config: {
          prompt: {
            sections: {
              "plugin-note": {
                title: "Plugin Note",
                body: "Plugin overlay note.",
              },
            },
          },
        },
      }),
      "utf8",
    );

    const result = spawnSync(
      "node",
      [builtCliEntrypoint, "config", "explain"],
      {
        cwd,
        encoding: "utf8",
        env: process.env,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /plugin overlay/i);
    assert.match(result.stdout, /Plugin Note/);
    assert.match(result.stdout, /Plugin overlay note\./);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
