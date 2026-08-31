import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import React from "react";
import { Text } from "ink";

import { renderDebugFrame, waitForSettledFrame } from "./work-shell-render-harness.mjs";
import {
  formatWorkShellHeaderLine,
  resolveWorkShellChromeWidth,
  resolveWorkShellComposerFrameLayout,
  WorkShellView,
} from "../../packages/tui/src/work-shell-view.tsx";
import { Composer } from "../../packages/tui/src/composer.tsx";
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

async function frameForSessionLength(entryCount, terminalRows = 32, overrides = {}) {
  const terminalColumns = overrides.terminalColumns ?? 80;
  const entries = Array.from({ length: entryCount }, (_, index) => ({
    id: `entry-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: index % 2 === 0 ? `request ${index}` : `response ${index}`,
  }));
  const { instance, getOutput, getFrame } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningLabel: "unsupported",
      reasoningSupported: false,
      mode: "Work",
      authLabel: "OAuth · pi engine",
      entries,
      isBusy: false,
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement(Text, null, "한글 draft"),
      inputValue: "한글 draft",
      slashSuggestionCount: 0,
      terminalColumns,
      terminalRows,
      cwd: "/Users/parkeungje/project/unclecode",
      ...overrides,
    }),
    { columns: terminalColumns, rows: terminalRows },
  );
  await waitForSettledFrame(getOutput);
  const output = stripVTControlCharacters(getFrame());
  instance.unmount();
  instance.cleanup();
  const start = output.lastIndexOf("UncleCode ·");
  return start >= 0 ? output.slice(start) : output;
}

function compactContextPacket() {
  const source = {
    id: "workspace-1",
    category: "workspace",
    label: "AGENTS.md",
    reason: "workspace guidance",
    preview: "Repository instructions.",
    tokenEstimate: 8,
    salience: 1,
    includedInModel: true,
  };
  return {
    id: "packet-resize",
    version: 1,
    generatedAt: "2026-08-31T00:00:00.000Z",
    title: "Next answer context",
    included: [source],
    excluded: [],
    warnings: [],
    preview: [],
    sourceCounts: { included: 1, excluded: 0, warnings: 0 },
    tokenEstimate: 8,
    tokenEstimateState: "estimated",
  };
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

test("composer frame budget reserves both overflow markers and the upper flex row", () => {
  const narrowBusy = resolveWorkShellComposerFrameLayout({
    terminalRows: 9,
    isBusy: true,
    hasComposerHint: true,
    liveTraceLineCount: 3,
  });
  assert.equal(narrowBusy.dockOverheadRows, 4, "9-row compact busy dock hides trace rows");
  assert.equal(narrowBusy.maxVisibleRows, 2, "9-row dock leaves room for two overflow markers");
  assert.deepEqual(narrowBusy.cursorAnchor, { x: 5, bottom: 7 });

  const roomyBusy = resolveWorkShellComposerFrameLayout({
    terminalRows: 24,
    isBusy: true,
    hasComposerHint: true,
    liveTraceLineCount: 3,
  });
  assert.equal(roomyBusy.dockOverheadRows, 7, "roomy busy dock includes activity, trace, hint, divider, and footer");
  assert.equal(roomyBusy.maxVisibleRows, 4, "roomy dock keeps the normal four-row viewport");
});

test("prompt dock stays on one terminal row as a session grows", async () => {
  const shortFrame = await frameForSessionLength(2);
  const longFrame = await frameForSessionLength(40);
  const promptRow = (frame) => frame
    .split("\n")
    .findIndex((line) => line.includes("› 한글 draft"));

  assert.equal(promptRow(shortFrame), 30, "the prompt row is pinned above the one-line footer");
  assert.equal(promptRow(longFrame), 30, "transcript growth must not move the prompt dock");
});

for (const terminalRows of [8, 10, 12, 16, 24]) {
  test(`prompt dock remains usable in a ${terminalRows}-row split`, async () => {
    const frame = await frameForSessionLength(40, terminalRows);
    const rows = frame.split("\n");
    const promptRow = rows.findIndex((line) => line.includes("› 한글 draft"));

    assert.ok(
      promptRow >= 0,
      `the prompt disappeared from a ${terminalRows}-row split: ${JSON.stringify(frame)}`,
    );
    assert.equal(
      promptRow,
      terminalRows - 2,
      "the prompt must keep the bottom dock slot while upper content is clipped",
    );
  });
}

test("Context Desk and attachment preview stay above the same bottom dock", async () => {
  const contextFrame = await frameForSessionLength(40, 16, {
    activePanel: { title: "Context expanded", lines: [] },
    contextPacket: compactContextPacket(),
    contextInspectorCursor: 0,
  });
  const contextRows = contextFrame.split("\n");
  assert.ok(contextRows.some((line) => line.includes("Context Desk")));
  assert.equal(
    contextRows.findIndex((line) => line.includes("› 한글 draft")),
    14,
    "opening Context Desk must not move the input row",
  );

  const attachmentFrame = await frameForSessionLength(40, 16, {
    attachmentLines: ["Image 1 · screenshot.png", "Ready for model input"],
    attachmentCount: 1,
  });
  const attachmentRows = attachmentFrame.split("\n");
  const attachmentAt = attachmentRows.findIndex((line) => line.includes("screenshot.png"));
  const promptAt = attachmentRows.findIndex((line) => line.includes("› 한글 draft"));
  assert.ok(attachmentAt >= 0, "attachment preview remains visible in the bounded upper region");
  assert.ok(attachmentAt < promptAt, "attachment preview must never displace content below the input dock");
  assert.equal(promptAt, 14);
});

test("an inline attachment count never clips an actual CJK Composer draft", async () => {
  const draft = "한".repeat(21);
  const frame = await frameForSessionLength(2, 16, {
    terminalColumns: 52,
    inputValue: draft,
    attachmentLines: ["Image 1 · screenshot.png"],
    attachmentCount: 1,
    composer: React.createElement(Composer, {
      value: draft,
      onChange: () => {},
      onSubmit: () => {},
      terminalColumns: 52,
      cursorAnchor: { x: 5, bottom: 14 },
    }),
  });

  assert.equal(
    [...frame.matchAll(/한/gu)].length,
    21,
    `every committed Hangul grapheme must remain painted beside attachment state: ${JSON.stringify(frame)}`,
  );
});

test("an 8-row busy dock drops optional trace chrome before the prompt or footer", async () => {
  const frame = await frameForSessionLength(2, 8, {
    inputValue: "한",
    isBusy: true,
    busyStatus: "Implementing the fix",
    liveToolTraceLines: ["read · first", "edit · second", "test · third"],
    composer: React.createElement(Composer, {
      value: "한",
      onChange: () => {},
      onSubmit: () => {},
      terminalColumns: 80,
      cursorAnchor: { x: 5, bottom: 6 },
    }),
  });
  const rows = frame.split("\n");

  assert.equal(
    rows.findIndex((line) => line.includes("› 한")),
    6,
    `busy frame lost the prompt: ${JSON.stringify(frame)}`,
  );
  assert.match(rows[7] ?? "", /unclecode/u, "the footer must remain directly below the input row");
  assert.doesNotMatch(frame, /read · first|edit · second|test · third/u);
});

test("an 8-row split keeps the footer with a long CJK draft cursor in the middle", async () => {
  const draft = "한".repeat(400);
  const { stdin, instance, getOutput, getFrame } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningLabel: "unsupported",
      reasoningSupported: false,
      mode: "Work",
      authLabel: "OAuth · pi engine",
      entries: [],
      isBusy: false,
      activePanel: { title: "Session status", lines: [] },
      composer: React.createElement(Composer, {
        value: draft,
        onChange: () => {},
        onSubmit: () => {},
        terminalColumns: 80,
        cursorAnchor: { x: 5, bottom: 6 },
      }),
      inputValue: draft,
      slashSuggestionCount: 0,
      terminalColumns: 80,
      terminalRows: 8,
      cwd: "/Users/parkeungje/project/unclecode",
    }),
    { columns: 80, rows: 8 },
  );

  try {
    await waitForSettledFrame(getOutput);
    const endCursorRows = stripVTControlCharacters(getFrame()).split("\n");
    assert.match(
      endCursorRows[7] ?? "",
      /unclecode/u,
      `the end-cursor footer must stay on the last row: ${JSON.stringify(endCursorRows)}`,
    );
    const baseline = getOutput();
    stdin.write("\u001b[D".repeat(200));
    await waitForSettledFrame(getOutput, { baseline });
    const rows = stripVTControlCharacters(getFrame()).split("\n");

    const upperMarkerAt = rows.findIndex((line) => /↑ \d+ more/u.test(line));
    const lowerMarkerAt = rows.findIndex((line) => /↓ \d+ more/u.test(line));
    const footerAt = rows.findIndex((line) => /unclecode/u.test(line));
    assert.ok(upperMarkerAt >= 0, `the middle cursor must expose hidden rows above: ${JSON.stringify(rows)}`);
    assert.ok(lowerMarkerAt > upperMarkerAt, `the middle cursor must expose hidden rows below: ${JSON.stringify(rows)}`);
    assert.equal(footerAt, 7, `the footer must remain pinned on the last row: ${JSON.stringify(rows)}`);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

for (const terminalRows of [9, 10]) {
  test(`${terminalRows}-row busy split bounds a long CJK draft and keeps the footer below the cursor`, async () => {
  const draft = "한".repeat(400);
  const { stdin, instance, getOutput, getFrame } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningLabel: "unsupported",
      reasoningSupported: false,
      mode: "Work",
      authLabel: "OAuth · pi engine",
      entries: [],
      isBusy: true,
      busyStatus: "Implementing the fix",
      liveToolTraceLines: ["read · first", "edit · second", "test · third"],
      activePanel: { title: "Session status", lines: [] },
      composer: React.createElement(Composer, {
        value: draft,
        onChange: () => {},
        onSubmit: () => {},
        terminalColumns: 80,
        cursorAnchor: { x: 5, bottom: terminalRows - 2 },
      }),
      inputValue: draft,
      slashSuggestionCount: 0,
      terminalColumns: 80,
      terminalRows,
      cwd: "/Users/parkeungje/project/unclecode",
    }),
    { columns: 80, rows: terminalRows },
  );

  try {
    await waitForSettledFrame(getOutput);
    stdin.write("\u001b[D".repeat(200));
    await waitForSettledFrame(getOutput);
    const rows = stripVTControlCharacters(getFrame()).split("\n");
    const upperMarkerAt = rows.findIndex((line) => /↑ \d+ more/u.test(line));
    const lowerMarkerAt = rows.findIndex((line) => /↓ \d+ more/u.test(line));
    const footerAt = rows.findIndex((line) => /unclecode/u.test(line));

    assert.ok(upperMarkerAt >= 0, `the middle cursor must expose hidden rows above: ${JSON.stringify(rows)}`);
    assert.ok(lowerMarkerAt > upperMarkerAt, `the middle cursor must expose hidden rows below: ${JSON.stringify(rows)}`);
    assert.equal(footerAt, terminalRows - 1, `the footer must stay pinned to the final terminal row: ${JSON.stringify(rows)}`);
    assert.ok(rows.length <= terminalRows, `the busy dock must stay inside ${terminalRows} rows: ${JSON.stringify(rows)}`);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
  });
}

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
