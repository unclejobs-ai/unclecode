import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { persistWorkShellSessionSnapshot } from "@unclecode/orchestrator";

import { loadResumedWorkSession } from "../../apps/unclecode-cli/src/work-runtime.ts";

test("loadResumedWorkSession restores persisted trace mode and reasoning override for work sessions", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-work-resume-"));
  const sessionStoreRoot = path.join(cwd, ".state");
  await persistWorkShellSessionSnapshot({
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
    sessionId: "work-session-42",
    model: "gpt-5.4",
    mode: "analyze",
    state: "idle",
    summary: "Chat: inspect repo",
    traceMode: "verbose",
    reasoningEffort: "low",
  });

  const resumed = await loadResumedWorkSession({
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
    sessionId: "work-session-42",
  });

  assert.equal(resumed.sessionId, "work-session-42");
  assert.equal(resumed.initialTraceMode, "verbose");
  assert.equal(resumed.reasoningEffort, "low");
  assert.match(resumed.contextLine, /Resumed session: work-session-42/);
});

test("loadResumedWorkSession rejects unknown work sessions", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-work-resume-missing-"));
  const sessionStoreRoot = path.join(cwd, ".state");

  await assert.rejects(
    () =>
      loadResumedWorkSession({
        cwd,
        env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
        sessionId: "work-session-missing",
      }),
    /Session not found: work-session-missing/,
  );
});
