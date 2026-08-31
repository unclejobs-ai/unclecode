import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadWorkCliBootstrap } from "../../apps/unclecode-cli/src/work-runtime-bootstrap.ts";

test("owner bootstrap retains only bounded redacted MCP configuration evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-observability-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  let loaded;
  try {
    await mkdir(workspace);
    await mkdir(home);
    await writeFile(join(workspace, ".mcp.json"), JSON.stringify({
      mcpServers: Object.fromEntries(Array.from({ length: 80 }, (_, index) => [
        `server-${String(index).padStart(3, "0")}`,
        { type: "stdio", command: `/secret/command-${index}`, args: [`token-${index}`] },
      ])),
    }));

    loaded = await loadWorkCliBootstrap({
      argv: ["--cwd", workspace, "--provider", "deepseek", "--model", "deepseek-chat"],
      role: "owner",
      userHomeDir: home,
      env: {
        HOME: home,
        PATH: process.env.PATH,
        DEEPSEEK_API_KEY: "test-only-key",
        UNCLECODE_SESSION_STORE_ROOT: join(root, "sessions"),
        ...(process.env.CARGO_HOME ? { CARGO_HOME: process.env.CARGO_HOME } : {}),
        ...(process.env.RUSTUP_HOME ? { RUSTUP_HOME: process.env.RUSTUP_HOME } : {}),
      },
    });

    const evidence = loaded.readObservability?.();
    assert.equal(evidence?.mcpServers?.length, 64);
    assert.equal(evidence?.mcpConfigurationStatus, "available");
    assert.equal(evidence?.mcpServers?.[0]?.name, "server-000");
    assert.equal(evidence?.mcpServers?.[63]?.name, "server-063");
    assert.ok(evidence?.mcpServers?.every((server) =>
      server.configured === true
      && server.authentication === "unverified"
      && server.liveProbe === "not-run"
      && !("command" in server)
      && !("args" in server)));
  } finally {
    await loaded?.dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("owner bootstrap records malformed MCP configuration as unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "unclecode-owner-observability-unavailable-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  let loaded;
  try {
    await mkdir(workspace);
    await mkdir(home);
    await writeFile(join(workspace, ".mcp.json"), "{ malformed");
    loaded = await loadWorkCliBootstrap({
      argv: ["--cwd", workspace, "--provider", "deepseek", "--model", "deepseek-chat"],
      role: "owner",
      userHomeDir: home,
      env: {
        HOME: home,
        PATH: process.env.PATH,
        DEEPSEEK_API_KEY: "test-only-key",
        UNCLECODE_SESSION_STORE_ROOT: join(root, "sessions"),
      },
    });

    const evidence = loaded.readObservability?.();
    assert.equal(evidence?.mcpConfigurationStatus, "unavailable");
    assert.deepEqual(evidence?.mcpServers, []);
  } finally {
    await loaded?.dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});
