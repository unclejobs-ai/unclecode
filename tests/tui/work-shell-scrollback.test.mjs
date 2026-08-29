import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import { render } from "ink";
import React from "react";

import { WorkShellPane } from "../../packages/tui/src/index.tsx";
import {
  getWorkShellTranscriptEntryCapacity,
  measureWorkShellEntryRows,
  createWorkShellTranscriptAnchor,
  formatWorkShellTranscriptScrollIndicator,
  projectWorkShellTranscript,
  resolveWorkShellTranscriptOffsetFromAnchor,
  resolveWorkShellTranscriptWindow,
} from "../../packages/tui/src/work-shell-view.tsx";
import {
  getWorkShellSlashSuggestions,
  shouldBlockSlashSubmit,
} from "../../packages/orchestrator/src/index.ts";

const KEY_PAGE_UP = "\u001b[5~";
const KEY_PAGE_DOWN = "\u001b[6~";
const KEY_ESCAPE = "\u001b";

function padScrollbackIndex(index) {
  return String(index).padStart(4, "0");
}

function createScrollbackEntries(count = 60) {
  return Array.from({ length: count }, (_, index) => ({
    role: "user",
    text: `sb-${padScrollbackIndex(index)}`,
  }));
}

// Multi-row tool entries (assembled tool-call detail) mixed into the
// transcript: every third entry carries a 5-row body, so entry heights vary
// and the window math has to weigh rows, not count entries.
function createMixedScrollbackEntries(count = 60) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 3 === 2 ? "tool" : "user",
    text: index % 3 === 2
      ? `sb-${padScrollbackIndex(index)}\n3 lines · 12ms\nrow one\nrow two\nrow three`
      : `sb-${padScrollbackIndex(index)}`,
  }));
}

// rows=30 leaves 20 rows for transcript entries (10 reserved for chrome);
// every 1-row entry weighs 2 rows (text + margin), so the weighted capacity
// for the single-line sb-* transcript is 10 entries per window.
const TERMINAL_ROWS = 30;
const TRANSCRIPT_ENTRY_COUNT = 60;
const TRANSCRIPT_CAPACITY = getWorkShellTranscriptEntryCapacity(
  createScrollbackEntries(),
  TERMINAL_ROWS,
);

function createInkInput() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  input.resume = () => input;
  input.pause = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

function createWritableOutput() {
  const output = new PassThrough();
  output.columns = 100;
  output.rows = TERMINAL_ROWS;
  output.isTTY = true;
  return output;
}

function createWritableError() {
  const error = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  error.columns = 100;
  error.rows = TERMINAL_ROWS;
  error.isTTY = true;
  return error;
}

function renderWithInput(element) {
  const stdin = createInkInput();
  const stdout = createWritableOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const instance = render(element, {
    stdin,
    stdout,
    stderr: createWritableError(),
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    stdin,
    instance,
    getOutput: () => output,
  };
}

async function waitForCondition(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function getLastWorkFrame(output) {
  const finalFrameStart = output.lastIndexOf("UncleCode · OpenAI");
  return finalFrameStart >= 0 ? output.slice(finalFrameStart) : output;
}

function createWorkShellPaneEngine(overrides = {}) {
  const submittedLines = [];
  let state = {
    entries: createScrollbackEntries(),
    model: "gpt-5.4",
    mode: "yolo",
    reasoning: "medium",
    authLabel: "oauth-file",
    isBusy: false,
    bridgeLines: [],
    memoryLines: [],
    panel: {
      title: "Session status",
      lines: ["Work context ready."],
    },
    ...overrides,
  };
  const listeners = new Set();

  return {
    submittedLines,
    emitEntries: (entries) => {
      state = { ...state, entries };
      for (const listener of listeners) {
        listener(state);
      }
    },
    engine: {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      initialize: async () => {},
      dispose: () => {},
      handleSubmit: async (line) => {
        submittedLines.push(line);
      },
      setMode: async () => {},
      openSessionsPanel: async () => {},
    },
  };
}

function renderScrollbackPane(engine) {
  return renderWithInput(
    React.createElement(WorkShellPane, {
      provider: "OpenAI",
      model: "gpt-5.4",
      mode: "yolo",
      engine,
      cwd: "/tmp/unclecode-test-workspace",
      resolveComposerInput: async (value) => ({
        prompt: value,
        attachments: [],
        transcriptText: value,
      }),
      getSuggestions: (value) =>
        getWorkShellSlashSuggestions(value, {
          provider: "openai",
          currentModel: "gpt-5.4",
        }),
      onExit: () => {},
      shouldBlockSlashSubmit: (line) =>
        shouldBlockSlashSubmit(line, {
          provider: "openai",
          currentModel: "gpt-5.4",
        }),
      getReasoningLabel: () => "default medium",
      isReasoningSupported: () => true,
    }),
  );
}

async function waitForNewestEntry(getOutput) {
  return waitForCondition(() =>
    getLastWorkFrame(getOutput()).includes(`sb-${String(TRANSCRIPT_ENTRY_COUNT - 1).padStart(4, "0")}`)
  );
}

test("resolveWorkShellTranscriptWindow keeps the historical window at rest and pages by capacity", () => {
  const entries = createScrollbackEntries();
  // Bottom-follow (offset 0) reproduces the pre-scrollback frame exactly.
  const atRest = resolveWorkShellTranscriptWindow({ entries, terminalRows: TERMINAL_ROWS, scrollOffset: 0 });
  assert.equal(atRest.scrolled, false);
  assert.equal(atRest.window.length, 50);
  assert.equal(atRest.window[atRest.window.length - 1].text, `sb-${String(TRANSCRIPT_ENTRY_COUNT - 1).padStart(4, "0")}`);

  // One PageUp: the window is the rows-derived capacity anchored one page
  // above the newest entry.
  const scrolled = resolveWorkShellTranscriptWindow({ entries, terminalRows: TERMINAL_ROWS, scrollOffset: TRANSCRIPT_CAPACITY });
  assert.equal(scrolled.scrolled, true);
  assert.equal(scrolled.window.length, TRANSCRIPT_CAPACITY);
  assert.equal(scrolled.window[0].text, `sb-${String(TRANSCRIPT_ENTRY_COUNT - 2 * TRANSCRIPT_CAPACITY).padStart(4, "0")}`);
  assert.equal(scrolled.entriesAbove, TRANSCRIPT_ENTRY_COUNT - 2 * TRANSCRIPT_CAPACITY);

  // The top clamp: an offset past the oldest entry still starts at entry 0.
  const atTop = resolveWorkShellTranscriptWindow({ entries, terminalRows: TERMINAL_ROWS, scrollOffset: TRANSCRIPT_ENTRY_COUNT });
  assert.equal(atTop.window[0].text, "sb-0000");
  assert.equal(atTop.entriesAbove, 0);
  assert.equal(atTop.scrolled, true);
});

test("measureWorkShellEntryRows counts text rows plus the one-row margin", () => {
  assert.equal(measureWorkShellEntryRows({ role: "user", text: "one line" }), 2);
  assert.equal(
    measureWorkShellEntryRows({ role: "tool", text: "bash test\n3 lines · 5ms\nout" }),
    4,
  );
  const eightRowToolEntry = {
    role: "tool",
    text: ["bash test", "9 lines · 5ms", "r1", "r2", "r3", "r4", "r5", "r6"].join("\n"),
  };
  assert.equal(measureWorkShellEntryRows(eightRowToolEntry), 9);
});

test("role-aware projection exactly budgets Korean user, assistant, system, and capped tool rows", () => {
  const korean = "가나다라마바사아자차카타파하";
  assert.equal(measureWorkShellEntryRows({ role: "user", text: korean }, 30), 3);
  assert.equal(measureWorkShellEntryRows({ role: "assistant", text: korean }, 30), 4);
  assert.equal(measureWorkShellEntryRows({ role: "system", text: korean }, 30), 3);
  assert.equal(measureWorkShellEntryRows({
    role: "tool",
    text: ["검사 실행", ...Array.from({ length: 10 }, (_, index) => `결과 ${index}`)].join("\n"),
  }, 30), 11);
});

test("entry-id and intra-entry anchor survives append, update, and resize", () => {
  const before = [
    { id: "old", role: "assistant", text: "오래된 답변" },
    { id: "anchor", role: "assistant", text: "가나다라마바사아자차카타파하" },
    { id: "new", role: "user", text: "최신" },
  ];
  const anchor = createWorkShellTranscriptAnchor(before, 30, 4);
  assert.deepEqual(anchor, { entryId: "anchor", intraEntryRow: 2 });
  const after = [
    before[0],
    { ...before[1], text: `${before[1].text} 업데이트` },
    before[2],
    { id: "fresh", role: "tool", text: "검사\n통과" },
  ];
  assert.equal(resolveWorkShellTranscriptOffsetFromAnchor(after, 30, anchor), 7);
  assert.equal(resolveWorkShellTranscriptOffsetFromAnchor(after, 20, anchor), 7);
});

test("streaming assistant anchor follows the committed assistant entry", () => {
  const durable = [
    { id: "entry-user", role: "user", text: "질문" },
    { id: "entry-old", role: "assistant", text: "이전 답변" },
  ];
  const streaming = projectWorkShellTranscript(durable, "새 답변을 스트리밍 중입니다 👨‍👩‍👧‍👦");
  const anchor = createWorkShellTranscriptAnchor(streaming, 20, 2);
  assert.deepEqual(anchor, { entryId: "streaming-assistant", intraEntryRow: 2 });

  const committed = projectWorkShellTranscript([
    ...durable,
    { id: "entry-committed", role: "assistant", text: "새 답변을 스트리밍 중입니다 👨‍👩‍👧‍👦" },
  ]);
  assert.equal(resolveWorkShellTranscriptOffsetFromAnchor(committed, 20, anchor), 2);
});

test("scroll indicator localizes owned chrome while preserving key names", () => {
  assert.equal(
    formatWorkShellTranscriptScrollIndicator({ earlierRows: 12, newerRows: 4, uiLocale: "ko" }),
    "↑ 12 이전 행 · Fn+Up/PageUp · ↓ 4 새 행 · Fn+Down/PageDown · Esc 최신",
  );
  assert.equal(
    formatWorkShellTranscriptScrollIndicator({ earlierRows: 12, newerRows: 4, uiLocale: "en" }),
    "↑ 12 earlier rows · Fn+Up/PageUp · ↓ 4 newer rows · Fn+Down/PageDown · Esc latest",
  );
});

test("multi-row tool entries shrink the window capacity the view and controller share", () => {
  // 20 available rows at rows=30: single-line entries weigh 2 → 10 fit.
  const singleLine = Array.from({ length: 20 }, (_, index) => ({
    role: "user",
    text: `sb-${padScrollbackIndex(index)}`,
  }));
  assert.equal(getWorkShellTranscriptEntryCapacity(singleLine, TERMINAL_ROWS), 10);

  // 8-row tool entries weigh 9: two fit in 20 rows, and the safety floor
  // (never fewer than 3 entries per window) holds the page there.
  const eightRowTools = Array.from({ length: 20 }, () => ({
    role: "tool",
    text: "bash test\n9 lines · 5ms\nr1\nr2\nr3\nr4\nr5\nr6",
  }));
  assert.equal(getWorkShellTranscriptEntryCapacity(eightRowTools, TERMINAL_ROWS), 3);

  // On a taller terminal the floor stops masking the weights: 50 available
  // rows fit five 9-row entries (45 rows), not the ten single-liners.
  assert.equal(getWorkShellTranscriptEntryCapacity(eightRowTools, 60), 5);

  // A transcript that ends on heavy entries pages smaller than one that ends
  // on single-row replies — the weight reads from the newest entry backwards.
  const mixed = createMixedScrollbackEntries();
  const mixedCapacity = getWorkShellTranscriptEntryCapacity(mixed, TERMINAL_ROWS);
  assert.ok(
    mixedCapacity < getWorkShellTranscriptEntryCapacity(createScrollbackEntries(), TERMINAL_ROWS),
    "heavy tool entries in the tail must shrink the page",
  );
});

test("the weighted window pages and clamps on the same capacity the controller steps by", () => {
  const entries = createMixedScrollbackEntries();
  const capacity = getWorkShellTranscriptEntryCapacity(entries, TERMINAL_ROWS);

  // One controller step (PageUp) lands exactly one window above the newest
  // entry — the offset, the window length, and entriesAbove all derive from
  // the one weight function.
  const scrolled = resolveWorkShellTranscriptWindow({
    entries,
    terminalRows: TERMINAL_ROWS,
    scrollOffset: capacity,
  });
  assert.equal(scrolled.window.length, capacity);
  assert.equal(scrolled.window[0].text, `sb-${padScrollbackIndex(TRANSCRIPT_ENTRY_COUNT - 2 * capacity)}`);
  assert.equal(scrolled.entriesAbove, TRANSCRIPT_ENTRY_COUNT - 2 * capacity);

  // The clamp: the controller's maxOffset is visible − capacity; at that
  // offset the window starts at entry 0.
  const atTop = resolveWorkShellTranscriptWindow({
    entries,
    terminalRows: TERMINAL_ROWS,
    scrollOffset: TRANSCRIPT_ENTRY_COUNT,
  });
  assert.equal(atTop.window[0].text, "sb-0000");
  assert.equal(atTop.entriesAbove, 0);
});

test("offset 0 keeps the exact last-50 slice even for mixed-height entries", () => {
  const entries = createMixedScrollbackEntries();
  const atRest = resolveWorkShellTranscriptWindow({
    entries,
    terminalRows: TERMINAL_ROWS,
    scrollOffset: 0,
  });
  assert.equal(atRest.scrolled, false);
  assert.deepEqual(atRest.window, entries.slice(-50));
  assert.equal(atRest.entriesAbove, 10);
});

test("PageUp scrolls older entries into view with the indicator row", async () => {
  const { engine } = createWorkShellPaneEngine();
  const { stdin, instance, getOutput } = renderScrollbackPane(engine);

  try {
    assert.ok(await waitForNewestEntry(getOutput));
    const atRest = getLastWorkFrame(getOutput());
    // The bottom-follow window renders the historical last-50 slice.
    assert.ok(atRest.includes("sb-0010"));
    assert.ok(!atRest.includes("entries above"));

    stdin.write(KEY_PAGE_UP);
    assert.ok(
      await waitForCondition(() =>
        getLastWorkFrame(getOutput()).includes("earlier rows")
      ),
    );
    const scrolled = getLastWorkFrame(getOutput());
    // The window moved one page up: entries inside the page stay visible,
    // everything below (and the far past outside the window) is gone.
    assert.ok(
      scrolled.includes(`sb-${String(TRANSCRIPT_ENTRY_COUNT - 2 * TRANSCRIPT_CAPACITY).padStart(4, "0")}`),
    );
    assert.ok(!scrolled.includes(`sb-${String(TRANSCRIPT_ENTRY_COUNT - 1).padStart(4, "0")}`));
    assert.ok(!scrolled.includes("sb-0010"));
    assert.match(
      scrolled,
      /↑ \d+ earlier rows · Fn\+Up\/PageUp · ↓ \d+ newer rows · Fn\+Down\/PageDown · Esc latest/,
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("PageUp shows older entries when multi-row tool entries fill the transcript", async () => {
  const entries = createMixedScrollbackEntries();
  const capacity = getWorkShellTranscriptEntryCapacity(entries, TERMINAL_ROWS);
  const { engine } = createWorkShellPaneEngine({ entries });
  const { stdin, instance, getOutput } = renderScrollbackPane(engine);

  try {
    assert.ok(
      await waitForCondition(() =>
        getLastWorkFrame(getOutput()).includes(`sb-${padScrollbackIndex(TRANSCRIPT_ENTRY_COUNT - 1)}`)
      ),
    );
    stdin.write(KEY_PAGE_UP);
    assert.ok(
      await waitForCondition(() => getLastWorkFrame(getOutput()).includes("earlier rows")),
    );
    const scrolled = getLastWorkFrame(getOutput());
    // The page is the weighted capacity: the first window entry, the gone
    // newest entry, and the indicator count all come from the same weight
    // math the controller stepped by.
    assert.ok(
      scrolled.includes(`sb-${padScrollbackIndex(TRANSCRIPT_ENTRY_COUNT - 2 * capacity)}`),
      `first weighted-window entry sb-${padScrollbackIndex(TRANSCRIPT_ENTRY_COUNT - 2 * capacity)} must be visible`,
    );
    assert.ok(!scrolled.includes(`sb-${padScrollbackIndex(TRANSCRIPT_ENTRY_COUNT - 1)}`));
    assert.match(
      scrolled,
      /↑ \d+ earlier rows · Fn\+Up\/PageUp · ↓ \d+ newer rows · Fn\+Down\/PageDown · Esc latest/,
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("a scrolled window separates entries with exactly one blank row and closes the weight budget on the indicator", async () => {
  const entries = createScrollbackEntries();
  const capacity = getWorkShellTranscriptEntryCapacity(entries, TERMINAL_ROWS);
  const { engine } = createWorkShellPaneEngine();
  const { stdin, instance, getOutput } = renderScrollbackPane(engine);

  try {
    assert.ok(await waitForNewestEntry(getOutput));
    stdin.write(KEY_PAGE_UP);
    assert.ok(
      await waitForCondition(() => getLastWorkFrame(getOutput()).includes("earlier rows")),
    );
    const frame = stripVTControlCharacters(getLastWorkFrame(getOutput()));
    const frameRows = frame.split("\n");
    const window = resolveWorkShellTranscriptWindow({
      entries,
      terminalRows: TERMINAL_ROWS,
      scrollOffset: capacity,
    }).window;

    // Every window entry renders as one row (the sb-* texts never wrap at the
    // test width), so consecutive entries must sit exactly one blank row apart:
    // the frame check the scroll weight's `+1` margin is written against.
    const entryRowIndexes = window.map(
      (entry) => frameRows.findIndex((row) => row.includes(entry.text)),
    );
    for (const [index, rowIndex] of entryRowIndexes.entries()) {
      assert.ok(rowIndex >= 0, `window entry ${window[index].text} must render in the scrolled frame`);
      if (index === 0) {
        continue;
      }
      const previousRow = entryRowIndexes[index - 1];
      assert.equal(
        rowIndex - previousRow,
        2,
        `exactly one blank row must separate ${window[index - 1].text} from ${window[index].text}`,
      );
      assert.equal(frameRows[previousRow + 1].trim(), "", "the separating row must be empty");
    }

    // The last window entry adds no trailing blank: the scroll indicator sits
    // directly beneath it, inside the conversation block.
    const lastEntryRow = entryRowIndexes[entryRowIndexes.length - 1];
    const indicatorRow = frameRows.findIndex((row) => row.includes("earlier rows"));
    assert.equal(indicatorRow, lastEntryRow + 1);

    // Weight consistency, direct assertion: the frame span from the window's
    // first entry row through the indicator row equals the sum of
    // measureWorkShellEntryRows over the window. The per-entry `+1` margin is
    // spent on the blank separators, and the indicator row closes the final
    // entry's budget — render and weight math agree row for row.
    const weightSum = window.reduce(
      (total, entry) => total + measureWorkShellEntryRows(entry),
      0,
    );
    assert.equal(indicatorRow - entryRowIndexes[0] + 1, weightSum);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("PageDown returns the transcript to the newest entries", async () => {
  const { engine } = createWorkShellPaneEngine();
  const { stdin, instance, getOutput } = renderScrollbackPane(engine);

  try {
    assert.ok(await waitForNewestEntry(getOutput));
    stdin.write(KEY_PAGE_UP);
    assert.ok(
      await waitForCondition(() => getLastWorkFrame(getOutput()).includes("earlier rows")),
    );

    stdin.write(KEY_PAGE_DOWN);
    assert.ok(await waitForNewestEntry(getOutput));
    const backToNewest = getLastWorkFrame(getOutput());
    assert.ok(!backToNewest.includes("earlier rows"));
    assert.ok(backToNewest.includes("sb-0010"));
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("Esc returns the transcript to the newest entries", async () => {
  const { engine } = createWorkShellPaneEngine();
  const { stdin, instance, getOutput } = renderScrollbackPane(engine);

  try {
    assert.ok(await waitForNewestEntry(getOutput));
    stdin.write(KEY_PAGE_UP);
    stdin.write(KEY_PAGE_UP);
    assert.ok(
      await waitForCondition(() =>
        getLastWorkFrame(getOutput()).includes(
          "earlier rows",
        )
      ),
    );

    stdin.write(KEY_ESCAPE);
    assert.ok(await waitForNewestEntry(getOutput));
    assert.ok(!getLastWorkFrame(getOutput()).includes("earlier rows"));
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("submitting input returns the transcript to the newest entries", async () => {
  const { engine, submittedLines } = createWorkShellPaneEngine();
  const { stdin, instance, getOutput } = renderScrollbackPane(engine);

  try {
    assert.ok(await waitForNewestEntry(getOutput));
    stdin.write(KEY_PAGE_UP);
    assert.ok(
      await waitForCondition(() => getLastWorkFrame(getOutput()).includes("earlier rows")),
    );

    stdin.write("hello\r");
    assert.ok(
      await waitForCondition(() => !getLastWorkFrame(getOutput()).includes("earlier rows")),
    );
    assert.deepEqual(submittedLines, ["hello"]);
    assert.ok(await waitForNewestEntry(getOutput));
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("a newly arrived entry preserves the user\'s transcript position", async () => {
  const { engine, emitEntries } = createWorkShellPaneEngine();
  const { stdin, instance, getOutput } = renderScrollbackPane(engine);

  try {
    assert.ok(await waitForNewestEntry(getOutput));
    stdin.write(KEY_PAGE_UP);
    assert.ok(
      await waitForCondition(() => getLastWorkFrame(getOutput()).includes("earlier rows")),
    );

    const outputLengthBeforeArrival = getOutput().length;
    emitEntries([...createScrollbackEntries(), { role: "user", text: "sb-fresh" }]);
    assert.ok(
      await waitForCondition(() => getOutput().length > outputLengthBeforeArrival),
    );
    const afterArrival = getLastWorkFrame(getOutput());
    assert.ok(afterArrival.includes("earlier rows"));
    assert.ok(!afterArrival.includes("sb-fresh"));

    stdin.write(KEY_PAGE_UP);
    assert.ok(
      await waitForCondition(() =>
        getLastWorkFrame(getOutput()).includes(
          "earlier rows",
        )
      ),
    );

    stdin.write(KEY_ESCAPE);
    assert.ok(await waitForCondition(() => getLastWorkFrame(getOutput()).includes("sb-fresh")));
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("PageUp works with text in the composer and keeps the draft", async () => {
  const { engine } = createWorkShellPaneEngine();
  const { stdin, instance, getOutput } = renderScrollbackPane(engine);

  try {
    assert.ok(await waitForNewestEntry(getOutput));
    stdin.write("hello");
    assert.ok(
      await waitForCondition(() => /› hello/.test(getLastWorkFrame(getOutput()))),
    );

    stdin.write(KEY_PAGE_UP);
    assert.ok(
      await waitForCondition(() => getLastWorkFrame(getOutput()).includes("earlier rows")),
    );
    const scrolled = getLastWorkFrame(getOutput());
    assert.match(scrolled, /↑ \d+ earlier rows · Fn\+Up\/PageUp · ↓ \d+ newer rows · Fn\+Down\/PageDown · Esc latest/);
    // Scrolling is not a print key: the draft survives it.
    assert.match(scrolled, /› hello/);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("PageUp is a no-op on a conversation shorter than the window", async () => {
  const { engine } = createWorkShellPaneEngine({
    entries: createScrollbackEntries(3),
  });
  const { stdin, instance, getOutput } = renderScrollbackPane(engine);

  try {
    assert.ok(
      await waitForCondition(() => getLastWorkFrame(getOutput()).includes("sb-0002")),
    );
    stdin.write(KEY_PAGE_UP);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const frame = getLastWorkFrame(getOutput());
    assert.ok(!frame.includes("earlier rows"));
    assert.ok(frame.includes("sb-0000"));
    assert.ok(frame.includes("sb-0002"));
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});
