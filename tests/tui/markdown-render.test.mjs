import assert from "node:assert/strict";
import test from "node:test";

import { parseInlineForTest } from "../../packages/tui/src/markdown-render.js";

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
