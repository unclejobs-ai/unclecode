import assert from "node:assert/strict";
import test from "node:test";

import { getDisplayWidth, wrapDisplayTextFast } from "../../packages/tui/src/text-width.ts";

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
