import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import React from "react";

import { renderDebugFrame, waitForSettledFrame } from "./work-shell-render-harness.mjs";
import {
  formatWorkShellHeaderLine,
  resolveWorkShellChromeWidth,
  WorkShellView,
} from "../../packages/tui/src/work-shell-view.tsx";
import { getDisplayWidth } from "../../packages/tui/src/text-width.ts";

// The work-shell frame is wrapped in paddingX={2}. Chrome rows therefore have
// four fewer columns than the terminal; header, rule, and the string formatter
// used to disagree about that, so "/ commands" spilled onto a second line and a
// horizontal split looked like it had failed to reflow.

function renderAt(terminalColumns) {
  return renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningLabel: "unsupported",
      reasoningSupported: false,
      mode: "Work",
      authLabel: "OAuth · pi engine",
      entries: [
        { role: "user", text: "image" },
        { role: "assistant", text: "어떤 이미지를 만들거나 찾아드릴까요? 주제, 스타일, 비율을 알려주세요." },
      ],
      isBusy: false,
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement("span", null, ""),
      inputValue: "",
      slashSuggestionCount: 0,
      terminalColumns,
      cwd: "/Users/parkeungje/project/unclecode",
    }),
    { columns: terminalColumns, rows: 40 },
  );
}

async function frameAt(terminalColumns) {
  const { instance, getOutput } = renderAt(terminalColumns);
  await waitForSettledFrame(getOutput);
  const output = getOutput();
  instance.unmount();
  instance.cleanup();
  const start = output.lastIndexOf("UncleCode ·");
  return stripVTControlCharacters(start >= 0 ? output.slice(start) : output);
}

test("resolveWorkShellChromeWidth accounts for the frame's horizontal padding", () => {
  assert.equal(resolveWorkShellChromeWidth(120), 116);
  assert.equal(resolveWorkShellChromeWidth(100), 96);
  // Floor keeps very narrow terminals from collapsing the chrome to nothing.
  assert.equal(resolveWorkShellChromeWidth(20), 32);
});

test("header row never exceeds the padded chrome width", () => {
  for (const columns of [72, 96, 100, 120, 160]) {
    const line = formatWorkShellHeaderLine({
      providerTitle: "UncleCode · OpenAI",
      headerHint: "work context · Ctrl+O tools · / commands",
      terminalColumns: columns,
    });
    assert.doesNotMatch(line, /\n/, `header wrapped at ${columns} columns`);
    assert.ok(
      line.length <= columns - 4,
      `header at ${columns} columns used ${line.length} of ${columns - 4}`,
    );
  }
});

for (const columns of [68, 96, 100, 120]) {
  test(`work shell reflows within ${columns} columns without spilling`, async () => {
    const frame = await frameAt(columns);
    const lines = frame.split("\n");

    const headerIndex = lines.findIndex((line) => line.includes("UncleCode ·"));
    assert.ok(headerIndex >= 0, `no header rendered at ${columns} columns`);
    assert.notEqual(
      (lines[headerIndex + 1] ?? "").trim(),
      "commands",
      `header hint wrapped onto a second line at ${columns} columns`,
    );

    const overflowing = lines.filter((line) => line.length > columns);
    assert.deepEqual(
      overflowing,
      [],
      `lines exceeded ${columns} columns:\n${overflowing.join("\n")}`,
    );
  });
}

for (const columns of [60, 80, 100, 140]) {
  test(`real no-color frame preserves the quiet-workspace golden at ${columns} columns`, async () => {
    const previousNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const frame = await frameAt(columns);
      const lines = frame.split("\n");
      assert.match(frame, /UncleCode · OpenAI/);
      assert.match(frame, /어떤 이미지를/);
      assert.match(frame, /◈ UncleCode/);
      assert.ok(lines.every((line) => getDisplayWidth(line) <= columns), `display overflow at ${columns}`);
      assert.doesNotMatch(frame, /\u001b\[[0-9;]*m/u, `SGR color leaked with NO_COLOR at ${columns}`);
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
    }
  });
}
