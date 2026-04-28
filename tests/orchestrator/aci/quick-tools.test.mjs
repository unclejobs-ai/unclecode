import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { todoWrite, todoRead, formatStats } from "@unclecode/orchestrator";

test("todoWrite then todoRead round-trips items", () => {
  const dir = mkdtempSync(join(tmpdir(), "uc-todo-"));
  try {
    const written = todoWrite({
      cwd: dir,
      sessionId: "s1",
      items: [
        { id: "1", content: "fix bug", status: "in_progress" },
        { id: "2", content: "add test", status: "pending" },
      ],
    });
    assert.equal(written.items.length, 2);
    const read = todoRead({ cwd: dir, sessionId: "s1" });
    assert.equal(read.items.length, 2);
    assert.equal(read.items[0].content, "fix bug");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("todoRead returns undefined when no file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "uc-todo-"));
  try {
    const read = todoRead({ cwd: dir, sessionId: "missing" });
    assert.equal(read, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatStats renders a stable multiline summary", () => {
  const text = formatStats({
    sessionId: "s1",
    steps: 12,
    toolCalls: 7,
    costUsd: 0.456,
    durationMs: 12345,
    lastTool: "write_file",
  });
  assert.match(text, /Session: s1/);
  assert.match(text, /Steps:\s+12/);
  assert.match(text, /\$0\.456/);
  assert.match(text, /12\.3s/);
  assert.match(text, /last: write_file/);
});
