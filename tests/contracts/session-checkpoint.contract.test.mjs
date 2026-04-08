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
  ]);

  assert.deepEqual(SESSION_METADATA_FIELDS, [
    "permissionMode",
    "isUltraworkMode",
    "traceMode",
    "model",
    "pendingAction",
    "postTurnSummary",
    "taskSummary",
  ]);
});
