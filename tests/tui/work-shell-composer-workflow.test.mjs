import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { render } from "ink";
import React from "react";

import {
  WORK_SHELL_SPINNER_INTERVAL_MS,
  resolveReadableWorkShellTextColor,
  resolveWorkShellComposerHint,
  WorkShellView,
} from "../../packages/tui/src/work-shell-view.tsx";

function createWritableOutput() {
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  output.isTTY = true;
  output.getColorDepth = () => 24;
  output.hasColors = () => true;
  return output;
}

function createWritableError() {
  const error = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  error.columns = 100;
  error.rows = 30;
  error.isTTY = true;
  error.getColorDepth = () => 24;
  error.hasColors = () => true;
  return error;
}

function renderDebugFrame(element) {
  const stdout = createWritableOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const instance = render(element, {
    stdout,
    stderr: createWritableError(),
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    instance,
    getOutput: () => output,
  };
}

test("WORK_SHELL_SPINNER_INTERVAL_MS matches DESIGN.md Motion timing", () => {
  assert.equal(WORK_SHELL_SPINNER_INTERVAL_MS, 100);
});

test("resolveWorkShellComposerHint prioritizes busy queue guidance over slash hints", () => {
  assert.equal(
    resolveWorkShellComposerHint({
      isBusy: true,
      inputValue: "/model",
      slashSuggestionCount: 4,
      selectedSlashCommand: "/model gpt-5.4",
    }),
    "Enter queues follow-up · Ctrl+C/Esc interrupt · /queue",
  );
});

test("resolveWorkShellComposerHint surfaces paused queue recovery guidance", () => {
  assert.equal(
    resolveWorkShellComposerHint({
      isBusy: false,
      queuePaused: true,
      queuedCount: 2,
      inputValue: "",
      slashSuggestionCount: 0,
    }),
    "Queue paused after interrupt · check /queue · /queue clear drops",
  );
});

test("resolveWorkShellComposerHint keeps idle slash discovery guidance", () => {
  assert.equal(
    resolveWorkShellComposerHint({
      isBusy: false,
      inputValue: "",
      slashSuggestionCount: 0,
    }),
    "Enter send · Shift+Enter newline · / commands · Ctrl+V image",
  );
});

test("busy WorkShellView renders composer hint above prompt deck", async () => {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.4",
      reasoningLabel: "medium",
      reasoningSupported: true,
      mode: "default",
      authLabel: "Saved OAuth",
      entries: [{ role: "user", text: "ship it" }],
      isBusy: true,
      busyStatus: "thinking",
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement("span", null, ""),
      inputValue: "next task",
      slashSuggestionCount: 0,
      terminalColumns: 100,
      cwd: "/Users/parkeungje/project/unclecode",
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  const output = getOutput();
  instance.unmount();
  instance.cleanup();

  assert.match(output, /Enter queues follow-up · Ctrl\+C\/Esc interrupt · \/queue/);
  const hintIndex = output.indexOf("Enter queues follow-up");
  const deckIndex = output.indexOf("prompt deck");
  assert.ok(hintIndex >= 0 && deckIndex > hintIndex, "composer hint should appear above prompt deck");
});

test("queued WorkShellView keeps queue indicator and composer hint visible", async () => {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.4",
      reasoningLabel: "medium",
      reasoningSupported: true,
      mode: "default",
      authLabel: "Saved OAuth",
      entries: [{ role: "user", text: "first" }],
      isBusy: true,
      busyStatus: "thinking",
      queuedCount: 1,
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement("span", null, ""),
      inputValue: "",
      slashSuggestionCount: 0,
      terminalColumns: 100,
      cwd: "/Users/parkeungje/project/unclecode",
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  const output = getOutput();
  instance.unmount();
  instance.cleanup();

  assert.match(output, /1 queued/);
  assert.match(output, /Enter queues follow-up/);
});

test("prompt deck footer keeps context cost readable on dark terminals", async () => {
  const previousBackground = process.env.UNCLECODE_TERMINAL_BACKGROUND;
  process.env.UNCLECODE_TERMINAL_BACKGROUND = "dark";
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.6-terra",
      reasoningLabel: "medium",
      reasoningSupported: true,
      mode: "default",
      authLabel: "Saved OAuth",
      entries: [],
      isBusy: false,
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement("span", null, ""),
      inputValue: "",
      slashSuggestionCount: 0,
      terminalColumns: 100,
      cwd: "/Users/parkeungje/project/unclecode",
      contextIndicator: "▤ 44 ctx · ~2k · 113 held",
    }),
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const output = getOutput();
    assert.match(output, /▤ 44 ctx · ~2k/);
    // Dark terminal: the old invisible border hex resolves to the muted tier.
    assert.equal(resolveReadableWorkShellTextColor("#21262d"), "gray");
  } finally {
    instance.unmount();
    instance.cleanup();
    if (previousBackground === undefined) {
      delete process.env.UNCLECODE_TERMINAL_BACKGROUND;
    } else {
      process.env.UNCLECODE_TERMINAL_BACKGROUND = previousBackground;
    }
  }
});
