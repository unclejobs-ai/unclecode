import assert from "node:assert/strict";
import test from "node:test";

import {
  clampAgentConsoleView,
  closeAgentConsoleView,
  countAgentConsoleRows,
  createAgentConsoleViewState,
  isSettledAgentRun,
  moveAgentConsoleCursor,
  openAgentConsoleView,
  requestAgentConsoleCancel,
  resolveAgentConsoleSelection,
  selectAgentConsoleTab,
  settleAgentConsoleControl,
  toggleAgentConsoleInspector,
} from "@unclecode/orchestrator";

function agentRun(id, status = "running", overrides = {}) {
  return {
    id,
    displayName: `Executor ${id}`,
    agentType: "executor",
    status,
    startedAt: 10,
    ...overrides,
  };
}

function asyncJob(id, status = "running", overrides = {}) {
  return { id, type: "executor", label: `Job ${id}`, status, queuedAt: 5, ...overrides };
}

function consoleSnapshot(overrides = {}) {
  return {
    profileId: "build",
    activity: [],
    agents: [],
    jobs: [],
    ...overrides,
  };
}

const twoAgents = consoleSnapshot({
  agents: [agentRun("run-1"), agentRun("run-2", "completed", { completedAt: 20 })],
  jobs: [asyncJob("job-1"), asyncJob("job-2", "queued")],
  workGraph: {
    id: "graph-1",
    approval: "approved",
    nodes: [
      { id: "node-1", summary: "Read the plan", status: "ready" },
      { id: "node-2", summary: "Write the code", status: "pending" },
      { id: "node-3", summary: "Verify", status: "pending" },
    ],
  },
});

test("agent console view opens on a requested tab and closes back to a browsing state", () => {
  const initial = createAgentConsoleViewState();
  assert.equal(initial.open, false);
  assert.equal(initial.tab, "agents");
  assert.equal(initial.cursor, 0);
  assert.deepEqual(initial.control, { kind: "browse" });

  const opened = openAgentConsoleView(initial, twoAgents, "jobs");
  assert.equal(opened.open, true);
  assert.equal(opened.tab, "jobs");
  assert.equal(opened.cursor, 0);
  // The helper is immutable: the caller's view is never mutated in place.
  assert.equal(initial.open, false);
  assert.equal(initial.tab, "agents");

  const reopened = openAgentConsoleView(opened, twoAgents);
  assert.equal(reopened.tab, "jobs");

  const closed = closeAgentConsoleView(opened);
  assert.equal(closed.open, false);
  assert.deepEqual(closed.control, { kind: "browse" });
  assert.equal(closed.tab, "jobs");
});

test("agent console cursor moves within the snapshot and clamps at both ends", () => {
  const opened = openAgentConsoleView(createAgentConsoleViewState(), twoAgents, "plan");
  assert.equal(countAgentConsoleRows(twoAgents, "plan"), 3);

  const down = moveAgentConsoleCursor(opened, twoAgents, 1);
  assert.equal(down.cursor, 1);

  const pastEnd = moveAgentConsoleCursor(down, twoAgents, 99);
  assert.equal(pastEnd.cursor, 2);

  const pastStart = moveAgentConsoleCursor(pastEnd, twoAgents, -99);
  assert.equal(pastStart.cursor, 0);

  const emptyPlan = consoleSnapshot();
  assert.equal(countAgentConsoleRows(emptyPlan, "plan"), 0);
  assert.equal(moveAgentConsoleCursor(opened, emptyPlan, 1).cursor, 0);
});

test("agent console view re-clamps the cursor and drops a confirmation once a record settles", () => {
  const opened = openAgentConsoleView(createAgentConsoleViewState(), twoAgents, "agents");
  const onSecondRow = moveAgentConsoleCursor(opened, twoAgents, 1);
  assert.equal(onSecondRow.cursor, 1);

  // A resumed/trimmed snapshot keeps fewer rows than the cursor addressed.
  const trimmed = consoleSnapshot({ agents: [agentRun("run-1")] });
  assert.equal(clampAgentConsoleView(onSecondRow, trimmed).cursor, 0);

  const confirming = requestAgentConsoleCancel(opened, twoAgents);
  assert.deepEqual(confirming.control, { kind: "confirm-cancel", agentRunId: "run-1" });

  const settledSnapshot = consoleSnapshot({
    agents: [agentRun("run-1", "completed", { completedAt: 30 }), twoAgents.agents[1]],
  });
  assert.deepEqual(clampAgentConsoleView(confirming, settledSnapshot).control, { kind: "browse" });
  // A still-live target keeps the confirmation open.
  assert.deepEqual(clampAgentConsoleView(confirming, twoAgents).control, {
    kind: "confirm-cancel",
    agentRunId: "run-1",
  });
});

test("agent console tab selection resets the cursor and abandons a pending confirmation", () => {
  const opened = openAgentConsoleView(createAgentConsoleViewState(), twoAgents, "agents");
  const confirming = requestAgentConsoleCancel(opened, twoAgents);

  const jobs = selectAgentConsoleTab(confirming, twoAgents, "jobs");
  assert.equal(jobs.tab, "jobs");
  assert.equal(jobs.cursor, 0);
  assert.deepEqual(jobs.control, { kind: "browse" });

  const movedThenSameTab = selectAgentConsoleTab(
    moveAgentConsoleCursor(jobs, twoAgents, 1),
    twoAgents,
    "jobs",
  );
  assert.equal(movedThenSameTab.cursor, 1);
});

test("agent console inspector toggles independently of tab and cursor", () => {
  const opened = openAgentConsoleView(createAgentConsoleViewState(), twoAgents, "jobs");
  const moved = moveAgentConsoleCursor(opened, twoAgents, 1);

  const hidden = toggleAgentConsoleInspector(moved);
  assert.equal(hidden.inspectorVisible, !moved.inspectorVisible);
  assert.equal(hidden.tab, "jobs");
  assert.equal(hidden.cursor, 1);

  assert.equal(toggleAgentConsoleInspector(hidden).inspectorVisible, moved.inspectorVisible);
});

test("agent console cancel confirmation only targets a live selected run", () => {
  const opened = openAgentConsoleView(createAgentConsoleViewState(), twoAgents, "agents");

  const confirming = requestAgentConsoleCancel(opened, twoAgents);
  assert.deepEqual(confirming.control, { kind: "confirm-cancel", agentRunId: "run-1" });
  assert.equal(confirming.receipt, undefined);

  const onSettledRun = requestAgentConsoleCancel(
    moveAgentConsoleCursor(opened, twoAgents, 1),
    twoAgents,
  );
  assert.deepEqual(onSettledRun.control, { kind: "browse" });
  assert.equal(onSettledRun.receipt?.status, "rejected");

  const onJobsTab = requestAgentConsoleCancel(selectAgentConsoleTab(opened, twoAgents, "jobs"), twoAgents);
  assert.deepEqual(onJobsTab.control, { kind: "browse" });
  assert.equal(onJobsTab.receipt?.status, "rejected");

  const settled = settleAgentConsoleControl(confirming, { status: "accepted", message: "Cancelling run-1." });
  assert.deepEqual(settled.control, { kind: "browse" });
  assert.deepEqual(settled.receipt, { status: "accepted", message: "Cancelling run-1." });

  // Navigating away retires the receipt so a stale outcome cannot linger.
  assert.equal(moveAgentConsoleCursor(settled, twoAgents, 1).receipt, undefined);
  assert.equal(settleAgentConsoleControl(settled).receipt, undefined);
});

test("agent console selection resolves the addressed agents, jobs, and plan record", () => {
  const view = openAgentConsoleView(createAgentConsoleViewState(), twoAgents, "agents");

  assert.deepEqual(resolveAgentConsoleSelection(view, twoAgents), {
    tab: "agents",
    run: twoAgents.agents[0],
  });
  assert.deepEqual(resolveAgentConsoleSelection(moveAgentConsoleCursor(view, twoAgents, 1), twoAgents), {
    tab: "agents",
    run: twoAgents.agents[1],
  });

  const jobs = selectAgentConsoleTab(view, twoAgents, "jobs");
  assert.deepEqual(resolveAgentConsoleSelection(moveAgentConsoleCursor(jobs, twoAgents, 1), twoAgents), {
    tab: "jobs",
    job: twoAgents.jobs[1],
  });

  const plan = selectAgentConsoleTab(view, twoAgents, "plan");
  assert.deepEqual(resolveAgentConsoleSelection(moveAgentConsoleCursor(plan, twoAgents, 2), twoAgents), {
    tab: "plan",
    node: twoAgents.workGraph.nodes[2],
  });

  assert.equal(resolveAgentConsoleSelection(view, consoleSnapshot()), undefined);
  assert.equal(resolveAgentConsoleSelection(plan, consoleSnapshot()), undefined);
});

test("agent console settlement classification matches the terminal run statuses", () => {
  assert.equal(isSettledAgentRun(agentRun("a", "queued")), false);
  assert.equal(isSettledAgentRun(agentRun("a", "running")), false);
  assert.equal(isSettledAgentRun(agentRun("a", "waiting")), false);
  assert.equal(isSettledAgentRun(agentRun("a", "completed")), true);
  assert.equal(isSettledAgentRun(agentRun("a", "failed")), true);
  assert.equal(isSettledAgentRun(agentRun("a", "cancelled")), true);
  assert.equal(isSettledAgentRun(agentRun("a", "interrupted")), true);
});
