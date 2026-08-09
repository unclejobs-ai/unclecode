import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_CONSOLE_TABS,
  AGENT_CONTROL_RECEIPT_STATUSES,
  AGENT_RUN_STATUSES,
  ASYNC_JOB_STATUSES,
  MAX_LIFECYCLE_SUMMARY_CHARS,
  boundLifecycleSummary,
  createAgentConsoleSnapshot,
  isAskUserQuestionAnswered,
  isCoalescibleToolActivity,
  isWorkGraphDispatchable,
  markUnrecoverableAgentConsoleWorkInterrupted,
  parseAgentConsoleSnapshot,
} from "@unclecode/contracts";

function activity(kind, status = "completed") {
  return {
    id: `${kind}-1`,
    toolCallId: `${kind}-call-1`,
    toolName: `${kind}_tool`,
    kind,
    intent: `Run ${kind}`,
    status,
    startedAt: 1,
  };
}

test("agent-console distinguishes answered questions from non-answer outcomes", () => {
  assert.equal(
    isAskUserQuestionAnswered({ status: "answered", answers: [] }),
    true,
  );
  assert.equal(isAskUserQuestionAnswered({ status: "cancelled" }), false);
  assert.equal(
    isAskUserQuestionAnswered({ status: "timed_out", answers: [] }),
    false,
  );
  assert.equal(
    isAskUserQuestionAnswered({
      status: "unavailable",
      reason: "TUI is not connected.",
    }),
    false,
  );
});

test("agent-console refuses work dispatch until graph approval", () => {
  const graph = {
    id: "graph-1",
    approval: "pending",
    nodes: [
      {
        id: "node-1",
        title: "Implement manifest",
        prompt: "Implement the manifest.",
        status: "ready",
        dependsOn: [],
        fileOwnership: ["packages/context-broker/src/prompt-manifest.ts"],
        manifestId: "manifest-1",
        evidenceRefs: [],
      },
    ],
  };

  assert.equal(isWorkGraphDispatchable(graph), false);
  assert.equal(
    isWorkGraphDispatchable({ ...graph, approval: "approved" }),
    true,
  );
});

test("agent-console retains compact evidence while stripping raw tool output", () => {
  const snapshot = createAgentConsoleSnapshot({
    profileId: "build",
    activity: [
      {
        ...activity("execute"),
        summary: "exit 0 · 34ms",
        output: "unbounded raw stdout that must not persist",
      },
    ],
  });

  assert.deepEqual(snapshot.activity, [
    {
      ...activity("execute"),
      summary: "exit 0 · 34ms",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /unbounded raw stdout/);
});

test("agent-console only coalesces completed routine read and search evidence", () => {
  assert.equal(isCoalescibleToolActivity(activity("read")), true);
  assert.equal(isCoalescibleToolActivity(activity("search")), true);
  assert.equal(isCoalescibleToolActivity(activity("write")), false);
  assert.equal(isCoalescibleToolActivity(activity("delete")), false);
  assert.equal(isCoalescibleToolActivity(activity("execute")), false);
  assert.equal(isCoalescibleToolActivity(activity("read", "running")), false);
});

test("agent-console journal snapshot restores one pending decision and running work node", () => {
  const snapshot = createAgentConsoleSnapshot({
    profileId: "review",
    pendingDecision: {
      id: "decision-1",
      questions: [
        {
          id: "approve",
          question: "Dispatch this graph?",
          options: [{ label: "Approve" }, { label: "Reject" }],
          recommended: 0,
        },
      ],
    },
    workGraph: {
      id: "graph-1",
      approval: "approved",
      nodes: [
        {
          id: "node-1",
          title: "Run focused tests",
          prompt: "Run tests.",
          status: "running",
          dependsOn: [],
          fileOwnership: [],
          manifestId: "manifest-1",
          evidenceRefs: ["tool-call-1"],
        },
      ],
    },
    activity: [],
  });

  assert.equal(snapshot.pendingDecision?.id, "decision-1");
  assert.equal(snapshot.workGraph?.nodes[0]?.status, "running");
});

test("agent-console resume parser keeps declared evidence and rejects raw tool output", async () => {
  const { parseAgentConsoleSnapshot } = await import("@unclecode/contracts");
  const parsed = parseAgentConsoleSnapshot({
    profileId: "build",
    activity: [
      {
        ...activity("execute"),
        summary: "exit 0",
        output: "unbounded raw stdout",
      },
    ],
  });

  assert.deepEqual(parsed, {
    profileId: "build",
    activity: [
      {
        ...activity("execute"),
        summary: "exit 0",
      },
    ],
    agents: [],
    jobs: [],
  });
  assert.equal(
    parseAgentConsoleSnapshot({
      profileId: "build",
      activity: [{ ...activity("execute"), kind: "not-a-kind" }],
    }),
    undefined,
  );
});

test("agent-console resume parser accepts goal metadata before a prompt manifest exists", async () => {
  const { parseAgentConsoleSnapshot } = await import("@unclecode/contracts");
  const parsed = parseAgentConsoleSnapshot({
    profileId: "build",
    workGraph: {
      id: "goal-1",
      goal: "Ship auth",
      constraints: ["No new dependencies"],
      approval: "approved",
      nodes: [
        {
          id: "task-1",
          title: "Implement auth",
          prompt: "executor assignment",
          status: "ready",
          dependsOn: [],
          fileOwnership: ["src/auth.ts"],
          acceptanceCriteria: ["Auth tests pass"],
          evidenceRefs: [],
        },
      ],
    },
    activity: [],
  });

  assert.equal(parsed?.workGraph?.goal, "Ship auth");
  assert.deepEqual(parsed?.workGraph?.nodes[0]?.acceptanceCriteria, [
    "Auth tests pass",
  ]);
  assert.equal(parsed?.workGraph?.nodes[0]?.manifestId, undefined);
});

test("agent-console resume parser round-trips every safe lifecycle field", () => {
  const parsed = parseAgentConsoleSnapshot({
    profileId: "build",
    activity: [
      {
        id: "tool:1",
        toolCallId: "call-1",
        toolName: "read_file",
        kind: "read",
        intent: "Reading source",
        status: "running",
        startedAt: 10,
        agentRunId: "run-1",
      },
    ],
    agents: [
      {
        id: "run-1",
        displayName: "ExecutionMap",
        agentType: "executor",
        status: "completed",
        currentActivity: "Reading source",
        parentRunId: "run-root",
        continuationOf: "run-0",
        transcriptRef: "transcript/run-1.json",
        startedAt: 10,
        completedAt: 30,
        summary: "Mapped the execution path",
        errorSummary: "one retried tool call",
        usage: {
          eventIds: ["usage-run-1"],
          inputTokens: 120,
          outputTokens: 45,
          cacheReadTokens: 12,
          costUsd: 0.125,
        },
        rawPrompt: "must disappear",
      },
    ],
    jobs: [
      {
        id: "job-1",
        type: "work-node",
        label: "Map execution",
        status: "completed",
        agentRunId: "run-1",
        queuedAt: 9,
        startedAt: 10,
        completedAt: 30,
        summary: "Job finished",
        errorSummary: "one retry",
        providerPayload: { messages: ["must disappear"] },
      },
    ],
    mainUsage: {
      eventIds: ["usage-main-1"],
      inputTokens: 300,
      outputTokens: 90,
      cacheReadTokens: 24,
      costUsd: 0.25,
    },
  });

  assert.deepEqual(parsed?.agents, [
    {
      id: "run-1",
      displayName: "ExecutionMap",
      agentType: "executor",
      status: "completed",
      currentActivity: "Reading source",
      parentRunId: "run-root",
      continuationOf: "run-0",
      transcriptRef: "transcript/run-1.json",
      startedAt: 10,
      completedAt: 30,
      summary: "Mapped the execution path",
      errorSummary: "one retried tool call",
      usage: {
        eventIds: ["usage-run-1"],
        inputTokens: 120,
        outputTokens: 45,
        cacheReadTokens: 12,
        costUsd: 0.125,
      },
    },
  ]);
  assert.deepEqual(parsed?.jobs, [
    {
      id: "job-1",
      type: "work-node",
      label: "Map execution",
      status: "completed",
      agentRunId: "run-1",
      queuedAt: 9,
      startedAt: 10,
      completedAt: 30,
      summary: "Job finished",
      errorSummary: "one retry",
    },
  ]);
  assert.deepEqual(parsed?.mainUsage, {
    eventIds: ["usage-main-1"],
    inputTokens: 300,
    outputTokens: 90,
    cacheReadTokens: 24,
    costUsd: 0.25,
  });
  assert.equal(parsed?.activity[0]?.agentRunId, "run-1");
  assert.doesNotMatch(JSON.stringify(parsed), /must disappear/);
});

test("agent-console resume parser defaults legacy snapshots to empty lifecycle arrays", () => {
  const parsed = parseAgentConsoleSnapshot({
    profileId: "explore",
    activity: [activity("read")],
  });

  assert.deepEqual(parsed?.agents, []);
  assert.deepEqual(parsed?.jobs, []);
  assert.equal(parsed?.mainUsage, undefined);
  assert.equal(parsed?.activity[0]?.agentRunId, undefined);
});

test("agent-console resume parser rejects malformed lifecycle records", () => {
  const base = {
    profileId: "build",
    activity: [],
    agents: [
      {
        id: "run-1",
        displayName: "ExecutionMap",
        agentType: "executor",
        status: "running",
        startedAt: 10,
      },
    ],
    jobs: [],
  };

  assert.notEqual(parseAgentConsoleSnapshot(base), undefined);
  assert.equal(
    parseAgentConsoleSnapshot({
      ...base,
      agents: [{ ...base.agents[0], status: "thinking" }],
    }),
    undefined,
  );
  assert.equal(
    parseAgentConsoleSnapshot({
      ...base,
      agents: [{ ...base.agents[0], startedAt: -1 }],
    }),
    undefined,
  );
  assert.equal(
    parseAgentConsoleSnapshot({
      ...base,
      agents: [{ ...base.agents[0], completedAt: 1.5 }],
    }),
    undefined,
  );
  assert.equal(
    parseAgentConsoleSnapshot({
      ...base,
      jobs: [
        {
          id: "job-1",
          type: "work-node",
          label: "Map execution",
          status: "pending",
          queuedAt: 9,
        },
      ],
    }),
    undefined,
  );
  assert.equal(
    parseAgentConsoleSnapshot({ ...base, agents: "not-an-array" }),
    undefined,
  );
  assert.equal(
    parseAgentConsoleSnapshot({ ...base, mainUsage: { eventIds: [""] } }),
    undefined,
  );
});

test("agent-console snapshot factory copies and bounds lifecycle projections", () => {
  const agents = Array.from({ length: 200 }, (_, index) => ({
    id: `run-${index}`,
    displayName: `Agent ${index}`,
    agentType: "executor",
    status: "completed",
    startedAt: index,
    completedAt: index + 1,
  }));
  const jobs = Array.from({ length: 200 }, (_, index) => ({
    id: `job-${index}`,
    type: "work-node",
    label: `Job ${index}`,
    status: "completed",
    queuedAt: index,
  }));
  const eventIds = Array.from({ length: 300 }, (_, index) => `usage-${index}`);

  const snapshot = createAgentConsoleSnapshot({
    profileId: "build",
    activity: [],
    agents,
    jobs,
    mainUsage: { eventIds, inputTokens: 12, costUsd: 0.5 },
  });

  assert.equal(snapshot.agents.length, 128);
  assert.equal(snapshot.agents[0]?.id, "run-72");
  assert.equal(snapshot.jobs.length, 128);
  assert.equal(snapshot.jobs[0]?.id, "job-72");
  assert.equal(snapshot.mainUsage?.eventIds.length, 256);
  assert.equal(snapshot.mainUsage?.eventIds[0], "usage-44");

  agents.push({
    id: "run-late",
    displayName: "Late",
    agentType: "executor",
    status: "running",
    startedAt: 999,
  });
  eventIds.push("usage-late");
  assert.equal(snapshot.agents.length, 128);
  assert.equal(snapshot.agents.at(-1)?.id, "run-199");
  assert.equal(snapshot.mainUsage?.eventIds.at(-1), "usage-299");
});

test("agent-console snapshot factory drops undeclared lifecycle fields", () => {
  const snapshot = createAgentConsoleSnapshot({
    profileId: "build",
    activity: [],
    agents: [
      {
        id: "run-1",
        displayName: "ExecutionMap",
        agentType: "executor",
        status: "running",
        startedAt: 10,
        rawPrompt: "must disappear",
        apiKey: "sk-secret",
      },
    ],
    jobs: [
      {
        id: "job-1",
        type: "work-node",
        label: "Map execution",
        status: "queued",
        queuedAt: 9,
        providerPayload: { messages: ["must disappear"] },
      },
    ],
  });

  assert.deepEqual(snapshot.agents, [
    {
      id: "run-1",
      displayName: "ExecutionMap",
      agentType: "executor",
      status: "running",
      startedAt: 10,
    },
  ]);
  assert.deepEqual(snapshot.jobs, [
    {
      id: "job-1",
      type: "work-node",
      label: "Map execution",
      status: "queued",
      queuedAt: 9,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /must disappear|sk-secret/);
});

test("agent-console resume marks unrecoverable active work interrupted", () => {
  const snapshot = createAgentConsoleSnapshot({
    profileId: "build",
    activity: [],
    agents: [
      {
        id: "run-queued",
        displayName: "Queued",
        agentType: "executor",
        status: "queued",
        startedAt: 1,
      },
      {
        id: "run-running",
        displayName: "Running",
        agentType: "executor",
        status: "running",
        startedAt: 2,
      },
      {
        id: "run-waiting",
        displayName: "Waiting",
        agentType: "reviewer",
        status: "waiting",
        startedAt: 3,
      },
      {
        id: "run-failed",
        displayName: "Failed",
        agentType: "executor",
        status: "failed",
        startedAt: 4,
        completedAt: 5,
        errorSummary: "boom",
      },
    ],
    jobs: [
      {
        id: "job-queued",
        type: "work-node",
        label: "Queued",
        status: "queued",
        queuedAt: 1,
      },
      {
        id: "job-running",
        type: "work-node",
        label: "Running",
        status: "running",
        queuedAt: 2,
        startedAt: 3,
      },
      {
        id: "job-cancelled",
        type: "work-node",
        label: "Cancelled",
        status: "cancelled",
        queuedAt: 4,
        completedAt: 6,
      },
    ],
  });
  const before = JSON.stringify(snapshot);

  const resumed = markUnrecoverableAgentConsoleWorkInterrupted(snapshot, 42);

  assert.notEqual(resumed, snapshot);
  assert.deepEqual(
    resumed.agents.map((agent) => [agent.id, agent.status, agent.completedAt]),
    [
      ["run-queued", "interrupted", 42],
      ["run-running", "interrupted", 42],
      ["run-waiting", "interrupted", 42],
      ["run-failed", "failed", 5],
    ],
  );
  assert.equal(resumed.agents[3]?.errorSummary, "boom");
  assert.deepEqual(
    resumed.jobs.map((job) => [job.id, job.status, job.completedAt]),
    [
      ["job-queued", "interrupted", 42],
      ["job-running", "interrupted", 42],
      ["job-cancelled", "cancelled", 6],
    ],
  );
  assert.equal(JSON.stringify(snapshot), before);
});

test("agent-console resume returns the same snapshot when no active work exists", () => {
  const snapshot = createAgentConsoleSnapshot({
    profileId: "build",
    activity: [],
    agents: [
      {
        id: "run-done",
        displayName: "Done",
        agentType: "executor",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
      },
    ],
    jobs: [
      {
        id: "job-done",
        type: "work-node",
        label: "Done",
        status: "completed",
        queuedAt: 1,
        completedAt: 2,
      },
    ],
  });

  assert.equal(
    markUnrecoverableAgentConsoleWorkInterrupted(snapshot, 42),
    snapshot,
  );
});

test("agent-console bounds persisted lifecycle summaries", () => {
  const exact = "x".repeat(MAX_LIFECYCLE_SUMMARY_CHARS);
  const overBy1 = "x".repeat(MAX_LIFECYCLE_SUMMARY_CHARS + 1);
  const long = "x".repeat(MAX_LIFECYCLE_SUMMARY_CHARS + 500);

  assert.equal(boundLifecycleSummary("short summary"), "short summary");
  assert.equal(boundLifecycleSummary(exact), exact);
  assert.equal(
    boundLifecycleSummary(exact).length,
    MAX_LIFECYCLE_SUMMARY_CHARS,
  );

  // One character over the budget must truncate and still fit the budget.
  assert.notEqual(boundLifecycleSummary(overBy1), overBy1);
  assert.equal(
    boundLifecycleSummary(overBy1).length,
    MAX_LIFECYCLE_SUMMARY_CHARS,
  );
  assert.match(boundLifecycleSummary(overBy1), /summary truncated$/);

  assert.equal(boundLifecycleSummary(long).length, MAX_LIFECYCLE_SUMMARY_CHARS);
  assert.match(boundLifecycleSummary(long), /summary truncated$/);
  assert.ok(
    parseAgentConsoleSnapshot({
      profileId: "build",
      activity: [],
      agents: [],
      jobs: [
        {
          id: "job-1",
          type: "work-node",
          label: "Map execution",
          status: "failed",
          queuedAt: 1,
          completedAt: 2,
          summary: long,
          errorSummary: long,
        },
      ],
    })?.jobs.every(
      (job) =>
        (job.summary?.length ?? 0) <= MAX_LIFECYCLE_SUMMARY_CHARS &&
        (job.errorSummary?.length ?? 0) <= MAX_LIFECYCLE_SUMMARY_CHARS,
    ),
  );

  const parsed = parseAgentConsoleSnapshot({
    profileId: "build",
    activity: [],
    agents: [
      {
        id: "run-1",
        displayName: "ExecutionMap",
        agentType: "executor",
        status: "failed",
        startedAt: 1,
        completedAt: 2,
        summary: long,
        errorSummary: long,
      },
    ],
    jobs: [],
  });

  assert.equal(parsed?.agents[0]?.summary, boundLifecycleSummary(long));
  assert.equal(parsed?.agents[0]?.errorSummary, boundLifecycleSummary(long));
});

test("agent-console exposes lifecycle, control, and tab unions", () => {
  assert.deepEqual(AGENT_RUN_STATUSES, [
    "queued",
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]);
  assert.deepEqual(ASYNC_JOB_STATUSES, [
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]);
  assert.deepEqual(AGENT_CONTROL_RECEIPT_STATUSES, [
    "accepted",
    "not_delivered",
    "rejected",
  ]);
  assert.deepEqual(AGENT_CONSOLE_TABS, ["agents", "jobs", "plan"]);
});

test("agent-console parser bounds oversized lifecycle lists to the newest tail", () => {
  const validAgent = (index) => ({
    id: `run-${index}`,
    displayName: `Agent ${index}`,
    agentType: "executor",
    status: "completed",
    startedAt: index,
  });
  const validJob = (index) => ({
    id: `job-${index}`,
    type: "work-node",
    label: `Job ${index}`,
    status: "completed",
    queuedAt: index,
  });
  const oversized = 5_000;
  const agents = Array.from({ length: oversized }, (_, index) => validAgent(index));
  const jobs = Array.from({ length: oversized }, (_, index) => validJob(index));

  const parsed = parseAgentConsoleSnapshot({
    profileId: "build",
    activity: [],
    agents,
    jobs,
  });

  // Only the newest 128 of 5000 survive, in order, for both projections.
  assert.equal(parsed?.agents.length, 128);
  assert.equal(parsed?.agents[0]?.id, `run-${oversized - 128}`);
  assert.equal(parsed?.agents.at(-1)?.id, `run-${oversized - 1}`);
  assert.deepEqual(
    parsed?.agents.map((agent) => agent.startedAt),
    Array.from({ length: 128 }, (_, index) => oversized - 128 + index),
  );
  assert.equal(parsed?.jobs.length, 128);
  assert.equal(parsed?.jobs[0]?.id, `job-${oversized - 128}`);
  assert.equal(parsed?.jobs.at(-1)?.id, `job-${oversized - 1}`);
});

test("agent-console parser rejects a malformed record inside the discarded prefix", () => {
  const validAgent = (index) => ({
    id: `run-${index}`,
    displayName: `Agent ${index}`,
    agentType: "executor",
    status: "completed",
    startedAt: index,
  });
  const oversized = 5_000;
  const agents = Array.from({ length: oversized }, (_, index) => validAgent(index));

  // Index 0 and a deep interior index both sit far outside the retained tail.
  for (const poisonedIndex of [0, 2_500]) {
    const poisoned = agents.map((agent, index) =>
      index === poisonedIndex ? { ...agent, status: "thinking" } : agent,
    );
    assert.equal(
      parseAgentConsoleSnapshot({
        profileId: "build",
        activity: [],
        agents: poisoned,
        jobs: [],
      }),
      undefined,
      `agent index ${poisonedIndex} must reject the snapshot`,
    );
  }

  assert.equal(
    parseAgentConsoleSnapshot({
      profileId: "build",
      activity: [],
      agents: [],
      jobs: [
        {
          id: "job-0",
          type: "work-node",
          label: "Bad",
          status: "pending",
          queuedAt: 0,
        },
        ...Array.from({ length: 200 }, (_, index) => ({
          id: `job-${index + 1}`,
          type: "work-node",
          label: `Job ${index}`,
          status: "completed",
          queuedAt: index,
        })),
      ],
    }),
    undefined,
  );
});

test("agent-console deduplicates usage event ids before capping", () => {
  const snapshot = createAgentConsoleSnapshot({
    profileId: "build",
    activity: [],
    agents: [],
    jobs: [],
    mainUsage: {
      eventIds: [
        ...Array.from({ length: 300 }, () => "usage-repeat"),
        "usage-distinct-a",
        "usage-distinct-b",
      ],
    },
  });

  assert.deepEqual(snapshot.mainUsage?.eventIds, [
    "usage-repeat",
    "usage-distinct-a",
    "usage-distinct-b",
  ]);

  const capped = createAgentConsoleSnapshot({
    profileId: "build",
    activity: [],
    agents: [],
    jobs: [],
    mainUsage: {
      eventIds: Array.from(
        { length: 300 },
        (_, index) => `usage-${index % 260}`,
      ),
    },
  });

  assert.equal(capped.mainUsage?.eventIds.length, 256);
  assert.equal(new Set(capped.mainUsage?.eventIds).size, 256);
});

test("agent-console snapshot factory copies nested manifest, decision, and graph arrays", () => {
  const policy = [
    {
      id: "policy-1",
      label: "Repo rules",
      authority: "mandatory",
      digest: "abc",
    },
  ];
  const options = [{ label: "Approve" }, { label: "Reject" }];
  const questions = [{ id: "approve", question: "Dispatch?", options }];
  const constraints = ["No new dependencies"];
  const dependsOn = ["node-0"];
  const fileOwnership = ["src/auth.ts"];
  const acceptanceCriteria = ["Auth tests pass"];
  const evidenceRefs = ["tool-call-1"];
  const nodes = [
    {
      id: "node-1",
      title: "Implement auth",
      prompt: "executor assignment",
      status: "ready",
      dependsOn,
      fileOwnership,
      acceptanceCriteria,
      evidenceRefs,
    },
  ];

  const snapshot = createAgentConsoleSnapshot({
    profileId: "build",
    manifest: {
      id: "manifest-1",
      profileId: "build",
      createdAt: "2026-08-09T00:00:00.000Z",
      packetId: "packet-1",
      policy,
      includedSourceCount: 1,
      excludedSourceCount: 0,
      tokenEstimate: 10,
    },
    pendingDecision: { id: "decision-1", title: "Dispatch", questions },
    workGraph: {
      id: "graph-1",
      goal: "Ship auth",
      constraints,
      approval: "approved",
      nodes,
    },
    activity: [],
    agents: [],
    jobs: [],
  });

  policy.push({
    id: "leak",
    label: "Leak",
    authority: "mandatory",
    digest: "zzz",
  });
  policy[0].label = "mutated";
  options.push({ label: "Leak" });
  questions.push({ id: "leak", question: "Leak?", options: [] });
  constraints.push("leak");
  nodes.push({ ...nodes[0], id: "leak" });
  dependsOn.push("leak");
  fileOwnership.push("leak");
  acceptanceCriteria.push("leak");
  evidenceRefs.push("leak");

  assert.equal(snapshot.manifest?.policy.length, 1);
  assert.equal(snapshot.manifest?.policy[0]?.label, "Repo rules");
  assert.equal(snapshot.pendingDecision?.questions.length, 1);
  assert.equal(snapshot.pendingDecision?.questions[0]?.options.length, 2);
  assert.deepEqual(snapshot.workGraph?.constraints, ["No new dependencies"]);
  assert.equal(snapshot.workGraph?.nodes.length, 1);
  assert.deepEqual(snapshot.workGraph?.nodes[0]?.dependsOn, ["node-0"]);
  assert.deepEqual(snapshot.workGraph?.nodes[0]?.fileOwnership, [
    "src/auth.ts",
  ]);
  assert.deepEqual(snapshot.workGraph?.nodes[0]?.acceptanceCriteria, [
    "Auth tests pass",
  ]);
  assert.deepEqual(snapshot.workGraph?.nodes[0]?.evidenceRefs, ["tool-call-1"]);
  assert.doesNotMatch(JSON.stringify(snapshot), /leak|mutated/);
});
