import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createToolRuntime, resolveModeExecutionPolicyProfile } from "@unclecode/orchestrator";

function runtime({ shell = false } = {}) {
  return createToolRuntime({
    policyProfile: resolveModeExecutionPolicyProfile({
      mode: "default",
      envShellOptIn: shell,
    }),
    runtimeMode: "local",
  });
}

test("run_shell executes a simple command once execution policy grants shell", async () => {
  const result = await runtime({ shell: true }).executor.execute({
    toolName: "run_shell",
    input: { command: "pwd" },
    cwd: process.cwd(),
  });

  assert.equal(result.isError ?? false, false);
  assert.match(result.content, /unclecode/);
});

test("run_shell aborts long-running Rust shell tools promptly", async () => {
  const abortController = new AbortController();
  const command = process.platform === "win32" ? "Start-Sleep -Seconds 10" : "sleep 10";
  const startedAt = Date.now();

  const pending = runtime({ shell: true }).executor.execute({
    toolName: "run_shell",
    input: { command },
    cwd: process.cwd(),
    signal: abortController.signal,
  });
  setTimeout(() => abortController.abort(), 50);

  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(Date.now() - startedAt < 3000, "abort should not wait for the shell command to finish");
});

test("run_shell fails closed by default without ever reading process.env at call time", async () => {
  const previous = process.env.UNCLECODE_ALLOW_RUN_SHELL;
  const gated = runtime();

  try {
    // Setting the env var after construction must not retroactively grant shell.
    process.env.UNCLECODE_ALLOW_RUN_SHELL = "1";

    const result = await gated.executor.execute({
      toolName: "run_shell",
      input: { command: "pwd" },
      cwd: process.cwd(),
    });

    assert.equal(result.isError, true);
    assert.match(result.content, /UNCLECODE_ALLOW_RUN_SHELL=1/);
    assert.doesNotMatch(result.content, /^\/.*unclecode/);
  } finally {
    if (previous === undefined) {
      delete process.env.UNCLECODE_ALLOW_RUN_SHELL;
    } else {
      process.env.UNCLECODE_ALLOW_RUN_SHELL = previous;
    }
  }
});

test("read_file rejects sibling path escape attempts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-tools-root-"));
  const sibling = `${root}-sibling`;

  try {
    writeFileSync(path.join(sibling), "secret", "utf8");

    await assert.rejects(
      () => runtime().executor.execute({
        toolName: "read_file",
        input: { path: "../" + path.basename(sibling) },
        cwd: root,
      }),
      /Path escapes working directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sibling, { force: true });
  }
});

test("read_file rejects symlink escape attempts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-tools-root-"));
  const outsideDir = mkdtempSync(path.join(tmpdir(), "unclecode-tools-outside-"));
  const outsideFile = path.join(outsideDir, "secret.txt");
  const linkPath = path.join(root, "linked-secret.txt");

  try {
    writeFileSync(outsideFile, "secret", "utf8");
    symlinkSync(outsideFile, linkPath);

    await assert.rejects(
      () => runtime().executor.execute({
        toolName: "read_file",
        input: { path: "linked-secret.txt" },
        cwd: root,
      }),
      /Path escapes working directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("search_text does not execute shell payloads embedded in the query", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-tools-search-"));

  try {
    writeFileSync(path.join(root, "note.txt"), "hello world", "utf8");

    const result = await runtime().executor.execute({
      toolName: "search_text",
      input: { query: '$(printf injected >&2)', path: '.' },
      cwd: root,
    });

    assert.doesNotMatch(result.content, /injected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unregistered tool names fail closed instead of reaching a handler", async () => {
  const result = await runtime().executor.execute({
    toolName: "definitely_not_a_tool",
    input: {},
    cwd: process.cwd(),
  });

  assert.equal(result.isError, true);
  assert.match(result.content, /not a registered tool/);
});
