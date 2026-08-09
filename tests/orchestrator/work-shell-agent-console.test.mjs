import assert from "node:assert/strict";
import test from "node:test";

import { applyTraceEventToAgentConsole } from "@unclecode/orchestrator";

const initialConsole = Object.freeze({ profileId: "build", activity: [], agents: [], jobs: [] });

test("tool activity reducer records a safe lifecycle without raw tool output", () => {
  const running = applyTraceEventToAgentConsole(initialConsole, {
    type: "tool.started",
    toolCallId: "call-1",
    toolName: "read_file",
    input: { i: "Reading session state", path: "sessions/state.json" },
    startedAt: 100,
  });
  const completed = applyTraceEventToAgentConsole(running, {
    type: "tool.completed",
    toolCallId: "call-1",
    toolName: "read_file",
    input: { path: "sessions/state.json" },
    startedAt: 100,
    completedAt: 145,
    durationMs: 45,
    isError: false,
    output: "unbounded raw stdout must not be retained",
  });

  assert.deepEqual(completed.activity, [{
    id: "tool:call-1",
    toolCallId: "call-1",
    toolName: "read_file",
    kind: "read",
    intent: "Reading session state",
    status: "completed",
    target: "sessions/state.json",
    summary: "completed · 45ms · 1 line",
    startedAt: 100,
    completedAt: 145,
  }]);
  assert.doesNotMatch(JSON.stringify(completed), /unbounded raw stdout/);
});

test("tool activity reducer preserves failures and ignores incomplete trace events", () => {
  const unchanged = applyTraceEventToAgentConsole(initialConsole, { type: "tool.completed" });
  assert.strictEqual(unchanged, initialConsole);

  const completed = applyTraceEventToAgentConsole(initialConsole, {
    type: "tool.completed",
    toolCallId: "call-2",
    toolName: "run_shell",
    input: { command: "npm test" },
    startedAt: 10,
    completedAt: 35,
    isError: true,
    output: "test failure details",
  });

  assert.deepEqual(completed.activity, [{
    id: "tool:call-2",
    toolCallId: "call-2",
    toolName: "run_shell",
    kind: "execute",
    intent: "run_shell",
    status: "failed",
    summary: "failed · 25ms · 1 line",
    startedAt: 10,
    completedAt: 35,
  }]);
});

test("tool activity reducer bounds history by discarding routine completed reads first", () => {
  let console = initialConsole;
  for (let index = 0; index < 81; index += 1) {
    console = applyTraceEventToAgentConsole(console, {
      type: "tool.completed",
      toolCallId: `read-${index}`,
      toolName: "read_file",
      input: { path: `file-${index}.ts` },
      startedAt: index,
      completedAt: index + 1,
      isError: false,
    });
  }

  assert.equal(console.activity.length, 80);
  assert.equal(console.activity[0]?.toolCallId, "read-1");
  assert.equal(console.activity.at(-1)?.toolCallId, "read-80");
});

test("work lifecycle reducer projects the proposed graph and correlated task statuses", () => {
  assert.strictEqual(
    applyTraceEventToAgentConsole(initialConsole, {
      type: "work.proposed",
      graphId: "invalid",
      graph: {
        id: "invalid",
        approval: "pending",
        nodes: [{ id: "task-1", title: "Missing required fields", status: "ready" }],
      },
    }),
    initialConsole,
  );

  const proposed = applyTraceEventToAgentConsole(initialConsole, {
    type: "work.proposed",
    graphId: "goal-1",
    graph: {
      id: "goal-1",
      goal: "Ship authentication",
      constraints: ["No dependencies"],
      approval: "pending",
      nodes: [{
        id: "task-1",
        title: "Implement auth",
        prompt: "private executor assignment",
        status: "proposed",
        dependsOn: [],
        fileOwnership: ["src/auth.ts"],
        acceptanceCriteria: ["Auth tests pass"],
        evidenceRefs: [],
      }],
    },
  });
  const approved = applyTraceEventToAgentConsole(proposed, {
    type: "work.approved",
    graphId: "goal-1",
  });
  const running = applyTraceEventToAgentConsole(approved, {
    type: "work.status",
    graphId: "goal-1",
    nodeId: "task-1",
    status: "running",
  });

  assert.equal(running.workGraph?.approval, "approved");
  assert.equal(running.workGraph?.nodes[0]?.status, "running");
  assert.strictEqual(
    applyTraceEventToAgentConsole(running, {
      type: "work.status",
      graphId: "other",
      nodeId: "task-1",
      status: "completed",
    }),
    running,
  );
});

test("agent lifecycle reducer correlates queued jobs, runs, and terminal status", () => {
  const queued = applyTraceEventToAgentConsole(initialConsole, {
    type: "job.queued",
    jobId: "job-1",
    jobType: "research",
    label: "Audit prompt cache",
    queuedAt: 100,
  });
  const running = applyTraceEventToAgentConsole(queued, {
    type: "agent.run.started",
    runId: "agent-1",
    jobId: "job-1",
    displayName: "CacheScout",
    agentType: "scout",
    startedAt: 120,
  });
  const settled = applyTraceEventToAgentConsole(running, {
    type: "agent.run.settled",
    runId: "agent-1",
    status: "completed",
    completedAt: 180,
    summary: "Cache path verified",
  });

  assert.deepEqual(running.jobs[0], {
    id: "job-1",
    type: "research",
    label: "Audit prompt cache",
    status: "running",
    agentRunId: "agent-1",
    queuedAt: 100,
    startedAt: 120,
  });
  assert.deepEqual(settled.agents[0], {
    id: "agent-1",
    displayName: "CacheScout",
    agentType: "scout",
    status: "completed",
    startedAt: 120,
    completedAt: 180,
    summary: "Cache path verified",
  });
});

test("usage reducer attributes cache telemetry once per provider event", () => {
  const running = applyTraceEventToAgentConsole(initialConsole, {
    type: "agent.run.started",
    runId: "agent-1",
    displayName: "CacheScout",
    agentType: "scout",
    startedAt: 100,
  });
  const usageEvent = {
    type: "usage.recorded",
    eventId: "usage-1",
    agentRunId: "agent-1",
    provider: "openai",
    model: "gpt-5.6-sol",
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 750,
    cacheWriteTokens: 50,
    cacheSavingsUsd: 0.004,
    costUsd: 0.01,
  };
  const recorded = applyTraceEventToAgentConsole(running, usageEvent);
  const replayed = applyTraceEventToAgentConsole(recorded, usageEvent);
  const { agentRunId, ...unscopedUsageEvent } = usageEvent;
  const mainRecorded = applyTraceEventToAgentConsole(replayed, {
    ...unscopedUsageEvent,
    eventId: "usage-main",
    cacheReadTokens: 500,
  });

  assert.deepEqual(recorded.agents[0]?.usage, {
    eventIds: ["usage-1"],
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 750,
    cacheWriteTokens: 50,
    cacheSavingsUsd: 0.004,
    costUsd: 0.01,
    routes: [{
      provider: "openai",
      model: "gpt-5.6-sol",
      eventIds: ["usage-1"],
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 750,
      cacheWriteTokens: 50,
      cacheSavingsUsd: 0.004,
      costUsd: 0.01,
    }],
  });
  assert.deepEqual(replayed.agents[0]?.usage, recorded.agents[0]?.usage);
  assert.deepEqual(mainRecorded.mainUsage, {
    eventIds: ["usage-main"],
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 500,
    cacheWriteTokens: 50,
    cacheSavingsUsd: 0.004,
    costUsd: 0.01,
    routes: [{
      provider: "openai",
      model: "gpt-5.6-sol",
      eventIds: ["usage-main"],
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 500,
      cacheWriteTokens: 50,
      cacheSavingsUsd: 0.004,
      costUsd: 0.01,
    }],
  });
  const switchedModel = applyTraceEventToAgentConsole(mainRecorded, {
    type: "usage.recorded",
    eventId: "usage-main-2",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    inputTokens: 300,
    cacheReadTokens: 200,
    costUsd: 0.005,
  });
  assert.deepEqual(
    switchedModel.mainUsage?.routes?.map((route) => [
      route.provider,
      route.model,
      route.inputTokens,
      route.cacheReadTokens,
    ]),
    [
      ["openai", "gpt-5.6-sol", 1_000, 500],
      ["anthropic", "claude-sonnet-4-6", 300, 200],
    ],
  );
});

const queuedRuntimeJob = {
  type: "job.queued",
  eventId: "event-job-1",
  jobId: "job-1",
  jobType: "work-node",
  label: "Map runtime",
  queuedAt: 10,
};
const startedRuntimeRun = {
  type: "agent.run.started",
  eventId: "event-run-1",
  runId: "run-1",
  jobId: "job-1",
  displayName: "RuntimeMap",
  agentType: "executor",
  startedAt: 20,
};

test("agent lifecycle reducer settles the linked job atomically and ignores unknown job links", () => {
  const queued = applyTraceEventToAgentConsole(initialConsole, queuedRuntimeJob);
  const running = applyTraceEventToAgentConsole(queued, startedRuntimeRun);
  const cancelled = applyTraceEventToAgentConsole(running, {
    type: "agent.run.settled",
    eventId: "event-run-2",
    runId: "run-1",
    jobId: "job-1",
    status: "cancelled",
    startedAt: 20,
    completedAt: 30,
    summary: "Cancelled by operator.",
  });

  assert.equal(cancelled.agents[0]?.status, "cancelled");
  assert.equal(cancelled.jobs[0]?.status, "cancelled");
  assert.equal(cancelled.jobs[0]?.completedAt, 30);
  assert.equal(cancelled.jobs[0]?.summary, "Cancelled by operator.");
  assert.equal(cancelled.jobs[0]?.agentRunId, "run-1");

  const orphanRun = applyTraceEventToAgentConsole(initialConsole, {
    ...startedRuntimeRun,
    runId: "run-9",
    jobId: "job-missing",
  });
  assert.deepEqual(orphanRun.jobs, []);
  assert.equal(orphanRun.agents[0]?.id, "run-9");

  const orphanSettled = applyTraceEventToAgentConsole(orphanRun, {
    type: "agent.run.settled",
    eventId: "event-run-3",
    runId: "run-9",
    jobId: "job-missing",
    status: "completed",
    completedAt: 40,
  });
  assert.deepEqual(orphanSettled.jobs, []);
  assert.equal(orphanSettled.agents[0]?.status, "completed");
});

test("lifecycle reducer replays every lifecycle event as the same snapshot reference", () => {
  const events = [
    queuedRuntimeJob,
    { ...queuedRuntimeJob, eventId: "event-job-2", jobId: "job-2", label: "Sweep cache" },
    startedRuntimeRun,
    {
      type: "agent.run.settled",
      eventId: "event-run-2",
      runId: "run-1",
      jobId: "job-1",
      status: "completed",
      completedAt: 30,
    },
    {
      type: "job.settled",
      eventId: "event-job-3",
      jobId: "job-2",
      status: "failed",
      completedAt: 40,
      errorSummary: "Sweep aborted",
    },
  ];

  let console = initialConsole;
  for (const event of events) {
    const projected = applyTraceEventToAgentConsole(console, event);
    assert.notStrictEqual(projected, console, `${event.type} ${event.eventId} must project`);
    assert.strictEqual(
      applyTraceEventToAgentConsole(projected, event),
      projected,
      `${event.type} ${event.eventId} must replay as a no-op`,
    );
    console = projected;
  }
});

test("lifecycle reducer refuses terminal regression, backwards completion, and malformed events", () => {
  const queued = applyTraceEventToAgentConsole(initialConsole, queuedRuntimeJob);
  const running = applyTraceEventToAgentConsole(queued, startedRuntimeRun);
  const settled = applyTraceEventToAgentConsole(running, {
    type: "agent.run.settled",
    eventId: "event-run-2",
    runId: "run-1",
    jobId: "job-1",
    status: "completed",
    completedAt: 30,
  });

  assert.strictEqual(
    applyTraceEventToAgentConsole(settled, { ...startedRuntimeRun, eventId: "event-run-restart" }),
    settled,
    "a settled run cannot return to running",
  );
  assert.strictEqual(
    applyTraceEventToAgentConsole(settled, {
      type: "agent.run.settled",
      eventId: "event-run-4",
      runId: "run-1",
      status: "failed",
      completedAt: 90,
    }),
    settled,
    "a terminal run status cannot be rewritten",
  );
  assert.strictEqual(
    applyTraceEventToAgentConsole(settled, {
      type: "job.settled",
      eventId: "event-job-4",
      jobId: "job-1",
      status: "failed",
      completedAt: 90,
    }),
    settled,
    "a terminal job status cannot be rewritten",
  );
  assert.strictEqual(
    applyTraceEventToAgentConsole(running, {
      type: "agent.run.settled",
      eventId: "event-run-5",
      runId: "run-1",
      status: "completed",
      completedAt: 5,
    }),
    running,
    "completion cannot precede the run start",
  );
  assert.strictEqual(
    applyTraceEventToAgentConsole(queued, {
      type: "job.settled",
      eventId: "event-job-5",
      jobId: "job-1",
      status: "completed",
      completedAt: 1,
    }),
    queued,
    "completion cannot precede the job queueing",
  );

  const jobSettledFirst = applyTraceEventToAgentConsole(queued, {
    type: "job.settled",
    eventId: "event-job-8",
    jobId: "job-1",
    status: "cancelled",
    completedAt: 15,
  });
  const lateRunStart = applyTraceEventToAgentConsole(jobSettledFirst, {
    ...startedRuntimeRun,
    eventId: "event-run-9",
    runId: "run-8",
  });
  assert.equal(
    lateRunStart.jobs[0]?.status,
    "cancelled",
    "a settled job cannot be reopened by a late run start",
  );

  const malformed = [
    { ...queuedRuntimeJob, eventId: "event-job-6", jobId: "job-7", label: "   " },
    { ...startedRuntimeRun, eventId: "event-run-6", runId: "run-7", agentType: "" },
    { type: "agent.run.settled", eventId: "event-run-7", runId: "run-absent", status: "completed", completedAt: 60 },
    { type: "agent.run.settled", eventId: "event-run-8", runId: "run-1", status: "running", completedAt: 60 },
    { type: "job.settled", eventId: "event-job-7", jobId: "job-1", status: "running", completedAt: 60 },
  ];
  for (const event of malformed) {
    assert.strictEqual(
      applyTraceEventToAgentConsole(settled, event),
      settled,
      `${event.type} ${event.eventId} must be rejected`,
    );
  }
});

test("tool reducer scopes activity and current intent to the owning agent run", () => {
  let console = applyTraceEventToAgentConsole(initialConsole, queuedRuntimeJob);
  console = applyTraceEventToAgentConsole(console, {
    ...queuedRuntimeJob,
    eventId: "event-job-2",
    jobId: "job-2",
    label: "Sweep cache",
    queuedAt: 11,
  });
  console = applyTraceEventToAgentConsole(console, startedRuntimeRun);
  console = applyTraceEventToAgentConsole(console, {
    ...startedRuntimeRun,
    eventId: "event-run-2",
    runId: "run-2",
    jobId: "job-2",
    displayName: "CacheSweep",
    startedAt: 21,
  });

  const findRun = (snapshot, id) => snapshot.agents.find((agent) => agent.id === id);

  const started = applyTraceEventToAgentConsole(console, {
    type: "tool.started",
    toolCallId: "call-1",
    toolName: "read_file",
    input: { path: "src/a.ts", i: "Reading runtime entry" },
    startedAt: 30,
    agentRunId: "run-1",
  });
  assert.equal(started.activity[0]?.agentRunId, "run-1");
  assert.equal(findRun(started, "run-1")?.currentActivity, "Reading runtime entry");
  assert.equal(findRun(started, "run-2")?.currentActivity, undefined);

  const completed = applyTraceEventToAgentConsole(started, {
    type: "tool.completed",
    toolCallId: "call-1",
    toolName: "read_file",
    input: { path: "src/a.ts", i: "Reading runtime entry" },
    isError: false,
    output: "one line",
    startedAt: 30,
    completedAt: 40,
    durationMs: 10,
    agentRunId: "run-1",
  });
  assert.equal(completed.activity[0]?.agentRunId, "run-1");
  assert.equal(completed.activity[0]?.status, "completed");
  assert.equal(findRun(completed, "run-1")?.currentActivity, "Reading runtime entry");

  const mainScoped = applyTraceEventToAgentConsole(completed, {
    type: "tool.started",
    toolCallId: "call-2",
    toolName: "shell",
    input: { i: "Running focused tests" },
    startedAt: 50,
  });
  assert.equal(mainScoped.activity[1]?.agentRunId, undefined);
  assert.equal(findRun(mainScoped, "run-1")?.currentActivity, "Reading runtime entry");
  assert.equal(findRun(mainScoped, "run-2")?.currentActivity, undefined);

  const jobScoped = applyTraceEventToAgentConsole(mainScoped, {
    type: "tool.started",
    toolCallId: "call-3",
    toolName: "grep",
    input: { i: "Scanning cache keys" },
    startedAt: 60,
    asyncJobId: "job-2",
  });
  assert.equal(jobScoped.activity[2]?.agentRunId, "run-2");
  assert.equal(findRun(jobScoped, "run-2")?.currentActivity, "Scanning cache keys");

  const blankScoped = applyTraceEventToAgentConsole(jobScoped, {
    type: "tool.started",
    toolCallId: "call-4",
    toolName: "read_file",
    input: { path: "src/b.ts" },
    startedAt: 70,
    agentRunId: "   ",
    asyncJobId: "",
  });
  assert.equal(blankScoped.activity[3]?.agentRunId, undefined);
  assert.equal(findRun(blankScoped, "run-1")?.currentActivity, "Reading runtime entry");

  const runSettled = applyTraceEventToAgentConsole(blankScoped, {
    type: "agent.run.settled",
    eventId: "event-run-3",
    runId: "run-1",
    jobId: "job-1",
    status: "completed",
    completedAt: 80,
  });
  assert.equal(findRun(runSettled, "run-1")?.currentActivity, undefined);
  assert.equal(findRun(runSettled, "run-2")?.currentActivity, "Scanning cache keys");

  const afterSettle = applyTraceEventToAgentConsole(runSettled, {
    type: "tool.started",
    toolCallId: "call-5",
    toolName: "read_file",
    input: { i: "Late straggler" },
    startedAt: 90,
    agentRunId: "run-1",
  });
  assert.equal(afterSettle.activity[4]?.agentRunId, "run-1");
  assert.equal(
    findRun(afterSettle, "run-1")?.currentActivity,
    undefined,
    "a settled run is never reanimated by a straggling tool event",
  );
});

test("usage reducer ignores zero, negative, and non-finite counters", () => {
  const running = applyTraceEventToAgentConsole(initialConsole, startedRuntimeRun);
  const noisy = applyTraceEventToAgentConsole(running, {
    type: "usage.recorded",
    eventId: "usage-noisy",
    agentRunId: "run-1",
    inputTokens: 0,
    outputTokens: -20,
    cacheReadTokens: Number.NaN,
    cacheWriteTokens: 1.5,
    cacheSavingsUsd: Number.POSITIVE_INFINITY,
    costUsd: 0,
  });
  assert.deepEqual(noisy.agents[0]?.usage, { eventIds: ["usage-noisy"] });

  const real = applyTraceEventToAgentConsole(noisy, {
    type: "usage.recorded",
    eventId: "usage-real",
    agentRunId: "run-1",
    inputTokens: 12,
    costUsd: 0.5,
  });
  assert.deepEqual(real.agents[0]?.usage, {
    eventIds: ["usage-noisy", "usage-real"],
    inputTokens: 12,
    costUsd: 0.5,
  });

  const zeroed = applyTraceEventToAgentConsole(real, {
    type: "usage.recorded",
    eventId: "usage-zero",
    agentRunId: "run-1",
    inputTokens: 0,
    costUsd: 0,
  });
  assert.deepEqual(zeroed.agents[0]?.usage, {
    eventIds: ["usage-noisy", "usage-real", "usage-zero"],
    inputTokens: 12,
    costUsd: 0.5,
  });

  assert.strictEqual(
    applyTraceEventToAgentConsole(real, {
      type: "usage.recorded",
      eventId: "usage-orphan",
      agentRunId: "run-absent",
      inputTokens: 5,
    }),
    real,
    "usage for an unknown run is dropped",
  );
  assert.strictEqual(
    applyTraceEventToAgentConsole(real, {
      type: "usage.recorded",
      agentRunId: "run-1",
      inputTokens: 5,
    }),
    real,
    "usage without a dedupe identity is dropped",
  );
});

test("lifecycle reducer bounds oversized summaries before persistence", () => {
  const running = applyTraceEventToAgentConsole(initialConsole, startedRuntimeRun);
  const settled = applyTraceEventToAgentConsole(running, {
    type: "agent.run.settled",
    eventId: "event-run-2",
    runId: "run-1",
    status: "failed",
    completedAt: 60,
    summary: "s".repeat(900),
    errorSummary: "e".repeat(900),
  });

  assert.equal(settled.agents[0]?.summary?.length, 400);
  assert.equal(settled.agents[0]?.errorSummary?.length, 400);
  assert.match(settled.agents[0]?.summary ?? "", /… summary truncated$/);
});

test("agent lifecycle reducer refuses to start a run against a job that cannot adopt it", () => {
  const queued = applyTraceEventToAgentConsole(initialConsole, queuedRuntimeJob);

  const jobFailed = applyTraceEventToAgentConsole(queued, {
    type: "job.settled",
    eventId: "event-job-2",
    jobId: "job-1",
    status: "failed",
    completedAt: 12,
  });
  assert.strictEqual(
    applyTraceEventToAgentConsole(jobFailed, startedRuntimeRun),
    jobFailed,
    "a settled job cannot adopt a new run",
  );
  assert.deepEqual(
    applyTraceEventToAgentConsole(jobFailed, startedRuntimeRun).agents,
    [],
    "a rejected job link must not leave an orphan running agent",
  );

  const owned = applyTraceEventToAgentConsole(queued, startedRuntimeRun);
  assert.strictEqual(
    applyTraceEventToAgentConsole(owned, {
      ...startedRuntimeRun,
      eventId: "event-run-2",
      runId: "run-2",
      startedAt: 21,
    }),
    owned,
    "a job already owned by another run cannot be stolen",
  );

  assert.strictEqual(
    applyTraceEventToAgentConsole(queued, {
      ...startedRuntimeRun,
      eventId: "event-run-3",
      runId: "run-3",
      startedAt: 5,
    }),
    queued,
    "a run cannot start before the job that queued it existed",
  );

  const unlinked = applyTraceEventToAgentConsole(queued, {
    ...startedRuntimeRun,
    eventId: "event-run-4",
    runId: "run-4",
    jobId: "job-absent",
  });
  assert.equal(unlinked.agents[0]?.id, "run-4", "an unknown job link still registers the run");
  assert.equal(unlinked.jobs[0]?.status, "queued");
});

test("agent lifecycle reducer settles only the job owned by the finishing run", () => {
  let console = applyTraceEventToAgentConsole(initialConsole, queuedRuntimeJob);
  console = applyTraceEventToAgentConsole(console, {
    ...queuedRuntimeJob,
    eventId: "event-job-2",
    jobId: "job-2",
    label: "Sweep cache",
    queuedAt: 11,
  });
  console = applyTraceEventToAgentConsole(console, {
    ...queuedRuntimeJob,
    eventId: "event-job-3",
    jobId: "job-late",
    label: "Deferred audit",
    queuedAt: 500,
  });
  console = applyTraceEventToAgentConsole(console, startedRuntimeRun);
  const linked = applyTraceEventToAgentConsole(console, {
    ...startedRuntimeRun,
    eventId: "event-run-2",
    runId: "run-2",
    jobId: "job-2",
    startedAt: 21,
  });

  assert.strictEqual(
    applyTraceEventToAgentConsole(linked, {
      type: "agent.run.settled",
      eventId: "event-run-3",
      runId: "run-1",
      jobId: "job-2",
      status: "completed",
      completedAt: 60,
    }),
    linked,
    "a run cannot settle a job owned by a different run",
  );
  assert.strictEqual(
    applyTraceEventToAgentConsole(linked, {
      type: "agent.run.settled",
      eventId: "event-run-4",
      runId: "run-1",
      jobId: "job-late",
      status: "completed",
      completedAt: 60,
    }),
    linked,
    "a run cannot settle a job queued after the run finished",
  );

  const settled = applyTraceEventToAgentConsole(linked, {
    type: "agent.run.settled",
    eventId: "event-run-5",
    runId: "run-1",
    jobId: "job-1",
    status: "completed",
    completedAt: 60,
  });
  assert.equal(settled.jobs[0]?.status, "completed", "the run's own job still settles with it");
  assert.equal(settled.jobs[1]?.status, "running", "another run's job is untouched");
});

test("job lifecycle reducer rejects settlements whose timeline runs backwards", () => {
  const queued = applyTraceEventToAgentConsole(initialConsole, queuedRuntimeJob);
  const running = applyTraceEventToAgentConsole(queued, startedRuntimeRun);
  const backwards = [
    { eventId: "event-job-2", startedAt: 5, completedAt: 30, why: "a start cannot precede the queueing" },
    { eventId: "event-job-3", startedAt: 15, completedAt: 30, why: "a start cannot precede a recorded start" },
    { eventId: "event-job-4", completedAt: 15, why: "completion cannot precede a recorded start" },
    { eventId: "event-job-5", startedAt: 25, completedAt: 22, why: "completion cannot precede its own start" },
    { eventId: "event-job-6", completedAt: 3, why: "completion cannot precede the queueing" },
  ];
  for (const { why, ...timeline } of backwards) {
    assert.strictEqual(
      applyTraceEventToAgentConsole(running, {
        type: "job.settled",
        jobId: "job-1",
        status: "completed",
        ...timeline,
      }),
      running,
      why,
    );
  }

  const settled = applyTraceEventToAgentConsole(running, {
    type: "job.settled",
    eventId: "event-job-7",
    jobId: "job-1",
    status: "completed",
    startedAt: 20,
    completedAt: 40,
  });
  assert.equal(settled.jobs[0]?.status, "completed");
  assert.equal(settled.jobs[0]?.completedAt, 40);
});

test("tool reducer keeps a call's established agent owner", () => {
  let console = applyTraceEventToAgentConsole(initialConsole, queuedRuntimeJob);
  console = applyTraceEventToAgentConsole(console, {
    ...queuedRuntimeJob,
    eventId: "event-job-2",
    jobId: "job-2",
    label: "Sweep cache",
    queuedAt: 11,
  });
  console = applyTraceEventToAgentConsole(console, startedRuntimeRun);
  console = applyTraceEventToAgentConsole(console, {
    ...startedRuntimeRun,
    eventId: "event-run-2",
    runId: "run-2",
    jobId: "job-2",
    displayName: "CacheSweep",
    startedAt: 21,
  });
  const opened = applyTraceEventToAgentConsole(console, {
    type: "tool.started",
    toolCallId: "call-1",
    toolName: "read_file",
    input: { path: "src/a.ts", i: "Reading runtime entry" },
    startedAt: 30,
    agentRunId: "run-1",
  });

  const completion = {
    type: "tool.completed",
    toolCallId: "call-1",
    toolName: "read_file",
    isError: false,
    output: "one line",
    startedAt: 30,
    completedAt: 40,
    durationMs: 10,
  };
  assert.strictEqual(
    applyTraceEventToAgentConsole(opened, { ...completion, agentRunId: "run-2" }),
    opened,
    "a conflicting direct owner cannot reassign an open call",
  );
  assert.strictEqual(
    applyTraceEventToAgentConsole(opened, { ...completion, asyncJobId: "job-2" }),
    opened,
    "a conflicting async-job-derived owner cannot reassign an open call",
  );

  const closed = applyTraceEventToAgentConsole(opened, completion);
  assert.equal(closed.activity[0]?.agentRunId, "run-1", "an unscoped completion keeps the established owner");
  assert.equal(closed.activity[0]?.status, "completed");
});

test("usage reducer routes one provider event id to exactly one ledger", () => {
  let console = applyTraceEventToAgentConsole(initialConsole, queuedRuntimeJob);
  console = applyTraceEventToAgentConsole(console, {
    ...queuedRuntimeJob,
    eventId: "event-job-2",
    jobId: "job-2",
    label: "Sweep cache",
    queuedAt: 11,
  });
  console = applyTraceEventToAgentConsole(console, startedRuntimeRun);
  const ready = applyTraceEventToAgentConsole(console, {
    ...startedRuntimeRun,
    eventId: "event-run-2",
    runId: "run-2",
    jobId: "job-2",
    displayName: "CacheSweep",
    startedAt: 21,
  });

  const scoped = applyTraceEventToAgentConsole(ready, {
    type: "usage.recorded",
    eventId: "usage-1",
    agentRunId: "run-1",
    inputTokens: 10,
  });
  assert.strictEqual(
    applyTraceEventToAgentConsole(scoped, { type: "usage.recorded", eventId: "usage-1", inputTokens: 10 }),
    scoped,
    "a run-scoped event id cannot be re-charged to main usage",
  );
  assert.strictEqual(
    applyTraceEventToAgentConsole(scoped, {
      type: "usage.recorded",
      eventId: "usage-1",
      agentRunId: "run-2",
      inputTokens: 10,
    }),
    scoped,
    "a run-scoped event id cannot be re-charged to another run",
  );

  const main = applyTraceEventToAgentConsole(ready, {
    type: "usage.recorded",
    eventId: "usage-2",
    inputTokens: 7,
  });
  assert.strictEqual(
    applyTraceEventToAgentConsole(main, {
      type: "usage.recorded",
      eventId: "usage-2",
      agentRunId: "run-1",
      inputTokens: 7,
    }),
    main,
    "a main-charged event id cannot be re-charged to a run",
  );
});

test("usage reducer rejects a present but malformed scope instead of charging main usage", () => {
  const running = applyTraceEventToAgentConsole(initialConsole, startedRuntimeRun);

  const malformedScopes = ["   ", "", 42, null, {}, undefined];
  for (const [index, agentRunId] of malformedScopes.entries()) {
    assert.strictEqual(
      applyTraceEventToAgentConsole(running, {
        type: "usage.recorded",
        eventId: `usage-bad-${index}`,
        agentRunId,
        inputTokens: 5,
      }),
      running,
      `a present but invalid scope (${JSON.stringify(agentRunId)}) must not charge main usage`,
    );
  }

  const absent = applyTraceEventToAgentConsole(running, {
    type: "usage.recorded",
    eventId: "usage-absent",
    inputTokens: 5,
  });
  assert.deepEqual(absent.mainUsage, { eventIds: ["usage-absent"], inputTokens: 5 });

  const explicitlyUndefined = applyTraceEventToAgentConsole(running, {
    type: "usage.recorded",
    eventId: "usage-undefined",
    agentRunId: undefined,
    inputTokens: 5,
  });
  assert.strictEqual(
    explicitlyUndefined,
    running,
    "an own `agentRunId` property set to undefined is malformed, not unscoped",
  );
  assert.equal(explicitlyUndefined.mainUsage, undefined, "a malformed scope charges no ledger");
  assert.equal(explicitlyUndefined.agents[0]?.usage, undefined);
});

test("usage reducer still books a settled run's closing measurement", () => {
  const running = applyTraceEventToAgentConsole(initialConsole, startedRuntimeRun);
  const settled = applyTraceEventToAgentConsole(running, {
    type: "agent.run.settled",
    eventId: "event-run-2",
    runId: "run-1",
    status: "completed",
    completedAt: 60,
  });

  // "A matching run" means a run this snapshot knows about, not a run that is
  // still active: the closing usage of a turn routinely lands after the run
  // settles, and dropping it would systematically understate subagent spend.
  const closing = applyTraceEventToAgentConsole(settled, {
    type: "usage.recorded",
    eventId: "usage-closing",
    agentRunId: "run-1",
    inputTokens: 42,
    costUsd: 0.02,
  });
  assert.deepEqual(closing.agents[0]?.usage, {
    eventIds: ["usage-closing"],
    inputTokens: 42,
    costUsd: 0.02,
  });
  assert.equal(closing.agents[0]?.status, "completed");
  assert.equal(closing.mainUsage, undefined, "a settled run's usage never falls through to main");
});

test("usage reducer refuses measurements it could not persist", () => {
  const running = applyTraceEventToAgentConsole(initialConsole, startedRuntimeRun);

  assert.strictEqual(
    applyTraceEventToAgentConsole(running, {
      type: "usage.recorded",
      eventId: "usage-huge",
      agentRunId: "run-1",
      inputTokens: Number.MAX_SAFE_INTEGER + 2,
    }),
    running,
    "a token count past the safe-integer range is rejected outright",
  );

  const near = applyTraceEventToAgentConsole(running, {
    type: "usage.recorded",
    eventId: "usage-near",
    agentRunId: "run-1",
    inputTokens: Number.MAX_SAFE_INTEGER - 1,
  });
  assert.equal(near.agents[0]?.usage?.inputTokens, Number.MAX_SAFE_INTEGER - 1);
  assert.ok(Number.isSafeInteger(near.agents[0]?.usage?.inputTokens));
  assert.strictEqual(
    applyTraceEventToAgentConsole(near, {
      type: "usage.recorded",
      eventId: "usage-tip",
      agentRunId: "run-1",
      inputTokens: 10,
    }),
    near,
    "a token total that would leave the safe-integer range is rejected",
  );

  const heavy = applyTraceEventToAgentConsole(running, {
    type: "usage.recorded",
    eventId: "usage-heavy",
    agentRunId: "run-1",
    costUsd: 1e308,
  });
  assert.equal(heavy.agents[0]?.usage?.costUsd, 1e308);
  assert.ok(Number.isFinite(heavy.agents[0]?.usage?.costUsd));
  assert.strictEqual(
    applyTraceEventToAgentConsole(heavy, {
      type: "usage.recorded",
      eventId: "usage-heavier",
      agentRunId: "run-1",
      costUsd: 1e308,
    }),
    heavy,
    "a monetary total that would stop being finite is rejected",
  );

  assert.strictEqual(
    applyTraceEventToAgentConsole(running, {
      type: "usage.recorded",
      eventId: "usage-main-huge",
      inputTokens: Number.MAX_SAFE_INTEGER + 2,
    }),
    running,
    "main usage is held to the same bounds",
  );
});
