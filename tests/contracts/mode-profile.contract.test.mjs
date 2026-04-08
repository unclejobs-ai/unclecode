import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMAND_SOURCES,
  COMMAND_TYPES,
  MODE_PROFILES,
  MODE_PROFILE_IDS,
  SKILL_SOURCES,
} from "@unclecode/contracts";

test("mode-profile fixtures expose canonical modes plus command and skill metadata sources", () => {
  assert.deepEqual(MODE_PROFILE_IDS, [
    "default",
    "ultrawork",
    "search",
    "analyze",
  ]);

  assert.deepEqual(MODE_PROFILES.default, {
    id: "default",
    label: "Default",
    editing: "allowed",
    searchDepth: "balanced",
    backgroundTasks: "allowed",
    explanationStyle: "balanced",
    reasoningDefault: "medium",
  });

  assert.deepEqual(MODE_PROFILES.ultrawork, {
    id: "ultrawork",
    label: "Ultra Work",
    editing: "allowed",
    searchDepth: "deep",
    backgroundTasks: "preferred",
    explanationStyle: "concise",
    reasoningDefault: "high",
  });

  assert.deepEqual(MODE_PROFILES.search, {
    id: "search",
    label: "Search",
    editing: "forbidden",
    searchDepth: "deep",
    backgroundTasks: "preferred",
    explanationStyle: "concise",
    reasoningDefault: "low",
  });

  assert.deepEqual(MODE_PROFILES.analyze, {
    id: "analyze",
    label: "Analyze",
    editing: "reviewed",
    searchDepth: "balanced",
    backgroundTasks: "allowed",
    explanationStyle: "detailed",
    reasoningDefault: "high",
  });

  assert.deepEqual(COMMAND_TYPES, ["prompt", "local", "local-jsx"]);
  assert.deepEqual(COMMAND_SOURCES, [
    "builtin",
    "mcp",
    "plugin",
    "bundled",
    "skills",
    "managed",
  ]);
  assert.deepEqual(SKILL_SOURCES, ["skills", "bundled", "plugin", "mcp"]);
});
