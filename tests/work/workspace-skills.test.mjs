import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverSkillMetadata } from "../../src/workspace-skills.ts";

test("discoverSkillMetadata reads skill frontmatter before full content loading", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-skill-meta-"));
  const home = path.join(cwd, "home");

  mkdirSync(path.join(cwd, ".codex", "skills", "analyze"), { recursive: true });
  mkdirSync(path.join(home, ".agents", "skills", "superpowers", "brainstorming"), { recursive: true });

  writeFileSync(
    path.join(cwd, ".codex", "skills", "analyze", "SKILL.md"),
    "---\nname: analyze\ndescription: Inspect the repo deeply.\n---\n# Analyze\nBody\n",
    "utf8",
  );
  writeFileSync(
    path.join(home, ".agents", "skills", "superpowers", "brainstorming", "SKILL.md"),
    "# Brainstorming\nExplore designs before implementation.\n",
    "utf8",
  );

  const skills = await discoverSkillMetadata(cwd, home);

  assert.ok(
    skills.some(
      (skill) =>
        skill.name === "analyze" &&
        skill.description === "Inspect the repo deeply." &&
        skill.source === "skills" &&
        skill.commandType === "prompt",
    ),
  );
  assert.ok(
    skills.some(
      (skill) =>
        skill.name === "brainstorming" &&
        /Explore designs/.test(skill.description),
    ),
  );
});
