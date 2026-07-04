import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listProjectBridgeLines,
  listScopedMemoryEntries,
  listScopedMemoryLines,
  publishContextBridge,
  writeScopedMemory,
} from "../../packages/context-broker/src/index.ts";

test("context-broker exports project bridge and scoped memory helpers", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-context-broker-memory-"));
  const rootDir = path.join(cwd, ".state");
  const env = { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir };

  const bridge = await publishContextBridge({
    cwd,
    env,
    summary: "Summarized work-shell runtime state",
    source: "work-shell",
    target: "session-center",
    kind: "summary",
  });

  await writeScopedMemory({
    scope: "session",
    cwd,
    env,
    sessionId: "work-ctx-1",
    summary: "Session remembers the latest runtime split.",
  });

  const bridgeLines = await listProjectBridgeLines(cwd, env);
  const sessionLines = await listScopedMemoryLines({
    scope: "session",
    cwd,
    env,
    sessionId: "work-ctx-1",
  });

  assert.match(bridge.line, /work-shell/);
  assert.ok(bridgeLines.some((line) => /runtime state/.test(line)));
  assert.ok(sessionLines.some((line) => /latest runtime split/.test(line)));
});

test("listScopedMemoryEntries preserves scope, citation id, and timestamp metadata", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-context-broker-entries-"));
  const rootDir = path.join(cwd, ".state");
  const env = { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir };

  await writeScopedMemory({
    scope: "session",
    cwd,
    env,
    sessionId: "work-ctx-entries",
    summary: "Session remembers the latest runtime split.",
  });

  const entries = await listScopedMemoryEntries({
    scope: "session",
    cwd,
    env,
    sessionId: "work-ctx-entries",
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.scope, "session");
  assert.match(entries[0]?.memoryId ?? "", /^memory:session:/);
  assert.ok(entries[0]?.timestamp.length > 0);
});
