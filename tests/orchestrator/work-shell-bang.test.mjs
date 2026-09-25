import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  parseWorkShellBangCommand,
  resolveWorkShellSubmitRoute,
  runWorkShellBangCommand,
} from "@unclecode/orchestrator";

test("a leading ! is a shell command; a bare ! and plain prose are not", () => {
  assert.equal(parseWorkShellBangCommand("  ! git status  "), "git status");
  assert.equal(parseWorkShellBangCommand("!"), undefined);
  assert.equal(parseWorkShellBangCommand("fix this!"), undefined);
});

test("the submit route sends ! lines to the shell only from the default composer", () => {
  const input = {
    value: "!echo hi",
    isBusy: false,
    resolveWorkShellSlashCommand: () => undefined,
    hasInlineCommandRunner: true,
  };
  assert.deepEqual(
    resolveWorkShellSubmitRoute({ ...input, composerMode: "default" }),
    { kind: "shell", line: "!echo hi", command: "echo hi" },
  );
  assert.notEqual(resolveWorkShellSubmitRoute({ ...input, composerMode: "agent-steer" })?.kind, "shell");
});

test("a failing command reports its output and exit status as an error", async () => {
  const result = await runWorkShellBangCommand({
    command: "echo broken >&2; exit 3",
    cwd: tmpdir(),
    signal: new AbortController().signal,
  });
  assert.equal(result.isError, true);
  assert.equal(result.output, "broken\nexit 3");
});
