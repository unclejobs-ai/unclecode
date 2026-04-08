import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createMcpHostController,
  createMcpHostRegistry,
  getResearchMcpProfile,
} from "../../packages/mcp-host/src/index.ts";

test("createMcpHostRegistry merges user and project servers with project precedence", () => {
  const registry = createMcpHostRegistry({
    userServers: {
      memory: {
        type: "stdio",
        command: "node",
        args: ["memory.js"],
        scope: "user",
      },
      shared: {
        type: "stdio",
        command: "node",
        args: ["user-shared.js"],
        scope: "user",
      },
    },
    projectServers: {
      shared: {
        type: "stdio",
        command: "node",
        args: ["project-shared.js"],
        scope: "project",
      },
      repo: {
        type: "http",
        url: "http://localhost:8787/mcp",
        scope: "project",
      },
    },
  });

  assert.equal(registry.entries.length, 3);
  assert.equal(registry.entries.find((entry) => entry.name === "shared")?.scope, "project");
  assert.equal(registry.entries.find((entry) => entry.name === "shared")?.originLabel, "project config");
  assert.equal(registry.entries.find((entry) => entry.name === "memory")?.trustTier, "user");
  assert.equal(registry.entries.find((entry) => entry.name === "repo")?.trustTier, "project");
});

test("getResearchMcpProfile returns only tool-capable connected entries", () => {
  const registry = createMcpHostRegistry({
    userServers: {
      docs: {
        type: "stdio",
        command: "node",
        scope: "user",
      },
    },
  });

  const profile = getResearchMcpProfile(registry, {
    enabledServerNames: ["docs"],
  });

  assert.equal(profile.profileName, "research-default");
  assert.deepEqual(profile.serverNames, ["docs"]);
});

test("createMcpHostController can start and stop a stdio server profile", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "unclecode-mcp-host-"));
  const scriptPath = path.join(tempDir, "server.js");

  try {
    writeFileSync(scriptPath, "setInterval(() => {}, 1000);", "utf8");

    const registry = createMcpHostRegistry({
      projectServers: {
        memory: {
          type: "stdio",
          command: process.execPath,
          args: [scriptPath],
          scope: "project",
        },
      },
    });

    const controller = createMcpHostController(registry);
    const started = await controller.startProfile({
      profileName: "research-default",
      serverNames: ["memory"],
    });

    assert.equal(started.connectedServerNames[0], "memory");
    assert.equal(started.connections[0]?.state, "connected");
    assert.equal(started.connections[0]?.transport, "stdio");
    assert.equal(typeof started.connections[0]?.pid, "number");

    await controller.stopProfile(started);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("createMcpHostController marks http servers as connected without spawning child processes", async () => {
  const registry = createMcpHostRegistry({
    projectServers: {
      repo: {
        type: "http",
        url: "http://localhost:8787/mcp",
        scope: "project",
      },
    },
  });

  const controller = createMcpHostController(registry);
  const started = await controller.startProfile({
    profileName: "research-default",
    serverNames: ["repo"],
  });

  assert.equal(started.connectedServerNames[0], "repo");
  assert.equal(started.connections[0]?.state, "connected");
  assert.equal(started.connections[0]?.transport, "http");
  assert.equal(started.connections[0]?.pid, null);
});
