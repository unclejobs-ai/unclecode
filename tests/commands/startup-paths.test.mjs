import assert from "node:assert/strict";
import test from "node:test";

import { shouldLaunchDefaultWorkSession } from "../../apps/unclecode-cli/src/startup-paths.ts";

test("shouldLaunchDefaultWorkSession stays a tiny pure startup predicate", () => {
  assert.equal(
    shouldLaunchDefaultWorkSession({
      args: [],
      stdinIsTTY: true,
      stdoutIsTTY: true,
    }),
    true,
  );
  assert.equal(
    shouldLaunchDefaultWorkSession({
      args: ["auth", "status"],
      stdinIsTTY: true,
      stdoutIsTTY: true,
    }),
    false,
  );
});
