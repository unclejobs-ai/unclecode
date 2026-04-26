import assert from "node:assert/strict";
import test from "node:test";
import {
  getWorkShellSlashSuggestions,
  resolveWorkShellSlashCommand,
} from "../../packages/orchestrator/src/work-shell-slash.ts";

test("work-shell slash routes mmbridge operational commands", () => {
  assert.deepEqual(resolveWorkShellSlashCommand("/mmbridge context"), ["mmbridge", "context"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/mmbridge review"), ["mmbridge", "review"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/mmbridge gate"), ["mmbridge", "gate"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/mmbridge handoff"), ["mmbridge", "handoff"]);
  assert.deepEqual(resolveWorkShellSlashCommand("/mmbridge doctor"), ["mmbridge", "doctor"]);
});

test("work-shell slash suggestions include mmbridge command surfaces", () => {
  const suggestions = getWorkShellSlashSuggestions("/mmbridge").map((item) => item.command);
  assert.ok(suggestions.includes("/mmbridge context"));
  assert.ok(suggestions.includes("/mmbridge review"));
  assert.ok(suggestions.includes("/mmbridge gate"));
  assert.ok(suggestions.includes("/mmbridge handoff"));
  assert.ok(suggestions.includes("/mmbridge doctor"));
});
