import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  clearTerminalScreen,
  shouldClearTerminalOnResize,
  subscribeTerminalResizeClear,
} from "../../packages/tui/src/terminal-resize-clear.ts";

const CLEAR_SEQUENCE = "\u001B[2J\u001B[3J\u001B[H";

function createFakeStdout({ columns = 100, isTTY = true } = {}) {
  const stdout = new PassThrough();
  stdout.columns = columns;
  stdout.isTTY = isTTY;
  let written = "";
  stdout.on("data", (chunk) => {
    written += chunk.toString();
  });
  return {
    stdout,
    getWritten: () => written,
    resetWritten: () => {
      written = "";
    },
  };
}

test("shouldClearTerminalOnResize only fires when the terminal narrows in columns", () => {
  assert.equal(shouldClearTerminalOnResize(100, 72), true);
  assert.equal(shouldClearTerminalOnResize(72, 100), false);
  assert.equal(shouldClearTerminalOnResize(100, 100), false);
});

test("row-only resizes never clear the screen on ink 6.8", () => {
  // The predicate is deliberately columns-only. Row-only shrink must not
  // clear: ink 6.8 resets nothing when only rows decrease, so a static
  // non-fullscreen frame (the boot screen) never repaints after an external
  // clear and the screen stays blank until the next state change. Verified
  // against a real terminal emulator (tmux): 100x40 -> 100x30 blanked a
  // static two-row frame. Row-only grow has the same hazard as any grow —
  // ink skips unchanged rows, so a clear would erase rows never rewritten.
  // These equal-columns cases document that invariant.
  assert.equal(shouldClearTerminalOnResize(100, 100), false);
  assert.equal(shouldClearTerminalOnResize(72, 72), false);
});

test("clearTerminalScreen writes screen+scrollback clear only on a TTY", () => {
  const tty = createFakeStdout({ isTTY: true });
  clearTerminalScreen(tty.stdout);
  assert.equal(tty.getWritten(), CLEAR_SEQUENCE);

  const pipe = createFakeStdout({ isTTY: false });
  clearTerminalScreen(pipe.stdout);
  assert.equal(pipe.getWritten(), "");
});

test("subscribeTerminalResizeClear clears before later-added resize listeners on narrowing", () => {
  const { stdout, getWritten, resetWritten } = createFakeStdout({ columns: 100 });
  const callOrder = [];
  // Simulates Ink's own resize handler, registered first (at render time).
  stdout.on("resize", () => {
    callOrder.push(`ink:${getWritten().includes(CLEAR_SEQUENCE) ? "after-clear" : "before-clear"}`);
  });
  const unsubscribe = subscribeTerminalResizeClear(stdout, () => stdout.columns);

  stdout.columns = 72;
  stdout.emit("resize");
  assert.deepEqual(callOrder, ["ink:after-clear"], "clear must run before Ink's resize redraw");
  assert.equal(getWritten(), CLEAR_SEQUENCE);

  resetWritten();
  stdout.columns = 100;
  stdout.emit("resize");
  assert.equal(getWritten(), "", "widening must not clear the screen");

  resetWritten();
  unsubscribe();
  stdout.columns = 60;
  stdout.emit("resize");
  assert.equal(getWritten(), "", "unsubscribed handler must not clear");
});
