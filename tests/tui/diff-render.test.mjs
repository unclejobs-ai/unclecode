import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDiffRows,
  formatDiffRow,
  formatDiffSummary,
  parseUnifiedDiff,
  resolveDiffGutterWidth,
  summarizeDiff,
} from "../../packages/tui/src/diff-render.ts";

const PATCH = [
  "diff --git a/src/theme.ts b/src/theme.ts",
  "index 1111111..2222222 100644",
  "--- a/src/theme.ts",
  "+++ b/src/theme.ts",
  "@@ -8,7 +8,9 @@",
  "   resetProbedTerminalBackground,",
  ' } from "./terminal-theme.ts";',
  "",
  "+// Restores env and the probe cache after `run` finishes.",
  "+// A plain try/finally would restore too early.",
  " function withEnv(overrides, run) {",
  "   const saved = new Map();",
  "-  try {",
  "-    return run();",
  "-  } finally {",
  "+  const restore = () => {",
  "   }",
].join("\n");

test("parseUnifiedDiff skips file metadata and reads hunk headers", () => {
  const hunks = parseUnifiedDiff(PATCH);
  assert.ok(hunks);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].oldStart, 8);
  assert.equal(hunks[0].newStart, 8);
});

test("parseUnifiedDiff rejects text that is not a patch", () => {
  assert.equal(parseUnifiedDiff("const a = 1;\nconst b = 2;"), null);
  assert.equal(parseUnifiedDiff(""), null);
});

test("summarizeDiff counts added and removed lines", () => {
  const hunks = parseUnifiedDiff(PATCH);
  assert.deepEqual(summarizeDiff(hunks), { added: 3, removed: 3 });
  assert.equal(formatDiffSummary({ added: 3, removed: 3 }), "Added 3 lines, removed 3 lines");
  assert.equal(formatDiffSummary({ added: 1, removed: 1 }), "Added 1 line, removed 1 line");
});

test("buildDiffRows numbers the post-image and leaves removals unnumbered", () => {
  const rows = buildDiffRows(parseUnifiedDiff(PATCH));
  const added = rows.filter((row) => row.kind === "added");
  const removed = rows.filter((row) => row.kind === "removed");

  assert.equal(added.length, 3);
  assert.equal(removed.length, 3);
  // Removed lines do not exist in the new file, so they carry no line number.
  assert.deepEqual([...new Set(removed.map((row) => row.lineNumber))], [undefined]);
  // Numbering advances only over lines present after the change.
  assert.deepEqual(
    rows.filter((row) => row.lineNumber !== undefined).map((row) => row.lineNumber),
    [8, 9, 10, 11, 12, 13, 14, 15, 16],
  );
});

test("buildDiffRows elides context far from any change", () => {
  const lines = [
    "@@ -1,40 +1,40 @@",
    ...Array.from({ length: 20 }, (_, i) => ` context ${i}`),
    "-old line",
    "+new line",
    ...Array.from({ length: 20 }, (_, i) => ` tail ${i}`),
  ].join("\n");

  const rows = buildDiffRows(parseUnifiedDiff(lines), { contextLines: 2 });
  const elisions = rows.filter((row) => row.kind === "elision");
  assert.ok(elisions.length >= 2, "expected leading and trailing elisions");
  // 2 context either side + the two changed lines.
  assert.equal(rows.filter((row) => row.kind === "context").length, 4);
});

test("buildDiffRows caps total height and says how much it hid", () => {
  const lines = [
    "@@ -1,200 +1,200 @@",
    ...Array.from({ length: 200 }, (_, i) => `+added ${i}`),
  ].join("\n");

  const rows = buildDiffRows(parseUnifiedDiff(lines), { maxRows: 10 });
  assert.equal(rows.length, 10);
  assert.equal(rows.at(-1).kind, "elision");
  assert.match(rows.at(-1).text, /\+\d+ more lines/);
});

test("formatDiffRow aligns the gutter and marker into straight columns", () => {
  const rows = buildDiffRows(parseUnifiedDiff(PATCH));
  const gutterWidth = resolveDiffGutterWidth(rows);

  // The marker sits at a fixed offset, so read that column directly. Scanning
  // for the first "+"/"-" in the line would find one inside the content —
  // `terminal-theme.ts` has a hyphen at column 23.
  const markerColumn = gutterWidth + 1;
  for (const row of rows) {
    const rendered = formatDiffRow(row, { gutterWidth, width: 80 });
    const expected = row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " ";
    if (row.kind === "elision") continue;
    assert.equal(
      rendered[markerColumn],
      expected,
      `${row.kind} row put "${rendered[markerColumn]}" in the marker column: ${JSON.stringify(rendered)}`,
    );
  }

  const added = rows
    .map((row) => formatDiffRow(row, { gutterWidth, width: 80 }))
    .find((line) => line.includes("Restores env"));
  assert.match(added, /^\s*\d+ \+ /);
});

test("formatDiffRow truncates to the available width", () => {
  const row = { kind: "added", lineNumber: 7, text: "x".repeat(200) };
  assert.equal(formatDiffRow(row, { gutterWidth: 2, width: 40 }).length <= 40, true);
});

test("blank lines survive inside a fenced block and keep diff numbering honest", async () => {
  const { renderMarkdown } = await import("../../packages/tui/src/markdown-render.tsx");
  const { default: React } = await import("react");
  const { Box } = await import("ink");
  const { renderDebugFrame, waitForSettledFrame } = await import("./work-shell-render-harness.mjs");
  const { stripVTControlCharacters } = await import("node:util");

  const theme = {
    heading: "cyan", headingL2: "cyan", headingL3: "gray", bold: "white",
    inlineCode: "blue", inlineCodeBg: "black", codeBlock: "white", bullet: "cyan",
    quote: "gray", tableHeader: "cyan", tableBorder: "gray", link: "blue",
    text: "whiteBright", textMuted: "white", diffAdded: "green", diffRemoved: "red",
  };

  const markdown = [
    "```diff",
    "@@ -8,7 +8,9 @@",
    " keep one",
    " keep two",
    "",
    "+added after a blank context line",
    " keep three",
    "```",
  ].join("\n");

  const { instance, getOutput } = renderDebugFrame(
    React.createElement(
      Box,
      { flexDirection: "column" },
      renderMarkdown({ text: markdown, width: 80, theme }),
    ),
    { columns: 80, rows: 20 },
  );
  await waitForSettledFrame(getOutput);
  const frame = stripVTControlCharacters(getOutput());
  instance.unmount();
  instance.cleanup();

  // The blank line is context line 10, so the addition must be numbered 11.
  assert.match(frame, /11 \+ added after a blank context line/);
});
