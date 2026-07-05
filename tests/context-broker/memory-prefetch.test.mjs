import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  prefetchScopedMemory,
  writeScopedMemory,
} from "../../packages/context-broker/src/index.ts";

describe("memory prefetch", () => {
  it("returns transparency lines for session and project scopes", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-memory-prefetch-"));
    const rootDir = path.join(cwd, ".state");
    const env = { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir };

    await writeScopedMemory({
      scope: "session",
      cwd,
      env,
      sessionId: "work-prefetch-1",
      summary: "Session remembers the latest runtime split.",
    });
    await writeScopedMemory({
      scope: "project",
      cwd,
      env,
      summary: "Project keeps the release objective visible.",
    });

    const result = await prefetchScopedMemory({
      cwd,
      env,
      sessionId: "work-prefetch-1",
      timeoutMs: 500,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.entries.length, 2);
    assert.ok(result.lines.some((line) => /session · .*runtime split/.test(line)));
    assert.ok(result.lines.some((line) => /project · .*release objective/.test(line)));
    assert.ok(result.lines.every((line) => / · cite memory:/.test(line)));
  });

  it("degrades to empty memory lines when prefetch exceeds the timeout budget", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-memory-prefetch-timeout-"));
    const rootDir = path.join(cwd, ".state");
    const env = { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir };

    await writeScopedMemory({
      scope: "session",
      cwd,
      env,
      sessionId: "work-prefetch-timeout",
      summary: "Should not block startup.",
    });

    const result = await prefetchScopedMemory({
      cwd,
      env,
      sessionId: "work-prefetch-timeout",
      timeoutMs: 5,
      loadEntries: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return [];
      },
    });

    assert.equal(result.status, "degraded");
    assert.deepEqual(result.lines, []);
    assert.match(result.reason ?? "", /timed out/i);
  });

  it("excludes synthetic bootstrap memory facts from prefetch budget", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-memory-prefetch-bootstrap-"));
    const rootDir = path.join(cwd, ".state");
    const env = { ...process.env, UNCLECODE_SESSION_STORE_ROOT: rootDir };

    await writeScopedMemory({
      scope: "project",
      cwd,
      env,
      summary: "Bootstrap context: 2 guidance, 1 cursor rules, 3 skills, 1 MCP servers.",
    });
    await writeScopedMemory({
      scope: "project",
      cwd,
      env,
      summary: "Project keeps the release objective visible.",
    });

    const result = await prefetchScopedMemory({
      cwd,
      env,
      timeoutMs: 500,
      limit: 6,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.entries.length, 1);
    assert.ok(result.lines.some((line) => /release objective/.test(line)));
    assert.ok(result.lines.every((line) => !/Bootstrap context:/.test(line)));
  });
});
