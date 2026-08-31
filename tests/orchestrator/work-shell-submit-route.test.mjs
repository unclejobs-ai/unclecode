import assert from "node:assert/strict";
import test from "node:test";

import { resolveWorkShellSubmitRoute } from "../../packages/orchestrator/src/work-shell-engine-submit.ts";

const route = (value) => resolveWorkShellSubmitRoute({
  value,
  isBusy: false,
  composerMode: "chat",
  resolveWorkShellSlashCommand: () => undefined,
  hasInlineCommandRunner: true,
});

test("an invalid multiline slash prompt never suggests its own first token", () => {
  const resolved = route("/context\n/research status\n/exit");

  assert.equal(resolved?.kind, "builtin");
  assert.deepEqual(resolved?.command, {
    kind: "unknown-slash",
    line: "/context /research status /exit",
  });
});

test("an exact context command remains a Rust-resolved builtin", () => {
  const resolved = route("/context");

  assert.equal(resolved?.kind, "builtin");
  assert.equal(resolved?.command.kind, "context");
});
