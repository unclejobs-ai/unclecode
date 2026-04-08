import assert from "node:assert/strict";
import test from "node:test";

import { withWorkCwd } from "../../apps/unclecode-cli/src/program.ts";

test("withWorkCwd injects caller cwd when none is present", () => {
  assert.deepEqual(withWorkCwd(["--tools"], "/tmp/project-a"), ["--cwd", "/tmp/project-a", "--tools"]);
});

test("withWorkCwd preserves explicit cwd when already provided", () => {
  assert.deepEqual(withWorkCwd(["--cwd", "/tmp/other", "--tools"], "/tmp/project-a"), ["--cwd", "/tmp/other", "--tools"]);
});
