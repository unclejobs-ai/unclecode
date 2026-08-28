import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXECUTION_TRACE_EVENT_TYPES,
  EXECUTION_TRACE_LEVELS,
} from "@unclecode/contracts";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");

test("execution trace contract exposes canonical event kinds", () => {
  assert.deepEqual(EXECUTION_TRACE_EVENT_TYPES, [
    "turn.started",
    "provider.route",
    "provider.calling",
    "turn.completed",
    "tool.started",
    "tool.completed",
    "decision.opened",
    "decision.resolved",
    "work.proposed",
    "work.approved",
    "work.status",
    "orchestrator.step",
    "bridge.published",
    "memory.written",
    "reasoning.delta",
    "assistant.delta",
    "attachment.attached",
    "attachment.dropped",
    "policy.denied",
    "job.queued",
    "job.settled",
    "agent.run.started",
    "agent.run.settled",
    "usage.recorded",
    "quality.stage_started",
    "quality.gate_evaluated",
    "quality.refine_requested",
    "quality.pivot_requested",
    "quality.completed",
    "evolution.proposed",
  ]);
});

test("execution trace contract exposes signal levels for UI prioritization", () => {
  assert.deepEqual(EXECUTION_TRACE_LEVELS, [
    "low-signal",
    "default",
    "high-signal",
  ]);
});

test("attachment trace copy is rendered by Rust UX text contract", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/orchestrator/src/work-shell-engine.ts"),
    "utf8",
  );
  assert.match(source, /"rust",\s*"ux",\s*"text",\s*"trace-line"/);
  assert.doesNotMatch(source, /byteEstimate\s*\/\s*1024/);
  assert.doesNotMatch(source, /attached \$\{event\.source\}/);
});
