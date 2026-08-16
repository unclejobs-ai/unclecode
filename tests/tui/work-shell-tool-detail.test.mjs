import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import React from "react";

import { renderDebugFrame, waitForSettledFrame } from "./work-shell-render-harness.mjs";

// Force light terminal background for the render smoke below — authored
// against the light palette like the other work-shell render tests.
process.env.UNCLECODE_TERMINAL_BACKGROUND = "light";

import { formatWorkShellToolDetailEntry } from "../../packages/orchestrator/src/work-shell-engine-trace.ts";
import {
  countUnifiedDiffLines,
  deriveToolOutputMetric,
} from "../../packages/orchestrator/src/work-shell-agent-console.ts";
import {
  shouldShowWorkShellConversationEntry,
  splitWorkShellToolEntry,
  WorkShellView,
} from "../../packages/tui/src/work-shell-view.tsx";

const READ_EVENT = {
  type: "tool.completed",
  toolName: "read_file",
  toolCallId: "call-read",
  input: { path: "src/index.ts" },
  isError: false,
  output: "export function main() {\n  return 42;\n}\n",
  startedAt: 1,
  completedAt: 13,
  durationMs: 12,
};

const BASH_EVENT = {
  type: "tool.completed",
  toolName: "run_shell",
  toolCallId: "call-bash",
  input: { command: "cargo test -p unclecode-core" },
  isError: false,
  output: "running 420 tests\ntest ok ... ok\n\ntest result: ok. 420 passed",
  startedAt: 1,
  completedAt: 1201,
  durationMs: 1200,
};

const ERROR_EVENT = {
  type: "tool.completed",
  toolName: "run_shell",
  toolCallId: "call-err",
  input: { command: "npm test" },
  isError: true,
  output: "Error: ENOENT no such file or directory\n    at run (node:1)\n",
  startedAt: 1,
  completedAt: 9,
  durationMs: 8,
};

const WRITE_DIFF_EVENT = {
  type: "tool.completed",
  toolName: "write_file",
  toolCallId: "call-write",
  // Display-safe input only: the provider layer strips patch arguments, so
  // diff stats must come from the output text alone.
  input: { path: "notes.txt", patch: "@@ -1 +1 @@\n-booby trapped\n+never counted\n" },
  isError: false,
  output: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,3 +1,4 @@\n keep\n-old\n+new\n+added\n",
  startedAt: 1,
  completedAt: 8,
  durationMs: 7,
};

function rows(text) {
  return text.split("\n");
}

test("formatWorkShellToolDetailEntry assembles a read call: verb row, metric, excerpt", () => {
  assert.deepEqual(rows(formatWorkShellToolDetailEntry(READ_EVENT)), [
    "read src/index.ts",
    "3 lines · 12ms",
    "export function main() {",
    "  return 42;",
    "}",
  ]);
});

test("formatWorkShellToolDetailEntry assembles a bash call from the command argument", () => {
  const text = formatWorkShellToolDetailEntry(BASH_EVENT);
  assert.equal(rows(text)[0], "bash cargo test -p unclecode-core");
  assert.equal(rows(text)[1], "4 lines · 1200ms");
  assert.deepEqual(rows(text).slice(2), [
    "running 420 tests",
    "test ok ... ok",
    "",
    "test result: ok. 420 passed",
  ]);
});

test("formatWorkShellToolDetailEntry surfaces the first error line as its own metric row", () => {
  assert.deepEqual(rows(formatWorkShellToolDetailEntry(ERROR_EVENT)), [
    "bash npm test",
    "Error: ENOENT no such file or directory · 8ms",
    "Error: ENOENT no such file or directory",
    "    at run (node:1)",
  ]);
});

test("formatWorkShellToolDetailEntry derives +N −M stats from the output diff only", () => {
  const text = formatWorkShellToolDetailEntry(WRITE_DIFF_EVENT);
  const lines = rows(text);
  // 1 verb + 2 metric rows + 6 excerpt rows = 9 candidates → capped at 8 with
  // exactly one ellipsis row.
  assert.equal(lines[0], "write notes.txt");
  assert.equal(lines[1], "7 lines");
  assert.equal(lines[2], "+2 −1 · 7ms");
  assert.equal(lines.length, 8);
  assert.equal(lines[7], "… +2 more lines");
  assert.equal(lines.filter((line) => line.startsWith("… +")).length, 1);
  // The patch living only in `input` never produces stats: the booby-trapped
  // hunk in WRITE_DIFF_EVENT.input.patch is absent from the output.
  assert.ok(!text.includes("booby trapped"));
  const noDiffStats = formatWorkShellToolDetailEntry({
    ...WRITE_DIFF_EVENT,
    output: "wrote notes.txt\n",
  });
  assert.ok(!rows(noDiffStats).some((line) => /^\+\d+ −\d+/.test(line)));
});

test("formatWorkShellToolDetailEntry maps verbs and picks the key argument by path > command > query", () => {
  assert.equal(
    formatWorkShellToolDetailEntry({
      type: "tool.completed",
      toolName: "search_text",
      input: { query: "TODO" },
      output: "src/a.ts:1:1: TODO fix\n",
      durationMs: 3,
    }).split("\n")[0],
    "search TODO",
  );
  assert.equal(
    formatWorkShellToolDetailEntry({
      type: "tool.completed",
      toolName: "apply_patch",
      input: { path: "a.ts" },
      output: "patched\n",
      durationMs: 3,
    }).split("\n")[0],
    "patch a.ts",
  );
  assert.equal(
    formatWorkShellToolDetailEntry({
      type: "tool.completed",
      toolName: "read_file",
      input: { command: "cmd wins over query", query: "query loses" },
      output: "out\n",
      durationMs: 3,
    }).split("\n")[0],
    "read cmd wins over query",
  );
  assert.equal(
    formatWorkShellToolDetailEntry({
      type: "tool.completed",
      toolName: "read_file",
      input: { command: "cmd loses", query: "query loses", path: "path wins" },
      output: "out\n",
      durationMs: 3,
    }).split("\n")[0],
    "read path wins",
  );
  // Unknown tool names pass through; missing input collapses to the bare verb.
  assert.equal(
    formatWorkShellToolDetailEntry({
      type: "tool.completed",
      toolName: "mcp_foo",
      output: "done\n",
      durationMs: 3,
    }).split("\n")[0],
    "mcp_foo",
  );
  // A newline inside the command must not split the first row.
  assert.equal(
    formatWorkShellToolDetailEntry({
      type: "tool.completed",
      toolName: "run_shell",
      input: { command: "cargo test\n  --workspace" },
      output: "ok\n",
      durationMs: 3,
    }).split("\n")[0],
    "bash cargo test --workspace",
  );
});

test("formatWorkShellToolDetailEntry caps the entry at 8 rows with a single ellipsis", () => {
  const longOutput = Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n");
  const text = formatWorkShellToolDetailEntry({
    type: "tool.completed",
    toolName: "read_file",
    input: { path: "big.txt" },
    isError: false,
    output: longOutput,
    durationMs: 5,
  });
  const lines = rows(text);
  // 1 verb + 1 metric + 6 excerpt = exactly 8 rows, no ellipsis needed yet.
  assert.equal(lines.length, 8);
  assert.ok(!lines.some((line) => line.startsWith("… +")));

  // One extra metric row (diff stats) pushes past the cap: 7 rows + one
  // ellipsis row, still 8 total.
  const overflowing = formatWorkShellToolDetailEntry({
    type: "tool.completed",
    toolName: "read_file",
    input: { path: "big.txt" },
    isError: false,
    output: `@@ -1 +1 @@\n-a\n${Array.from({ length: 20 }, (_, index) => `+line-${index}`).join("\n")}\n`,
    durationMs: 5,
  });
  const overflowingLines = rows(overflowing);
  assert.equal(overflowingLines.length, 8);
  assert.equal(overflowingLines.at(-1), "… +2 more lines");
  assert.equal(overflowingLines.filter((line) => line.startsWith("… +")).length, 1);

  // Wide rows are truncated per-row with an ellipsis character, never spilled.
  const wide = formatWorkShellToolDetailEntry({
    type: "tool.completed",
    toolName: "run_shell",
    input: { command: "echo" },
    isError: false,
    output: `${"x".repeat(400)}\n`,
    durationMs: 5,
  });
  const wideLines = rows(wide);
  assert.ok(wideLines.every((line) => Array.from(line).length <= 120));
  assert.ok(wideLines[2].endsWith("…"));
});

test("assembled tool detail entries are glyph-less and survive the transcript kill filter", () => {
  for (const event of [READ_EVENT, BASH_EVENT, ERROR_EVENT, WRITE_DIFF_EVENT]) {
    const text = formatWorkShellToolDetailEntry(event);
    assert.ok(!text.includes("●"), `assembly must not carry the renderer call glyph: ${text}`);
    assert.ok(!text.includes("⎿"), `assembly must not carry the renderer result glyph: ${text}`);
    assert.equal(
      shouldShowWorkShellConversationEntry({ role: "tool", text }),
      true,
      `the first row must not match the kill filters: ${text}`,
    );
  }
  // Control: the old formatted one-liners the filter exists to hide.
  assert.equal(shouldShowWorkShellConversationEntry({ role: "tool", text: "→ read package.json" }), false);
  assert.equal(shouldShowWorkShellConversationEntry({ role: "tool", text: "✓ write notes.txt" }), false);
});

test("splitWorkShellToolEntry keeps the assembled entry inside the render cap without a second ellipsis", () => {
  const { call, resultLines } = splitWorkShellToolEntry(
    formatWorkShellToolDetailEntry(WRITE_DIFF_EVENT),
    100,
  );
  assert.equal(call, "write notes.txt");
  assert.equal(resultLines.length, 7);
  assert.equal(resultLines.filter((line) => line.startsWith("… +")).length, 1);
});

test("countUnifiedDiffLines counts only unified-diff hunks embedded in output", () => {
  assert.deepEqual(
    countUnifiedDiffLines("--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep\n-a\n+b\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1,2 @@\n-c\n+d\n+e\n"),
    { additions: 3, deletions: 2 },
  );
  assert.deepEqual(countUnifiedDiffLines("@@ -1 +1 @@\n-a\n+b\n"), { additions: 1, deletions: 1 });
  assert.equal(countUnifiedDiffLines("plain stdout with a + plus line\n- dash line\n"), undefined);
  assert.equal(countUnifiedDiffLines(""), undefined);
  assert.equal(countUnifiedDiffLines(undefined), undefined);
});

test("deriveToolOutputMetric keeps its exported shape", () => {
  assert.equal(deriveToolOutputMetric("one line\n"), "1 line");
  assert.equal(deriveToolOutputMetric("a\nb\nc"), "3 lines");
  assert.equal(deriveToolOutputMetric("(no matches)"), "no matches");
  assert.equal(deriveToolOutputMetric("   "), undefined);
});

test("a rendered frame shows the renderer-owned glyphs around the assembled rows", async () => {
  const text = formatWorkShellToolDetailEntry(READ_EVENT);
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.4",
      reasoningLabel: "medium (mode-default)",
      reasoningSupported: true,
      mode: "Work",
      authLabel: "env-key",
      entries: [
        { role: "user", text: "read it" },
        { role: "tool", text },
      ],
      isBusy: false,
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement("span", null, ""),
      inputValue: "",
      slashSuggestionCount: 0,
      terminalColumns: 100,
      cwd: "/Users/parkeungje/project/unclecode",
    }),
  );
  const output = await waitForSettledFrame(getOutput);
  instance.unmount();
  instance.cleanup();

  const frameStart = output.lastIndexOf("UncleCode ·");
  const frame = stripVTControlCharacters(frameStart >= 0 ? output.slice(frameStart) : output);
  assert.match(frame, /● read src\/index\.ts/u);
  assert.match(frame, /⎿ 3 lines · 12ms/u);
  assert.match(frame, /export function main\(\) \{/u);
  // The stored text is glyph-less; the glyphs above are renderer-owned, so
  // exactly one ● appears per tool entry in the frame.
  assert.equal(frame.split("●").length - 1, 1);
});
