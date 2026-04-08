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

function makeTempWorkspace() {
  return mkdtempSync(path.join(tmpdir(), "unclecode-mcp-"));
}

test("built unclecode cli lists merged MCP servers with project precedence", () => {
  const cwd = makeTempWorkspace();
  const fakeHome = path.join(cwd, "fake-home");

  try {
    mkdirSync(path.join(cwd, ".unclecode"), { recursive: true });
    mkdirSync(path.join(fakeHome, ".unclecode"), { recursive: true });

    writeFileSync(
      path.join(fakeHome, ".unclecode", "mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            memory: {
              type: "stdio",
              command: "node",
              args: ["memory.js"],
            },
            shared: {
              type: "stdio",
              command: "node",
              args: ["user-shared.js"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    writeFileSync(
      path.join(cwd, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            shared: {
              type: "http",
              url: "http://localhost:8787/mcp",
            },
            repo: {
              type: "stdio",
              command: "node",
              args: ["repo.js"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = spawnSync("node", [builtCliEntrypoint, "mcp", "list"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fakeHome,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MCP servers/i);
    assert.match(result.stdout, /memory \| stdio \| user \| user config/i);
    assert.match(result.stdout, /shared \| http \| project \| project config/i);
    assert.match(result.stdout, /repo \| stdio \| project \| project config/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
