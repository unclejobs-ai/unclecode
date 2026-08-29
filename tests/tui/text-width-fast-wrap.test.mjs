import assert from "node:assert/strict";
import test from "node:test";

import {
  getDisplayWidth,
  segmentDisplayGraphemes,
  truncateForDisplayWidth,
  wrapDisplayTextFast,
} from "../../packages/tui/src/text-width.ts";

test("wrapDisplayTextFast wraps at word boundaries", () => {
  assert.deepEqual(wrapDisplayTextFast("abc def", 4), ["abc", "def"]);
  assert.deepEqual(wrapDisplayTextFast("one two three", 8), ["one two", "three"]);
});

test("wrapDisplayTextFast keeps CJK display width safe", () => {
  // "하이"(4 cols) + space + "요"(2 cols) does not fit in 5 columns.
  assert.deepEqual(wrapDisplayTextFast("하이 요", 5), ["하이", "요"]);
  for (const line of wrapDisplayTextFast("스트리밍 UX 검수용 긴 응답입니다. ".repeat(6), 40)) {
    assert.ok(getDisplayWidth(line) <= 40, `line exceeds width: "${line}"`);
  }
});

test("wrapDisplayTextFast splits unbroken words by grapheme", () => {
  assert.deepEqual(wrapDisplayTextFast("하이abc", 5), ["하이a", "bc"]);
  assert.deepEqual(wrapDisplayTextFast("abcdefgh", 3), ["abc", "def", "gh"]);
});

test("wrapDisplayTextFast preserves explicit newlines", () => {
  assert.deepEqual(wrapDisplayTextFast("one\n\ntwo", 6), ["one", "", "two"]);
});

test("truncateForDisplayWidth avoids splitting Hangul and emoji graphemes", () => {
  assert.equal(truncateForDisplayWidth("한글", 4), "한글");
  assert.equal(truncateForDisplayWidth("한글응답", 4), "한글");
  assert.equal(getDisplayWidth(truncateForDisplayWidth("한글응답", 4)), 4);
  assert.equal(truncateForDisplayWidth("🙂테스트", 3), "🙂");
  assert.equal(getDisplayWidth(truncateForDisplayWidth("🙂테스트", 3)), 2);
});

test("display cells keep jamo, combining marks, ZWJ emoji, and ANSI styling out of cursor math", () => {
  const decomposedHangul = "\u1112\u1161\u11ab";
  const combiningLatin = "e\u0301";
  const zwjFamily = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";

  assert.deepEqual(segmentDisplayGraphemes(`${decomposedHangul}${combiningLatin}${zwjFamily}`), [
    decomposedHangul,
    combiningLatin,
    zwjFamily,
  ]);
  assert.equal(getDisplayWidth(decomposedHangul), 2);
  assert.equal(getDisplayWidth(combiningLatin), 1);
  assert.equal(getDisplayWidth(zwjFamily), 2);
  assert.equal(getDisplayWidth("\u001b[31m한글\u001b[0m"), 4);
  assert.equal(truncateForDisplayWidth("\u001b[31m한글응답\u001b[0m", 3), "한");
});

/**
 * Ink measures with `string-width`, which counts any RGI emoji cluster as two
 * cells. Undercounting one here makes every bounded row a cell too generous,
 * so ink wraps the row the layout believed it had trimmed.
 */
test("getDisplayWidth counts RGI emoji clusters the way ink's renderer does", () => {
  assert.equal(getDisplayWidth("\u{1F680}"), 2, "rocket");
  assert.equal(getDisplayWidth("\u26A0\uFE0F"), 2, "warning with emoji presentation");
  assert.equal(getDisplayWidth("\u2699\uFE0F"), 2, "gear with emoji presentation");
  assert.equal(getDisplayWidth("\u23F3"), 2, "hourglass");
  assert.equal(getDisplayWidth("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"), 2, "zwj family");
  assert.equal(getDisplayWidth("\u{1F1F0}\u{1F1F7}"), 2, "regional-indicator flag");
  assert.equal(getDisplayWidth("1\uFE0F\u20E3"), 2, "qualified keycap");
  assert.equal(getDisplayWidth("1\u20E3"), 2, "unqualified keycap");

  // Text-presentation glyphs and the console's own status set stay one cell,
  // so widening emoji must not widen the chrome.
  assert.equal(getDisplayWidth("\u2714"), 1, "heavy check without VS16");
  assert.equal(getDisplayWidth("\u25D0\u25CF\u25B2\u2715\u25CB\u2298"), 6, "ledger glyphs");
  assert.equal(getDisplayWidth("\u203A\u23BF\u2502"), 3, "console chrome glyphs");
});

test("emoji-bearing text truncates and wraps on the widened measurement", () => {
  assert.equal(getDisplayWidth(truncateForDisplayWidth("\u{1F680}\u{1F680}\u{1F680}", 4)), 4);
  for (const line of wrapDisplayTextFast("\u{1F680} ship \u26A0\uFE0F check \u23F3 wait", 10)) {
    assert.ok(getDisplayWidth(line) <= 10, `line exceeds width: "${line}"`);
  }
});
