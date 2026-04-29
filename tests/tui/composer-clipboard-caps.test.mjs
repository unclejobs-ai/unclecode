import test from "node:test";
import assert from "node:assert/strict";

import { handleComposerClipboardPaste } from "@unclecode/tui";

/**
 * Smoke regression for the v1 cap implementation. The pure helper that
 * drives the Ctrl+V branch (handleComposerClipboardPaste) has no cap of
 * its own — caps live in addClipboardAttachment in useWorkShellPaneState
 * — but the helper is the one place every paste flows through, so we
 * exercise the rejection path by feeding a synthetic capture that
 * already hit a capture-side cap.
 */

test("handleComposerClipboardPaste falls through when capture rejects an oversized payload", () => {
  const errors = [];
  const outcome = handleComposerClipboardPaste({
    capture: () => ({
      status: "failed",
      reason: "clipboard image too large at capture (12.0 MiB; max 5 MiB)",
    }),
    onClipboardImage: () => {
      assert.fail("onClipboardImage must not fire when capture rejects oversized payload");
    },
    onClipboardImageError: (reason, status) => errors.push({ status, reason }),
  });
  assert.equal(outcome, "fallthrough");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].status, "failed");
  assert.match(errors[0].reason, /too large at capture/);
});
