import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("createTeamMiniLoopExecutor emits policy.denied and blocks denied run_shell actions", async () => {
  const traces = [];
  const executor = createTeamMiniLoopExecutor({
    runtimeMode: "openshell",
    evaluatePolicy(request) {
      assert.equal(request.capability, "shell.run");
      assert.equal(request.tool, "run_shell");
      assert.equal(request.runtimeMode, "openshell");
      assert.equal(request.command, "echo denied");
      return {
        capability: "shell.run",
        effect: "deny",
        source: "runtime",
        reason: "OpenShell runtime requires an explicit shell policy.",
        matchedRule: "workspace.shell.run.openshell.default-deny",
        auditOnly: false,
      };
    },
    onPolicyDenied(event) {
      traces.push(event);
    },
  });

  const observation = await executor.execute(
    { tool: "run_shell", input: { command: "echo denied" } },
    process.cwd(),
  );

  assert.equal(observation.exitCode, -1);
  assert.match(observation.stderr, /policy denied shell\.run/);
  assert.equal(traces.length, 1);
  assert.deepEqual(
    {
      type: traces[0].type,
      capability: traces[0].capability,
      source: traces[0].source,
      matchedRule: traces[0].matchedRule,
      runtimeMode: traces[0].runtimeMode,
      toolName: traces[0].toolName,
    },
    {
      type: "policy.denied",
      capability: "shell.run",
      source: "runtime",
      matchedRule: "workspace.shell.run.openshell.default-deny",
      runtimeMode: "openshell",
      toolName: "run_shell",
    },
  );
  assert.equal(typeof traces[0].startedAt, "number");
});

test("createTeamMiniLoopExecutor installs default non-local deny policy", async () => {
  const traces = [];
  const executor = createTeamMiniLoopExecutor({
    runtimeMode: "openshell",
    onPolicyDenied(event) {
      traces.push(event);
    },
  });

  const observation = await executor.execute(
    { tool: "run_shell", input: { command: "echo should-not-run" } },
    process.cwd(),
  );

  assert.equal(observation.exitCode, -1);
  assert.match(observation.stderr, /policy denied shell\.run/);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].effect, "deny");
  assert.equal(traces[0].matchedRule, "team.openshell.default-deny.shell.run.default");
});

test("createTeamMiniLoopExecutor blocks non-local filesystem read tools by default", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "unclecode-exec-read-policy-"));
  const traces = [];
  try {
    writeFileSync(path.join(dir, "secret.txt"), "do not read", "utf8");
    const executor = createTeamMiniLoopExecutor({
      runtimeMode: "openshell",
      onPolicyDenied(event) {
        traces.push(event);
      },
    });

    const readObservation = await executor.execute(
      { tool: "read_file", input: { path: "secret.txt" } },
      dir,
    );
    const searchObservation = await executor.execute(
      { tool: "search_text", input: { query: "secret", path: "." } },
      dir,
    );
    const listObservation = await executor.execute(
      { tool: "list_files", input: { pattern: "**/*" } },
      dir,
    );

    assert.equal(readObservation.exitCode, -1);
    assert.equal(searchObservation.exitCode, -1);
    assert.equal(listObservation.exitCode, -1);
    assert.match(readObservation.stderr, /policy denied filesystem\.read/);
    assert.equal(traces.length, 3);
    assert.deepEqual(traces.map((event) => event.toolName), ["read_file", "search_text", "list_files"]);
    assert.equal(traces.every((event) => event.effect === "deny"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("createTeamMiniLoopExecutor emits policy.denied and blocks denied write_file actions", async () => {
  const { existsSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const dir = mkdtempSync(path.join(tmpdir(), "unclecode-exec-write-policy-"));
  const traces = [];
  try {
    const executor = createTeamMiniLoopExecutor({
      runtimeMode: "openshell",
      evaluatePolicy(request) {
        assert.equal(request.capability, "filesystem.write");
        assert.equal(request.tool, "write_file");
        assert.equal(request.runtimeMode, "openshell");
        assert.equal(request.path, "out/blocked.txt");
        return {
          capability: "filesystem.write",
          effect: "deny",
          source: "runtime",
          reason: "OpenShell runtime requires an explicit filesystem write policy.",
          matchedRule: "workspace.filesystem.write.openshell.default-deny",
          auditOnly: false,
        };
      },
      onPolicyDenied(event) {
        traces.push(event);
      },
    });

    const observation = await executor.execute(
      {
        tool: "write_file",
        input: { path: "out/blocked.txt", contents: "no write\n" },
      },
      dir,
    );

    assert.equal(observation.exitCode, -1);
    assert.match(observation.stderr, /policy denied filesystem\.write/);
    assert.equal(existsSync(path.join(dir, "out", "blocked.txt")), false);
    assert.equal(traces.length, 1);
    assert.deepEqual(
      {
        type: traces[0].type,
        capability: traces[0].capability,
        source: traces[0].source,
        matchedRule: traces[0].matchedRule,
        runtimeMode: traces[0].runtimeMode,
        toolName: traces[0].toolName,
      },
      {
        type: "policy.denied",
        capability: "filesystem.write",
        source: "runtime",
        matchedRule: "workspace.filesystem.write.openshell.default-deny",
        runtimeMode: "openshell",
        toolName: "write_file",
      },
    );
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

test("createTeamMiniLoopExecutor emits policy.denied and blocks denied apply_patch actions", async () => {
  const { writeFileSync, readFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const dir = mkdtempSync(path.join(tmpdir(), "unclecode-exec-patch-policy-"));
  const traces = [];
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
    const executor = createTeamMiniLoopExecutor({
      runtimeMode: "openshell",
      evaluatePolicy(request) {
        assert.equal(request.capability, "filesystem.write");
        assert.equal(request.tool, "apply_patch");
        assert.equal(request.runtimeMode, "openshell");
        assert.equal(request.patchLength, patch.length);
        return {
          capability: "filesystem.write",
          effect: "deny",
          source: "runtime",
          reason: "OpenShell runtime requires an explicit patch policy.",
          matchedRule: "workspace.apply_patch.openshell.default-deny",
          auditOnly: false,
        };
      },
      onPolicyDenied(event) {
        traces.push(event);
      },
    });

    const observation = await executor.execute(
      { tool: "apply_patch", input: { patch } },
      dir,
    );

    assert.equal(observation.exitCode, -1);
    assert.match(observation.stderr, /policy denied filesystem\.write/);
    assert.equal(readFileSync(path.join(dir, "src.txt"), "utf8"), "alpha\nbeta\ngamma\n");
    assert.equal(traces.length, 1);
    assert.deepEqual(
      {
        type: traces[0].type,
        capability: traces[0].capability,
        source: traces[0].source,
        matchedRule: traces[0].matchedRule,
        runtimeMode: traces[0].runtimeMode,
        toolName: traces[0].toolName,
      },
      {
        type: "policy.denied",
        capability: "filesystem.write",
        source: "runtime",
        matchedRule: "workspace.apply_patch.openshell.default-deny",
        runtimeMode: "openshell",
        toolName: "apply_patch",
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SYMLINKS_REQUIRE_ELEVATION = process.platform === "win32";

test(
  "createTeamMiniLoopExecutor refuses writes to a workspace-internal symlink targeting outside",
  { skip: SYMLINKS_REQUIRE_ELEVATION },
  async () => {
    // Q27 / system-level regression for the allowMissing symlink-parent
    // escape patched in commit 5e9e66e. Unit tests on canonical() proved
    // the helper resolves the parent symlink; this test proves the
    // attack chain through the public dispatch surface is closed: a
    // model that places a symlink inside the workspace must NOT be able
    // to write outside via a not-yet-existing leaf under that symlink.
    const { mkdtempSync, rmSync, symlinkSync, existsSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = (await import("node:path")).default;
    // Canonicalise both root and target so macOS /var → /private/var
    // does not satisfy a partial-string assertion accidentally.
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "unclecode-exec-symlink-")));
    const target = realpathSync(mkdtempSync(path.join(tmpdir(), "unclecode-exec-symlink-target-")));
    symlinkSync(target, path.join(dir, "escape-link"));
    try {
      const executor = createTeamMiniLoopExecutor();
      const observation = await executor.execute(
        {
          tool: "write_file",
          input: { path: "escape-link/foo.txt", contents: "should-be-blocked" },
        },
        dir,
      );
      assert.equal(observation.exitCode, -1);
      assert.match(
        observation.stderr,
        /escapes workspace|PathContainmentError|escape-link/,
      );
      assert.equal(
        existsSync(path.join(target, "foo.txt")),
        false,
        "write must not have crossed the symlink to the outside target",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  },
);

test(
  "createTeamMiniLoopExecutor refuses writes to a deeper non-existent path under a symlink",
  { skip: SYMLINKS_REQUIRE_ELEVATION },
  async () => {
    // The closest-existing-ancestor walk in canonical() must follow the
    // symlink for any depth of missing leaf, not only the immediate
    // child. This case probes a deeper miss to lock the invariant in.
    const { mkdtempSync, rmSync, symlinkSync, existsSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = (await import("node:path")).default;
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "unclecode-exec-symlink-deep-")));
    const target = realpathSync(mkdtempSync(path.join(tmpdir(), "unclecode-exec-symlink-deep-target-")));
    symlinkSync(target, path.join(dir, "escape-link"));
    try {
      const executor = createTeamMiniLoopExecutor();
      const observation = await executor.execute(
        {
          tool: "write_file",
          input: { path: "escape-link/sub/deeper/foo.txt", contents: "should-be-blocked" },
        },
        dir,
      );
      assert.equal(observation.exitCode, -1);
      assert.equal(existsSync(path.join(target, "sub", "deeper", "foo.txt")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  },
);

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
