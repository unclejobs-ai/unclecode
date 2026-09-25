import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPiShellQueue,
  formatPiShellStatus,
  nextPiShellMode,
  formatPiShellToolRows,
  PiShellStatusLine,
  readPiShellState,
} from "@unclecode/tui";

test("status row stays one row when the busy status carries newlines", () => {
  // The busy status previews reasoning text. A newline inside a rendered row
  // scrolled the terminal under pi-tui's differential renderer: the top rows
  // vanished and the status row showed twice (measured in tmux frames).
  const status = new PiShellStatusLine();
  status.setText("◆ ✦ reasoning·\n\n'acceptance-marker' is the file.\nNext line");
  const rows = status.render(60);
  assert.equal(rows.length, 1);
  assert.doesNotMatch(rows[0], /[\r\n]/);
});

test("owner-remote state is read field by field; malformed entries are dropped", () => {
  const state = readPiShellState({
    entries: [
      { role: "user", text: "hi" },
      { role: "tool", text: "list_files .\n3 lines" },
      { role: "bogus", text: "x" },
      { role: "assistant" },
      null,
    ],
    streamingAssistantText: "partial",
    isBusy: true,
    busyStatus: "→ read .",
    model: "grok-4.3",
  });
  assert.deepEqual(state.entries.map((entry) => entry.role), ["user", "tool"]);
  assert.equal(state.streamingAssistantText, "partial");
  assert.equal(state.isBusy, true);
  assert.equal(state.lastTurnDurationMs, undefined);
  assert.deepEqual(readPiShellState(undefined).entries, []);
});

test("tool entries render with the Ink shell's call and result glyphs", () => {
  const rows = formatPiShellToolRows(`list_files .\n3 lines · 21ms\n${Array.from({ length: 10 }, (_, i) => `file ${i}`).join("\n")}`);
  assert.equal(rows[0], "● list_files .");
  assert.equal(rows[1], "  ⎿ 3 lines · 21ms");
  assert.equal(rows[2], "    file 0");
  assert.equal(rows.length, 1 + 8 + 1);
  assert.equal(rows.at(-1), "    … +3 more lines");
});

test("status names the idle state the acceptance harness waits for", () => {
  const idle = readPiShellState({ entries: [], isBusy: false, lastTurnDurationMs: 7900 });
  assert.equal(formatPiShellStatus(idle), "◇ Ready · last 7.9s");
  const busy = readPiShellState({ entries: [], isBusy: true, busyStatus: "" });
  assert.equal(formatPiShellStatus(busy), "◆ Working");
});

test("busy status shows the newest live tool row and the turn's elapsed time", () => {
  const busy = readPiShellState({
    entries: [],
    isBusy: true,
    busyStatus: "✦ reasoning· planning",
    currentTurnStartedAt: 1_000,
    liveTraceLines: ["Turn started", "→ list_files .", "→ read second-file.txt"],
  });
  assert.equal(formatPiShellStatus(busy, 4_600), "◆ → read second-file.txt · 3.6s");
  const thinking = readPiShellState({ entries: [], isBusy: true, busyStatus: "✦ reasoning· planning", liveTraceLines: ["Turn started"] });
  assert.equal(formatPiShellStatus(thinking), "◆ ✦ reasoning· planning");
});

test("a command's panel is read; the resting context panel is not", () => {
  const help = readPiShellState({ entries: [], panel: { title: "Help", lines: ["/model  pick a model", 7] } });
  assert.deepEqual(help.panel, { title: "Help", lines: ["/model  pick a model"] });
  assert.equal(readPiShellState({ entries: [], panel: { title: "Context", lines: ["guidance"] } }).panel, undefined);
  assert.equal(readPiShellState({ entries: [] }).panel, undefined);
});

test("Shift+Tab cycles modes in the Ink order; the queue shows only when something waits", () => {
  assert.equal(nextPiShellMode("default"), "yolo");
  assert.equal(nextPiShellMode("search"), "default");
  assert.equal(nextPiShellMode("unknown-mode"), "default");
  assert.equal(formatPiShellQueue(readPiShellState({ entries: [], queuedCount: 0 })), undefined);
  assert.equal(formatPiShellQueue(readPiShellState({ entries: [], queuedCount: 2, queuePaused: true })), "2 queued · paused");
});
