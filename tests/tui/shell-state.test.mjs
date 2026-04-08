import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialShellState,
  reduceShellEvent,
} from "../../packages/tui/src/shell-state.ts";

const baseHomeState = {
  modeLabel: "default",
  authLabel: "none",
  sessionCount: 1,
  mcpServerCount: 0,
  latestResearchSummary: null,
  sessions: [
    {
      sessionId: "session-alpha",
      state: "idle",
      updatedAt: "2026-04-02T10:00:00.000Z",
      model: "gpt-5.4",
      taskSummary: "Review repo",
    },
  ],
};

test("createInitialShellState starts in the unified work view with no running activity and empty transcript", () => {
  const state = createInitialShellState(baseHomeState);

  assert.equal(state.isRunning, false);
  assert.equal(state.activityEntries.length, 0);
  assert.equal(state.traceEntries.length, 0);
  assert.equal(state.outputLines.length, 0);
  assert.equal(state.homeState.modeLabel, "default");
  assert.equal(state.view, "work");
});

test("createInitialShellState prefers actions column when auth is unavailable", () => {
  const state = createInitialShellState({
    ...baseHomeState,
    authLabel: "none",
  });

  assert.equal(state.focus.column, "actions");
  assert.equal(state.focus.actionIndex, 0);
});

test("createInitialShellState can start in the sessions tab for session-center entry", () => {
  const state = createInitialShellState(baseHomeState, {
    initialView: "sessions",
  });

  assert.equal(state.view, "sessions");
  assert.equal(state.focus.column, "sessions");
  assert.equal(state.focus.sessionIndex, 0);
});

test("createInitialShellState stays work-first even when resumable sessions exist", () => {
  const state = createInitialShellState({
    ...baseHomeState,
    authLabel: "api-key-env",
  });

  assert.equal(state.focus.column, "actions");
  assert.equal(state.focus.actionIndex, 0);
});

test("reduceShellEvent marks action as running and keeps focus stable", () => {
  const initial = createInitialShellState(baseHomeState);

  const next = reduceShellEvent(initial, {
    type: "action.started",
    actionId: "doctor",
  });

  assert.equal(next.isRunning, true);
  assert.equal(next.runningActionId, "doctor");
  assert.equal(next.view, "work");
  assert.equal(next.focus.column, initial.focus.column);
  assert.equal(next.activityEntries[0]?.title, "Running doctor");
  assert.equal(next.activityEntries[0]?.tone, "info");
  assert.equal(next.traceEntries[0]?.message, "Running doctor");
});

test("reduceShellEvent does not duplicate running state for repeated action.started", () => {
  const started = reduceShellEvent(createInitialShellState(baseHomeState), {
    type: "action.started",
    actionId: "doctor",
  });

  const repeated = reduceShellEvent(started, {
    type: "action.started",
    actionId: "doctor",
  });

  assert.equal(repeated.activityEntries.length, started.activityEntries.length);
  assert.equal(repeated.traceEntries.length, started.traceEntries.length);
  assert.equal(repeated.runningActionId, "doctor");
});

test("reduceShellEvent appends completed activity entries and refreshes home state", () => {
  const running = reduceShellEvent(createInitialShellState(baseHomeState), {
    type: "action.started",
    actionId: "new-research",
  });

  const next = reduceShellEvent(running, {
    type: "action.completed",
    entry: {
      id: "research-1",
      source: "new-research",
      title: "Research: summarize repo",
      lines: ["Research completed", "Artifact: /tmp/research.md"],
      tone: "success",
    },
    outputLines: ["Research completed", "Artifact: /tmp/research.md"],
    homeState: {
      ...baseHomeState,
      modeLabel: "analyze",
      sessionCount: 2,
      latestResearchSummary: "Prepared a local research bundle",
      sessions: [
        {
          sessionId: "research-1",
          state: "idle",
          updatedAt: "2026-04-02T11:00:00.000Z",
          model: "research-local",
          taskSummary: "Prepared a local research bundle",
        },
        ...baseHomeState.sessions,
      ],
    },
  });

  assert.equal(next.isRunning, false);
  assert.equal(next.runningActionId, undefined);
  assert.equal(next.activityEntries[0]?.id, "research-1");
  assert.equal(next.homeState.sessionCount, 2);
  assert.equal(next.homeState.modeLabel, "analyze");
  assert.equal(next.view, "research");
  assert.deepEqual(next.outputLines, ["Research completed", "Artifact: /tmp/research.md"]);
  assert.match(next.traceEntries[0]?.message ?? "", /completed/);
});

test("reduceShellEvent records failed runs as warning activity", () => {
  const running = reduceShellEvent(createInitialShellState(baseHomeState), {
    type: "action.started",
    actionId: "doctor",
  });

  const next = reduceShellEvent(running, {
    type: "action.failed",
    entry: {
      id: "doctor-err",
      source: "doctor",
      title: "Doctor",
      lines: ["Doctor failed"],
      tone: "warning",
    },
    outputLines: ["Doctor failed"],
  });

  assert.equal(next.isRunning, false);
  assert.equal(next.activityEntries[0]?.tone, "warning");
  assert.equal(next.view, "work");
  assert.deepEqual(next.outputLines, ["Doctor failed"]);
  assert.match(next.traceEntries[0]?.message ?? "", /failed/);
});

test("reduceShellEvent can switch shell views without disturbing activity state", () => {
  const initial = createInitialShellState(baseHomeState);
  const withActivity = reduceShellEvent(initial, {
    type: "action.completed",
    entry: {
      id: "doctor-1",
      source: "doctor",
      title: "Doctor",
      lines: ["Doctor report"],
      tone: "success",
    },
    outputLines: ["Doctor report"],
    homeState: baseHomeState,
  });

  const next = reduceShellEvent(withActivity, {
    type: "view.changed",
    view: "work",
  });

  assert.equal(next.view, "work");
  assert.equal(next.activityEntries.length, 1);
  assert.equal(next.outputLines[0], "Doctor report");
});

test("reduceShellEvent ignores no-op home.updated patches", () => {
  const initial = createInitialShellState({
    ...baseHomeState,
    bridgeLines: ["Bridge refreshed"],
    memoryLines: ["Memory refreshed"],
  });

  const next = reduceShellEvent(initial, {
    type: "home.updated",
    homeState: {
      authLabel: baseHomeState.authLabel,
      bridgeLines: ["Bridge refreshed"],
      memoryLines: ["Memory refreshed"],
    },
  });

  assert.equal(next, initial);
});

test("reduceShellEvent can merge refreshed home state without dropping work activity", () => {
  const withActivity = reduceShellEvent(createInitialShellState(baseHomeState), {
    type: "action.started",
    actionId: "doctor",
  });

  const next = reduceShellEvent(withActivity, {
    type: "home.updated",
    homeState: {
      authLabel: "api-key-file",
      sessionCount: 2,
      sessions: [
        {
          sessionId: "work-2",
          state: "idle",
          updatedAt: "2026-04-02T12:00:00.000Z",
          model: "gpt-5.4",
          taskSummary: "Follow-up task",
        },
        ...baseHomeState.sessions,
      ],
      bridgeLines: ["Bridge refreshed"],
      memoryLines: ["Memory refreshed"],
    },
  });

  assert.equal(next.isRunning, true);
  assert.equal(next.runningActionId, "doctor");
  assert.equal(next.homeState.authLabel, "api-key-file");
  assert.equal(next.homeState.sessionCount, 2);
  assert.equal(next.homeState.sessions[0]?.sessionId, "work-2");
  assert.deepEqual(next.homeState.bridgeLines, ["Bridge refreshed"]);
  assert.deepEqual(next.homeState.memoryLines, ["Memory refreshed"]);
});

test("reduceShellEvent tracks worker progress while an action is running", () => {
  const initial = createInitialShellState(baseHomeState);

  const started = reduceShellEvent(initial, {
    type: "action.started",
    actionId: "new-research",
  });

  const progressed = reduceShellEvent(started, {
    type: "worker.progressed",
    worker: {
      id: "worker-1",
      label: "research",
      status: "running",
      detail: "assembling context",
    },
  });

  assert.equal(progressed.workers.length, 1);
  assert.equal(progressed.workers[0]?.label, "research");
  assert.equal(progressed.workers[0]?.detail, "assembling context");
  assert.match(progressed.traceEntries[0]?.message ?? "", /research: assembling context/);

  const updated = reduceShellEvent(progressed, {
    type: "worker.progressed",
    worker: {
      id: "worker-1",
      label: "research",
      status: "running",
      detail: "writing artifact",
    },
  });

  assert.equal(updated.workers.length, 1);
  assert.equal(updated.workers[0]?.detail, "writing artifact");
});

test("reduceShellEvent queues and clears approval requests deterministically", () => {
  const initial = createInitialShellState(baseHomeState);

  const pending = reduceShellEvent(initial, {
    type: "approval.requested",
    approval: {
      id: "approval-1",
      title: "Run networked research",
      detail: "Research wants network access.",
      severity: "warning",
    },
  });

  assert.equal(pending.view, "work");
  assert.equal(pending.approvals.length, 1);
  assert.equal(pending.approvals[0]?.title, "Run networked research");
  assert.equal(pending.activityEntries.length, 1);
  assert.equal(pending.activityEntries[0]?.title, "Run networked research");
  assert.equal(pending.activityEntries[0]?.tone, "warning");
  assert.equal(pending.traceEntries[0]?.kind, "approval");

  const duplicate = reduceShellEvent(pending, {
    type: "approval.requested",
    approval: {
      id: "approval-1",
      title: "Run networked research",
      detail: "Research wants network access.",
      severity: "warning",
    },
  });

  assert.equal(duplicate.approvals.length, 1);

  const replaced = reduceShellEvent(pending, {
    type: "approval.requested",
    approval: {
      id: "approval-2",
      title: "Open Browser Login",
      detail: "OAuth wants browser approval.",
      severity: "info",
    },
  });

  assert.equal(replaced.approvals.length, 1);
  assert.equal(replaced.approvals[0]?.id, "approval-2");

  const cleared = reduceShellEvent(replaced, {
    type: "approval.resolved",
    approvalId: "approval-2",
  });

  assert.equal(cleared.approvals.length, 0);
  assert.equal(cleared.traceEntries.length, replaced.traceEntries.length);

  const missing = reduceShellEvent(cleared, {
    type: "approval.resolved",
    approvalId: "approval-2",
  });

  assert.equal(missing.traceEntries.length, cleared.traceEntries.length);
});

test("reduceShellEvent can record approval rejection in transcript", () => {
  const initial = createInitialShellState(baseHomeState);
  const pending = reduceShellEvent(initial, {
    type: "approval.requested",
    approval: {
      id: "approval-2",
      title: "Open Browser Login",
      detail: "Generate an OAuth browser login URL.",
      severity: "info",
    },
  });

  const rejected = reduceShellEvent(pending, {
    type: "action.failed",
    entry: {
      id: "approval-2-rejected",
      source: "browser-login",
      title: "Browser Auth rejected",
      timestamp: "2026-04-02T00:00:00.000Z",
      lines: ["User rejected approval."],
      tone: "warning",
    },
    outputLines: ["User rejected approval."],
  });

  assert.equal(rejected.activityEntries[0]?.title, "Browser Auth rejected");
  assert.equal(rejected.activityEntries[0]?.tone, "warning");
});
