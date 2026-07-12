import assert from "node:assert/strict";
import test from "node:test";

import {
  SESSION_CHECKPOINT_TYPES,
  SESSION_METADATA_FIELDS,
} from "@unclecode/contracts";

test("session-checkpoint fixtures expose canonical restore-safe checkpoint shapes", () => {
  assert.deepEqual(SESSION_CHECKPOINT_TYPES, [
    "state",
    "metadata",
    "task_summary",
    "mode",
    "worktree",
    "approval",
    "agent_console",
    "team_run",
    "team_step",
  ]);

  assert.deepEqual(SESSION_METADATA_FIELDS, [
    "permissionMode",
    "isUltraworkMode",
    "traceMode",
    "reasoningEffort",
    "model",
    "pendingAction",
    "postTurnSummary",
    "taskSummary",
  ]);
});
