import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { render } from "ink";
import React from "react";

import { WorkShellPane } from "../../packages/tui/src/index.tsx";
import {
  getWorkShellTranscriptEntryCapacity,
  resolveWorkShellTranscriptWindow,
} from "../../packages/tui/src/work-shell-view.tsx";
import {
  getWorkShellSlashSuggestions,
  shouldBlockSlashSubmit,
} from "../../packages/orchestrator/src/index.ts";

const KEY_PAGE_UP = "\u001b[5~";
const KEY_PAGE_DOWN = "\u001b[6~";
const KEY_ESCAPE = "\u001b";

// rows=30 → capacity max(3, floor((30-10)/3)) = 6 entries per window.
const TERMINAL_ROWS = 30;
const TRANSCRIPT_ENTRY_COUNT = 60;
const TRANSCRIPT_CAPACITY = getWorkShellTranscriptEntryCapacity(TERMINAL_ROWS);

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

function createScrollbackEntries(count = TRANSCRIPT_ENTRY_COUNT) {
  return Array.from({ length: count }, (_, index) => ({
    role: "user",
    text: `sb-${String(index).padStart(4, "0")}`,
  }));
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
        getLastWorkFrame(getOutput()).includes("entries above")
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
      new RegExp(`↑ ${TRANSCRIPT_ENTRY_COUNT - 2 * TRANSCRIPT_CAPACITY} entries above · PageUp/PageDown scroll · Esc newest`),
    );
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
      await waitForCondition(() => getLastWorkFrame(getOutput()).includes("entries above")),
    );

    stdin.write(KEY_PAGE_DOWN);
    assert.ok(await waitForNewestEntry(getOutput));
    const backToNewest = getLastWorkFrame(getOutput());
    assert.ok(!backToNewest.includes("entries above"));
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
          `↑ ${TRANSCRIPT_ENTRY_COUNT - 3 * TRANSCRIPT_CAPACITY} entries above`,
        )
      ),
    );

    stdin.write(KEY_ESCAPE);
    assert.ok(await waitForNewestEntry(getOutput));
    assert.ok(!getLastWorkFrame(getOutput()).includes("entries above"));
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
      await waitForCondition(() => getLastWorkFrame(getOutput()).includes("entries above")),
    );

    stdin.write("hello\r");
    assert.ok(
      await waitForCondition(() => !getLastWorkFrame(getOutput()).includes("entries above")),
    );
    assert.deepEqual(submittedLines, ["hello"]);
    assert.ok(await waitForNewestEntry(getOutput));
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("a newly arrived entry returns the transcript to bottom-follow", async () => {
  const { engine, emitEntries } = createWorkShellPaneEngine();
  const { stdin, instance, getOutput } = renderScrollbackPane(engine);

  try {
    assert.ok(await waitForNewestEntry(getOutput));
    stdin.write(KEY_PAGE_UP);
    assert.ok(
      await waitForCondition(() => getLastWorkFrame(getOutput()).includes("entries above")),
    );

    emitEntries([...createScrollbackEntries(), { role: "user", text: "sb-fresh" }]);
    assert.ok(
      await waitForCondition(() => getLastWorkFrame(getOutput()).includes("sb-fresh")),
    );
    assert.ok(!getLastWorkFrame(getOutput()).includes("entries above"));
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
      await waitForCondition(() => getLastWorkFrame(getOutput()).includes("entries above")),
    );
    const scrolled = getLastWorkFrame(getOutput());
    assert.match(scrolled, /↑ \d+ entries above · PageUp\/PageDown scroll · Esc newest/);
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
    assert.ok(!frame.includes("entries above"));
    assert.ok(frame.includes("sb-0000"));
    assert.ok(frame.includes("sb-0002"));
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});
