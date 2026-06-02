import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import {
  inspectHarnessStatus,
  applyHarnessPreset,
  formatHarnessStatusLines,
  formatHarnessExplainLines,
  getHarnessPresetPatch,
  getRustStartupProbe,
} from "../../apps/unclecode-cli/src/harness.ts";

const testDir = path.join(tmpdir(), `harness-test-${Date.now()}`);

test("inspectHarnessStatus returns not-found when config is missing", () => {
  const status = inspectHarnessStatus(testDir);
  assert.equal(status.exists, false);
  assert.equal(status.model, null);
});

test("inspectHarnessStatus reads real .codex/config.toml values", () => {
  mkdirSync(path.join(testDir, ".codex"), { recursive: true });
  writeFileSync(
    path.join(testDir, ".codex", "config.toml"),
    [
      'model = "gpt-5.4"',
      'model_reasoning_effort = "high"',
      'approvals_reviewer = "user"',
      "",
      "[features]",
      "multi_agent = true",
      "",
      "[tui]",
      'status_line = ["model-with-reasoning", "git-branch"]',
      "",
      "[mcp_servers.workspace_state]",
      'command = "node"',
      "",
      "[mcp_servers.workspace_memory]",
      'command = "node"',
    ].join("\n"),
    "utf8",
  );

  const status = inspectHarnessStatus(testDir);
  assert.equal(status.exists, true);
  assert.equal(status.model, "gpt-5.4");
  assert.equal(status.reasoningEffort, "high");
  assert.equal(status.approvals, "user");
  assert.equal(status.multiAgent, true);
  assert.deepEqual(status.statusLine, ["model-with-reasoning", "git-branch"]);
  assert.deepEqual(status.mcpServers, ["workspace_state", "workspace_memory"]);
});

test("formatHarnessStatusLines returns readable output", () => {
  const status = inspectHarnessStatus(testDir);
  const lines = formatHarnessStatusLines(status);
  assert.ok(lines.some((l) => l.includes("gpt-5.4")));
  assert.ok(lines.some((l) => l.includes("high")));
  assert.ok(lines.some((l) => l.includes("workspace_state")));
});

test("formatHarnessExplainLines describes available presets", () => {
  const lines = formatHarnessExplainLines();
  assert.ok(lines.some((l) => l.includes("yolo")));
  assert.ok(lines.some((l) => l.includes("harness status")));
});

test("getHarnessPresetPatch returns correct yolo overrides", () => {
  const patch = getHarnessPresetPatch("yolo");
  assert.equal(patch.model_reasoning_effort, "medium");
  assert.equal(patch.approvals_reviewer, "auto-edit");
});

test("getHarnessPresetPatch is backed by Rust preset catalog", () => {
  const patch = getHarnessPresetPatch("team-auditor");
  assert.deepEqual(patch, {
    model_reasoning_effort: "low",
    approvals_reviewer: "user",
  });
});

test("getRustStartupProbe exposes native startup timing", () => {
  const probe = getRustStartupProbe();
  assert.equal(probe.probe, "native-startup");
  assert.ok(Number.isFinite(probe.elapsedMs));
  assert.ok(probe.elapsedMs >= 0);
});

test("formatHarnessStatusLines handles missing config gracefully", () => {
  const missingDir = path.join(testDir, "nonexistent");
  const status = inspectHarnessStatus(missingDir);
  const lines = formatHarnessStatusLines(status);
  assert.ok(lines.some((l) => l.includes("not found")));
});

test("harness apply yolo patches config.toml values correctly", () => {
  const applyDir = path.join(testDir, "apply-test");
  mkdirSync(path.join(applyDir, ".codex"), { recursive: true });
  writeFileSync(
    path.join(applyDir, ".codex", "config.toml"),
    [
      'model = "gpt-5.4"',
      'model_reasoning_effort = "high"',
      'approvals_reviewer = "user"',
    ].join("\n"),
    "utf8",
  );

  const changes = applyHarnessPreset(applyDir, "yolo");

  const status = inspectHarnessStatus(applyDir);
  assert.deepEqual(changes, [
    { key: "model_reasoning_effort", value: "medium", changed: true },
    { key: "approvals_reviewer", value: "auto-edit", changed: true },
  ]);
  assert.equal(
    status.reasoningEffort,
    "medium",
    "reasoning effort patched to medium",
  );
  assert.equal(
    status.approvals,
    "auto-edit",
    "approvals patched to auto-edit",
  );
  assert.equal(status.model, "gpt-5.4", "model preserved unchanged");
});

test("harness apply uses the requested preset instead of hard-coded yolo", () => {
  const applyDir = path.join(testDir, "apply-team-auditor");
  mkdirSync(path.join(applyDir, ".codex"), { recursive: true });
  writeFileSync(
    path.join(applyDir, ".codex", "config.toml"),
    [
      'model = "gpt-5.4"',
      'model_reasoning_effort = "high"',
      'approvals_reviewer = "auto-edit"',
    ].join("\n"),
    "utf8",
  );

  const changes = applyHarnessPreset(applyDir, "team-auditor");
  const status = inspectHarnessStatus(applyDir);

  assert.deepEqual(changes, [
    { key: "model_reasoning_effort", value: "low", changed: true },
    { key: "approvals_reviewer", value: "user", changed: true },
  ]);
  assert.equal(status.reasoningEffort, "low");
  assert.equal(status.approvals, "user");
});

test.after(() => {
  rmSync(testDir, { recursive: true, force: true });
});
