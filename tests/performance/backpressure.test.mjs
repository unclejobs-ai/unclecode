import assert from "node:assert/strict";
import test from "node:test";

import {
  applyShellEvents,
  coalesceShellEvents,
  createInitialShellState,
} from "../../packages/tui/src/shell-state.ts";

const baseHomeState = {
  modeLabel: "default",
  authLabel: "ready",
  sessionCount: 1,
  mcpServerCount: 0,
  mcpServers: [],
  latestResearchSessionId: null,
  latestResearchSummary: null,
  latestResearchTimestamp: null,
  researchRunCount: 0,
  sessions: [
    {
      sessionId: "session-alpha",
      state: "idle",
      updatedAt: "2026-04-05T00:00:00.000Z",
      model: "gpt-5.4",
      taskSummary: "Review repo",
    },
  ],
};

test("coalesceShellEvents keeps the latest worker update while preserving approval events", () => {
  const events = [
    { type: "action.started", actionId: "new-research" },
    ...Array.from({ length: 100 }, (_, index) => ({
      type: "worker.progressed",
      worker: {
        id: "worker-1",
        label: "research",
        status: "running",
        detail: `chunk ${index}`,
      },
    })),
    {
      type: "approval.requested",
      approval: {
        id: "approval-1",
        title: "Need approval",
        detail: "Open browser login.",
        severity: "warning",
      },
    },
  ];

  const coalesced = coalesceShellEvents(events);

  assert.equal(coalesced[0]?.type, "action.started");
  assert.equal(coalesced[1]?.type, "approval.requested");
  assert.equal(coalesced[2]?.type, "worker.progressed");
  assert.equal(coalesced.length, 3);
  assert.equal(coalesced[2]?.worker.detail, "chunk 99");
});

test("applyShellEvents keeps approvals responsive during worker-event floods", () => {
  const initial = createInitialShellState(baseHomeState);
  const next = applyShellEvents(initial, [
    { type: "action.started", actionId: "new-research" },
    ...Array.from({ length: 100 }, (_, index) => ({
      type: "worker.progressed",
      worker: {
        id: "worker-1",
        label: "research",
        status: "running",
        detail: `chunk ${index}`,
      },
    })),
    {
      type: "approval.requested",
      approval: {
        id: "approval-1",
        title: "Need approval",
        detail: "Open browser login.",
        severity: "warning",
      },
    },
  ]);

  assert.equal(next.isRunning, true);
  assert.equal(next.approvals.length, 1);
  assert.equal(next.workers.length, 1);
  assert.equal(next.workers[0]?.detail, "chunk 99");
  assert.equal(next.activityEntries.length, 2);
});
