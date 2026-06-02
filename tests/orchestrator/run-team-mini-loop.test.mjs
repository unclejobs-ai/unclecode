import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { TeamBinding, runTeamMiniLoop } from "@unclecode/orchestrator";
import { createTeamRun, readTeamCheckpoints, verifyTeamRunChain } from "@unclecode/session-store";

function makeBinding() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "unclecode-team-"));
  const ref = createTeamRun({
    dataRoot,
    objective: "test objective",
    persona: "coder",
    lanes: 1,
    gate: "warn",
    runtime: "local",
    workspaceRoot: dataRoot,
    createdBy: "tests",
  });
  const binding = new TeamBinding({
    runId: ref.runId,
    runRoot: ref.runRoot,
    role: "worker",
    workspaceRoot: dataRoot,
  });
  return { dataRoot, binding };
}

function fakeProvider(scriptedResponses) {
  let i = 0;
  return {
    async runTurn() {
      throw new Error("runTurn not used");
    },
    async query(_messages, _options) {
      const response = scriptedResponses[Math.min(i, scriptedResponses.length - 1)];
      i += 1;
      return response;
    },
    clear() {},
    updateRuntimeSettings() {},
    setTraceListener() {},
  };
}

test("runTeamMiniLoop drives the model + executor and publishes team_step events", async () => {
  const { dataRoot, binding } = makeBinding();
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-team-cwd-"));
  try {
    const provider = fakeProvider([
      {
        content: "running shell",
        actions: [
          { callId: "c1", tool: "run_shell", input: { command: "echo first" } },
        ],
        costUsd: 0,
      },
      {
        content: "all done",
        actions: [],
        costUsd: 0,
      },
    ]);

    const result = await runTeamMiniLoop({
      workerId: "w1",
      persona: "coder",
      task: "do echo first then submit",
      binding,
      provider,
      cwd,
    });

    assert.equal(result.status, "submitted");
    assert.equal(result.steps, 2);
    assert.match(result.submission, /all done/);

    const checkpoints = readTeamCheckpoints(binding.runRoot);
    const teamSteps = checkpoints.filter((cp) => cp.type === "team_step");
    assert.equal(teamSteps.length, 1);
    assert.equal(teamSteps[0].action?.tool, "run_shell");
    assert.equal(teamSteps[0].workerId, "w1");
    assert.ok(typeof teamSteps[0].observationHash === "string");
    assert.ok(teamSteps[0].observationHash.length > 0);

    const verification = verifyTeamRunChain(binding.runRoot);
    assert.equal(verification.ok, true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTeamMiniLoop wires default non-local policy profile and records denial metadata", async () => {
  const { dataRoot, binding } = makeBinding();
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-team-cwd-"));
  const deniedEvents = [];
  try {
    const provider = fakeProvider([
      {
        content: "try shell",
        actions: [
          { callId: "c1", tool: "run_shell", input: { command: "echo should-not-run" } },
        ],
        costUsd: 0,
      },
      {
        content: "blocked and done",
        actions: [],
        costUsd: 0,
      },
    ]);

    const result = await runTeamMiniLoop({
      workerId: "w1",
      persona: "coder",
      task: "try echo then submit",
      binding,
      provider,
      cwd,
      runtimeMode: "openshell",
      onPolicyDenied(event) {
        deniedEvents.push(event);
      },
    });

    assert.equal(result.status, "submitted");
    assert.equal(deniedEvents.length, 1);
    assert.equal(deniedEvents[0].type, "policy.denied");
    assert.equal(deniedEvents[0].capability, "shell.run");
    assert.equal(deniedEvents[0].runtimeMode, "openshell");
    assert.equal(deniedEvents[0].matchedRule, "team.openshell.default-deny.shell.run.default");

    const checkpoints = readTeamCheckpoints(binding.runRoot);
    const teamSteps = checkpoints.filter((cp) => cp.type === "team_step");
    assert.equal(teamSteps.length, 1);
    assert.equal(teamSteps[0].action?.tool, "run_shell");
    assert.deepEqual(teamSteps[0].policy, {
      capability: "shell.run",
      effect: "deny",
      source: "base",
      reason: "Default deny for shell.run.",
      matchedRule: "team.openshell.default-deny.shell.run.default",
      runtimeMode: "openshell",
      toolName: "run_shell",
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTeamMiniLoop exits limits_exceeded when step budget runs out", async () => {
  const { dataRoot, binding } = makeBinding();
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-team-cwd-"));
  try {
    const provider = fakeProvider([
      {
        content: "loop forever",
        actions: [
          { callId: "c1", tool: "run_shell", input: { command: "true" } },
        ],
        costUsd: 0,
      },
    ]);

    const result = await runTeamMiniLoop({
      workerId: "w1",
      persona: "coder",
      task: "go forever",
      binding,
      provider,
      cwd,
    });

    assert.equal(result.status, "limits_exceeded");
    assert.ok(result.steps > 0);

    const checkpoints = readTeamCheckpoints(binding.runRoot);
    const teamSteps = checkpoints.filter((cp) => cp.type === "team_step");
    assert.ok(teamSteps.length >= 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runTeamMiniLoop rejects providers that do not implement query()", async () => {
  const { dataRoot, binding } = makeBinding();
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-team-cwd-"));
  try {
    const broken = {
      async runTurn() {
        return { text: "" };
      },
      clear() {},
      updateRuntimeSettings() {},
      setTraceListener() {},
    };

    await assert.rejects(
      () =>
        runTeamMiniLoop({
          workerId: "w1",
          persona: "coder",
          task: "x",
          binding,
          provider: broken,
          cwd,
        }),
      /stateless query\(\) contract/,
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
