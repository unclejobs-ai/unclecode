import assert from "node:assert/strict";
import test from "node:test";

import {
  applyComposerEdit,
  sanitizeComposerInput,
  shouldTreatComposerChangeAsPaste,
} from "@unclecode/tui";

test("shouldTreatComposerChangeAsPaste detects large pasted text deltas", () => {
  assert.equal(shouldTreatComposerChangeAsPaste("hello", "hello world"), false);
  assert.equal(shouldTreatComposerChangeAsPaste("", "line 1\nline 2\nline 3"), true);
  assert.equal(shouldTreatComposerChangeAsPaste("short", `short ${"x".repeat(80)}`), true);
});

test("shouldTreatComposerChangeAsPaste ignores deletions and tiny edits", () => {
  assert.equal(shouldTreatComposerChangeAsPaste("abcdef", "abcde"), false);
  assert.equal(shouldTreatComposerChangeAsPaste("hello", "hello!"), false);
});

test("sanitizeComposerInput strips bracketed paste control artifacts", () => {
  assert.equal(sanitizeComposerInput("\u001b[200~/tmp/a.png\u001b[201~"), "/tmp/a.png");
  assert.equal(sanitizeComposerInput("[990~/tmp/b.png"), "/tmp/b.png");
  assert.equal(sanitizeComposerInput("look [990~here"), "look here");
});

test("applyComposerEdit composes Hangul jamo at mid-cursor without duplicating tail", () => {
  assert.deepEqual(
    applyComposerEdit({
      value: "앞 ㅎ 뒤",
      cursorOffset: "앞 ㅎ".length,
      input: "하",
      key: {},
      allowLineBreaks: false,
    }),
    {
      nextValue: "앞 하 뒤",
      nextCursorOffset: "앞 하".length,
      submitted: false,
    },
  );
});

test("applyComposerEdit merges prefix-anchored Hangul IME updates in the middle of a line", () => {
  assert.deepEqual(
    applyComposerEdit({
      value: "시작 중간 끝",
      cursorOffset: "시작 ".length,
      input: "시작 중",
      key: {},
      allowLineBreaks: false,
    }),
    {
      nextValue: "시작 중간 끝",
      nextCursorOffset: "시작 중".length,
      submitted: false,
    },
  );
});
