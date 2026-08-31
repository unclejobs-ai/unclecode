import assert from "node:assert/strict";
import test from "node:test";

import { applyTraceEventToAgentConsole } from "@unclecode/orchestrator";
import { parseAgentConsoleSnapshot } from "@unclecode/contracts";
import { createUsageRecorder } from "./usage-recorder-fixture.mjs";

const initialConsole = Object.freeze({ profileId: "build", activity: [], agents: [], jobs: [] });
const TEST_USAGE_ROUTE = { provider: "openai", model: "gpt-5.6-sol" };

test("plugin diagnostics retain canonical trust and exit status through console persistence", () => {
  const projected = applyTraceEventToAgentConsole(initialConsole, {
    type: "plugin.diagnostic",
    level: "high-signal",
    runId: "run-plugin-roundtrip",
    source: "cached",
    trustLane: "cached-external",
    pluginId: "cached-reviewer",
    pluginName: "cached-reviewer",
    hookName: "runClassified",
    status: "error",
    errorName: "PluginHookError",
    errorMessage: `Failed in /tmp/private/plugin.mjs api_key=raw-secret ${"z".repeat(400)}`,
    exitStatus: "17",
    dedupeKey: `sha256:${"b".repeat(64)}`,
    startedAt: 101,
  });
  const resumed = parseAgentConsoleSnapshot(JSON.parse(JSON.stringify(projected)));
  const [diagnostic] = resumed?.pluginDiagnostics ?? [];

  assert.equal(diagnostic?.source, "cached");
  assert.equal(diagnostic?.trustLane, "cached-external");
  assert.equal(diagnostic?.pluginName, "cached-reviewer");
  assert.equal(diagnostic?.hookName, "runClassified");
  assert.equal(diagnostic?.exitStatus, "17");
  assert.match(diagnostic?.errorMessage ?? "", /\[PATH\]/);
  assert.match(diagnostic?.errorMessage ?? "", /api_key=\[REDACTED\]/);
  assert.ok(Array.from(diagnostic?.errorMessage ?? "").length <= 240);
  assert.doesNotMatch(JSON.stringify(resumed), /private|raw-secret/);
});

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
      startedAt: 1,
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
    startedAt: 2,
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

function proposalReplayEvent(graphId = "goal-proposal-replay", startedAt = 10) {
  return {
    type: "work.proposed",
    graphId,
    startedAt,
    graph: {
      id: graphId,
      qualityProfile: "deep",
      currentStage: "plan",
      gateStatus: "unproven",
      iteration: 0,
      approval: "pending",
      nodes: [{
        id: "task-1",
        title: "Implement auth",
        prompt: "private executor assignment",
        status: "proposed",
        dependsOn: [],
        fileOwnership: ["src/auth.ts"],
        acceptanceCriteria: ["tests pass"],
        evidenceRefs: [],
        stage: "work",
        role: "worker",
        attempt: 0,
        artifactRefs: [],
        reviewRequired: true,
      }],
    },
  };
}

test("an exact work proposal replay preserves snapshot identity", () => {
  const originalProposal = proposalReplayEvent();
  const proposed = applyTraceEventToAgentConsole(initialConsole, originalProposal);
  assert.strictEqual(
    applyTraceEventToAgentConsole(proposed, structuredClone(originalProposal)),
    proposed,
    "an exact serialized replay must not create snapshot churn",
  );
});

test("a completed work graph rejects stale proposals but accepts a newer iteration", () => {
  const originalProposal = proposalReplayEvent();
  const proposed = applyTraceEventToAgentConsole(initialConsole, originalProposal);
  const completed = applyTraceEventToAgentConsole(proposed, {
    type: "quality.completed",
    runId: "run-proposal-replay",
    graphId: "goal-proposal-replay",
    profile: "deep",
    stage: "promote",
    iteration: 0,
    decision: "unproven",
    startedAt: 20,
  });
  assert.equal(completed.workGraph?.currentStage, "promote");
  assert.strictEqual(
    applyTraceEventToAgentConsole(completed, structuredClone(originalProposal)),
    completed,
    "replaying the original proposal after completion must not regress the graph",
  );

  const newerProposal = structuredClone(originalProposal);
  newerProposal.graph.iteration = 1;
  newerProposal.graph.currentStage = "work";
  newerProposal.graph.nodes[0].attempt = 1;
  const refined = applyTraceEventToAgentConsole(completed, newerProposal);
  assert.notStrictEqual(refined, completed);
  assert.equal(refined.workGraph?.iteration, 1);
  assert.equal(refined.workGraph?.currentStage, "work");
  assert.equal(refined.workGraph?.nodes[0]?.attempt, 1);

  assert.strictEqual(
    applyTraceEventToAgentConsole(refined, structuredClone(originalProposal)),
    refined,
    "an older proposal must not replace the active iteration",
  );
});

test("a newer cross-graph proposal rejects replay of its superseded predecessor", () => {
  const proposalA = proposalReplayEvent("graph-a", 100);
  const proposalB = proposalReplayEvent("graph-b", 200);
  const graphA = applyTraceEventToAgentConsole(initialConsole, proposalA);
  const graphB = applyTraceEventToAgentConsole(graphA, proposalB);

  assert.equal(graphB.workGraph?.id, "graph-b");
  assert.strictEqual(
    applyTraceEventToAgentConsole(graphB, structuredClone(proposalA)),
    graphB,
    "A -> B -> replay A must retain B without snapshot churn",
  );
});

test("work proposal sequence outranks timestamps and rejects an equal sequence", () => {
  const proposalA = { ...proposalReplayEvent("graph-sequence-a", 200), sequence: 7 };
  const proposalB = { ...proposalReplayEvent("graph-sequence-b", 100), sequence: 8 };
  const graphA = applyTraceEventToAgentConsole(initialConsole, proposalA);
  const graphB = applyTraceEventToAgentConsole(graphA, proposalB);
  const restored = parseAgentConsoleSnapshot(JSON.parse(JSON.stringify(graphB)));

  assert.equal(graphB.workGraph?.id, "graph-sequence-b", "the owner sequence is authoritative");
  assert.equal(restored?.workProposalOrder?.sequence, 8);
  assert.ok(restored);
  assert.strictEqual(
    applyTraceEventToAgentConsole(restored, {
      ...proposalReplayEvent("graph-sequence-c", 300),
      sequence: 8,
    }),
    restored,
    "a sequence already consumed by another proposal is not later",
  );
});

test("an established work proposal sequence rejects an unsequenced timestamp bypass", () => {
  const sequenced = applyTraceEventToAgentConsole(initialConsole, {
    ...proposalReplayEvent("graph-sequenced", 100),
    sequence: 9,
  });

  assert.strictEqual(
    applyTraceEventToAgentConsole(
      sequenced,
      proposalReplayEvent("graph-unsequenced-newer-time", 1_000),
    ),
    sequenced,
  );
});

test("a work proposal with malformed ordering metadata is rejected", () => {
  const current = applyTraceEventToAgentConsole(
    initialConsole,
    proposalReplayEvent("graph-order-valid", 100),
  );
  for (const startedAt of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.strictEqual(
      applyTraceEventToAgentConsole(
        current,
        proposalReplayEvent(`graph-order-invalid-${startedAt}`, startedAt),
      ),
      current,
    );
  }
  assert.strictEqual(
    applyTraceEventToAgentConsole(current, {
      ...proposalReplayEvent("graph-sequence-invalid", 200),
      sequence: -1,
    }),
    current,
  );
});

test("equal-time proposal ordering survives snapshot serialization", () => {
  const proposalA = proposalReplayEvent("graph-tie-a", 500);
  const proposalB = proposalReplayEvent("graph-tie-b", 500);
  const graphA = applyTraceEventToAgentConsole(initialConsole, proposalA);
  const graphB = applyTraceEventToAgentConsole(graphA, proposalB);
  const restored = parseAgentConsoleSnapshot(JSON.parse(JSON.stringify(graphB)));

  assert.ok(restored);
  assert.equal(restored.workGraph?.id, "graph-tie-b");
  assert.deepEqual(restored.workProposalOrder, {
    graphId: "graph-tie-b",
    iteration: 0,
    startedAt: 500,
    superseded: [{ graphId: "graph-tie-a", iteration: 0 }],
  });
  assert.strictEqual(
    applyTraceEventToAgentConsole(restored, structuredClone(proposalA)),
    restored,
    "the bounded superseded identity survives restart",
  );
});

test("work proposal superseded identities stay bounded without reopening an older timestamp", () => {
  let snapshot = initialConsole;
  for (let index = 0; index < 40; index += 1) {
    snapshot = applyTraceEventToAgentConsole(
      snapshot,
      { ...proposalReplayEvent(`graph-bounded-${index}`, index), sequence: index },
    );
  }

  assert.equal(snapshot.workGraph?.id, "graph-bounded-39");
  assert.equal(snapshot.workProposalOrder?.superseded.length, 32);
  assert.strictEqual(
    applyTraceEventToAgentConsole(snapshot, proposalReplayEvent("graph-bounded-0", 0)),
    snapshot,
  );
});

test("an evicted equal-time proposal cannot reopen a saturated legacy tie", () => {
  let snapshot = initialConsole;
  for (let index = 0; index < 34; index += 1) {
    snapshot = applyTraceEventToAgentConsole(
      snapshot,
      proposalReplayEvent(`graph-equal-bounded-${index}`, 700),
    );
  }

  assert.equal(snapshot.workGraph?.id, "graph-equal-bounded-33");
  assert.equal(snapshot.workProposalOrder?.superseded.length, 32);
  assert.equal(snapshot.workProposalOrder?.unsequencedTieSaturated, true);
  const restored = parseAgentConsoleSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.ok(restored);
  assert.strictEqual(
    applyTraceEventToAgentConsole(
      restored,
      proposalReplayEvent("graph-equal-bounded-0", 700),
    ),
    restored,
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
    jobId: "job-1",
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
  const recorder = createUsageRecorder();
  const queued = applyTraceEventToAgentConsole(initialConsole, {
    type: "job.queued",
    jobId: "job-1",
    jobType: "research",
    label: "Audit prompt cache",
    queuedAt: 90,
  });
  const running = applyTraceEventToAgentConsole(queued, {
    type: "agent.run.started",
    runId: "agent-1",
    jobId: "job-1",
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
  const recorded = applyTraceEventToAgentConsole(running, usageEvent, recorder);
  const replayed = applyTraceEventToAgentConsole(recorded, usageEvent, recorder);
  const { agentRunId, ...unscopedUsageEvent } = usageEvent;
  const mainRecorded = applyTraceEventToAgentConsole(replayed, {
    ...unscopedUsageEvent,
    eventId: "usage-main",
    cacheReadTokens: 500,
  }, recorder);

  assert.deepEqual(recorded.agents[0]?.usage, {
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 750,
    cacheWriteTokens: 50,
    cacheSavingsUsd: 0.004,
    costUsd: 0.01,
  });
  assert.deepEqual(replayed.agents[0]?.usage, recorded.agents[0]?.usage);
  assert.deepEqual(mainRecorded.mainUsage, {
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 500,
    cacheWriteTokens: 50,
    cacheSavingsUsd: 0.004,
    costUsd: 0.01,
  });
  const switchedModel = applyTraceEventToAgentConsole(mainRecorded, {
    type: "usage.recorded",
    eventId: "usage-main-2",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    inputTokens: 300,
    cacheReadTokens: 200,
    costUsd: 0.005,
  }, recorder);
  assert.deepEqual(
    switchedModel.totalUsage?.routes?.map((route) => [
      route.provider,
      route.model,
      route.inputTokens,
      route.cacheReadTokens,
    ]),
    [
      ["openai", "gpt-5.6-sol", 2_000, 1_250],
      ["anthropic", "claude-sonnet-4-6", 300, 200],
    ],
  );
  assert.equal(switchedModel.mainUsage?.inputTokens, 1_300);
  assert.equal(switchedModel.mainUsage?.cacheReadTokens, 700);
  assert.equal(switchedModel.mainUsage?.costUsd, 0.015);
});

test("usage reducer rejects live measurements without provider and model", () => {
  const missingRoute = applyTraceEventToAgentConsole(initialConsole, {
    type: "usage.recorded",
    eventId: "usage-unattributed",
    inputTokens: 10,
    costUsd: 0.001,
  });
  assert.strictEqual(missingRoute, initialConsole);
});

test("usage reducer keeps replay identity in the owner ledger, not the projection", () => {
  const recorder = createUsageRecorder();
  let snapshot = initialConsole;
  for (let index = 0; index < 300; index += 1) {
    snapshot = applyTraceEventToAgentConsole(snapshot, {
      type: "usage.recorded",
      ...TEST_USAGE_ROUTE,
      eventId: `usage-long-${index}`,
      inputTokens: 1,
    }, recorder);
  }
  const replayed = applyTraceEventToAgentConsole(snapshot, {
    type: "usage.recorded",
    ...TEST_USAGE_ROUTE,
    eventId: "usage-long-0",
    inputTokens: 1,
  }, recorder);
  assert.deepEqual(replayed, snapshot);
  assert.doesNotMatch(JSON.stringify(snapshot), /eventIds/);
  assert.equal(snapshot.mainUsage?.inputTokens, 300);
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
// Every run owns exactly one job, so a run event only means anything against a
// console that already queued the job the run claims.
const queuedRuntimeConsole = applyTraceEventToAgentConsole(initialConsole, queuedRuntimeJob);

test("agent lifecycle reducer settles the linked job atomically and rejects unresolvable links", () => {
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
  assert.strictEqual(
    orphanRun,
    initialConsole,
    "a run whose job link resolves to nothing is never registered",
  );

  assert.strictEqual(
    applyTraceEventToAgentConsole(running, {
      type: "agent.run.settled",
      eventId: "event-run-3",
      runId: "run-1",
      jobId: "job-missing",
      status: "completed",
      completedAt: 40,
    }),
    running,
    "a settlement whose job link resolves to nothing settles neither side",
  );
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
  const recorder = createUsageRecorder();
  const running = applyTraceEventToAgentConsole(queuedRuntimeConsole, startedRuntimeRun);
  const noisy = applyTraceEventToAgentConsole(running, {
    type: "usage.recorded",
    ...TEST_USAGE_ROUTE,
    eventId: "usage-noisy",
    agentRunId: "run-1",
    inputTokens: 0,
    outputTokens: -20,
    cacheReadTokens: Number.NaN,
    cacheWriteTokens: 1.5,
    cacheSavingsUsd: Number.POSITIVE_INFINITY,
    costUsd: 0,
  }, recorder);
  assert.deepEqual(noisy.agents[0]?.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheSavingsUsd: 0,
    costUsd: 0,
  });

  const real = applyTraceEventToAgentConsole(noisy, {
    type: "usage.recorded",
    ...TEST_USAGE_ROUTE,
    eventId: "usage-real",
    agentRunId: "run-1",
    inputTokens: 12,
    costUsd: 0.5,
  }, recorder);
  assert.deepEqual(real.agents[0]?.usage, {
    inputTokens: 12,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheSavingsUsd: 0,
    costUsd: 0.5,
  });

  const zeroed = applyTraceEventToAgentConsole(real, {
    type: "usage.recorded",
    ...TEST_USAGE_ROUTE,
    eventId: "usage-zero",
    agentRunId: "run-1",
    inputTokens: 0,
    costUsd: 0,
  }, recorder);
  assert.deepEqual(zeroed.agents[0]?.usage, {
    inputTokens: 12,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheSavingsUsd: 0,
    costUsd: 0.5,
  });

  assert.strictEqual(
    applyTraceEventToAgentConsole(real, {
      type: "usage.recorded",
      ...TEST_USAGE_ROUTE,
      eventId: "usage-orphan",
      agentRunId: "run-absent",
      inputTokens: 5,
    }, recorder),
    real,
    "usage for an unknown run is dropped",
  );
  assert.strictEqual(
    applyTraceEventToAgentConsole(real, {
      type: "usage.recorded",
      ...TEST_USAGE_ROUTE,
      agentRunId: "run-1",
      inputTokens: 5,
    }, recorder),
    real,
    "usage without a dedupe identity is dropped",
  );
});

test("lifecycle reducer bounds oversized summaries before persistence", () => {
  const running = applyTraceEventToAgentConsole(queuedRuntimeConsole, startedRuntimeRun);
  const settled = applyTraceEventToAgentConsole(running, {
    type: "agent.run.settled",
    eventId: "event-run-2",
    runId: "run-1",
    jobId: "job-1",
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

  assert.strictEqual(
    applyTraceEventToAgentConsole(queued, {
      ...startedRuntimeRun,
      eventId: "event-run-4",
      runId: "run-4",
      jobId: "job-absent",
    }),
    queued,
    "an unknown job link registers nothing",
  );
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
    "a run cannot settle a job that never took its ownership",
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

// A persisted job may carry a recorded start with no run link at all, which
// `parseAgentConsoleSnapshot` accepts. Standalone settlement is the only way
// such a job can reach a terminal status, so it is where the timeline bounds
// still bite.
const resumedUnownedJobConsole = Object.freeze({
  profileId: "build",
  activity: [],
  agents: [],
  jobs: [
    { id: "job-1", type: "work-node", label: "Map runtime", status: "running", queuedAt: 10, startedAt: 20 },
  ],
});

test("job lifecycle reducer rejects settlements whose timeline runs backwards", () => {
  const backwards = [
    { eventId: "event-job-2", startedAt: 5, completedAt: 30, why: "a start cannot precede the queueing" },
    { eventId: "event-job-3", startedAt: 15, completedAt: 30, why: "a start cannot precede a recorded start" },
    { eventId: "event-job-4", completedAt: 15, why: "completion cannot precede a recorded start" },
    { eventId: "event-job-5", startedAt: 25, completedAt: 22, why: "completion cannot precede its own start" },
    { eventId: "event-job-6", completedAt: 3, why: "completion cannot precede the queueing" },
  ];
  for (const { why, ...timeline } of backwards) {
    assert.strictEqual(
      applyTraceEventToAgentConsole(resumedUnownedJobConsole, {
        type: "job.settled",
        jobId: "job-1",
        status: "completed",
        ...timeline,
      }),
      resumedUnownedJobConsole,
      why,
    );
  }

  const settled = applyTraceEventToAgentConsole(resumedUnownedJobConsole, {
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

test("job lifecycle reducer refuses standalone settlement of a job an agent run owns", () => {
  const queued = applyTraceEventToAgentConsole(queuedRuntimeConsole, {
    ...queuedRuntimeJob,
    eventId: "event-job-2",
    jobId: "job-2",
    label: "Sweep cache",
    queuedAt: 11,
  });
  const running = applyTraceEventToAgentConsole(queued, startedRuntimeRun);
  assert.equal(running.jobs[0]?.agentRunId, "run-1");

  // A standalone settlement cannot be trusted to name the owner, so the job's
  // own link is what decides: every flavour is refused while run-1 owns job-1.
  const standalone = [
    { eventId: "event-job-3", agentRunId: "run-99", why: "a foreign owner cannot settle run-1's job" },
    { eventId: "event-job-4", agentRunId: "run-1", why: "even the true owner settles its job only through agent.run.settled" },
    { eventId: "event-job-5", why: "a settlement naming no owner cannot settle an owned job" },
  ];
  for (const { why, ...event } of standalone) {
    assert.strictEqual(
      applyTraceEventToAgentConsole(running, {
        type: "job.settled",
        jobId: "job-1",
        status: "failed",
        startedAt: 20,
        completedAt: 30,
        errorSummary: "Sweep aborted",
        ...event,
      }),
      running,
      why,
    );
  }
  assert.equal(running.agents[0]?.status, "running", "the owning run stays steerable");
  assert.equal(running.jobs[0]?.status, "running", "the owned job stays with its run");

  const unowned = applyTraceEventToAgentConsole(running, {
    type: "job.settled",
    eventId: "event-job-6",
    jobId: "job-2",
    status: "cancelled",
    completedAt: 30,
    summary: "Blocked by dependency.",
  });
  assert.equal(
    unowned.jobs[1]?.status,
    "cancelled",
    "a queued job that never opened a run still settles on its own",
  );
  assert.equal(unowned.jobs[1]?.completedAt, 30);
  assert.equal(unowned.jobs[1]?.summary, "Blocked by dependency.");
  assert.equal(unowned.agents[0]?.status, "running", "settling an unowned job leaves every run alone");

  const settled = applyTraceEventToAgentConsole(running, {
    type: "agent.run.settled",
    eventId: "event-run-2",
    runId: "run-1",
    jobId: "job-1",
    status: "completed",
    completedAt: 30,
  });
  assert.strictEqual(
    applyTraceEventToAgentConsole(settled, {
      type: "job.settled",
      eventId: "event-job-7",
      jobId: "job-1",
      agentRunId: "run-1",
      status: "failed",
      completedAt: 90,
    }),
    settled,
    "an owned job that settled with its run stays terminal",
  );
});

test("job lifecycle reducer keeps a job-first settlement from splitting its run", () => {
  const running = applyTraceEventToAgentConsole(queuedRuntimeConsole, startedRuntimeRun);

  const jobFirst = applyTraceEventToAgentConsole(running, {
    type: "job.settled",
    eventId: "event-job-2",
    jobId: "job-1",
    agentRunId: "run-1",
    status: "completed",
    startedAt: 20,
    completedAt: 30,
    summary: "Runtime mapped.",
  });
  assert.strictEqual(
    jobFirst,
    running,
    "a job.settled that lands ahead of its run settles neither side",
  );

  const settled = applyTraceEventToAgentConsole(jobFirst, {
    type: "agent.run.settled",
    eventId: "event-run-2",
    runId: "run-1",
    jobId: "job-1",
    status: "completed",
    startedAt: 20,
    completedAt: 30,
    summary: "Runtime mapped.",
  });
  assert.equal(settled.agents[0]?.status, "completed");
  assert.equal(
    settled.jobs[0]?.status,
    settled.agents[0]?.status,
    "the later run settlement carries its job to the same terminal status",
  );
  assert.equal(
    settled.jobs[0]?.completedAt,
    settled.agents[0]?.completedAt,
    "run and job share one completion timestamp",
  );
  assert.equal(settled.jobs[0]?.summary, "Runtime mapped.");
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
  const recorder = createUsageRecorder();
  let console = applyTraceEventToAgentConsole(initialConsole, queuedRuntimeJob);
  console = applyTraceEventToAgentConsole(console, {
    ...queuedRuntimeJob,
    eventId: "event-job-2",
    jobId: "job-2",
    label: "Sweep cache",
    queuedAt: 11,
  }, recorder);
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
    ...TEST_USAGE_ROUTE,
    eventId: "usage-1",
    agentRunId: "run-1",
    inputTokens: 10,
  }, recorder);
  assert.strictEqual(
    applyTraceEventToAgentConsole(scoped, {
      type: "usage.recorded",
      ...TEST_USAGE_ROUTE,
      eventId: "usage-1",
      inputTokens: 10,
    }, recorder),
    scoped,
    "a run-scoped event id cannot be re-charged to main usage",
  );
  assert.strictEqual(
    applyTraceEventToAgentConsole(scoped, {
      type: "usage.recorded",
      ...TEST_USAGE_ROUTE,
      eventId: "usage-1",
      agentRunId: "run-2",
      inputTokens: 10,
    }, recorder),
    scoped,
    "a run-scoped event id cannot be re-charged to another run",
  );

  const main = applyTraceEventToAgentConsole(ready, {
    type: "usage.recorded",
    ...TEST_USAGE_ROUTE,
    eventId: "usage-2",
    inputTokens: 7,
  }, recorder);
  assert.strictEqual(
    applyTraceEventToAgentConsole(main, {
      type: "usage.recorded",
      ...TEST_USAGE_ROUTE,
      eventId: "usage-2",
      agentRunId: "run-1",
      inputTokens: 7,
    }, recorder),
    main,
    "a main-charged event id cannot be re-charged to a run",
  );
});

test("usage reducer rejects a present but malformed scope instead of charging main usage", () => {
  const recorder = createUsageRecorder();
  const running = applyTraceEventToAgentConsole(queuedRuntimeConsole, startedRuntimeRun);

  const malformedScopes = ["   ", "", 42, null, {}, undefined];
  for (const [index, agentRunId] of malformedScopes.entries()) {
    assert.strictEqual(
      applyTraceEventToAgentConsole(running, {
        type: "usage.recorded",
        ...TEST_USAGE_ROUTE,
        eventId: `usage-bad-${index}`,
        agentRunId,
        inputTokens: 5,
      }, recorder),
      running,
      `a present but invalid scope (${JSON.stringify(agentRunId)}) must not charge main usage`,
    );
  }

  const absent = applyTraceEventToAgentConsole(running, {
    type: "usage.recorded",
    ...TEST_USAGE_ROUTE,
    eventId: "usage-absent",
    inputTokens: 5,
  }, recorder);
  assert.deepEqual(absent.mainUsage, {
    inputTokens: 5,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheSavingsUsd: 0,
    costUsd: 0,
  });

  const explicitlyUndefined = applyTraceEventToAgentConsole(running, {
    type: "usage.recorded",
    ...TEST_USAGE_ROUTE,
    eventId: "usage-undefined",
    agentRunId: undefined,
    inputTokens: 5,
  }, recorder);
  assert.strictEqual(
    explicitlyUndefined,
    running,
    "an own `agentRunId` property set to undefined is malformed, not unscoped",
  );
  assert.equal(explicitlyUndefined.mainUsage, undefined, "a malformed scope charges no ledger");
  assert.equal(explicitlyUndefined.agents[0]?.usage, undefined);
});

test("usage reducer still books a settled run's closing measurement", () => {
  const recorder = createUsageRecorder();
  const running = applyTraceEventToAgentConsole(queuedRuntimeConsole, startedRuntimeRun);
  const settled = applyTraceEventToAgentConsole(running, {
    type: "agent.run.settled",
    eventId: "event-run-2",
    runId: "run-1",
    jobId: "job-1",
    status: "completed",
    completedAt: 60,
  });

  // "A matching run" means a run this snapshot knows about, not a run that is
  // still active: the closing usage of a turn routinely lands after the run
  // settles, and dropping it would systematically understate subagent spend.
  const closing = applyTraceEventToAgentConsole(settled, {
    type: "usage.recorded",
    ...TEST_USAGE_ROUTE,
    eventId: "usage-closing",
    agentRunId: "run-1",
    inputTokens: 42,
    costUsd: 0.02,
  }, recorder);
  assert.deepEqual(closing.agents[0]?.usage, {
    inputTokens: 42,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheSavingsUsd: 0,
    costUsd: 0.02,
  });
  assert.equal(closing.agents[0]?.status, "completed");
  assert.equal(closing.mainUsage, undefined, "a settled run's usage never falls through to main");
});

test("usage reducer refuses measurements it could not persist", () => {
  const recorder = createUsageRecorder();
  const running = applyTraceEventToAgentConsole(queuedRuntimeConsole, startedRuntimeRun);

  assert.strictEqual(
    applyTraceEventToAgentConsole(running, {
      type: "usage.recorded",
      ...TEST_USAGE_ROUTE,
      eventId: "usage-huge",
      agentRunId: "run-1",
      inputTokens: Number.MAX_SAFE_INTEGER + 2,
    }, recorder),
    running,
    "a token count past the safe-integer range is rejected outright",
  );

  const near = applyTraceEventToAgentConsole(running, {
    type: "usage.recorded",
    ...TEST_USAGE_ROUTE,
    eventId: "usage-near",
    agentRunId: "run-1",
    inputTokens: Number.MAX_SAFE_INTEGER - 1,
  }, recorder);
  assert.equal(near.agents[0]?.usage?.inputTokens, Number.MAX_SAFE_INTEGER - 1);
  assert.ok(Number.isSafeInteger(near.agents[0]?.usage?.inputTokens));
  assert.strictEqual(
    applyTraceEventToAgentConsole(near, {
      type: "usage.recorded",
      ...TEST_USAGE_ROUTE,
      eventId: "usage-tip",
      agentRunId: "run-1",
      inputTokens: 10,
    }, recorder),
    near,
    "a token total that would leave the safe-integer range is rejected",
  );

  const heavy = applyTraceEventToAgentConsole(running, {
    type: "usage.recorded",
    ...TEST_USAGE_ROUTE,
    eventId: "usage-heavy",
    agentRunId: "run-1",
    costUsd: 1e308,
  }, recorder);
  assert.equal(heavy.agents[0]?.usage?.costUsd, 1e308);
  assert.ok(Number.isFinite(heavy.agents[0]?.usage?.costUsd));
  assert.strictEqual(
    applyTraceEventToAgentConsole(heavy, {
      type: "usage.recorded",
      ...TEST_USAGE_ROUTE,
      eventId: "usage-heavier",
      agentRunId: "run-1",
      costUsd: 1e308,
    }, recorder),
    heavy,
    "a monetary total that would stop being finite is rejected",
  );

  assert.strictEqual(
    applyTraceEventToAgentConsole(running, {
      type: "usage.recorded",
      ...TEST_USAGE_ROUTE,
      eventId: "usage-main-huge",
      inputTokens: Number.MAX_SAFE_INTEGER + 2,
    }),
    running,
    "main usage is held to the same bounds",
  );
});

test("tool reducer keeps a settled call terminal", () => {
  const started = applyTraceEventToAgentConsole(
    applyTraceEventToAgentConsole(queuedRuntimeConsole, startedRuntimeRun),
    {
      type: "tool.started",
      toolCallId: "call-1",
      toolName: "read_file",
      input: { path: "src/a.ts", i: "Reading runtime entry" },
      startedAt: 30,
      agentRunId: "run-1",
    },
  );
  const completed = applyTraceEventToAgentConsole(started, {
    type: "tool.completed",
    toolCallId: "call-1",
    toolName: "read_file",
    input: { path: "src/a.ts", i: "Reading runtime entry" },
    startedAt: 30,
    completedAt: 40,
    durationMs: 10,
    isError: false,
    output: "one line",
    agentRunId: "run-1",
  });
  assert.equal(completed.activity[0]?.status, "completed");
  assert.equal(completed.activity[0]?.summary, "completed · 10ms · 1 line");

  const stale = [
    {
      type: "tool.started",
      toolCallId: "call-1",
      toolName: "read_file",
      input: { path: "src/a.ts", i: "Reading runtime entry" },
      startedAt: 50,
      agentRunId: "run-1",
      why: "a settled call cannot reopen as running",
    },
    {
      type: "tool.completed",
      toolCallId: "call-1",
      toolName: "read_file",
      input: { path: "src/a.ts", i: "Reading runtime entry" },
      startedAt: 30,
      completedAt: 90,
      durationMs: 60,
      isError: true,
      agentRunId: "run-1",
      why: "a duplicate completion cannot re-time or re-grade the call",
    },
  ];
  for (const { why, ...event } of stale) {
    assert.strictEqual(applyTraceEventToAgentConsole(completed, event), completed, why);
  }

  const failed = applyTraceEventToAgentConsole(completed, {
    type: "tool.completed",
    toolCallId: "call-2",
    toolName: "run_shell",
    input: { command: "npm test" },
    startedAt: 41,
    completedAt: 45,
    isError: true,
    agentRunId: "run-1",
  });
  assert.equal(failed.activity[1]?.status, "failed");
  assert.strictEqual(
    applyTraceEventToAgentConsole(failed, {
      type: "tool.completed",
      toolCallId: "call-2",
      toolName: "run_shell",
      input: { command: "npm test" },
      startedAt: 41,
      completedAt: 46,
      isError: false,
      agentRunId: "run-1",
    }),
    failed,
    "a failed call cannot be rewritten as a success",
  );
});

test("work lifecycle reducer keeps terminal node statuses monotonic", () => {
  const proposed = applyTraceEventToAgentConsole(initialConsole, {
    type: "work.proposed",
    graphId: "goal-1",
    startedAt: 3,
    graph: {
      id: "goal-1",
      approval: "pending",
      nodes: [{
        id: "task-1",
        title: "Implement auth",
        prompt: "private executor assignment",
        status: "ready",
        dependsOn: [],
        fileOwnership: ["src/auth.ts"],
        evidenceRefs: [],
      }],
    },
  });
  const running = applyTraceEventToAgentConsole(proposed, {
    type: "work.status",
    graphId: "goal-1",
    nodeId: "task-1",
    status: "running",
  });
  assert.equal(running.workGraph?.nodes[0]?.status, "running");
  assert.strictEqual(
    applyTraceEventToAgentConsole(running, {
      type: "work.status",
      graphId: "goal-1",
      nodeId: "task-1",
      status: "running",
    }),
    running,
    "a repeated status projects nothing",
  );

  const completed = applyTraceEventToAgentConsole(running, {
    type: "work.status",
    graphId: "goal-1",
    nodeId: "task-1",
    status: "completed",
  });
  assert.equal(completed.workGraph?.nodes[0]?.status, "completed");

  for (const status of ["running", "ready", "blocked", "completed", "failed", "cancelled"]) {
    assert.strictEqual(
      applyTraceEventToAgentConsole(completed, {
        type: "work.status",
        graphId: "goal-1",
        nodeId: "task-1",
        status,
      }),
      completed,
      `a completed node cannot move to ${status}`,
    );
  }

  assert.strictEqual(
    applyTraceEventToAgentConsole(completed, {
      type: "work.status",
      graphId: "goal-1",
      nodeId: "task-absent",
      status: "running",
    }),
    completed,
    "an unknown node changes nothing",
  );
});

test("quality traces project stage, gate, iteration, node attempt, and artifacts into resume state", () => {
  const proposed = applyTraceEventToAgentConsole(initialConsole, {
    type: "work.proposed",
    graphId: "goal-quality",
    startedAt: 4,
    graph: {
      id: "goal-quality",
      qualityProfile: "standard",
      currentStage: "plan",
      gateStatus: "unproven",
      iteration: 0,
      approval: "approved",
      nodes: [{
        id: "task-1",
        title: "Implement auth",
        prompt: "private executor assignment",
        status: "running",
        dependsOn: [],
        fileOwnership: ["src/auth.ts"],
        acceptanceCriteria: ["tests pass"],
        evidenceRefs: [],
        stage: "work",
        role: "worker",
        attempt: 0,
        artifactRefs: [],
        reviewRequired: true,
      }],
    },
  });
  const started = applyTraceEventToAgentConsole(proposed, {
    type: "quality.stage_started",
    runId: "run-quality",
    graphId: "goal-quality",
    profile: "standard",
    stage: "work",
    iteration: 1,
    nodeId: "task-1",
    nodeAttempt: 1,
    startedAt: 10,
  });
  const gated = applyTraceEventToAgentConsole(started, {
    type: "quality.gate_evaluated",
    runId: "run-quality",
    graphId: "goal-quality",
    profile: "standard",
    stage: "work",
    iteration: 2,
    decision: "refine",
    nodeId: "task-1",
    nodeAttempt: 2,
    artifactRefs: [".unclecode/artifacts/run-quality/task-1-attempt-2.json"],
    artifactHash: "sha256:worker-v2",
    reviewedArtifactHash: "sha256:manifest-reviewed",
    currentArtifactHash: "sha256:manifest-current",
    evidenceRefs: ["evidence:test-output"],
    failures: ["critic found stale behavior"],
    reason: "Critic found stale behavior in the Korean queue path.",
    refineCount: 1,
    pivotCount: 0,
    provider: "anthropic",
    model: "claude-review",
    route: "frontier",
    reviewerRunId: "review-run-critic-2",
    stale: false,
    independentVerification: true,
    startedAt: 20,
  });
  assert.ok(gated.qualityReview, "quality review must be projected before persistence");
  const resumed = parseAgentConsoleSnapshot(JSON.parse(JSON.stringify(gated)));

  assert.equal(resumed?.workGraph?.currentStage, "work");
  assert.equal(resumed?.workGraph?.gateStatus, "refine");
  assert.equal(resumed?.workGraph?.iteration, 2);
  assert.equal(resumed?.workGraph?.nodes[0]?.attempt, 2);
  assert.deepEqual(resumed?.workGraph?.nodes[0]?.artifactRefs, [
    ".unclecode/artifacts/run-quality/task-1-attempt-2.json",
  ]);
  assert.deepEqual(resumed?.qualityReview, {
    runId: "run-quality",
    graphId: "goal-quality",
    profile: "standard",
    currentStage: "work",
    iteration: 2,
    refineCount: 1,
    pivotCount: 0,
    latestDecision: "refine",
    history: [{
      event: "gate",
      stage: "work",
      decision: "refine",
      iteration: 2,
      reason: "Critic found stale behavior in the Korean queue path.",
      failures: ["critic found stale behavior"],
      evidenceRefs: ["evidence:test-output"],
      artifactRefs: [".unclecode/artifacts/run-quality/task-1-attempt-2.json"],
      artifactHash: "sha256:worker-v2",
      reviewedArtifactHash: "sha256:manifest-reviewed",
      currentArtifactHash: "sha256:manifest-current",
      reviewerId: "work:anthropic:claude-review",
      reviewerRunId: "review-run-critic-2",
      provider: "anthropic",
      model: "claude-review",
      route: "frontier",
      independentVerification: true,
      stale: false,
      startedAt: 20,
    }],
  });

  const requested = applyTraceEventToAgentConsole(resumed, {
    type: "quality.refine_requested",
    runId: "run-quality",
    graphId: "goal-quality",
    profile: "standard",
    stage: "work",
    iteration: 3,
    decision: "refine",
    count: 2,
    limit: 3,
    reason: "Same plan, another bounded correction.",
    startedAt: 25,
  });
  const resumedRequest = parseAgentConsoleSnapshot(JSON.parse(JSON.stringify(requested)));
  assert.equal(resumedRequest?.qualityReview?.refineCount, 2);
  assert.equal(resumedRequest?.qualityReview?.history.at(-1)?.event, "refine");
  assert.equal(resumedRequest?.qualityReview?.history.at(-1)?.count, 2);
  assert.equal(resumedRequest?.qualityReview?.history.at(-1)?.limit, 3);

  const completed = applyTraceEventToAgentConsole(resumed, {
    type: "quality.completed",
    runId: "run-quality",
    graphId: "goal-quality",
    profile: "standard",
    stage: "promote",
    iteration: 3,
    decision: "unproven",
    startedAt: 30,
    completedAt: 31,
  });
  assert.equal(completed.workGraph?.currentStage, "promote");
  assert.equal(completed.workGraph?.gateStatus, "unproven");
  assert.equal(completed.workGraph?.iteration, 3);
  assert.equal(completed.qualityReview?.history.length, 2);
  assert.equal(completed.qualityReview?.history.at(-1)?.event, "completed");
  assert.equal(completed.qualityReview?.latestDecision, "unproven");
});

test("quality completion preserves only proven critic provenance and bounded artifacts", () => {
  const criticStarted = applyTraceEventToAgentConsole(initialConsole, {
    type: "quality.stage_started",
    runId: "run-quality-terminal",
    graphId: "goal-quality-terminal",
    profile: "deep",
    stage: "critic",
    iteration: 3,
    startedAt: 10,
  });
  const criticGate = applyTraceEventToAgentConsole(criticStarted, {
    type: "quality.gate_evaluated",
    runId: "run-quality-terminal",
    graphId: "goal-quality-terminal",
    profile: "deep",
    stage: "critic",
    iteration: 3,
    decision: "proceed",
    evidenceRefs: ["run.json", "critic.json"],
    artifactRefs: ["critic-artifact.json"],
    artifactHash: "sha256:verified",
    reviewedArtifactHash: "sha256:verified",
    currentArtifactHash: "sha256:verified",
    provider: "anthropic",
    model: "claude-review",
    route: "frontier",
    reviewerRunId: "critic-run-3",
    independentVerification: true,
    stale: false,
    startedAt: 20,
  });
  const promoteStarted = applyTraceEventToAgentConsole(criticGate, {
    type: "quality.stage_started",
    runId: "run-quality-terminal",
    graphId: "goal-quality-terminal",
    profile: "deep",
    stage: "promote",
    iteration: 3,
    startedAt: 30,
  });
  const completed = applyTraceEventToAgentConsole(promoteStarted, {
    type: "quality.completed",
    runId: "run-quality-terminal",
    graphId: "goal-quality-terminal",
    profile: "deep",
    stage: "promote",
    iteration: 3,
    decision: "proceed",
    evidenceRefs: ["run.json"],
    independentVerification: true,
    startedAt: 40,
  });
  const terminal = completed.qualityReview?.history.at(-1);
  assert.equal(terminal?.independentVerification, true);
  assert.equal(terminal?.reviewerRunId, "critic-run-3");
  assert.equal(terminal?.provider, "anthropic");
  assert.equal(terminal?.model, "claude-review");
  assert.equal(terminal?.route, "frontier");
  assert.equal(terminal?.artifactHash, "sha256:verified");
  assert.deepEqual(terminal?.artifactRefs, [
    "run.json",
    "critic-artifact.json",
    "critic.json",
  ]);

  const staleGate = applyTraceEventToAgentConsole(criticStarted, {
    type: "quality.gate_evaluated",
    runId: "run-quality-terminal",
    graphId: "goal-quality-terminal",
    profile: "deep",
    stage: "critic",
    iteration: 3,
    decision: "proceed",
    reviewerRunId: "critic-run-stale",
    independentVerification: true,
    stale: true,
    startedAt: 21,
  });
  const stalePromote = applyTraceEventToAgentConsole(staleGate, {
    type: "quality.stage_started",
    runId: "run-quality-terminal",
    graphId: "goal-quality-terminal",
    profile: "deep",
    stage: "promote",
    iteration: 3,
    startedAt: 31,
  });
  const unproven = applyTraceEventToAgentConsole(stalePromote, {
    type: "quality.completed",
    runId: "run-quality-terminal",
    graphId: "goal-quality-terminal",
    profile: "deep",
    stage: "promote",
    iteration: 3,
    decision: "unproven",
    independentVerification: true,
    startedAt: 41,
  }).qualityReview?.history.at(-1);
  assert.equal(unproven?.independentVerification, false);
  assert.equal(unproven?.reviewerRunId, undefined);
  assert.deepEqual(unproven?.artifactRefs, []);
});

test("quality projection is idempotent across live and restored trace replay", () => {
  const stage = {
    type: "quality.stage_started",
    runId: "run-replay",
    graphId: "graph-replay",
    profile: "deep",
    stage: "work",
    iteration: 0,
    startedAt: 10,
  };
  let snapshot = applyTraceEventToAgentConsole(initialConsole, stage);
  assert.strictEqual(applyTraceEventToAgentConsole(snapshot, stage), snapshot);

  const events = [
    {
      type: "quality.gate_evaluated",
      runId: "run-replay",
      graphId: "graph-replay",
      profile: "deep",
      stage: "work",
      iteration: 0,
      decision: "proceed",
      artifactHash: "sha256:worker",
      startedAt: 20,
    },
    {
      type: "quality.refine_requested",
      runId: "run-replay",
      graphId: "graph-replay",
      profile: "deep",
      stage: "critic",
      iteration: 1,
      decision: "refine",
      count: 1,
      limit: 3,
      startedAt: 30,
    },
    {
      type: "quality.pivot_requested",
      runId: "run-replay",
      graphId: "graph-replay",
      profile: "deep",
      stage: "critic",
      iteration: 2,
      decision: "pivot",
      count: 1,
      limit: 2,
      startedAt: 40,
    },
    {
      type: "quality.completed",
      runId: "run-replay",
      graphId: "graph-replay",
      profile: "deep",
      stage: "promote",
      iteration: 2,
      decision: "unproven",
      startedAt: 50,
    },
  ];

  for (const event of events) {
    snapshot = applyTraceEventToAgentConsole(snapshot, event);
    assert.strictEqual(applyTraceEventToAgentConsole(snapshot, event), snapshot);
    const restored = parseAgentConsoleSnapshot(JSON.parse(JSON.stringify(snapshot)));
    assert.ok(restored);
    assert.strictEqual(applyTraceEventToAgentConsole(restored, event), restored);
  }
  assert.deepEqual(snapshot.qualityReview?.history.map(({ event }) => event), [
    "gate", "refine", "pivot", "completed",
  ]);
});

test("quality projection cannot regress a stage or overwrite same-iteration completion", () => {
  const critic = applyTraceEventToAgentConsole(initialConsole, {
    type: "quality.stage_started",
    runId: "run-monotonic",
    graphId: "graph-monotonic",
    profile: "deep",
    stage: "critic",
    iteration: 3,
    startedAt: 30,
  });
  const promote = applyTraceEventToAgentConsole(critic, {
    type: "quality.stage_started",
    runId: "run-monotonic",
    graphId: "graph-monotonic",
    profile: "deep",
    stage: "promote",
    iteration: 3,
    startedAt: 40,
  });

  for (const stage of ["work", "critic"]) {
    assert.strictEqual(applyTraceEventToAgentConsole(promote, {
      type: "quality.stage_started",
      runId: "run-monotonic",
      graphId: "graph-monotonic",
      profile: "deep",
      stage,
      iteration: 3,
      startedAt: 20,
    }), promote);
  }

  const completed = applyTraceEventToAgentConsole(promote, {
    type: "quality.completed",
    runId: "run-monotonic",
    graphId: "graph-monotonic",
    profile: "deep",
    stage: "promote",
    iteration: 3,
    decision: "unproven",
    startedAt: 50,
  });
  assert.strictEqual(applyTraceEventToAgentConsole(completed, {
    type: "quality.gate_evaluated",
    runId: "run-monotonic",
    graphId: "graph-monotonic",
    profile: "deep",
    stage: "promote",
    iteration: 3,
    decision: "block",
    startedAt: 60,
  }), completed);
  assert.equal(completed.qualityReview?.currentStage, "promote");
  assert.equal(completed.qualityReview?.latestDecision, "unproven");
});

test("agent lifecycle reducer accepts run events only against the job the run owns", () => {
  const queued = applyTraceEventToAgentConsole(queuedRuntimeConsole, {
    ...queuedRuntimeJob,
    eventId: "event-job-2",
    jobId: "job-2",
    label: "Sweep cache",
    queuedAt: 11,
  });
  const { jobId, ...unlinkedRun } = startedRuntimeRun;

  const rejectedStarts = [
    { ...unlinkedRun, eventId: "event-run-a", runId: "run-a", why: "a run start with no job link is rejected" },
    { ...startedRuntimeRun, eventId: "event-run-b", runId: "run-b", jobId: "job-absent", why: "a run start naming an unknown job is rejected" },
    { ...startedRuntimeRun, eventId: "event-run-c", runId: "run-c", jobId: "   ", why: "a blank job link is no link at all" },
  ];
  for (const { why, ...event } of rejectedStarts) {
    assert.strictEqual(applyTraceEventToAgentConsole(queued, event), queued, why);
  }

  const running = applyTraceEventToAgentConsole(queued, startedRuntimeRun);
  assert.equal(running.jobs[0]?.agentRunId, "run-1");
  assert.deepEqual(
    running.jobs[1],
    queued.jobs[1],
    "a run start leaves every job but its own untouched",
  );

  const rejectedSettlements = [
    { eventId: "event-run-d", why: "a settlement with no job link is rejected" },
    { eventId: "event-run-e", jobId: "job-absent", why: "a settlement naming an unknown job is rejected" },
    { eventId: "event-run-f", jobId: "job-2", why: "a merely queued job the run never owned cannot be settled" },
  ];
  for (const { why, ...settlement } of rejectedSettlements) {
    assert.strictEqual(
      applyTraceEventToAgentConsole(running, {
        type: "agent.run.settled",
        runId: "run-1",
        status: "completed",
        completedAt: 40,
        ...settlement,
      }),
      running,
      why,
    );
  }

  const lateOwnedJob = applyTraceEventToAgentConsole(running, {
    ...queuedRuntimeJob,
    eventId: "event-job-3",
    jobId: "job-late",
    label: "Deferred audit",
    queuedAt: 500,
    agentRunId: "run-1",
  });
  assert.strictEqual(
    applyTraceEventToAgentConsole(lateOwnedJob, {
      type: "agent.run.settled",
      eventId: "event-run-g",
      runId: "run-1",
      jobId: "job-late",
      status: "completed",
      completedAt: 40,
    }),
    lateOwnedJob,
    "an owned job queued after the run finished is mis-routed",
  );

  const settled = applyTraceEventToAgentConsole(running, {
    type: "agent.run.settled",
    eventId: "event-run-h",
    runId: "run-1",
    jobId: "job-1",
    status: "completed",
    completedAt: 40,
  });
  assert.equal(settled.agents[0]?.status, "completed");
  assert.equal(settled.jobs[0]?.status, "completed");
  assert.deepEqual(settled.jobs[1], queued.jobs[1], "another job never settles with a foreign run");
});
