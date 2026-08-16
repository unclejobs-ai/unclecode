import assert from "node:assert/strict";
import test from "node:test";

import {
  getMarkdownRenderParseCountForTest,
  parseInlineForTest,
  renderMarkdown,
  resetMarkdownRenderCacheForTest,
} from "../../packages/tui/src/markdown-render.js";

const THEME = {
  heading: "#ff5f87",
  headingL2: "#ff5f87",
  headingL3: "#8a919f",
  bold: "#7aa2f7",
  inlineCode: "#7dcfff",
  inlineCodeBg: "#1a1b26",
  codeBlock: "#8a919f",
  bullet: "#7aa2f7",
  quote: "#8a919f",
  tableHeader: "#7aa2f7",
  tableBorder: "#3b4261",
  link: "#7dcfff",
  text: "#c0caf5",
  textMuted: "#8a919f",
};

test("renderMarkdown reparses nothing for repeated (text, width, theme) keys", () => {
  resetMarkdownRenderCacheForTest();
  const input = { text: "# Title\n\nbody **bold** `code`", width: 80, theme: THEME };
  const first = renderMarkdown(input);
  const before = getMarkdownRenderParseCountForTest();
  const second = renderMarkdown({ text: input.text, width: 80, theme: { ...THEME } });
  assert.equal(
    getMarkdownRenderParseCountForTest(),
    before,
    "identical text/width/theme (by value) must be served from the cache",
  );
  assert.equal(second, first, "cache returns the same rendered node");

  // A different width is a different layout: reparsed.
  renderMarkdown({ ...input, width: 60 });
  assert.equal(getMarkdownRenderParseCountForTest(), before + 1);
  // A different theme is a different palette: reparsed.
  renderMarkdown({ ...input, theme: { ...THEME, text: "#ffffff" } });
  assert.equal(getMarkdownRenderParseCountForTest(), before + 2);
});

test("renderMarkdown skips the cache for streaming text", () => {
  resetMarkdownRenderCacheForTest();
  const input = { text: "still growing reply", width: 80, theme: THEME };
  renderMarkdown({ ...input, isStreamingText: true });
  const before = getMarkdownRenderParseCountForTest();
  renderMarkdown({ ...input, isStreamingText: true });
  assert.equal(
    getMarkdownRenderParseCountForTest(),
    before + 1,
    "streaming text must reparse on every call (no cache applied)",
  );

  // The raw streaming-cursor suffix keeps the same exclusion for callers
  // that pass untrimmed text — the rule the view's Rust caches follow.
  renderMarkdown({ text: "growing▌", width: 80, theme: THEME });
  const rawBefore = getMarkdownRenderParseCountForTest();
  renderMarkdown({ text: "growing▌", width: 80, theme: THEME });
  assert.equal(getMarkdownRenderParseCountForTest(), rawBefore + 1);

  // Settled text lands in the cache right after streaming ends.
  renderMarkdown(input);
  const settledBefore = getMarkdownRenderParseCountForTest();
  renderMarkdown(input);
  assert.equal(getMarkdownRenderParseCountForTest(), settledBefore);
});

test("renderMarkdown cache evicts least-recently-used entries past 64 keys", () => {
  resetMarkdownRenderCacheForTest();
  const first = { text: "oldest entry", width: 80, theme: THEME };
  renderMarkdown(first);
  for (let i = 0; i < 64; i += 1) {
    renderMarkdown({ text: `entry ${i}`, width: 80 + i, theme: THEME });
  }
  const before = getMarkdownRenderParseCountForTest();
  renderMarkdown(first);
  assert.equal(
    getMarkdownRenderParseCountForTest(),
    before + 1,
    "the oldest key must have been evicted by the 64-entry bound",
  );
});

test("parseInline preserves snake_case QA markers", () => {
  const tokens = parseInlineForTest("UNCLECODE_FULL_TUI_QA_OK");
  assert.deepEqual(
    tokens.map((token) => `${token.kind}:${token.value}`),
    ["text:UNCLECODE_FULL_TUI_QA_OK"],
  );
});

test("parseInline still renders asterisk italics", () => {
  const tokens = parseInlineForTest("Use *emphasis* here");
  assert.deepEqual(
    tokens.map((token) => `${token.kind}:${token.value}`),
    ["text:Use ", "italic:emphasis", "text: here"],
  );
});
