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

test("applyComposerEdit inserts committed Hangul text at the cursor without changing the tail", () => {
  assert.deepEqual(
    applyComposerEdit({
      value: "앞 뒤",
      cursorOffset: "앞 ".length,
      input: "중간 ",
      key: {},
      allowLineBreaks: false,
    }),
    {
      nextValue: "앞 중간 뒤",
      nextCursorOffset: "앞 중간 ".length,
      submitted: false,
    },
  );
});

test("applyComposerEdit appends a shorter Korean paste that overlaps the draft", () => {
  assert.deepEqual(
    applyComposerEdit({
      value: "안녕하세요",
      cursorOffset: "안녕하세요".length,
      input: "안녕",
      key: {},
      allowLineBreaks: false,
    }),
    {
      nextValue: "안녕하세요안녕",
      nextCursorOffset: "안녕하세요안녕".length,
      submitted: false,
    },
  );
});
