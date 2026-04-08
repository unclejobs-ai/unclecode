import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeComposerInput,
  shouldTreatComposerChangeAsPaste,
} from "../../src/composer.tsx";

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
