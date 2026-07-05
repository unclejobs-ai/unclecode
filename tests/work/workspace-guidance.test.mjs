import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearCachedWorkspaceGuidance,
  loadCachedWorkspaceGuidance,
} from "@unclecode/context-broker";

test("workspace guidance package seam loads AGENTS.md, CLAUDE.md, and workspace skills into runtime context", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-guidance-"));
  const nested = path.join(root, "apps", "demo");
  mkdirSync(path.join(nested, ".codex", "skills", "autopilot"), { recursive: true });
  writeFileSync(path.join(root, "AGENTS.md"), "# Agents\nPrefer read before edit.\n", "utf8");
  writeFileSync(path.join(nested, "CLAUDE.md"), "# Claude\nUse slash commands for operator surfaces.\n", "utf8");
  writeFileSync(path.join(nested, ".codex", "skills", "autopilot", "SKILL.md"), "# Autopilot\nKeep moving without waiting for approval.\n", "utf8");

  const guidance = await loadCachedWorkspaceGuidance({ cwd: nested, userHomeDir: root });

  // AGENTS.md is excluded from systemPromptAppendix (agent orchestration, not coding guidance)
  assert.match(guidance.systemPromptAppendix, /Use slash commands/);
  assert.doesNotMatch(guidance.systemPromptAppendix, /Keep moving without waiting for approval/);
  assert.ok(guidance.contextSummaryLines.some((line) => /AGENTS\.md/.test(line)));
  assert.ok(guidance.contextSummaryLines.some((line) => /CLAUDE\.md/.test(line)));
  assert.ok(guidance.contextSummaryLines.some((line) => /Skill catalog: autopilot/.test(line)));
  assert.equal(guidance.sources.length, 3);
});

test("clearCachedWorkspaceGuidance lets /reload pick up changed guidance", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-guidance-cache-"));
  const nested = path.join(root, "apps", "demo");
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(root, "CLAUDE.md"), "# Claude\nPrefer read before edit.\n", "utf8");

  const first = await loadCachedWorkspaceGuidance({ cwd: nested, userHomeDir: root });
  writeFileSync(path.join(root, "CLAUDE.md"), "# Claude\nPrefer tests first.\n", "utf8");

  const cached = await loadCachedWorkspaceGuidance({ cwd: nested, userHomeDir: root });
  assert.match(first.systemPromptAppendix, /Prefer read before edit/);
  assert.match(cached.systemPromptAppendix, /Prefer read before edit/);

  clearCachedWorkspaceGuidance(nested, root);
  const refreshed = await loadCachedWorkspaceGuidance({ cwd: nested, userHomeDir: root });
  assert.match(refreshed.systemPromptAppendix, /Prefer tests first/);
});
