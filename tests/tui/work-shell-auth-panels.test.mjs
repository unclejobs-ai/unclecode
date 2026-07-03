import assert from "node:assert/strict";
import test from "node:test";

import { compactContextValue } from "../../packages/tui/src/work-shell-auth-panels.ts";
import { getDisplayWidth } from "../../packages/tui/src/text-width.ts";

test("compactContextValue truncates by display width, not JavaScript string length", () => {
  const koreanValue = "가".repeat(20);
  const compact = compactContextValue("Context", koreanValue);
  assert.ok(getDisplayWidth(compact) <= 36, `expected display width <= 36, got ${getDisplayWidth(compact)} for "${compact}"`);
  assert.doesNotMatch(compact, /[\uD800-\uDFFF]/, "truncation must not split surrogate pairs");
  assert.match(compact, /…$/, "long values should end with an ellipsis");

  const ascii = "abcdefghijklmnopqrstuvwxyz0123456789EXTRA";
  const asciiCompact = compactContextValue("Context", ascii);
  assert.ok(getDisplayWidth(asciiCompact) <= 36);
  assert.match(asciiCompact, /…$/);
});

test("compactContextValue keeps short Korean values intact", () => {
  const value = "한글 컨텍스트 요약";
  assert.equal(compactContextValue("Context", value), value);
});

test("compactContextValue uses a tighter limit for Issue labels", () => {
  const value = "가".repeat(20);
  const compact = compactContextValue("Issue", value);
  assert.ok(getDisplayWidth(compact) <= 35, `Issue rows should fit 35 columns, got ${getDisplayWidth(compact)}`);
});
