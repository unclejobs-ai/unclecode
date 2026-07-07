import assert from "node:assert/strict";
import test from "node:test";

import { resolveDefaultWorkRustEntrypoint } from "../../apps/unclecode-cli/src/rust-work-passthrough.ts";
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

test("default work Rust passthrough honors explicit binary without loading the app runtime", () => {
  const entrypoint = resolveDefaultWorkRustEntrypoint("/tmp/project-a", {
    UNCLECODE_RUST_BIN: "./target/debug/unclecode",
  });

  assert.equal(entrypoint.command, "/tmp/project-a/target/debug/unclecode");
  assert.deepEqual(entrypoint.argsPrefix, []);
});
