import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SESSION_CHECKPOINT_TYPES,
  TEAM_GATE_LEVELS,
  TEAM_LANE_RUNTIMES,
  TEAM_RUNTIME_MODES,
  TEAM_RUN_STATUSES,
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
