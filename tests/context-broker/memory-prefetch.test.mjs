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

  it("filters inactive lineage before applying the prefetch limit", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-memory-prefetch-lineage-"));
    const env = { ...process.env, UNCLECODE_SESSION_STORE_ROOT: path.join(cwd, ".state") };
    const sessionId = "work-prefetch-lineage";
    const active = await writeScopedMemory({
      scope: "session",
      cwd,
      env,
      sessionId,
      summary: "Older active memory remains visible.",
    });
    const superseded = await writeScopedMemory({
      scope: "session",
      cwd,
      env,
      sessionId,
      summary: "Superseded memory is hidden.",
    });
    const expiring = await writeScopedMemory({
      scope: "session",
      cwd,
      env,
      sessionId,
      summary: "Expired memory is hidden.",
    });
    await writeScopedMemory({
      scope: "session",
      cwd,
      env,
      sessionId,
      summary: "Untracked memory is hidden.",
    });
    const states = new Map([
      [active.memoryId, "active"],
      [superseded.memoryId, "superseded"],
      [expiring.memoryId, "active"],
    ]);
    let expiryRuns = 0;
    const lineage = {
      record() {
        throw new Error("not used");
      },
      invalidate() {
        throw new Error("not used");
      },
      expire() {
        expiryRuns += 1;
        states.set(expiring.memoryId, "expired");
        return 1;
      },
      get(memoryId) {
        const state = states.get(memoryId);
        return state === undefined ? undefined : {
          memoryId,
          sourceId: "assistant-summary",
          originTurnId: "turn-1",
          originPacketReceiptId: "receipt-1",
          state,
          confidence: 0.9,
          createdAt: "2026-07-13T00:00:00.000Z",
        };
      },
      isActive(memoryId) {
        return states.get(memoryId) === "active";
      },
    };

    const result = await prefetchScopedMemory({
      cwd,
      env,
      sessionId,
      scopes: ["session"],
      limit: 1,
      lineage,
    });

    assert.equal(result.status, "ok");
    assert.equal(expiryRuns, 1);
    assert.deepEqual(result.entries.map((entry) => entry.memoryId), [active.memoryId]);
    assert.equal(result.entries[0]?.scope, "session");
    assert.match(result.lines[0] ?? "", /Older active memory remains visible/);
  });
});
