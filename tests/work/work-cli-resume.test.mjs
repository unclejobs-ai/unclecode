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
    agentConsole: {
      profileId: "build",
      manifest: {
        id: "manifest-42",
        profileId: "build",
        createdAt: "2026-07-12T00:00:00.000Z",
        packetId: "packet-42",
        policy: [],
        includedSourceCount: 2,
        excludedSourceCount: 1,
        tokenEstimate: 42,
      },
      activity: [{
        id: "activity-42",
        toolCallId: "call-42",
        toolName: "read_file",
        kind: "read",
        intent: `Read token sk-proj-${"a".repeat(30)}`,
        status: "completed",
        startedAt: 1,
        output: "raw tool output must not resume",
      }],
    },
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
  assert.deepEqual(resumed.initialAgentConsole, {
    profileId: "build",
    manifest: {
      id: "manifest-42",
      profileId: "build",
      createdAt: "2026-07-12T00:00:00.000Z",
      packetId: "packet-42",
      policy: [],
      includedSourceCount: 2,
      excludedSourceCount: 1,
      tokenEstimate: 42,
    },
    activity: [{
      id: "activity-42",
      toolCallId: "call-42",
      toolName: "read_file",
      kind: "read",
      intent: "Read token [REDACTED]",
      status: "completed",
      startedAt: 1,
    }],
    agents: [],
    jobs: [],
  });
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

test("loadResumedWorkSession round-trips safe lifecycle records and settles unrecoverable work once", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-work-resume-console-"));
  const sessionStoreRoot = path.join(cwd, ".state");
  const before = Date.now();
  await persistWorkShellSessionSnapshot({
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
    sessionId: "work-session-console",
    model: "gpt-5.4",
    mode: "ultrawork",
    state: "running",
    summary: "Chat: dispatch the plan",
    traceMode: "minimal",
    entries: [{ role: "user", text: "dispatch the plan" }],
    agentConsole: {
      profileId: "build",
      activity: [],
      agents: [
        {
          id: "run-running",
          displayName: "Executor A",
          agentType: "executor",
          status: "running",
          currentActivity: "Reading auth.ts",
          startedAt: 10,
        },
        {
          id: "run-waiting",
          displayName: "Executor B",
          agentType: "executor",
          status: "waiting",
          startedAt: 11,
        },
        {
          id: "run-done",
          displayName: "Executor C",
          agentType: "executor",
          status: "completed",
          parentRunId: "run-running",
          transcriptRef: "transcripts/run-done.jsonl",
          startedAt: 12,
          completedAt: 30,
          summary: "Refactored the auth guard.",
          usage: {
            eventIds: ["usage-run-done"],
            inputTokens: 120,
            outputTokens: 40,
            costUsd: 0.002,
            routes: [{
              provider: "openai",
              model: "gpt-5.6-sol",
              eventIds: ["usage-run-done"],
              inputTokens: 120,
              outputTokens: 40,
              costUsd: 0.002,
            }],
          },
        },
      ],
      jobs: [
        { id: "job-queued", type: "executor", label: "Plan step one", status: "queued", queuedAt: 5 },
        {
          id: "job-done",
          type: "executor",
          label: "Plan step two",
          status: "completed",
          agentRunId: "run-done",
          queuedAt: 6,
          startedAt: 12,
          completedAt: 31,
          summary: "Plan step two finished.",
        },
      ],
      mainUsage: {
        eventIds: ["usage-main"],
        inputTokens: 900,
        outputTokens: 150,
        cacheReadTokens: 400,
        costUsd: 0.01,
        routes: [{
          provider: "openai",
          model: "gpt-5.6-sol",
          eventIds: ["usage-main"],
          inputTokens: 900,
          outputTokens: 150,
          cacheReadTokens: 400,
          costUsd: 0.01,
        }],
      },
    },
  });

  const resumed = await loadResumedWorkSession({
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
    sessionId: "work-session-console",
  });
  const after = Date.now();

  const resumedConsole = resumed.initialAgentConsole;
  assert.ok(resumedConsole);
  assert.equal(resumedConsole.profileId, "build");

  // Safe lifecycle records survive the durable gate.
  assert.deepEqual(
    resumedConsole.agents.map((agent) => [agent.id, agent.status]),
    [["run-running", "interrupted"], ["run-waiting", "interrupted"], ["run-done", "completed"]],
  );
  assert.deepEqual(
    resumedConsole.jobs.map((job) => [job.id, job.status]),
    [["job-queued", "interrupted"], ["job-done", "completed"]],
  );
  assert.equal(resumedConsole.agents[2]?.summary, "Refactored the auth guard.");
  assert.equal(resumedConsole.agents[2]?.parentRunId, "run-running");
  assert.equal(resumedConsole.agents[2]?.transcriptRef, "transcripts/run-done.jsonl");
  assert.deepEqual(resumedConsole.agents[2]?.usage?.eventIds, ["usage-run-done"]);
  assert.equal(resumedConsole.agents[2]?.usage?.routes?.[0]?.model, "gpt-5.6-sol");
  assert.equal(resumedConsole.jobs[1]?.summary, "Plan step two finished.");
  assert.equal(resumedConsole.jobs[1]?.agentRunId, "run-done");
  assert.equal(resumedConsole.mainUsage?.inputTokens, 900);
  assert.equal(resumedConsole.mainUsage?.cacheReadTokens, 400);
  assert.deepEqual(resumedConsole.mainUsage?.eventIds, ["usage-main"]);

  // Unrecoverable work settles exactly once: interrupted records gain one
  // completion stamped at the resume, settled records keep their own.
  assert.equal(resumedConsole.agents[2]?.completedAt, 30);
  assert.equal(resumedConsole.jobs[1]?.completedAt, 31);
  for (const completedAt of [
    resumedConsole.agents[0]?.completedAt,
    resumedConsole.agents[1]?.completedAt,
    resumedConsole.jobs[0]?.completedAt,
  ]) {
    assert.ok(typeof completedAt === "number" && completedAt >= before && completedAt <= after);
  }
  assert.equal(
    resumedConsole.agents.some(
      (agent) => agent.status === "queued" || agent.status === "running" || agent.status === "waiting",
    ),
    false,
  );
  assert.equal(
    resumedConsole.jobs.some((job) => job.status === "queued" || job.status === "running"),
    false,
  );
});

test("loadResumedWorkSession drops unknown and secret-looking lifecycle fields", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-work-resume-console-secret-"));
  const sessionStoreRoot = path.join(cwd, ".state");
  await persistWorkShellSessionSnapshot({
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
    sessionId: "work-session-console-secret",
    model: "gpt-5.4",
    mode: "ultrawork",
    state: "running",
    summary: "Chat: dispatch the plan",
    traceMode: "minimal",
    entries: [],
    agentConsole: {
      profileId: "build",
      activity: [],
      agents: [{
        id: "run-1",
        displayName: "Executor A",
        agentType: "executor",
        status: "completed",
        startedAt: 10,
        completedAt: 30,
        summary: `Used key sk-proj-${"a".repeat(30)} while refactoring.`,
        systemPrompt: "You are an executor.",
        rawAssignment: "internal worker assignment text",
        providerApiKey: `sk-proj-${"b".repeat(30)}`,
      }],
      jobs: [{
        id: "job-1",
        type: "executor",
        label: "Plan step one",
        status: "completed",
        queuedAt: 5,
        completedAt: 31,
        summary: "Plan step one finished.",
        credential: `ghp_${"1".repeat(36)}`,
      }],
    },
  });

  const resumed = await loadResumedWorkSession({
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
    sessionId: "work-session-console-secret",
  });

  const resumedConsole = resumed.initialAgentConsole;
  assert.ok(resumedConsole);
  assert.equal(resumedConsole.agents[0]?.summary, "Used key [REDACTED] while refactoring.");
  assert.equal(resumedConsole.jobs[0]?.summary, "Plan step one finished.");
  assert.doesNotMatch(
    JSON.stringify(resumedConsole),
    /systemPrompt|rawAssignment|providerApiKey|credential|sk-proj-|ghp_/,
  );
});

test("loadResumedWorkSession keeps an oversized console interruptible instead of resuming empty", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-work-resume-console-oversized-"));
  const sessionStoreRoot = path.join(cwd, ".state");
  const longSummary = "s".repeat(400);
  const agents = Array.from({ length: 128 }, (unused, index) => {
    const active = index >= 120;
    return {
      id: `run-${index}`,
      displayName: `Executor ${index}`,
      agentType: "executor",
      status: active ? "running" : "completed",
      startedAt: 1_000 + index,
      ...(active ? {} : { completedAt: 2_000 + index }),
      summary: longSummary,
      transcriptRef: `transcripts/run-${index}.jsonl`,
    };
  });
  const jobs = Array.from({ length: 128 }, (unused, index) => {
    const active = index >= 120;
    return {
      id: `job-${index}`,
      type: "executor",
      label: `Plan step ${index}`,
      status: active ? "queued" : "completed",
      queuedAt: 900 + index,
      ...(active ? {} : { completedAt: 2_100 + index }),
      summary: longSummary,
    };
  });
  const activity = Array.from({ length: 80 }, (unused, index) => ({
    id: `activity-${index}`,
    toolCallId: `call-${index}`,
    toolName: "read_file",
    kind: "read",
    intent: "i".repeat(400),
    status: "completed",
    startedAt: 1,
  }));

  await persistWorkShellSessionSnapshot({
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
    sessionId: "work-session-oversized",
    model: "gpt-5.4",
    mode: "ultrawork",
    state: "running",
    summary: "Chat: dispatch the plan",
    traceMode: "minimal",
    entries: [],
    agentConsole: {
      profileId: "build",
      activity,
      agents,
      jobs,
      mainUsage: {
        eventIds: Array.from({ length: 64 }, (unusedId, slot) => `usage-main-${slot}`),
        inputTokens: 900,
        outputTokens: 150,
        cacheReadTokens: 400,
        costUsd: 0.01,
      },
    },
  });

  const resumed = await loadResumedWorkSession({
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
    sessionId: "work-session-oversized",
  });

  const resumedConsole = resumed.initialAgentConsole;
  assert.ok(resumedConsole, "an oversized but legal console must not resume as missing");
  assert.ok(resumedConsole.agents.length > 0);
  assert.ok(resumedConsole.jobs.length > 0);

  // The trimmed projection still reaches the resume interruption gate.
  for (let index = 120; index < 128; index += 1) {
    const run = resumedConsole.agents.find((agent) => agent.id === `run-${index}`);
    assert.ok(run, `active run-${index} must survive fitting`);
    assert.equal(run.status, "interrupted");
    const job = resumedConsole.jobs.find((entry) => entry.id === `job-${index}`);
    assert.ok(job, `active job-${index} must survive fitting`);
    assert.equal(job.status, "interrupted");
  }
  assert.equal(
    resumedConsole.agents.some(
      (agent) => agent.status === "queued" || agent.status === "running" || agent.status === "waiting",
    ),
    false,
  );
  assert.equal(
    resumedConsole.jobs.some((job) => job.status === "queued" || job.status === "running"),
    false,
  );

  // Oldest terminal history paid for the budget; aggregate counters did not.
  assert.ok(resumedConsole.agents.length < 128);
  assert.equal(resumedConsole.agents.some((agent) => agent.id === "run-0"), false);
  assert.equal(resumedConsole.mainUsage?.inputTokens, 900);
  assert.equal(resumedConsole.mainUsage?.outputTokens, 150);
  assert.equal(resumedConsole.mainUsage?.cacheReadTokens, 400);
});

test("loadResumedWorkSession spends oversized shell metadata before active work", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-work-resume-console-shell-"));
  const sessionStoreRoot = path.join(cwd, ".state");

  await persistWorkShellSessionSnapshot({
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
    sessionId: "work-session-shell",
    model: "gpt-5.4",
    mode: "ultrawork",
    state: "running",
    summary: "Chat: dispatch the plan",
    traceMode: "minimal",
    entries: [],
    agentConsole: {
      profileId: "build",
      activity: [],
      manifest: {
        id: "manifest-oversized",
        profileId: "build",
        createdAt: "2026-08-09T00:00:00.000Z",
        packetId: "packet-oversized",
        includedSourceCount: 400,
        excludedSourceCount: 0,
        tokenEstimate: 4_000,
        policy: Array.from({ length: 400 }, (unused, index) => ({
          id: `policy-${index}`,
          label: "l".repeat(400),
          authority: "mandatory",
          digest: `digest-${index}`,
        })),
      },
      pendingDecision: {
        id: "decision-oversized",
        title: "Execution choice",
        questions: Array.from({ length: 400 }, (unused, index) => ({
          id: `question-${index}`,
          question: "q".repeat(400),
          recommended: 0,
          options: [
            { label: "Safe", description: "d".repeat(400) },
            { label: "Fast", description: "d".repeat(400) },
          ],
        })),
      },
      agents: [{
        id: "run-active",
        displayName: "Executor A",
        agentType: "executor",
        status: "running",
        startedAt: 10,
      }],
      jobs: [{
        id: "job-active",
        type: "executor",
        label: "Plan step one",
        status: "queued",
        queuedAt: 5,
      }],
      mainUsage: {
        eventIds: ["usage-main"],
        inputTokens: 900,
        outputTokens: 150,
        cacheReadTokens: 400,
        costUsd: 0.01,
      },
    },
  });

  const resumed = await loadResumedWorkSession({
    cwd,
    env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
    sessionId: "work-session-shell",
  });

  const resumedConsole = resumed.initialAgentConsole;
  assert.ok(resumedConsole, "oversized shell metadata must not evict the whole console");

  // Active identity outlived the optional shell metadata and still reached the
  // resume interruption gate.
  assert.deepEqual(
    resumedConsole.agents.map((agent) => [agent.id, agent.status]),
    [["run-active", "interrupted"]],
  );
  assert.deepEqual(
    resumedConsole.jobs.map((job) => [job.id, job.status]),
    [["job-active", "interrupted"]],
  );
  assert.equal(resumedConsole.mainUsage?.inputTokens, 900);
  assert.equal(resumedConsole.mainUsage?.outputTokens, 150);
  assert.equal(resumedConsole.mainUsage?.cacheReadTokens, 400);
  assert.equal(resumedConsole.manifest, undefined);
  assert.equal(resumedConsole.pendingDecision, undefined);
});
