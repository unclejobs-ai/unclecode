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

test("execution trace contract declares agent and job lifecycle payloads", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/contracts/src/trace.ts"),
    "utf8",
  );

  for (const declaration of [
    /export type JobQueuedTraceEvent = \{[\s\S]*?readonly type: "job\.queued";[\s\S]*?readonly eventId: string;[\s\S]*?readonly jobId: string;[\s\S]*?readonly queuedAt: number;[\s\S]*?\};/,
    /export type JobSettledTraceEvent = \{[\s\S]*?readonly type: "job\.settled";[\s\S]*?readonly eventId: string;[\s\S]*?readonly jobId: string;[\s\S]*?readonly status: TerminalAsyncJobStatus;[\s\S]*?readonly completedAt: number;[\s\S]*?\};/,
    /export type AgentRunStartedTraceEvent = \{[\s\S]*?readonly type: "agent\.run\.started";[\s\S]*?readonly eventId: string;[\s\S]*?readonly runId: string;[\s\S]*?readonly jobId\?: string;[\s\S]*?readonly displayName: string;[\s\S]*?readonly agentType: string;[\s\S]*?readonly parentRunId\?: string;[\s\S]*?readonly continuationOf\?: string;[\s\S]*?readonly startedAt: number;[\s\S]*?\};/,
    /export type AgentRunSettledTraceEvent = \{[\s\S]*?readonly type: "agent\.run\.settled";[\s\S]*?readonly eventId: string;[\s\S]*?readonly runId: string;[\s\S]*?readonly jobId\?: string;[\s\S]*?readonly status: TerminalAgentRunStatus;[\s\S]*?readonly completedAt: number;[\s\S]*?readonly summary\?: string;[\s\S]*?readonly errorSummary\?: string;[\s\S]*?\};/,
    /export type UsageRecordedTraceEvent = \{[\s\S]*?readonly type: "usage\.recorded";[\s\S]*?readonly eventId: string;[\s\S]*?readonly agentRunId\?: string;[\s\S]*?readonly inputTokens\?: number;[\s\S]*?readonly outputTokens\?: number;[\s\S]*?readonly cacheReadTokens\?: number;[\s\S]*?readonly costUsd\?: number;[\s\S]*?\};/,
  ]) {
    assert.match(source, declaration);
  }

  for (const member of [
    "| JobQueuedTraceEvent",
    "| JobSettledTraceEvent",
    "| AgentRunStartedTraceEvent",
    "| AgentRunSettledTraceEvent",
    "| UsageRecordedTraceEvent",
  ]) {
    assert.ok(
      source.includes(member),
      `ExecutionTraceEvent union is missing ${member}`,
    );
  }
});

test("execution trace tool events scope optionally to an agent run and job", () => {
  const source = readFileSync(
    path.join(workspaceRoot, "packages/contracts/src/trace.ts"),
    "utf8",
  );

  assert.match(
    source,
    /export type ToolStartedTraceEvent = \{[\s\S]*?readonly agentRunId\?: string;[\s\S]*?readonly asyncJobId\?: string;[\s\S]*?\};/,
  );
  assert.match(
    source,
    /export type ToolCompletedTraceEvent = \{[\s\S]*?readonly agentRunId\?: string;[\s\S]*?readonly asyncJobId\?: string;[\s\S]*?\};/,
  );
});
