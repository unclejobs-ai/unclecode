import test from "node:test";
import assert from "node:assert/strict";

import {
  handleComposerClipboardPaste,
  sanitizeComposerInput,
  shouldTreatComposerChangeAsPaste,
} from "@unclecode/tui";

test("handleComposerClipboardPaste reports handled when capture returns ok", () => {
  const calls = [];
  const outcome = handleComposerClipboardPaste({
    capture: () => ({
      status: "ok",
      attachment: {
        type: "image",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,iVBORw0K",
        path: "(test)",
        displayName: "clipboard.png",
      },
    }),
    onClipboardImage: (attachment) => {
      calls.push(["image", attachment.displayName, attachment.mimeType]);
    },
    onClipboardImageError: () => {
      calls.push(["error"]);
    },
  });

  assert.equal(outcome, "handled");
  assert.deepEqual(calls, [["image", "clipboard.png", "image/png"]]);
});

test("handleComposerClipboardPaste falls through when clipboard has no image", () => {
  const errorCalls = [];
  const outcome = handleComposerClipboardPaste({
    capture: () => ({ status: "no-image", reason: "clipboard does not hold an image" }),
    onClipboardImage: () => {
      assert.fail("onClipboardImage must not fire when capture status is not ok");
    },
    onClipboardImageError: (reason, status) => {
      errorCalls.push([status, reason]);
    },
  });

  assert.equal(outcome, "fallthrough");
  assert.deepEqual(errorCalls, [["no-image", "clipboard does not hold an image"]]);
});

test("handleComposerClipboardPaste skips capture when no onClipboardImage handler is provided", () => {
  let captureCalled = false;
  const outcome = handleComposerClipboardPaste({
    capture: () => {
      captureCalled = true;
      return { status: "ok", attachment: {
        type: "image",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,iVBORw0K",
        path: "(test)",
        displayName: "clipboard.png",
      } };
    },
  });

  assert.equal(outcome, "fallthrough");
  assert.equal(captureCalled, false, "capture must not run when no consumer is wired");
});

test("handleComposerClipboardPaste reports unsupported platform without firing onClipboardImage", () => {
  const errorCalls = [];
  const outcome = handleComposerClipboardPaste({
    capture: () => ({ status: "unsupported", reason: "clipboard capture not wired for platform sunos" }),
    onClipboardImage: () => {
      assert.fail("onClipboardImage must not fire when capture status is unsupported");
    },
    onClipboardImageError: (reason, status) => {
      errorCalls.push([status, reason]);
    },
  });

  assert.equal(outcome, "fallthrough");
  assert.deepEqual(errorCalls, [["unsupported", "clipboard capture not wired for platform sunos"]]);
});

test("handleComposerClipboardPaste falls through and reports failure when the platform shell errors", () => {
  const errorCalls = [];
  const outcome = handleComposerClipboardPaste({
    capture: () => ({ status: "failed", reason: "pbpaste exec failed: ENOENT" }),
    onClipboardImage: () => {
      assert.fail("onClipboardImage must not fire when capture status is failed");
    },
    onClipboardImageError: (reason, status) => {
      errorCalls.push([status, reason]);
    },
  });

  assert.equal(outcome, "fallthrough");
  assert.deepEqual(errorCalls, [["failed", "pbpaste exec failed: ENOENT"]]);
});

test("text-paste sanitizer and threshold heuristic remain wired alongside clipboard branch", () => {
  // Sanity check that exporting handleComposerClipboardPaste did not regress
  // the existing pure helpers consumers rely on.
  assert.equal(sanitizeComposerInput("hi[200~paste[201~"), "hipaste");
  assert.equal(shouldTreatComposerChangeAsPaste("a", "a".repeat(80)), true);
  assert.equal(shouldTreatComposerChangeAsPaste("foo", "foo bar"), false);
});


test("macOS clipboard capture no longer probes with redundant pbpaste -Prefer", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../packages/orchestrator/src/clipboard-image.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /pbpaste[\s\S]*?-Prefer/);
  assert.match(source, /osascript/);
});
