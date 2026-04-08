import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverSkillMetadata,
  listAvailableSkills,
  loadNamedSkill,
} from "../../packages/context-broker/src/index.ts";

test("context-broker workspace-skill helpers discover metadata and load content", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-context-broker-skills-"));
  const home = path.join(cwd, "home");

  mkdirSync(path.join(cwd, ".codex", "skills", "analyze"), {
    recursive: true,
  });
  mkdirSync(
    path.join(home, ".agents", "skills", "superpowers", "brainstorming"),
    { recursive: true },
  );

  writeFileSync(
    path.join(cwd, ".codex", "skills", "analyze", "SKILL.md"),
    "---\nname: analyze\ndescription: Inspect the repo deeply.\n---\n# Analyze\nBody\n",
    "utf8",
  );
  writeFileSync(
    path.join(
      home,
      ".agents",
      "skills",
      "superpowers",
      "brainstorming",
      "SKILL.md",
    ),
    "# Brainstorming\nExplore designs before implementation.\n",
    "utf8",
  );

  const metadata = await discoverSkillMetadata(cwd, home);
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
