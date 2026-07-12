import assert from "node:assert/strict";
import test from "node:test";

import { applyTraceEventToAgentConsole } from "@unclecode/orchestrator";

const initialConsole = Object.freeze({ profileId: "build", activity: [] });

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
    summary: "completed · 45ms",
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
    summary: "failed · 25ms",
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
