import assert from "node:assert/strict";
import test from "node:test";

import {
  createCliSlashCommandRegistry,
  createWorkShellCommandRegistry,
} from "@unclecode/orchestrator";

test("CLI slash command registry exposes builtin command metadata and routes", () => {
  const registry = createCliSlashCommandRegistry();
  const commands = registry.list();

  assert.ok(commands.some((entry) => entry.command === "/doctor" && entry.metadata.source === "builtin"));
  assert.ok(commands.some((entry) => entry.command === "/mode status" && entry.metadata.type === "local"));
  assert.deepEqual(registry.resolve("/help"), ["--help"]);
  assert.deepEqual(registry.resolve("/research status"), ["research", "status"]);
  assert.deepEqual(registry.resolve("/ses"), ["sessions"]);
});

test("work-shell command registry shares builtin metadata for inline operational commands", () => {
  const registry = createWorkShellCommandRegistry();
  const commands = registry.list();

  assert.ok(commands.some((entry) => entry.command === "/auth status" && entry.metadata.source === "builtin"));
  assert.ok(commands.some((entry) => entry.command === "/browser" && entry.metadata.aliases?.includes("/auth login")));
  assert.ok(commands.some((entry) => entry.command === "/auth logout" && entry.metadata.source === "builtin"));
  assert.ok(commands.some((entry) => entry.command === "/reload" && entry.metadata.source === "builtin"));
  assert.ok(commands.some((entry) => entry.command === "/review" && entry.metadata.type === "prompt"));
  assert.ok(commands.some((entry) => entry.command === "/commit" && entry.metadata.type === "prompt"));
  assert.ok(commands.some((entry) => entry.command === "/research" && entry.metadata.type === "prompt"));
  assert.ok(commands.some((entry) => entry.command === "/research status" && entry.metadata.type === "local"));
  assert.deepEqual(registry.resolve("/auth login"), ["auth", "login"]);
  assert.deepEqual(registry.resolve("/auth logout"), ["auth", "logout"]);
  assert.deepEqual(registry.resolve("/reload"), ["reload"]);
  assert.deepEqual(registry.resolve("/rev"), ["prompt", "review"]);
  assert.deepEqual(registry.resolve("/com"), ["prompt", "commit"]);
  assert.deepEqual(registry.resolve("/research"), ["research", "run"]);
  assert.deepEqual(registry.resolve("/research status"), ["research", "status"]);
  assert.equal(registry.resolve("/aut"), undefined);
  assert.deepEqual(registry.resolve("/mode status"), ["mode", "status"]);
  assert.equal(registry.resolve("/unknown"), undefined);
});

test("command registries can accept plugin or skill provided entries", () => {
  const registry = createWorkShellCommandRegistry([
    {
      command: "/analyze",
      routeTo: ["skill", "analyze"],
      metadata: {
        name: "analyze",
        description: "Inspect the repo deeply.",
        type: "prompt",
        source: "skills",
        userInvocable: true,
      },
    },
  ]);

  assert.deepEqual(registry.resolve("/analyze"), ["skill", "analyze"]);
  assert.ok(
    registry.list().some(
      (entry) => entry.command === "/analyze" && entry.metadata.source === "skills",
    ),
  );
});
