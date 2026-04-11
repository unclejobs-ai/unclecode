import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import {
  inspectHarnessStatus,
  formatHarnessStatusLines,
  formatHarnessExplainLines,
  getHarnessPresetPatch,
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
      "[mcp_servers.omx_state]",
      'command = "node"',
      "",
      "[mcp_servers.omx_memory]",
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
  assert.deepEqual(status.mcpServers, ["omx_state", "omx_memory"]);
});

test("formatHarnessStatusLines returns readable output", () => {
  const status = inspectHarnessStatus(testDir);
  const lines = formatHarnessStatusLines(status);
  assert.ok(lines.some((l) => l.includes("gpt-5.4")));
  assert.ok(lines.some((l) => l.includes("high")));
  assert.ok(lines.some((l) => l.includes("omx_state")));
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

  const patch = getHarnessPresetPatch("yolo");
  let content = readFileSync(
    path.join(applyDir, ".codex", "config.toml"),
    "utf8",
  );

  for (const [key, value] of Object.entries(patch)) {
    const pattern = new RegExp(`^(${key}\\s*=\\s*)"[^"]*"`, "m");
    content = content.replace(pattern, `$1"${value}"`);
  }

  writeFileSync(
    path.join(applyDir, ".codex", "config.toml"),
    content,
    "utf8",
  );

  const status = inspectHarnessStatus(applyDir);
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

test.after(() => {
  rmSync(testDir, { recursive: true, force: true });
});
