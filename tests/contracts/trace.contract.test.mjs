import assert from "node:assert/strict";
import test from "node:test";

import {
  EXECUTION_TRACE_EVENT_TYPES,
  EXECUTION_TRACE_LEVELS,
} from "@unclecode/contracts";

test("execution trace contract exposes canonical event kinds", () => {
  assert.deepEqual(EXECUTION_TRACE_EVENT_TYPES, [
    "turn.started",
    "provider.calling",
    "turn.completed",
    "tool.started",
    "tool.completed",
    "orchestrator.step",
    "bridge.published",
    "memory.written",
  ]);
});

test("execution trace contract exposes signal levels for UI prioritization", () => {
  assert.deepEqual(EXECUTION_TRACE_LEVELS, [
    "low-signal",
    "default",
    "high-signal",
  ]);
});
