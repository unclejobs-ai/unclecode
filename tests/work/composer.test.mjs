import assert from "node:assert/strict";
import test from "node:test";

import {
  applyComposerEdit,
  sanitizeComposerInput,
  shouldComposerDeferVerticalArrows,
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

test("shouldComposerDeferVerticalArrows keeps slash drafts on the picker", () => {
  assert.equal(shouldComposerDeferVerticalArrows("/help"), true);
  assert.equal(shouldComposerDeferVerticalArrows("/모델"), true);
  assert.equal(shouldComposerDeferVerticalArrows("안녕"), false);
  assert.equal(shouldComposerDeferVerticalArrows(""), false);
});

test("applyComposerEdit Home/End stay on the current Hangul visual line", () => {
  // width 6 wraps "안녕하세요" into "안녕하" / "세요".
  const value = "안녕하세요";
  const home = applyComposerEdit({
    value,
    cursorOffset: 4,
    input: "",
    key: { home: true },
    allowLineBreaks: true,
    width: 6,
  });
  assert.equal(home.nextValue, value);
  assert.equal(home.nextCursorOffset, 3, "Home jumps to the start of 세요, not the buffer");

  const end = applyComposerEdit({
    value,
    cursorOffset: 1,
    input: "",
    key: { end: true },
    allowLineBreaks: true,
    width: 6,
  });
  assert.equal(end.nextValue, value);
  assert.equal(end.nextCursorOffset, 3, "End jumps to the end of 안녕하, not the buffer");
});

test("applyComposerEdit Up/Down move one Hangul visual row and preserve column", () => {
  const value = "안녕하세요";
  const up = applyComposerEdit({
    value,
    cursorOffset: 4,
    input: "",
    key: { upArrow: true },
    allowLineBreaks: true,
    width: 6,
  });
  assert.equal(up.nextValue, value);
  assert.equal(up.nextCursorOffset, 1, "Up from after 세 (col 2) lands after 안");

  const down = applyComposerEdit({
    value,
    cursorOffset: 1,
    input: "",
    key: { downArrow: true },
    allowLineBreaks: true,
    width: 6,
  });
  assert.equal(down.nextValue, value);
  assert.equal(down.nextCursorOffset, 4, "Down from after 안 (col 2) lands after 세");
});

test("applyComposerEdit Down clamps to a shorter Hangul visual row", () => {
  const value = "안녕하세";
  const down = applyComposerEdit({
    value,
    cursorOffset: 2,
    input: "",
    key: { downArrow: true },
    allowLineBreaks: true,
    width: 6,
  });
  assert.equal(down.nextValue, value);
  assert.equal(down.nextCursorOffset, 4, "col 4 on 세 (2 cols) clamps to the end of the row");
});

test("applyComposerEdit Home/End follow explicit Hangul newlines, not wrap", () => {
  const value = "안녕\n하세요";
  const home = applyComposerEdit({
    value,
    cursorOffset: 5,
    input: "",
    key: { home: true },
    allowLineBreaks: true,
    width: 20,
  });
  assert.equal(home.nextCursorOffset, 3);

  const end = applyComposerEdit({
    value,
    cursorOffset: 3,
    input: "",
    key: { end: true },
    allowLineBreaks: true,
    width: 20,
  });
  assert.equal(end.nextCursorOffset, 6);
});
