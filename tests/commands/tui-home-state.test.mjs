import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildTuiHomeState } from "../../apps/unclecode-cli/src/operational.ts";
import { publishContextBridge, writeScopedMemory } from "../../src/context-memory.ts";

test("buildTuiHomeState surfaces bridge and project memory lines for the session center", async () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-tui-home-"));
  const homeRoot = path.join(workspaceRoot, ".home");
  mkdirSync(homeRoot, { recursive: true });
  mkdirSync(path.join(workspaceRoot, ".unclecode"), { recursive: true });
  writeFileSync(path.join(workspaceRoot, ".unclecode", "config.json"), '{"mode":"analyze"}\n', "utf8");

  const env = {
    HOME: homeRoot,
    UNCLECODE_SESSION_STORE_ROOT: path.join(homeRoot, "state"),
  };

  await publishContextBridge({
    cwd: workspaceRoot,
    env,
    summary: "Bridge line from work shell",
    source: "work-shell",
    target: "project-context",
    kind: "summary",
  });

  await writeScopedMemory({
    scope: "project",
    cwd: workspaceRoot,
    env,
    summary: "Remember this workspace objective",
  });

  const state = await buildTuiHomeState({
    workspaceRoot,
    env,
    userHomeDir: homeRoot,
  });

  assert.ok(state.bridgeLines.some((line) => /Bridge line from work shell/.test(line)));
  assert.ok(state.memoryLines.some((line) => /Remember this workspace objective/.test(line)));
});
