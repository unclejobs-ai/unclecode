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

test("built unclecode cli lists the project-local mmbridge MCP server", () => {
  const result = spawnSync("node", [builtCliEntrypoint, "mcp", "list"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: process.env,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MCP servers/i);
  assert.match(
    result.stdout,
    /mmbridge \| stdio \| project \| project config/i,
  );
});
