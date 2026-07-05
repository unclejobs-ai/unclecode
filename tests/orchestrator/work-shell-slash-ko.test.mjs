import assert from "node:assert/strict";
import test from "node:test";

const {
  getWorkShellSlashSuggestions,
  listWorkShellSlashSuggestionEntries,
} = await import("../../packages/orchestrator/src/work-shell-slash.ts");

test("work shell slash registry exposes Korean /context description", () => {
  const context = listWorkShellSlashSuggestionEntries().find((entry) => entry.command === "/context");
  assert.ok(context, "expected /context in slash registry");
  assert.match(context.description, /컨텍스트|답변/);
});

test("work shell /mode suggestions use Korean profile copy", () => {
  const status = getWorkShellSlashSuggestions("/mode").find((entry) => entry.command === "/mode status");
  assert.ok(status, "expected /mode status suggestion");
  assert.match(status.description, /모드/);

  const parallel = getWorkShellSlashSuggestions("/mode").find((entry) => entry.command === "/mode set ultrawork");
  assert.ok(parallel, "expected /mode set ultrawork suggestion");
  assert.match(parallel.description, /병렬/);
});
