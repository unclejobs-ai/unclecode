import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearWorkspaceGuidanceCache,
  loadWorkspaceGuidance,
} from "../../src/workspace-guidance.ts";

test("src/workspace-guidance shim loads AGENTS.md, CLAUDE.md, and workspace skills into runtime context", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-guidance-"));
  const nested = path.join(root, "apps", "demo");
  mkdirSync(path.join(nested, ".codex", "skills", "autopilot"), { recursive: true });
  writeFileSync(path.join(root, "AGENTS.md"), "# Agents\nPrefer read before edit.\n", "utf8");
  writeFileSync(path.join(nested, "CLAUDE.md"), "# Claude\nUse slash commands for operator surfaces.\n", "utf8");
  writeFileSync(path.join(nested, ".codex", "skills", "autopilot", "SKILL.md"), "# Autopilot\nKeep moving without waiting for approval.\n", "utf8");

  const guidance = await loadWorkspaceGuidance(nested);

  assert.match(guidance.systemPromptAppendix, /Prefer read before edit/);
  assert.match(guidance.systemPromptAppendix, /Use slash commands/);
  assert.match(guidance.systemPromptAppendix, /Keep moving without waiting for approval/);
  assert.ok(guidance.contextSummaryLines.some((line) => /AGENTS\.md/.test(line)));
  assert.ok(guidance.contextSummaryLines.some((line) => /CLAUDE\.md/.test(line)));
  assert.ok(guidance.contextSummaryLines.some((line) => /Loaded skills: autopilot/.test(line)));
  assert.equal(guidance.sources.length, 3);
});

test("clearWorkspaceGuidanceCache lets /reload pick up changed guidance", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-guidance-cache-"));
  const nested = path.join(root, "apps", "demo");
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(root, "AGENTS.md"), "# Agents\nPrefer read before edit.\n", "utf8");

  const first = await loadWorkspaceGuidance(nested);
  writeFileSync(path.join(root, "AGENTS.md"), "# Agents\nPrefer tests first.\n", "utf8");

  const cached = await loadWorkspaceGuidance(nested);
  assert.match(first.systemPromptAppendix, /Prefer read before edit/);
  assert.match(cached.systemPromptAppendix, /Prefer read before edit/);

  clearWorkspaceGuidanceCache(nested);
  const refreshed = await loadWorkspaceGuidance(nested);
  assert.match(refreshed.systemPromptAppendix, /Prefer tests first/);
});
