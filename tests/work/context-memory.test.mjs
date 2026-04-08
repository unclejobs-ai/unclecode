import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listProjectBridgeLines,
  listScopedMemoryLines,
  publishContextBridge,
  writeScopedMemory,
} from "../../src/context-memory.ts";

test("publishContextBridge writes project bridge summaries for later reuse", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-bridge-"));
  const rootDir = path.join(cwd, ".state");

  const bridge = await publishContextBridge({
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir },
    summary: "Investigated MCP startup latency",
    source: "planner",
    target: "executor",
    kind: "summary",
  });
  const lines = await listProjectBridgeLines(cwd, {
    ...process.env,
    UNCLECODE_SESSION_STORE_ROOT: rootDir,
  });

  assert.match(bridge.line, /planner/);
  assert.ok(lines.some((line) => /Investigated MCP startup latency/.test(line)));
});

test("writeScopedMemory persists session and user memories separately", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-memory-"));
  const rootDir = path.join(cwd, ".state");

  await writeScopedMemory({
    scope: "session",
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir },
    sessionId: "work-1",
    summary: "Session learned current build is green.",
  });
  await writeScopedMemory({
    scope: "user",
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir },
    summary: "User prefers visible reasoning and fast startup.",
  });

  const sessionLines = await listScopedMemoryLines({
    scope: "session",
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir },
    sessionId: "work-1",
  });
  const userLines = await listScopedMemoryLines({
    scope: "user",
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir },
  });

  assert.ok(sessionLines.some((line) => /build is green/.test(line)));
  assert.ok(userLines.some((line) => /visible reasoning/.test(line)));
});
