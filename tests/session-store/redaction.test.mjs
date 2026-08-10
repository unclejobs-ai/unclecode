import assert from "node:assert/strict";
import test from "node:test";

import { redactSecrets, stringifyWithRedaction } from "../../packages/session-store/src/redaction.ts";
import { applyCheckpoint, createBaseSnapshot, parseCheckpoint } from "../../packages/session-store/src/validators.ts";
import { markUnrecoverableAgentConsoleWorkInterrupted } from "@unclecode/contracts";

test("session-store redaction delegates string scrubbing to Rust", () => {
  const githubToken = `ghp_${"1".repeat(36)}`;
  assert.equal(
    redactSecrets(`token ${githubToken}`),
    "token [REDACTED]",
  );
});

test("session-store stringifyWithRedaction redacts nested string values through Rust", () => {
  const payload = {
    sessionId: "plain-session",
    metadata: {
      credential: `sk-proj-${"a".repeat(30)}`,
    },
  };

  assert.equal(
    stringifyWithRedaction(payload),
    '{"sessionId":"plain-session","metadata":{"credential":"[REDACTED]"}}',
  );
});

test("session-store persists only the safe agent console projection", () => {
  const checkpoint = parseCheckpoint({
    type: "agent_console",
    agentConsole: {
      profileId: "build",
      activity: [{
        id: "tool-1",
        toolCallId: "call-1",
        toolName: "read_file",
        kind: "read",
        intent: `Read token sk-proj-${"a".repeat(30)}`,
        status: "completed",
        startedAt: 1,
        summary: "raw output is omitted",
        output: "unbounded raw output",
      }],
    },
  });

  assert.deepEqual(checkpoint, {
    type: "agent_console",
    agentConsole: {
      profileId: "build",
      activity: [{
        id: "tool-1",
        toolCallId: "call-1",
        toolName: "read_file",
        kind: "read",
        intent: "Read token [REDACTED]",
        status: "completed",
        startedAt: 1,
        summary: "raw output is omitted",
      }],
      agents: [],
      jobs: [],
    },
  });
  assert.equal("output" in checkpoint.agentConsole.activity[0], false);

  const snapshot = applyCheckpoint(
    createBaseSnapshot({ sessionId: "session-1", projectPath: "/project" }),
    checkpoint,
    "2026-07-12T00:00:00.000Z",
  );
  assert.equal(snapshot.agentConsole?.activity[0]?.intent, "Read token [REDACTED]");
});

test("session-store keeps safe agent and job summaries while dropping unknown secret-looking fields", () => {
  const checkpoint = parseCheckpoint({
    type: "agent_console",
    agentConsole: {
      profileId: "build",
      activity: [],
      agents: [{
        id: "run-1",
        displayName: "Executor A",
        agentType: "executor",
        status: "completed",
        startedAt: 10,
        completedAt: 30,
        summary: "Refactored the auth guard.",
        systemPrompt: "You are an executor. Use key sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.",
        providerApiKey: `sk-proj-${"b".repeat(30)}`,
        rawAssignment: "internal worker assignment text",
      }],
      jobs: [{
        id: "job-1",
        type: "executor",
        label: "Plan step one",
        status: "completed",
        queuedAt: 5,
        completedAt: 31,
        summary: "Plan step one finished.",
        credential: `ghp_${"1".repeat(36)}`,
      }],
    },
  });

  assert.deepEqual(checkpoint?.agentConsole.agents, [{
    id: "run-1",
    displayName: "Executor A",
    agentType: "executor",
    status: "completed",
    startedAt: 10,
    completedAt: 30,
    summary: "Refactored the auth guard.",
  }]);
  assert.deepEqual(checkpoint?.agentConsole.jobs, [{
    id: "job-1",
    type: "executor",
    label: "Plan step one",
    status: "completed",
    queuedAt: 5,
    completedAt: 31,
    summary: "Plan step one finished.",
  }]);
  assert.doesNotMatch(
    JSON.stringify(checkpoint),
    /systemPrompt|providerApiKey|rawAssignment|credential|sk-proj-|ghp_/,
  );
});

test("resume gate settles unrecoverable console work exactly once after redaction", () => {
  const checkpoint = parseCheckpoint({
    type: "agent_console",
    agentConsole: {
      profileId: "build",
      activity: [],
      agents: [
        {
          id: "run-running",
          displayName: "Executor A",
          agentType: "executor",
          status: "running",
          startedAt: 10,
          currentActivity: `Reading with sk-proj-${"c".repeat(30)}`,
        },
        { id: "run-waiting", displayName: "Executor B", agentType: "executor", status: "waiting", startedAt: 11 },
        {
          id: "run-done",
          displayName: "Executor C",
          agentType: "executor",
          status: "completed",
          startedAt: 12,
          completedAt: 30,
          summary: "Refactored the auth guard.",
        },
      ],
      jobs: [
        { id: "job-queued", type: "executor", label: "Plan step one", status: "queued", queuedAt: 5 },
        {
          id: "job-done",
          type: "executor",
          label: "Plan step two",
          status: "completed",
          queuedAt: 6,
          completedAt: 31,
          summary: "Plan step two finished.",
        },
      ],
    },
  });
  assert.ok(checkpoint);

  // The resume boundary composes exactly these two gates, in this order.
  const resumed = markUnrecoverableAgentConsoleWorkInterrupted(checkpoint.agentConsole, 99);

  assert.deepEqual(resumed.agents.map((agent) => [agent.id, agent.status, agent.completedAt]), [
    ["run-running", "interrupted", 99],
    ["run-waiting", "interrupted", 99],
    ["run-done", "completed", 30],
  ]);
  assert.deepEqual(resumed.jobs.map((job) => [job.id, job.status, job.completedAt]), [
    ["job-queued", "interrupted", 99],
    ["job-done", "completed", 31],
  ]);
  // Settling is idempotent: a second pass finds nothing active and changes nothing.
  assert.equal(markUnrecoverableAgentConsoleWorkInterrupted(resumed, 500), resumed);

  assert.equal(resumed.agents[2]?.summary, "Refactored the auth guard.");
  assert.equal(resumed.jobs[1]?.summary, "Plan step two finished.");
  assert.equal(resumed.agents[0]?.currentActivity, undefined);
  assert.doesNotMatch(JSON.stringify(resumed), /sk-proj-/);
});
