import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

import { render } from "ink";
import React from "react";

import { WorkShellPane } from "../../packages/tui/src/index.tsx";
import {
  WORK_SHELL_STARTER_PROMPTS,
  WORK_SHELL_WORDMARK,
  WorkShellView,
} from "../../packages/tui/src/work-shell-view.tsx";
import {
  getWorkShellSlashSuggestions,
  shouldBlockSlashSubmit,
} from "../../packages/orchestrator/src/index.ts";
import { renderDebugFrame, waitForSettledFrame } from "./work-shell-render-harness.mjs";

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
  output.columns = 120;
  output.rows = 40;
  output.isTTY = true;
  return output;
}

function createWritableError() {
  const error = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  error.columns = 120;
  error.rows = 40;
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
    entries: [],
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

function renderWorkShellPane(engine) {
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

test("empty conversation renders the starter prompts and the opener hint", async () => {
  const { engine } = createWorkShellPaneEngine();
  const { instance, getOutput } = renderWorkShellPane(engine);

  try {
    await waitForCondition(() =>
      getLastWorkFrame(getOutput()).includes("Ready for the next move")
    );
    const frame = getLastWorkFrame(getOutput());

    // The pre-existing heading and hint stay; the starters join them.
    assert.match(frame, /● Ready for the next move/);
    // Task 13: the ASCII wordmark brands the empty screen above the heading.
    const wideFrame = stripVTControlCharacters(frame);
    assert.ok(
      wideFrame.includes(WORK_SHELL_WORDMARK[4].trimEnd()),
      "wordmark bottom art row is rendered on a wide terminal",
    );
    assert.ok(
      wideFrame.indexOf(WORK_SHELL_WORDMARK[4].trimEnd()) <
        wideFrame.indexOf("Ready for the next move"),
      "wordmark sits above the heading",
    );
    for (const [index, prompt] of WORK_SHELL_STARTER_PROMPTS.entries()) {
      assert.match(frame, new RegExp(`${index + 1}  ${prompt}`));
    }
    assert.match(frame, /\/ commands · @ attach a file · ! shell · \? keys/);
    assert.doesNotMatch(
      frame,
      /(?:Tweet|X\.com|embed (?:a )?(?:tweet|post)|Vite \+ React)/i,
      "UncleCode starter chrome must not inherit social/embed template copy",
    );
    // `? keys` is advertised with its binding in place; Ctrl+O never shows.
    assert.doesNotMatch(frame, /Ctrl\+O/);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("pressing 1 on the empty screen prefills the first starter prompt", async () => {
  const { engine, submittedLines } = createWorkShellPaneEngine();
  const { stdin, instance, getOutput } = renderWorkShellPane(engine);

  try {
    await waitForCondition(() =>
      getLastWorkFrame(getOutput()).includes("Ready for the next move")
    );
    stdin.write("1");
    await waitForCondition(() =>
      getLastWorkFrame(getOutput()).includes(`› ${WORK_SHELL_STARTER_PROMPTS[0]}`)
    );
    const frame = getLastWorkFrame(getOutput());

    assert.match(frame, new RegExp(`› ${WORK_SHELL_STARTER_PROMPTS[0]}`));
    // The digit itself never joins the draft.
    assert.doesNotMatch(frame, /› 1/);
    // A prefill is a draft, not a submission.
    assert.deepEqual(submittedLines, []);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("pressing 1 with draft text types the digit into the composer", async () => {
  const { engine } = createWorkShellPaneEngine();
  const { stdin, instance, getOutput } = renderWorkShellPane(engine);

  try {
    await waitForCondition(() =>
      getLastWorkFrame(getOutput()).includes("Ready for the next move")
    );
    stdin.write("x");
    await waitForCondition(() => /› x/.test(getLastWorkFrame(getOutput())));
    stdin.write("1");
    await waitForCondition(() => /› x1/.test(getLastWorkFrame(getOutput())));
    const frame = getLastWorkFrame(getOutput());

    assert.match(frame, /› x1/);
    assert.doesNotMatch(frame, /› Explain this codebase/);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("pressing 1 once the conversation has entries types the digit", async () => {
  const { engine } = createWorkShellPaneEngine({
    entries: [{ role: "user", text: "hello" }],
  });
  const { stdin, instance, getOutput } = renderWorkShellPane(engine);

  try {
    await waitForCondition(() => /› hello/.test(getLastWorkFrame(getOutput())));
    stdin.write("1");
    await waitForCondition(() => /› 1/.test(getLastWorkFrame(getOutput())));
    const frame = getLastWorkFrame(getOutput());

    assert.match(frame, /› 1/);
    assert.doesNotMatch(frame, /› Explain this codebase/);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("pressing 1 during api-key entry types the digit instead of prefilling", async () => {
  const { engine } = createWorkShellPaneEngine({
    composerMode: "api-key-entry",
  });
  const { stdin, instance, getOutput } = renderWorkShellPane(engine);

  try {
    await waitForCondition(() =>
      getLastWorkFrame(getOutput()).includes("Ready for the next move")
    );
    stdin.write("1");
    await waitForCondition(() => /› •/.test(getLastWorkFrame(getOutput())));
    const frame = getLastWorkFrame(getOutput());

    // Exactly one masked character: the digit as typed, not a prefilled
    // starter prompt worth of bullets.
    assert.match(frame, /› •/);
    assert.doesNotMatch(frame, /› ••/);
    assert.doesNotMatch(frame, /› Explain this codebase/);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("WORK_SHELL_WORDMARK is a rectangular, ASCII-only block of 4-7 rows", () => {
  // figlet's standard font emits ASCII glyphs only, so string length equals
  // display width; equal row lengths make the block rectangular so it can
  // never shred asymmetrically when it does render.
  assert.ok(
    WORK_SHELL_WORDMARK.length >= 4 && WORK_SHELL_WORDMARK.length <= 7,
    `wordmark keeps 4-7 rows (got ${WORK_SHELL_WORDMARK.length})`,
  );
  const width = WORK_SHELL_WORDMARK[0].length;
  for (const [index, row] of WORK_SHELL_WORDMARK.entries()) {
    assert.equal(
      row.length,
      width,
      `wordmark row ${index} must stay padded to the ${width}-column block width`,
    );
    assert.match(
      row,
      /^[\x20-\x7E]*$/,
      `wordmark row ${index} must stay ASCII-only`,
    );
  }
});

async function renderEmptyShellFrame(terminalColumns, terminalRows = 40) {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.4",
      reasoningLabel: "default medium",
      reasoningSupported: true,
      mode: "Work",
      authLabel: "oauth-file",
      entries: [],
      isBusy: false,
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement("span", null, ""),
      inputValue: "",
      slashSuggestionCount: 0,
      terminalColumns,
      terminalRows,
      cwd: "/Users/parkeungje/project/unclecode",
    }),
    { columns: terminalColumns, rows: terminalRows },
  );
  const output = await waitForSettledFrame(getOutput);
  instance.unmount();
  instance.cleanup();
  const start = output.lastIndexOf("UncleCode ·");
  return stripVTControlCharacters(start >= 0 ? output.slice(start) : output);
}

test("wide empty conversation renders the wordmark above the starter block", async () => {
  const frame = await renderEmptyShellFrame(100);
  // 100 terminal columns → 94 conversation columns: the 47-column art fits
  // with its 2-column side margins, so the whole block renders.
  for (const [index, row] of WORK_SHELL_WORDMARK.entries()) {
    assert.ok(
      frame.includes(row.trimEnd()),
      `wordmark row ${index} must render on a wide terminal`,
    );
  }
  assert.ok(
    frame.indexOf(WORK_SHELL_WORDMARK[4].trimEnd()) <
      frame.indexOf("Ready for the next move"),
    "wordmark must sit above the heading",
  );
  // The Task 4 empty state survives unchanged beneath the art.
  assert.match(frame, /● Ready for the next move/);
  for (const [index, prompt] of WORK_SHELL_STARTER_PROMPTS.entries()) {
    assert.ok(frame.includes(`${index + 1}  ${prompt}`));
  }
  assert.match(frame, /\/ commands · @ attach a file · ! shell · \? keys/);
  assert.doesNotMatch(frame, /(?:Tweet|X\.com|embed (?:a )?(?:tweet|post)|Vite \+ React)/i);
});

test("narrow empty conversation skips the wordmark and keeps the text block", async () => {
  const frame = await renderEmptyShellFrame(40);
  // 40 terminal columns → 34 conversation columns: below art width + 4, so
  // not a single row — and no wrapped fragment — may appear.
  for (const [index, row] of WORK_SHELL_WORDMARK.entries()) {
    const trimmed = row.trim();
    if (trimmed.length > 0) {
      assert.ok(
        !frame.includes(trimmed),
        `wordmark row ${index} must not render on a narrow terminal`,
      );
    }
  }
  assert.doesNotMatch(frame, /___\| \|/);
  assert.doesNotMatch(frame, /\\__,_/);
  assert.doesNotMatch(frame, / {19}_ {20}_/);
  // The pre-wordmark empty state stays intact (fragments that fit 40
  // columns; longer rows wrap naturally by design).
  assert.match(frame, /● Ready for the next move/);
  assert.match(frame, /1  Explain this/);
  assert.match(frame, /\/ commands/);
});

test("small empty frames never render a partial wordmark or overflow the dock", async () => {
  for (const terminalRows of [8, 12, 18]) {
    const frame = await renderEmptyShellFrame(100, terminalRows);
    const renderedWordmarkRows = WORK_SHELL_WORDMARK.filter((row) =>
      row.trim().length > 0 && frame.includes(row.trimEnd()));
    assert.equal(
      renderedWordmarkRows.length,
      0,
      `${terminalRows}-row empty frame must omit the wordmark as one unit`,
    );
    assert.match(frame, /● Ready for the next move/u);
    const rows = frame.split("\n");
    assert.ok(rows.length <= terminalRows, `${terminalRows}-row empty frame overflowed: ${JSON.stringify(rows)}`);
    assert.ok(rows.some((line) => line.includes("›")), `${terminalRows}-row empty frame lost the prompt`);
    assert.ok(rows.some((line) => /unclecode/u.test(line)), `${terminalRows}-row empty frame lost the footer`);
  }

  const roomyFrame = await renderEmptyShellFrame(100, 24);
  for (const row of WORK_SHELL_WORDMARK) {
    assert.ok(roomyFrame.includes(row.trimEnd()), "roomy empty frame should retain the complete wordmark");
  }
});
