import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearCachedWorkspaceGuidance,
  loadCachedWorkspaceGuidance,
  loadWorkspaceGuidance,
} from "@unclecode/context-broker";

test("context-broker loadWorkspaceGuidance loads cross-CLI guidance files and project skills", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-guidance-broker-"));
  const nested = path.join(root, "apps", "demo");
  const home = path.join(root, "home");
  mkdirSync(nested, { recursive: true });
  mkdirSync(path.join(home, ".unclecode"), { recursive: true });

  writeFileSync(path.join(home, ".unclecode", "UNCLECODE.md"), "# Claude\nUse slash commands for operator surfaces.\n", "utf8");
  writeFileSync(path.join(root, "AGENTS.md"), "# Agents\nPrefer read before edit.\n", "utf8");
  writeFileSync(path.join(nested, "CLAUDE.md"), "# Claude\nUse slash commands for operator surfaces.\n", "utf8");
  writeFileSync(path.join(nested, "GEMINI.local.md"), "# Gemini Local\nPrefer local overrides.\n", "utf8");
  writeFileSync(path.join(nested, "UNCLECODE.md"), "# UncleCode\nKeep shell transitions smooth.\n", "utf8");

  const guidance = await loadWorkspaceGuidance({
    cwd: nested,
    userHomeDir: home,
    workspaceSkills: [
      {
        name: "autopilot",
        path: path.join(nested, ".codex", "skills", "autopilot", "SKILL.md"),
        scope: "project",
        summary: "Keep moving without waiting for approval.",
        content: "# Autopilot\nKeep moving without waiting for approval.\n",
      },
    ],
  });

  assert.match(guidance.systemPromptAppendix, /Prefer read before edit/);
  assert.match(guidance.systemPromptAppendix, /Use slash commands/);
  assert.match(guidance.systemPromptAppendix, /Prefer local overrides/);
  assert.match(guidance.systemPromptAppendix, /Keep shell transitions smooth/);
  assert.match(guidance.systemPromptAppendix, /Keep moving without waiting for approval/);
  assert.equal((guidance.systemPromptAppendix.match(/Use slash commands for operator surfaces\./g) ?? []).length, 1);
  assert.ok(guidance.contextSummaryLines.some((line) => /AGENTS\.md/.test(line)));
  assert.ok(guidance.contextSummaryLines.some((line) => /CLAUDE\.md/.test(line)));
  assert.ok(guidance.contextSummaryLines.some((line) => /GEMINI\.local\.md/.test(line)));
  assert.ok(guidance.contextSummaryLines.some((line) => /UNCLECODE\.md/.test(line)));
  assert.ok(guidance.contextSummaryLines.some((line) => /Deduped duplicate guidance/i));
  assert.ok(guidance.contextSummaryLines.some((line) => /Loaded skills: autopilot/.test(line)));
  assert.equal(guidance.sources.length, 5);
});

test("context-broker loadWorkspaceGuidance reports basic directive conflicts with higher-priority winners", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-guidance-conflicts-"));
  const nested = path.join(root, "apps", "demo");
  mkdirSync(nested, { recursive: true });

  writeFileSync(path.join(root, "AGENTS.md"), "# Agents\nTests optional for quick edits.\n", "utf8");
  writeFileSync(path.join(nested, "CLAUDE.md"), "# Claude\nTDD required for all changes.\n", "utf8");

  const guidance = await loadWorkspaceGuidance({ cwd: nested });

  assert.ok(guidance.contextSummaryLines.some((line) => /Conflict: tests/i.test(line)));
  assert.ok(guidance.contextSummaryLines.some((line) => /CLAUDE\.md wins/i.test(line)));
});

test("context-broker cached workspace guidance keeps project-skill context stable until cleared", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-guidance-runtime-cache-"));
  const nested = path.join(root, "apps", "demo");
  mkdirSync(path.join(nested, ".codex", "skills", "autopilot"), { recursive: true });

  writeFileSync(path.join(root, "AGENTS.md"), "# Agents\nPrefer read before edit.\n", "utf8");
  writeFileSync(
    path.join(nested, ".codex", "skills", "autopilot", "SKILL.md"),
    "# Autopilot\nKeep moving without waiting for approval.\n",
    "utf8",
  );

  const first = await loadCachedWorkspaceGuidance({ cwd: nested });
  writeFileSync(path.join(root, "AGENTS.md"), "# Agents\nPrefer tests first.\n", "utf8");

  const cached = await loadCachedWorkspaceGuidance({ cwd: nested });
  assert.match(first.systemPromptAppendix, /Prefer read before edit/);
  assert.match(cached.systemPromptAppendix, /Prefer read before edit/);
  assert.match(cached.systemPromptAppendix, /Keep moving without waiting for approval/);

  clearCachedWorkspaceGuidance(nested);
  const refreshed = await loadCachedWorkspaceGuidance({ cwd: nested });
  assert.match(refreshed.systemPromptAppendix, /Prefer tests first/);
});
