import assert from "node:assert/strict";
import test from "node:test";

import { redactSecrets, stringifyWithRedaction } from "../../packages/session-store/src/redaction.ts";
import { applyCheckpoint, createBaseSnapshot, parseCheckpoint } from "../../packages/session-store/src/validators.ts";

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
