import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKGROUND_TASK_STATUSES,
  BACKGROUND_TASK_TERMINAL_STATUSES,
  BACKGROUND_TASK_TYPES,
  ENGINE_EVENT_TYPES,
  ENGINE_WORKFLOW_PHASE_STATUSES,
  SESSION_STATES,
} from "@unclecode/contracts";

test("event fixtures expose canonical engine and task lifecycle discriminants", () => {
  assert.deepEqual(ENGINE_EVENT_TYPES, [
    "task.started",
    "task.progress",
    "task.terminated",
    "session.state_changed",
  ]);

  assert.deepEqual(SESSION_STATES, [
    "idle",
    "running",
    "pause_pending",
    "paused",
    "requires_action",
  ]);

  assert.deepEqual(BACKGROUND_TASK_STATUSES, [
    "pending",
    "running",
    "completed",
    "failed",
    "killed",
  ]);

  assert.deepEqual(BACKGROUND_TASK_TERMINAL_STATUSES, [
    "completed",
    "failed",
    "killed",
  ]);

  assert.deepEqual(BACKGROUND_TASK_TYPES, [
    "local_bash",
    "local_agent",
    "remote_agent",
    "in_process_teammate",
    "local_workflow",
    "monitor_mcp",
    "dream",
  ]);

  assert.deepEqual(ENGINE_WORKFLOW_PHASE_STATUSES, [
    "pending",
    "running",
    "completed",
    "failed",
  ]);
});
