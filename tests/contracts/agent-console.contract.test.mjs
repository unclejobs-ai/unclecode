import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");

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

test("agent-console resume parser restores lifecycle records without raw prompts", () => {
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
        status: "running",
        startedAt: 10,
        rawPrompt: "must disappear",
      },
    ],
    jobs: [
      {
        id: "job-1",
        type: "work-node",
        label: "Map execution",
        status: "running",
        agentRunId: "run-1",
        queuedAt: 9,
        startedAt: 10,
      },
    ],
    mainUsage: { eventIds: ["usage-main-1"], costUsd: 0.25 },
  });

  assert.equal(parsed?.agents[0]?.id, "run-1");
  assert.equal(parsed?.agents[0]?.displayName, "ExecutionMap");
  assert.equal(parsed?.agents[0]?.agentType, "executor");
  assert.equal(parsed?.agents[0]?.status, "running");
  assert.equal(parsed?.agents[0]?.startedAt, 10);
  assert.equal("rawPrompt" in (parsed?.agents[0] ?? {}), false);
  assert.doesNotMatch(JSON.stringify(parsed), /must disappear/);

  assert.equal(parsed?.jobs[0]?.id, "job-1");
  assert.equal(parsed?.jobs[0]?.type, "work-node");
  assert.equal(parsed?.jobs[0]?.label, "Map execution");
  assert.equal(parsed?.jobs[0]?.status, "running");
  assert.equal(parsed?.jobs[0]?.agentRunId, "run-1");
  assert.equal(parsed?.jobs[0]?.queuedAt, 9);
  assert.equal(parsed?.jobs[0]?.startedAt, 10);

  assert.equal(parsed?.activity[0]?.agentRunId, "run-1");
  assert.deepEqual(parsed?.mainUsage, {
    eventIds: ["usage-main-1"],
    costUsd: 0.25,
  });
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
  const long = "x".repeat(MAX_LIFECYCLE_SUMMARY_CHARS + 500);

  assert.equal(boundLifecycleSummary("short summary"), "short summary");
  assert.ok(boundLifecycleSummary(long).length < long.length);
  assert.match(boundLifecycleSummary(long), /summary truncated$/);

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

test("agent-console declares the async control port before runtime adapters", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/contracts/src/agent-console.ts"),
    "utf8",
  );

  assert.match(
    source,
    /steer\(agentRunId: string, message: string\): Promise<AgentControlReceipt>;/,
  );
  assert.match(
    source,
    /cancel\(agentRunId: string\): Promise<AgentControlReceipt>;/,
  );
  assert.match(
    source,
    /continue\(agentRunId: string, message\?: string\): Promise<AgentControlReceipt>;/,
  );
});
