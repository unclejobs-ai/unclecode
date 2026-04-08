import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatSlashCommandHelp,
  parseSlashCommand,
  routeSlashCommand,
} from "../../apps/unclecode-cli/src/command-router.ts";

test("parseSlashCommand parses /help as a shell-help alias", () => {
  const parsed = parseSlashCommand("/help");

  assert.deepEqual(parsed, {
    kind: "slash",
    name: "help",
    args: [],
    raw: "/help",
  });
});

test("parseSlashCommand parses /mode set analyze with args", () => {
  const parsed = parseSlashCommand("/mode set analyze");

  assert.deepEqual(parsed, {
    kind: "slash",
    name: "mode",
    args: ["set", "analyze"],
    raw: "/mode set analyze",
  });
});

test("parseSlashCommand returns plain for non-slash input", () => {
  const parsed = parseSlashCommand("summarize this repo");

  assert.deepEqual(parsed, {
    kind: "plain",
    raw: "summarize this repo",
  });
});

test("routeSlashCommand maps /help and /mode commands to CLI command vectors", () => {
  assert.deepEqual(routeSlashCommand("/help"), ["--help"]);
  assert.deepEqual(routeSlashCommand("/work"), ["work"]);
  assert.deepEqual(routeSlashCommand("/mode status"), ["mode", "status"]);
  assert.deepEqual(routeSlashCommand("/mode set analyze"), ["mode", "set", "analyze"]);
  assert.deepEqual(routeSlashCommand("/doctor"), ["doctor"]);
  assert.deepEqual(routeSlashCommand("/sessions"), ["sessions"]);
  assert.deepEqual(routeSlashCommand("/mcp list"), ["mcp", "list"]);
  assert.deepEqual(routeSlashCommand("/research status"), ["research", "status"]);
});

test("routeSlashCommand loads plugin manifest commands from project extensions", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-plugin-router-"));
  mkdirSync(path.join(cwd, ".unclecode", "extensions"), { recursive: true });
  writeFileSync(
    path.join(cwd, ".unclecode", "extensions", "focus.json"),
    JSON.stringify({
      name: "focus-tools",
      commands: [
        {
          command: "/focus",
          routeTo: ["doctor"],
          description: "Run doctor from a plugin command.",
        },
      ],
    }),
    "utf8",
  );

  assert.deepEqual(routeSlashCommand("/focus", { workspaceRoot: cwd }), ["doctor"]);
});

test("formatSlashCommandHelp exposes current slash-command metadata", () => {
  const helpText = formatSlashCommandHelp();

  assert.match(helpText, /\/help/);
  assert.match(helpText, /\/work/);
  assert.match(helpText, /\/mode status/);
  assert.match(helpText, /\/mode set <mode>/);
  assert.match(helpText, /\/doctor/);
  assert.match(helpText, /\/sessions/);
  assert.match(helpText, /\/research status/);
  assert.match(helpText, /\/mcp list/);
});
