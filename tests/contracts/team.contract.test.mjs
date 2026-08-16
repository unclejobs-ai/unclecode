import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_SEMANTIC_INTENTS,
  AGENT_TOOL_POLICIES,
  AGENT_WRITE_POLICIES,
  EVIDENCE_GATE_STATUSES,
  SESSION_CHECKPOINT_TYPES,
  TEAM_GATE_LEVELS,
  TEAM_ISOLATION_MODES,
  TEAM_LANE_RUNTIMES,
  TEAM_RUNTIME_MODES,
  TEAM_RUN_STATUSES,
  isEvidenceGateReceiptComplete,
  isTeamLaneRuntime,
} from "@unclecode/contracts";

test("team run statuses cover lifecycle transitions", () => {
  assert.deepEqual(TEAM_RUN_STATUSES, [
    "started",
    "running",
    "gated",
    "accepted",
    "corrective",
    "aborted",
    "killed",
    "errored",
  ]);
});

test("team gate levels map to mmbridge severity", () => {
  assert.deepEqual(TEAM_GATE_LEVELS, ["strict", "warn", "off"]);
});

test("team runtime modes mirror runtime-broker contract", () => {
  assert.deepEqual(TEAM_RUNTIME_MODES, ["local", "docker", "e2b", "openshell"]);
});

test("team isolation modes distinguish shared and per-worker workspaces", () => {
  assert.deepEqual(TEAM_ISOLATION_MODES, ["shared", "worktree"]);
});

test("session checkpoint types now include team_run + team_step", () => {
  assert.ok(SESSION_CHECKPOINT_TYPES.includes("team_run"));
  assert.ok(SESSION_CHECKPOINT_TYPES.includes("team_step"));
});

test("team lane runtimes is a closed enum of 8 entries", () => {
  assert.deepEqual(TEAM_LANE_RUNTIMES, [
    "openai",
    "anthropic",
    "gemini",
    "cursor",
    "codex",
    "opencode",
    "glm",
    "hermes",
  ]);
});

test("isTeamLaneRuntime accepts members and rejects unknowns", () => {
  for (const id of TEAM_LANE_RUNTIMES) {
    assert.equal(isTeamLaneRuntime(id), true);
  }
  assert.equal(isTeamLaneRuntime("bogus"), false);
  assert.equal(isTeamLaneRuntime(""), false);
  assert.equal(isTeamLaneRuntime(null), false);
  assert.equal(isTeamLaneRuntime(undefined), false);
  assert.equal(isTeamLaneRuntime(42), false);
});

test("evidence gate statuses support pass fail and blocked receipts", () => {
  assert.deepEqual(EVIDENCE_GATE_STATUSES, ["pass", "fail", "blocked"]);
});

test("evidence gate receipts fail closed when artifact or cleanup evidence is empty", () => {
  const receipt = {
    status: "pass",
    summary: "focused tests passed",
    artifacts: [
      {
        path: ".omo/evidence/focused.txt",
        kind: "test-output",
        description: "focused test stdout",
      },
    ],
    cleanupReceipt: "no runtime resources spawned",
    recordedAt: 0,
  };

  assert.equal(isEvidenceGateReceiptComplete(receipt), true);
  assert.equal(
    isEvidenceGateReceiptComplete({ ...receipt, artifacts: [] }),
    false,
  );
  assert.equal(
    isEvidenceGateReceiptComplete({ ...receipt, cleanupReceipt: "" }),
    false,
  );
  assert.equal(
    isEvidenceGateReceiptComplete({ ...receipt, summary: "" }),
    false,
  );
});

test("agent intent routing metadata exposes narrow semantic and policy enums", () => {
  assert.deepEqual(AGENT_SEMANTIC_INTENTS, [
    "implementation",
    "verification",
    "review",
    "research",
    "coordination",
  ]);
  assert.deepEqual(AGENT_TOOL_POLICIES, [
    "none",
    "read_only",
    "sandboxed",
    "unrestricted",
  ]);
  assert.deepEqual(AGENT_WRITE_POLICIES, ["none", "propose_only", "workspace"]);
});
