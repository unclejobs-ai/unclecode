import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentConsoleSnapshot,
  isAskUserQuestionAnswered,
  isCoalescibleToolActivity,
  isWorkGraphDispatchable,
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
