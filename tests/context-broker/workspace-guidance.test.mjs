import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearCachedWorkspaceGuidance,
  getContextBrokerCacheTelemetrySnapshot,
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
  assert.ok(guidance.contextSummaryLines.some((line) => /Skill catalog: autopilot/.test(line)));
  assert.equal(guidance.sources.length, 5);
  assert.ok(guidance.guidanceSources.some((source) => source.authority === "mandatory"));
  assert.deepEqual(
    guidance.guidanceSources.find((source) => source.label === "SKILL autopilot"),
    {
      id: guidance.guidanceSources.find((source) => source.label === "SKILL autopilot")?.id,
      path: path.join(nested, ".codex", "skills", "autopilot", "SKILL.md"),
      label: "SKILL autopilot",
      authority: "profile-eligible",
      sha256: guidance.guidanceSources.find((source) => source.label === "SKILL autopilot")?.sha256,
    },
  );
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

  const before = getContextBrokerCacheTelemetrySnapshot()
    .find((snapshot) => snapshot.name === "workspace-guidance");
  const first = await loadCachedWorkspaceGuidance({ cwd: nested });
  writeFileSync(path.join(root, "AGENTS.md"), "# Agents\nPrefer tests first.\n", "utf8");

  const cached = await loadCachedWorkspaceGuidance({ cwd: nested });
  const afterHit = getContextBrokerCacheTelemetrySnapshot()
    .find((snapshot) => snapshot.name === "workspace-guidance");
  assert.match(first.systemPromptAppendix, /Prefer read before edit/);
  assert.match(cached.systemPromptAppendix, /Prefer read before edit/);
  assert.doesNotMatch(cached.systemPromptAppendix, /Keep moving without waiting for approval/);
  assert.equal(afterHit.misses - before.misses, 1);
  assert.equal(afterHit.hits - before.hits, 1);
  assert.ok(afterHit.maxRetainedBytes > 0);
  assert.ok(afterHit.retainedBytesEstimate > 0);

  clearCachedWorkspaceGuidance(nested);
  const afterInvalidation = getContextBrokerCacheTelemetrySnapshot()
    .find((snapshot) => snapshot.name === "workspace-guidance");
  assert.equal(afterInvalidation.invalidations - afterHit.invalidations, 1);
  assert.equal(afterInvalidation.currentSize, afterHit.currentSize - 1);
  const refreshed = await loadCachedWorkspaceGuidance({ cwd: nested });
  assert.match(refreshed.systemPromptAppendix, /Prefer tests first/);
});

test("context-broker cache isolates cwd and home pairs containing delimiters", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-guidance-key-isolation-"));
  const cwdA = path.join(root, "a");
  const homeA = path.join(root, "b::", root, "c");
  const cwdB = path.join(root, "a::", root, "b");
  const homeB = path.join(root, "c");
  mkdirSync(cwdA, { recursive: true });
  mkdirSync(homeA, { recursive: true });
  mkdirSync(cwdB, { recursive: true });
  mkdirSync(homeB, { recursive: true });
  writeFileSync(path.join(cwdA, "AGENTS.md"), "# A\nGuidance belongs only to workspace A.\n", "utf8");
  writeFileSync(path.join(cwdB, "AGENTS.md"), "# B\nGuidance belongs only to workspace B.\n", "utf8");

  const first = await loadCachedWorkspaceGuidance({ cwd: cwdA, userHomeDir: homeA });
  const second = await loadCachedWorkspaceGuidance({ cwd: cwdB, userHomeDir: homeB });

  assert.match(first.systemPromptAppendix, /workspace A/);
  assert.match(second.systemPromptAppendix, /workspace B/);
  assert.doesNotMatch(second.systemPromptAppendix, /workspace A/);
  clearCachedWorkspaceGuidance(cwdA, homeA);
  clearCachedWorkspaceGuidance(cwdB, homeB);
});

test("context-broker loadWorkspaceGuidance discovers .sisyphus/rules/*.md as guidance sources", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-guidance-rules-"));
  mkdirSync(path.join(root, ".sisyphus", "rules"), { recursive: true });
  writeFileSync(
    path.join(root, ".sisyphus", "rules", "code-limits.md"),
    "# Code Limits\nNo file may exceed 500 lines.\n",
    "utf8",
  );
  writeFileSync(
    path.join(root, "AGENTS.md"),
    "# Agents\nFollow all rules.\n",
    "utf8",
  );

  const guidance = await loadWorkspaceGuidance({ cwd: root });

  assert.ok(
    guidance.sources.includes(path.join(root, ".sisyphus", "rules", "code-limits.md")),
    "rules file path appears in sources",
  );
  assert.match(guidance.systemPromptAppendix, /No file may exceed 500 lines/);
  assert.ok(
    guidance.contextSummaryLines.some((line) => line.includes("rules/code-limits.md")),
    "rules file appears in context summary",
  );
});
