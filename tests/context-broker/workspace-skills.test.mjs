import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearWorkspaceSkillCache,
  discoverSkillMetadata,
  getContextBrokerCacheTelemetrySnapshot,
  listAvailableSkills,
  loadNamedSkill,
} from "../../packages/context-broker/src/index.ts";

test("context-broker workspace-skill helpers discover metadata and load content", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-context-broker-skills-"));
  const home = path.join(cwd, "home");

  mkdirSync(path.join(cwd, ".codex", "skills", "analyze"), {
    recursive: true,
  });
  mkdirSync(path.join(home, ".agents", "skills", "brainstorming"), {
    recursive: true,
  });

  writeFileSync(
    path.join(cwd, ".codex", "skills", "analyze", "SKILL.md"),
    "---\nname: analyze\ndescription: Inspect the repo deeply.\n---\n# Analyze\nBody\n",
    "utf8",
  );
  writeFileSync(
    path.join(home, ".agents", "skills", "brainstorming", "SKILL.md"),
    "# Brainstorming\nExplore designs before implementation.\n",
    "utf8",
  );

  const before = getContextBrokerCacheTelemetrySnapshot()
    .find((snapshot) => snapshot.name === "workspace-skill-metadata");
  const metadata = await discoverSkillMetadata(cwd, home);
  const cachedMetadata = await discoverSkillMetadata(cwd, home);
  const skills = await listAvailableSkills(cwd, home);
  const loaded = await loadNamedSkill("brainstorming", cwd, home);

  assert.ok(
    metadata.some(
      (skill) =>
        skill.name === "analyze" &&
        skill.description === "Inspect the repo deeply." &&
        skill.scope === "project",
    ),
  );
  assert.equal(cachedMetadata, metadata);
  const afterHit = getContextBrokerCacheTelemetrySnapshot()
    .find((snapshot) => snapshot.name === "workspace-skill-metadata");
  assert.equal(afterHit.misses - before.misses, 1);
  assert.equal(afterHit.hits - before.hits, 1);
  assert.ok(afterHit.maxRetainedBytes > 0);
  assert.ok(afterHit.retainedBytesEstimate > 0);
  clearWorkspaceSkillCache(cwd, home);
  const afterInvalidation = getContextBrokerCacheTelemetrySnapshot()
    .find((snapshot) => snapshot.name === "workspace-skill-metadata");
  assert.equal(afterInvalidation.invalidations - afterHit.invalidations, 1);
  assert.ok(
    skills.some(
      (skill) =>
        skill.name === "brainstorming" &&
        /Explore designs/.test(skill.summary),
    ),
  );
  assert.equal(loaded.name, "brainstorming");
  assert.match(loaded.content, /Explore designs/);
});

test("context-broker workspace-skill helpers ignore legacy superpowers skills", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-context-broker-skills-"));
  const home = path.join(cwd, "home");

  mkdirSync(path.join(home, ".agents", "skills", "superpowers", "using-superpowers"), {
    recursive: true,
  });
  writeFileSync(
    path.join(home, ".agents", "skills", "superpowers", "using-superpowers", "SKILL.md"),
    "# Using Superpowers\nMandatory meta skill.\n",
    "utf8",
  );

  const metadata = await discoverSkillMetadata(cwd, home);
  const skills = await listAvailableSkills(cwd, home);

  assert.ok(metadata.every((skill) => skill.name !== "using-superpowers"));
  assert.ok(skills.every((skill) => skill.name !== "using-superpowers"));
  await assert.rejects(() => loadNamedSkill("using-superpowers", cwd, home), /Skill not found/);
});

test("workspace skill cache isolates cwd and home pairs containing delimiters", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-skill-key-isolation-"));
  const cwdA = path.join(root, "a");
  const homeA = path.join(root, "b::", root, "c");
  const cwdB = path.join(root, "a::", root, "b");
  const homeB = path.join(root, "c");
  mkdirSync(path.join(cwdA, ".codex", "skills", "skill-a"), { recursive: true });
  mkdirSync(path.join(cwdB, ".codex", "skills", "skill-b"), { recursive: true });
  mkdirSync(homeA, { recursive: true });
  mkdirSync(homeB, { recursive: true });
  writeFileSync(path.join(cwdA, ".codex", "skills", "skill-a", "SKILL.md"), "# Skill A\nA only.\n", "utf8");
  writeFileSync(path.join(cwdB, ".codex", "skills", "skill-b", "SKILL.md"), "# Skill B\nB only.\n", "utf8");

  const first = await discoverSkillMetadata(cwdA, homeA);
  const second = await discoverSkillMetadata(cwdB, homeB);

  assert.ok(first.some((skill) => skill.name === "skill-a"));
  assert.ok(second.some((skill) => skill.name === "skill-b"));
  assert.ok(second.every((skill) => skill.name !== "skill-a"));
  clearWorkspaceSkillCache(cwdA, homeA);
  clearWorkspaceSkillCache(cwdB, homeB);
});
