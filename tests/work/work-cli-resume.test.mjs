import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
    entries: [
      { role: "user", text: "inspect repo" },
      { role: "assistant", text: "repo inspected" },
    ],
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
  assert.equal(resumed.initialSessionSummary, "Chat: inspect repo");
  assert.deepEqual(resumed.initialEntries, [
    { role: "user", text: "inspect repo" },
    { role: "assistant", text: "repo inspected" },
  ]);
});

test("loadResumedWorkSession falls back to legacy session memory summaries when checkpoints have no transcript entries", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-work-resume-legacy-"));
  const sessionStoreRoot = path.join(cwd, ".state");
  await persistWorkShellSessionSnapshot({
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
    sessionId: "work-session-legacy",
    model: "gpt-5.4",
    mode: "analyze",
    state: "idle",
    summary: "Chat: 반가워",
    traceMode: "minimal",
  });
  mkdirSync(path.join(sessionStoreRoot, "memory", "sessions"), { recursive: true });
  writeFileSync(
    path.join(sessionStoreRoot, "memory", "sessions", "work-session-legacy.jsonl"),
    `${JSON.stringify({
      memoryId: "memory:session:1",
      scope: "session",
      summary: "Q: 반가워 · A: 반가워요! 무엇을 도와드릴까요?",
      timestamp: "2026-01-01T00:00:00.000Z",
    })}\n`,
    "utf8",
  );

  const resumed = await loadResumedWorkSession({
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
    sessionId: "work-session-legacy",
  });

  assert.deepEqual(resumed.initialEntries, [
    { role: "user", text: "반가워" },
    { role: "assistant", text: "반가워요! 무엇을 도와드릴까요?" },
  ]);
});

test("loadResumedWorkSession restores only privacy-minimized transcript entries", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-work-resume-private-"));
  const sessionStoreRoot = path.join(cwd, ".state");
  await persistWorkShellSessionSnapshot({
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
    sessionId: "work-session-private",
    model: "gpt-5.4",
    mode: "analyze",
    state: "idle",
    summary: "Chat: inspect referenced file",
    traceMode: "minimal",
    entries: [
      { role: "system", text: "internal shell state" },
      {
        role: "user",
        text: [
          "inspect the referenced file",
          "",
          "Referenced file: secrets.txt",
          "OPENAI_API_KEY=sk-private-resume-token",
          "private file content should not persist",
          "Referenced file: secrets.txt",
        ].join("\n"),
      },
      { role: "tool", text: "tool output should not resume" },
      { role: "assistant", text: "I saw sk-private-assistant-token and summarized it." },
    ],
  });

  const resumed = await loadResumedWorkSession({
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
    sessionId: "work-session-private",
  });

  assert.deepEqual(resumed.initialEntries, [
    { role: "user", text: "inspect the referenced file\nReferenced file: secrets.txt" },
    { role: "assistant", text: "I saw [REDACTED] and summarized it." },
  ]);
  assert.doesNotMatch(JSON.stringify(resumed.initialEntries), /private file content|sk-private|internal shell state|tool output/);
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
