import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadMcpHostRegistry } from "@unclecode/mcp-host";

test("loadMcpHostRegistry resolves relative stdio command args against config location", () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-mcp-host-"));

  try {
    mkdirSync(path.join(workspaceRoot, "scripts"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, "scripts", "run-mmbridge-mcp.mjs"),
      "#!/usr/bin/env node\n",
      "utf8",
    );
    writeFileSync(
      path.join(workspaceRoot, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            mmbridge: {
              type: "stdio",
              command: "node",
              args: ["./scripts/run-mmbridge-mcp.mjs"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const registry = loadMcpHostRegistry({ workspaceRoot });
    const entry = registry.byName.get("mmbridge");
    assert.ok(entry);
    assert.equal(entry?.config.type, "stdio");
    assert.equal(entry?.config.command, "node");
    assert.equal(
      entry?.config.args?.[0],
      path.join(workspaceRoot, "scripts", "run-mmbridge-mcp.mjs"),
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
