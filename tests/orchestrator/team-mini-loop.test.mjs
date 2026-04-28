import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createTeamMiniLoopExecutor,
  miniLoopMessagesToProviderQuery,
  runShell,
} from "@unclecode/orchestrator";

test("runShell captures stdout and exit code for a successful command", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "unclecode-runshell-"));
  try {
    const result = await runShell({ command: "echo hi", cwd: dir });
    assert.equal(result.stdout.trim(), "hi");
    assert.equal(result.stderr, "");
    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runShell preserves stderr and non-zero exit for failing commands", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "unclecode-runshell-"));
  try {
    const result = await runShell({
      command: "echo oops 1>&2; exit 7",
      cwd: dir,
    });
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /oops/);
    assert.equal(result.exitCode, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runShell rejects empty command without spawning", async () => {
  const result = await runShell({ command: "   ", cwd: process.cwd() });
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /empty command/);
});

test("runShell honors cwd for the spawned shell", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "unclecode-runshell-"));
  try {
    const result = await runShell({ command: "pwd", cwd: dir });
    assert.equal(result.exitCode, 0);
    // macOS resolves /tmp via /private/tmp; compare basenames.
    assert.equal(path.basename(result.stdout.trim()), path.basename(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runShell kills runaway commands at the configured timeout", async () => {
  const result = await runShell({
    command: "sleep 5",
    cwd: process.cwd(),
    timeoutMs: 80,
  });
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /timed out/);
});

test("createTeamMiniLoopExecutor dispatches run_shell actions", async () => {
  const executor = createTeamMiniLoopExecutor();
  const observation = await executor.execute(
    { tool: "run_shell", input: { command: "echo ready" } },
    process.cwd(),
  );
  assert.equal(observation.exitCode, 0);
  assert.match(observation.stdout, /ready/);
  assert.equal(observation.truncated, false);
});

test("createTeamMiniLoopExecutor rejects unknown tools without throwing", async () => {
  const executor = createTeamMiniLoopExecutor();
  const observation = await executor.execute(
    { tool: "not_a_real_tool", input: {} },
    process.cwd(),
  );
  assert.equal(observation.exitCode, -1);
  assert.match(observation.stderr, /Unknown tool: not_a_real_tool/);
});

test("miniLoopMessagesToProviderQuery passes plain user/system messages through", () => {
  const wire = miniLoopMessagesToProviderQuery([
    { role: "system", content: "you are a worker" },
    { role: "user", content: "do the thing" },
  ]);
  assert.deepEqual(wire, [
    { role: "system", content: "you are a worker" },
    { role: "user", content: "do the thing" },
  ]);
});

test("miniLoopMessagesToProviderQuery pairs assistant + tool messages with synthetic callIds", () => {
  const wire = miniLoopMessagesToProviderQuery([
    { role: "system", content: "go" },
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: "running",
      stepIndex: 1,
    },
    {
      role: "tool",
      content: "ok\n",
      stepIndex: 1,
      action: { tool: "run_shell", input: { command: "echo ok" } },
      observation: { stdout: "ok\n", stderr: "", exitCode: 0, truncated: false },
    },
  ]);

  assert.equal(wire.length, 4);
  assert.equal(wire[2].role, "assistant");
  assert.equal(wire[2].toolCalls?.length, 1);
  const callId = wire[2].toolCalls?.[0]?.callId;
  assert.equal(callId, "step_1_0");
  assert.equal(wire[2].toolCalls?.[0]?.name, "run_shell");
  assert.equal(wire[2].toolCalls?.[0]?.argumentsJson, '{"command":"echo ok"}');
  assert.equal(wire[3].role, "tool");
  assert.equal(wire[3].callId, "step_1_0");
  assert.equal(wire[3].content, "ok\n");
});

test("miniLoopMessagesToProviderQuery groups multi-tool steps under one assistant message", () => {
  const wire = miniLoopMessagesToProviderQuery([
    { role: "user", content: "do two things" },
    { role: "assistant", content: "two", stepIndex: 1 },
    {
      role: "tool",
      content: "first",
      stepIndex: 1,
      action: { tool: "run_shell", input: { command: "echo a" } },
      observation: { stdout: "first", stderr: "", exitCode: 0, truncated: false },
    },
    {
      role: "tool",
      content: "second",
      stepIndex: 1,
      action: { tool: "run_shell", input: { command: "echo b" } },
      observation: { stdout: "second", stderr: "", exitCode: 0, truncated: false },
    },
  ]);

  const assistant = wire.find((m) => m.role === "assistant");
  assert.ok(assistant);
  assert.equal(assistant.toolCalls?.length, 2);
  assert.equal(assistant.toolCalls?.[0]?.callId, "step_1_0");
  assert.equal(assistant.toolCalls?.[1]?.callId, "step_1_1");
  const toolMsgs = wire.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 2);
  assert.equal(toolMsgs[0]?.callId, "step_1_0");
  assert.equal(toolMsgs[1]?.callId, "step_1_1");
});

test("miniLoopMessagesToProviderQuery drops exit-role sentinel messages", () => {
  const wire = miniLoopMessagesToProviderQuery([
    { role: "user", content: "go" },
    { role: "assistant", content: "done", stepIndex: 1 },
    { role: "exit", content: "submitted", stepIndex: 1 },
  ]);
  assert.equal(wire.length, 2);
  assert.equal(wire[1].role, "assistant");
});

test("miniLoopMessagesToProviderQuery emits assistant without tool_calls when no following tool message exists", () => {
  const wire = miniLoopMessagesToProviderQuery([
    { role: "user", content: "submit" },
    { role: "assistant", content: "all done", stepIndex: 1 },
  ]);
  assert.equal(wire.length, 2);
  assert.equal(wire[1].role, "assistant");
  assert.equal(wire[1].toolCalls, undefined);
});

test("createTeamMiniLoopExecutor reads files via the file-viewer ACI", async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const dir = mkdtempSync(path.join(tmpdir(), "unclecode-exec-read-"));
  try {
    writeFileSync(path.join(dir, "hello.txt"), "alpha\nbravo\ncharlie\n", "utf8");
    const executor = createTeamMiniLoopExecutor();
    const observation = await executor.execute(
      { tool: "read_file", input: { path: "hello.txt" } },
      dir,
    );
    assert.equal(observation.exitCode, 0);
    assert.match(observation.stdout, /alpha/);
    assert.match(observation.stdout, /bravo/);
    assert.match(observation.stdout, /\[Total\] 4 lines/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createTeamMiniLoopExecutor reports missing path for read_file without throwing", async () => {
  const executor = createTeamMiniLoopExecutor();
  const observation = await executor.execute(
    { tool: "read_file", input: {} },
    process.cwd(),
  );
  assert.equal(observation.exitCode, -1);
  assert.match(observation.stderr, /missing path/);
});

test("createTeamMiniLoopExecutor writes files inside the workspace", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const dir = mkdtempSync(path.join(tmpdir(), "unclecode-exec-write-"));
  try {
    const executor = createTeamMiniLoopExecutor();
    const observation = await executor.execute(
      {
        tool: "write_file",
        input: { path: "out/note.txt", contents: "hello world\n" },
      },
      dir,
    );
    assert.equal(observation.exitCode, 0);
    assert.match(observation.stdout, /wrote 12 bytes/);
    const written = readFileSync(path.join(dir, "out", "note.txt"), "utf8");
    assert.equal(written, "hello world\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createTeamMiniLoopExecutor refuses workspace-escape writes", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const dir = mkdtempSync(path.join(tmpdir(), "unclecode-exec-escape-"));
  try {
    const executor = createTeamMiniLoopExecutor();
    const observation = await executor.execute(
      { tool: "write_file", input: { path: "../escape.txt", contents: "no" } },
      dir,
    );
    assert.equal(observation.exitCode, -1);
    assert.match(observation.stderr, /traversal segment|escapes workspace/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createTeamMiniLoopExecutor returns ripgrep hits for search_text", async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const dir = mkdtempSync(path.join(tmpdir(), "unclecode-exec-search-"));
  try {
    writeFileSync(path.join(dir, "a.ts"), "const NEEDLE = 1;\n", "utf8");
    writeFileSync(path.join(dir, "b.ts"), "const other = 2;\n", "utf8");
    const executor = createTeamMiniLoopExecutor();
    const observation = await executor.execute(
      { tool: "search_text", input: { query: "NEEDLE" } },
      dir,
    );
    assert.equal(observation.exitCode, 0);
    assert.match(observation.stdout, /a\.ts:1:.*NEEDLE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createTeamMiniLoopExecutor lists files matching a glob", async () => {
  const { writeFileSync, mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const dir = mkdtempSync(path.join(tmpdir(), "unclecode-exec-glob-"));
  try {
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "one.ts"), "x", "utf8");
    writeFileSync(path.join(dir, "src", "two.ts"), "x", "utf8");
    writeFileSync(path.join(dir, "README.md"), "x", "utf8");
    const executor = createTeamMiniLoopExecutor();
    const observation = await executor.execute(
      { tool: "list_files", input: { pattern: "**/*.ts" } },
      dir,
    );
    assert.equal(observation.exitCode, 0);
    const lines = observation.stdout.split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.ok(line.endsWith(".ts"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createTeamMiniLoopExecutor applies a unified diff via apply_patch", async () => {
  const { writeFileSync, readFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const dir = mkdtempSync(path.join(tmpdir(), "unclecode-exec-patch-"));
  try {
    writeFileSync(path.join(dir, "src.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const patch = [
      "--- a/src.txt",
      "+++ b/src.txt",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "",
    ].join("\n");
    const executor = createTeamMiniLoopExecutor();
    const observation = await executor.execute(
      { tool: "apply_patch", input: { patch } },
      dir,
    );
    assert.equal(observation.exitCode, 0);
    assert.match(observation.stdout, /src\.txt \(1 hunks\)/);
    const updated = readFileSync(path.join(dir, "src.txt"), "utf8");
    assert.equal(updated, "alpha\nBETA\ngamma\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
