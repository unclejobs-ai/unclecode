import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

import chalk from "chalk";
import React from "react";

import { renderDebugFrame, waitForSettledFrame } from "./work-shell-render-harness.mjs";

// Force light terminal background for the render smoke below — authored
// against the light palette like the other work-shell render tests.
process.env.UNCLECODE_TERMINAL_BACKGROUND = "light";
// Raise the shared chalk instance so Ink's Text color props emit real ANSI
// codes in the debug frame (the CI environment is not a TTY, so chalk would
// otherwise default to level 0 and strip every color assertion of meaning).
chalk.level = 3;

import {
  applyWorkShellTraceEvent,
  formatWorkShellToolDetailEntry,
} from "../../packages/orchestrator/src/work-shell-engine-trace.ts";
import { createInitialWorkShellEngineState } from "../../packages/orchestrator/src/work-shell-engine-state.ts";
import {
  countUnifiedDiffLines,
  deriveToolOutputMetric,
} from "../../packages/orchestrator/src/work-shell-agent-console.ts";
import {
  isWorkShellToolErrorEntry,
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
  const output = await renderWorkShellFrame([
    { role: "user", text: "read it" },
    { role: "tool", text },
  ]);

  const frameStart = output.lastIndexOf("UncleCode ·");
  const frame = stripVTControlCharacters(frameStart >= 0 ? output.slice(frameStart) : output);
  assert.match(frame, /● read src\/index\.ts/u);
  assert.match(frame, /⎿ 3 lines · 12ms/u);
  assert.match(frame, /export function main\(\) \{/u);
  // The stored text is glyph-less; the glyphs above are renderer-owned, so
  // exactly one ● appears per tool entry in the frame.
  assert.equal(frame.split("●").length - 1, 1);
  // Same ownership discipline for the result glyph: one call row, one ⎿ row.
  assert.equal(frame.split("⎿").length - 1, 1);
});

test("isWorkShellToolErrorEntry reads the failure off the glyph-less metric rows", () => {
  // Success assemblies: the first metric row always carries a success shape
  // (line metric, diff stats, bare duration), so the renderer keeps green.
  for (const event of [READ_EVENT, BASH_EVENT, WRITE_DIFF_EVENT]) {
    assert.equal(
      isWorkShellToolErrorEntry(formatWorkShellToolDetailEntry(event)),
      false,
      `success assembly misread as error: ${event.toolName}`,
    );
  }
  assert.equal(isWorkShellToolErrorEntry("bash echo\n8ms"), false, "duration-only metric is a success shape");
  assert.equal(isWorkShellToolErrorEntry("read a.ts"), false, "verb-only entry has no metric row to read");
  // Error assembly: the first metric row is the raw first error line.
  assert.equal(isWorkShellToolErrorEntry(formatWorkShellToolDetailEntry(ERROR_EVENT)), true);
  assert.equal(isWorkShellToolErrorEntry("bash npm test\ncustom failure text · 8ms"), true);
});

test("consecutive transcript blocks sit exactly one blank row apart with no trailing blank after the last", async () => {
  const text = formatWorkShellToolDetailEntry(READ_EVENT);
  const output = await renderWorkShellFrame([
    { role: "user", text: "read it" },
    { role: "assistant", text: "short reply one" },
    { role: "tool", text },
    { role: "assistant", text: "✻ settled thinking line" },
  ]);
  const frameStart = output.lastIndexOf("UncleCode ·");
  const frame = stripVTControlCharacters(frameStart >= 0 ? output.slice(frameStart) : output);
  const frameRows = frame.split("\n");

  const userRow = frameRows.findIndex((row) => row.includes("read it"));
  const badgeRow = frameRows.findIndex((row) => row.includes("◈ UncleCode"));
  const toolRow = frameRows.findIndex((row) => row.includes("● read src/index.ts"));
  const reasoningRow = frameRows.findIndex((row) => row.includes("✻ settled thinking"));
  const hintRow = frameRows.findIndex((row) => row.includes("Enter send"));
  assert.ok(userRow >= 0, "the user chip row must render");
  assert.ok(badgeRow >= 0, "the assistant badge row must render");
  assert.ok(toolRow >= 0, "the tool call row must render");
  assert.ok(reasoningRow >= 0, "the ✻ reasoning row must render");
  assert.ok(hintRow >= 0, "the composer hint row must render");

  // Block extents at the test width: the compact assistant reply is badge +
  // one body row; the READ_EVENT assembly renders one call row plus its four
  // result rows.
  const assistantLastRow = badgeRow + 1;
  assert.ok(frameRows[assistantLastRow].includes("short reply one"));
  const toolLastRow = toolRow + 4;
  assert.ok(frameRows[toolLastRow].includes("}"));

  // Between one entry's last rendered row and the next entry's first row
  // there is exactly one empty line — user turn, assistant reply, tool call,
  // reasoning summary all read as separate blocks.
  for (const [blockLastRow, nextBlockFirstRow] of [
    [userRow, badgeRow],
    [assistantLastRow, toolRow],
    [toolLastRow, reasoningRow],
  ]) {
    assert.equal(
      nextBlockFirstRow - blockLastRow,
      2,
      "consecutive entries must be separated by exactly one row",
    );
    assert.equal(frameRows[blockLastRow + 1].trim(), "", "the separating row must be empty");
  }

  // The last entry contributes no trailing blank: exactly one blank row (the
  // composer dock's own top margin) stands between it and the hint row.
  assert.equal(hintRow - reasoningRow, 2);
  assert.equal(frameRows[reasoningRow + 1].trim(), "");
});

test("two single-row entries render as two entry rows plus one separating blank row", async () => {
  const output = await renderWorkShellFrame([
    { role: "user", text: "first turn" },
    { role: "user", text: "second turn" },
  ]);
  const frameStart = output.lastIndexOf("UncleCode ·");
  const frame = stripVTControlCharacters(frameStart >= 0 ? output.slice(frameStart) : output);
  const frameRows = frame.split("\n");

  const firstRow = frameRows.findIndex((row) => row.includes("first turn"));
  const secondRow = frameRows.findIndex((row) => row.includes("second turn"));
  const hintRow = frameRows.findIndex((row) => row.includes("Enter send"));
  assert.ok(firstRow >= 0 && secondRow >= 0);

  // The frame shape the scroll weight budget is written against: 2 single-row
  // entries → 2 entry rows + exactly 1 blank row between them.
  assert.equal(secondRow - firstRow, 2);
  assert.equal(frameRows[firstRow + 1].trim(), "");

  // And nothing after the last entry beyond the dock's own single margin row.
  assert.equal(hintRow - secondRow, 2);
  assert.equal(frameRows[secondRow + 1].trim(), "");
});

test("the tool call glyph carries the outcome color: green success, red error", async () => {
  const successFrame = await renderWorkShellFrame([
    { role: "tool", text: formatWorkShellToolDetailEntry(READ_EVENT) },
  ]);
  assert.match(
    successFrame,
    /\u001b\[1m\u001b\[32m● /u,
    "the success ● must be bold green",
  );

  const errorFrame = await renderWorkShellFrame([
    { role: "tool", text: formatWorkShellToolDetailEntry(ERROR_EVENT) },
  ]);
  assert.match(
    errorFrame,
    /\u001b\[1m\u001b\[31m● /u,
    "the failed call's ● must flip to bold red",
  );
  // The error heuristic is renderer-owned: the stored entry text itself never
  // claims failure, only the first metric row's shape does.
  assert.ok(!formatWorkShellToolDetailEntry(ERROR_EVENT).includes("●"));
});

test("a rendered tool entry carries at most one overflow ellipsis row", async () => {
  // WRITE_DIFF_EVENT's assembly already folds overflow into one `… +N more
  // lines` row; the render cap must not stack a second one on top of it.
  const output = await renderWorkShellFrame([
    { role: "tool", text: formatWorkShellToolDetailEntry(WRITE_DIFF_EVENT) },
  ]);
  const frameStart = output.lastIndexOf("UncleCode ·");
  const frame = stripVTControlCharacters(frameStart >= 0 ? output.slice(frameStart) : output);
  const ellipsisRows = frame.split("\n").filter((line) => line.trim().startsWith("… +"));
  assert.equal(ellipsisRows.length, 1);

  // A body already carrying an overflow row inside the render cap's shown
  // prefix (a run_shell whose output embeds another run's ellipsis rows) must
  // fold into ONE ellipsis: the shown prefix drops the inner row, the appended
  // row counts everything left out — including it.
  const nestedOverflowBody = [
    "outer line 1",
    "outer line 2",
    "… +40 more lines",
    "outer line 4",
    "outer line 5",
    "outer line 6",
    "outer line 7",
    "outer line 8",
    "outer line 9",
    "outer line 10",
  ].join("\n");
  const merged = splitWorkShellToolEntry(`bash run nested\n${nestedOverflowBody}`, 100);
  // 7 surviving content rows + the one merged ellipsis row.
  assert.equal(merged.resultLines.length, 8);
  assert.equal(merged.resultLines.filter((line) => line.startsWith("… +")).length, 1);
  assert.equal(merged.resultLines.at(-1), "… +3 more lines");
  assert.ok(!merged.resultLines.slice(0, -1).some((line) => line.startsWith("… +")));
  // Narrow widths wrap the WRITE_DIFF_EVENT assembly past the render cap the
  // same way — still exactly one ellipsis row out of the splitter.
  const narrow = splitWorkShellToolEntry(
    formatWorkShellToolDetailEntry({
      ...BASH_EVENT,
      output: Array.from({ length: 8 }, (_, index) => `w${index} ${"x".repeat(40)}`).join("\n"),
    }),
    30,
  );
  assert.ok(narrow.resultLines.length > 8, "narrow wrapping must actually trip the render cap here");
  assert.equal(narrow.resultLines.filter((line) => line.startsWith("… +")).length, 1);
  assert.match(narrow.resultLines.at(-1), /^… \+\d+ more lines$/u);
});

test("a ✻ reasoning entry renders as a single dim block without markdown parsing", async () => {
  const reasoningText = "✻ thinking about *emphasis*, `inline code`, and # headings";
  const output = await renderWorkShellFrame([
    { role: "assistant", text: reasoningText },
  ]);
  const frameStart = output.lastIndexOf("UncleCode ·");
  const rawFrame = frameStart >= 0 ? output.slice(frameStart) : output;
  const frame = stripVTControlCharacters(rawFrame);

  // The frame keeps the ✻ line verbatim...
  assert.ok(frame.includes("✻ thinking about"));
  // ...with its markdown syntax intact — the markdown renderer would have
  // consumed the asterisks/backticks/hash, the dim branch must not.
  assert.ok(frame.includes("*emphasis*"), "markdown emphasis syntax must survive unstyled");
  assert.ok(frame.includes("`inline code`"), "inline code syntax must survive unstyled");
  assert.ok(frame.includes("# headings"), "heading syntax must survive unstyled");

  // Dim single tone: the whole ✻ row is one muted (gray) span, with no bold
  // or accent escapes inside it that markdown styling would have produced.
  const reasoningRow = rawFrame.split("\n").find((line) => line.includes("✻ thinking"));
  assert.match(reasoningRow, /\u001b\[90m[^\u001b]*\u001b\[39m/u);
  assert.ok(!/\u001b\[(1|32|36)m/u.test(reasoningRow), "the ✻ row must stay single-tone muted");
});

/**
 * Render the work shell with the given transcript entries and resolve the
 * settled frame. Returns the RAW frame (ANSI intact) — color assertions need
 * it; content assertions strip with stripVTControlCharacters.
 */
async function renderWorkShellFrame(entries) {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.4",
      reasoningLabel: "medium (mode-default)",
      reasoningSupported: true,
      mode: "Work",
      authLabel: "env-key",
      entries,
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
  return output;
}

/** Minimal engine state for driving applyWorkShellTraceEvent outside a live engine. */
function createTraceDriverState(overrides = {}) {
  return {
    ...createInitialWorkShellEngineState({
      options: {
        provider: "openai",
        model: "gpt-5.4",
        mode: "default",
        authLabel: "api-key-env",
        reasoning: {
          effort: "high",
          source: "mode-default",
          support: { status: "supported", defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"] },
        },
        cwd: "/repo",
        contextSummaryLines: [],
      },
      contextSummaryLines: [],
      buildContextPanel: () => ({ title: "Context", lines: [] }),
    }),
    ...overrides,
  };
}

test("the engine's flushed ✻ entry survives the kill filter and renders dim ahead of the answer", async () => {
  // Drive the real engine accumulation path: reasoning deltas, then the
  // first assistant delta that flushes the settled summary.
  let state = createTraceDriverState({ isBusy: true });
  const flushedEntries = [];
  const apply = (event) => {
    applyWorkShellTraceEvent({
      state,
      event,
      formatAgentTraceLine: (candidate) =>
        candidate.type === "reasoning.delta" ? `✦ thinking· ${candidate.delta ?? ""}` : "",
      setState: (patch) => {
        state = { ...state, ...patch };
      },
      appendEntries: (...next) => {
        flushedEntries.push(...next);
        state = { ...state, entries: [...state.entries, ...next] };
      },
      pushTraceLine() {},
    });
  };
  apply({ type: "reasoning.delta", kind: "text", delta: "weigh *options* before answering" });
  apply({ type: "assistant.delta", delta: "Answer." });

  assert.equal(flushedEntries.length, 1, "the flush appends exactly one entry");
  const reasoningEntry = flushedEntries[0];
  assert.equal(reasoningEntry.role, "assistant");
  assert.ok(reasoningEntry.text.startsWith("✻ "), "the engine owns the ✻ prefix the view renders dim");
  // ✻ sits outside the kill filter's glyph class, so the summary is shown.
  assert.equal(shouldShowWorkShellConversationEntry(reasoningEntry), true);

  const output = await renderWorkShellFrame([
    ...flushedEntries,
    { role: "assistant", text: "Answer." },
  ]);
  const frameStart = output.lastIndexOf("UncleCode ·");
  const rawFrame = frameStart >= 0 ? output.slice(frameStart) : output;
  const frame = stripVTControlCharacters(rawFrame);

  const reasoningRowIndex = frame.split("\n").findIndex((line) => line.includes("✻ weigh"));
  const answerRowIndex = frame.split("\n").findIndex((line) => line.includes("Answer."));
  assert.ok(reasoningRowIndex >= 0, "the flushed ✻ row must render");
  assert.ok(answerRowIndex > reasoningRowIndex, "the ✻ row lands above the answer row");
  // Markdown syntax survives unstyled — the dim branch, not the parser, owns it.
  assert.ok(frame.includes("*options*"));

  const reasoningRow = rawFrame.split("\n").find((line) => line.includes("✻ weigh"));
  assert.match(reasoningRow, /\u001b\[90m[^\u001b]*\u001b\[39m/u, "the ✻ row is muted");
  assert.ok(!/\u001b\[(1|32|36)m/u.test(reasoningRow), "the ✻ row stays single-tone dim");
});

test("the transcript kill filter's glyph class stays ✻-free", () => {
  const source = readFileSync(
    new URL("../../packages/tui/src/work-shell-view.tsx", import.meta.url),
    "utf8",
  );
  const glyphClass = source.match(/\[✓✖→·★↔↗📎\]/u)?.[0];
  assert.ok(glyphClass, "the kill filter glyph class must stay findable in the view source");
  assert.ok(
    !glyphClass.includes("✻"),
    "✻ belongs to the reasoning summary render branch, never to the kill filter",
  );
});
