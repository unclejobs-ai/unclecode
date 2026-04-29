import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CLIPBOARD_ATTACHMENT_COUNT,
  MAX_CLIPBOARD_ATTACHMENT_BYTES,
} from "@unclecode/tui";

/**
 * The cap defaults are user-visible policy values; if a future change
 * tightens them the user-facing cap line moves with the constant. These
 * tests pin the v1 contract so an accidental drop in the limit fails
 * loudly rather than silently shipping a tighter rejection rule.
 */

test("v1 default count cap matches the documented Anthropic-aligned ceiling", () => {
  assert.equal(MAX_CLIPBOARD_ATTACHMENT_COUNT, 5);
});

test("v1 default per-image byte cap is 5 MiB", () => {
  assert.equal(MAX_CLIPBOARD_ATTACHMENT_BYTES, 5 * 1024 * 1024);
});
