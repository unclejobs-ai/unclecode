import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { toolHandlers } from "../../src/tools.ts";

test("run_shell executes a simple command on the current platform", async () => {
  const original = process.env.UNCLECODE_ALLOW_RUN_SHELL;
  process.env.UNCLECODE_ALLOW_RUN_SHELL = "1";

  try {
    const result = await toolHandlers.run_shell({ command: "pwd" }, process.cwd());

    assert.match(result.content, /unclecode/);
  } finally {
    if (original === undefined) {
      delete process.env.UNCLECODE_ALLOW_RUN_SHELL;
    } else {
      process.env.UNCLECODE_ALLOW_RUN_SHELL = original;
    }
  }
});

test("run_shell is blocked by default without explicit opt-in", async () => {
  const original = process.env.UNCLECODE_ALLOW_RUN_SHELL;

  try {
    delete process.env.UNCLECODE_ALLOW_RUN_SHELL;
    await assert.rejects(
      () => toolHandlers.run_shell({ command: "pwd" }, process.cwd()),
      /UNCLECODE_ALLOW_RUN_SHELL=1/,
    );
  } finally {
    if (original === undefined) {
      delete process.env.UNCLECODE_ALLOW_RUN_SHELL;
    } else {
      process.env.UNCLECODE_ALLOW_RUN_SHELL = original;
    }
  }
});

test("read_file rejects sibling path escape attempts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-tools-root-"));
  const sibling = `${root}-sibling`;

  try {
    writeFileSync(path.join(sibling), "secret", "utf8");

    await assert.rejects(
      () => toolHandlers.read_file({ path: "../" + path.basename(sibling) }, root),
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
      () => toolHandlers.read_file({ path: "linked-secret.txt" }, root),
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

    const result = await toolHandlers.search_text(
      { query: '$(printf injected >&2)', path: '.' },
      root,
    );

    assert.doesNotMatch(result.content, /injected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
