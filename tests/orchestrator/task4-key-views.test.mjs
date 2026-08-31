import assert from "node:assert/strict";
import test from "node:test";

import { resolveWorkShellBuiltinCommand } from "@unclecode/orchestrator";

test("quality and policy slash commands reach read-only runtime views", () => {
  assert.deepEqual(resolveWorkShellBuiltinCommand("/todo"), {
    kind: "agent-console",
    tab: "plan",
  });
  assert.deepEqual(resolveWorkShellBuiltinCommand("/policy"), { kind: "policy" });
});
