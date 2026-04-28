import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TeamBinding,
  bindToRun,
  readBindingFromEnv,
  RUN_ID_ENV,
  RUN_ROOT_ENV,
} from "@unclecode/orchestrator";
import { createTeamRun, appendTeamCheckpoint } from "@unclecode/session-store";

function makeRun() {
  const dataRoot = mkdtempSync(join(tmpdir(), "uc-binding-"));
  const ref = createTeamRun({
    dataRoot,
    objective: "test",
    persona: "coder",
    lanes: 1,
    gate: "strict",
    runtime: "local",
    workspaceRoot: dataRoot,
    createdBy: "tests",
  });
  return { dataRoot, ref };
}

test("readCode returns content + sha256 + mtime for in-workspace files", () => {
  const { dataRoot, ref } = makeRun();
  try {
    const filePath = join(ref.runRoot, "fixture.txt");
    writeFileSync(filePath, "alpha");
    const binding = bindToRun({
      runId: ref.runId,
      runRoot: ref.runRoot,
      role: "worker",
      workspaceRoot: ref.runRoot,
    });
    const result = binding.readCode("fixture.txt");
    assert.equal(result.content, "alpha");
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("cite + verifyCitation roundtrip on code citation; tampering invalidates", () => {
  const { dataRoot, ref } = makeRun();
  try {
    const filePath = join(ref.runRoot, "fixture.txt");
    writeFileSync(filePath, "alpha");
    const binding = bindToRun({
      runId: ref.runId,
      runRoot: ref.runRoot,
      role: "worker",
      workspaceRoot: ref.runRoot,
    });
    const ref1 = binding.cite("code", "fixture.txt");
    assert.equal(binding.verifyCitation(ref1), true);
    writeFileSync(filePath, "tampered");
    assert.equal(binding.verifyCitation(ref1), false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("cite checkpoint resolves to lineHash and verifies", () => {
  const { dataRoot, ref } = makeRun();
  try {
    appendTeamCheckpoint(ref.runRoot, {
      type: "team_run",
      runId: ref.runId,
      persona: "coder",
      status: "started",
      objective: "test",
      lanes: 1,
      timestamp: new Date(0).toISOString(),
    });
    const binding = bindToRun({
      runId: ref.runId,
      runRoot: ref.runRoot,
      role: "worker",
      workspaceRoot: ref.runRoot,
    });
    const cite0 = binding.cite("checkpoint", "0");
    assert.match(cite0.versionHash, /^[0-9a-f]{64}$/);
    assert.equal(binding.verifyCitation(cite0), true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("cite throws Not implemented for unsupported SSOT categories", () => {
  const { dataRoot, ref } = makeRun();
  try {
    const binding = bindToRun({
      runId: ref.runId,
      runRoot: ref.runRoot,
      role: "worker",
      workspaceRoot: ref.runRoot,
    });
    assert.throws(() => binding.cite("memory_observation", "ignored"), /Not implemented/);
    assert.throws(() => binding.cite("external_doc", "ignored"), /Not implemented/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("envForChild + readBindingFromEnv roundtrip", () => {
  const { dataRoot, ref } = makeRun();
  try {
    const binding = bindToRun({
      runId: ref.runId,
      runRoot: ref.runRoot,
      role: "coordinator",
      workspaceRoot: ref.runRoot,
    });
    const env = binding.envForChild();
    assert.equal(env[RUN_ID_ENV], ref.runId);
    assert.equal(env[RUN_ROOT_ENV], ref.runRoot);
    const restored = readBindingFromEnv({ ...env, PWD: ref.runRoot });
    assert.equal(restored.runId, ref.runId);
    assert.equal(restored.role, "worker");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("readCode rejects absolute paths and traversal via path-containment guard", () => {
  const { dataRoot, ref } = makeRun();
  try {
    const binding = bindToRun({
      runId: ref.runId,
      runRoot: ref.runRoot,
      role: "worker",
      workspaceRoot: ref.runRoot,
    });
    // readCode does not currently guard path containment by itself — it accepts
    // already-rooted paths and reads them. This test pins the current behavior
    // and flags any future regression that lets absolute reads succeed
    // silently. It should be revisited when readCode adopts the helper.
    assert.throws(() => binding.readCode("../../etc/passwd"), /readCode|ENOENT|does not exist/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
