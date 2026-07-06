import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

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
    assert.equal(result.sha256, "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8");
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
    assert.equal(binding.verifyCitationDetail(ref1).status, "valid");
    writeFileSync(filePath, "tampered");
    assert.equal(binding.verifyCitation(ref1), false);
    const stale = binding.verifyCitationDetail(ref1);
    assert.equal(stale.status, "stale");
    assert.equal(stale.expectedHash, ref1.versionHash);
    assert.match(stale.summary, /stale code citation/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("verifyCitationDetail explains missing code citations", () => {
  const { dataRoot, ref } = makeRun();
  try {
    const binding = bindToRun({
      runId: ref.runId,
      runRoot: ref.runRoot,
      role: "worker",
      workspaceRoot: ref.runRoot,
    });
    const detail = binding.verifyCitationDetail({
      category: "code",
      key: "missing.txt",
      versionHash: "abc123",
      retrievedAt: 0,
    });
    assert.equal(detail.status, "missing");
    assert.match(detail.summary, /missing code citation target/);
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
    assert.equal(binding.verifyCitationDetail(cite0).status, "valid");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("checkpoint citations reject partially numeric keys", () => {
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
    const valid = binding.cite("checkpoint", "0");
    const malformed = {
      category: "checkpoint",
      key: "0junk",
      versionHash: valid.versionHash,
      retrievedAt: 0,
    };

    assert.equal(binding.cite("checkpoint", "0junk").versionHash, "");
    assert.equal(binding.verifyCitation(malformed), false);
    const detail = binding.verifyCitationDetail(malformed);
    assert.equal(detail.status, "missing");
    assert.match(detail.summary, /missing checkpoint citation target/);
    assert.throws(
      () => binding.attachCitation("checkpoint 0 was cited", [malformed]),
      /Cannot attach invalid citation: missing checkpoint citation target/,
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("verifyCitationDetail explains missing checkpoint citations", () => {
  const { dataRoot, ref } = makeRun();
  try {
    const binding = bindToRun({
      runId: ref.runId,
      runRoot: ref.runRoot,
      role: "worker",
      workspaceRoot: ref.runRoot,
    });
    const detail = binding.verifyCitationDetail({
      category: "checkpoint",
      key: "99",
      versionHash: "abc123",
      retrievedAt: 0,
    });
    assert.equal(detail.status, "missing");
    assert.match(detail.summary, /missing checkpoint citation target/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("verifyCitationDetail explains unsupported citation categories", () => {
  const { dataRoot, ref } = makeRun();
  try {
    const binding = bindToRun({
      runId: ref.runId,
      runRoot: ref.runRoot,
      role: "worker",
      workspaceRoot: ref.runRoot,
    });
    const detail = binding.verifyCitationDetail({
      category: "external_doc",
      key: "doc",
      versionHash: "abc123",
      retrievedAt: 0,
    });
    assert.equal(detail.status, "unsupported");
    assert.equal(binding.verifyCitation(detail.ref), false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("attachCitation rejects stale code citations", () => {
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
    writeFileSync(filePath, "tampered");

    assert.throws(
      () => binding.attachCitation("fixture remained alpha", [ref1]),
      /Cannot attach invalid citation: stale code citation/,
    );
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
  const outsideDir = mkdtempSync(join(tmpdir(), "uc-binding-outside-"));
  try {
    const outsideFile = join(outsideDir, "secret.txt");
    writeFileSync(outsideFile, "secret");
    writeFileSync(join(ref.runRoot, "fixture.txt"), "alpha");
    const binding = bindToRun({
      runId: ref.runId,
      runRoot: ref.runRoot,
      role: "worker",
      workspaceRoot: ref.runRoot,
    });
    assert.throws(() => binding.readCode(outsideFile), /absolute paths are not allowed/);
    assert.throws(() => binding.readCode(`../${basename(outsideDir)}/secret.txt`), /path escapes working directory/);
    assert.equal(binding.readCode("fixture.txt").content, "alpha");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("readCode rejects in-workspace symlinks that resolve outside workspaceRoot", () => {
  const { dataRoot, ref } = makeRun();
  const outsideDir = mkdtempSync(join(tmpdir(), "uc-binding-outside-"));
  try {
    const outsideFile = join(outsideDir, "secret.txt");
    const linkPath = join(ref.runRoot, "linked-secret.txt");
    writeFileSync(outsideFile, "secret");
    symlinkSync(outsideFile, linkPath);
    const binding = bindToRun({
      runId: ref.runId,
      runRoot: ref.runRoot,
      role: "worker",
      workspaceRoot: ref.runRoot,
    });

    assert.throws(() => binding.readCode("linked-secret.txt"), /path escapes working directory/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});
