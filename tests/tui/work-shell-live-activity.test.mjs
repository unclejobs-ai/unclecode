import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import React from "react";

import { renderDebugFrame } from "./work-shell-render-harness.mjs";
import { getDisplayWidth } from "../../packages/tui/src/text-width.ts";

// Force light terminal background for the render tests below — they were
// authored against the light palette and assert specific hex values.
process.env.UNCLECODE_TERMINAL_BACKGROUND = "light";

import {
  formatWorkShellLiveActivityLine,
  formatWorkShellPanelEmptyLines,
  WorkShellView,
  resolveReadableWorkShellTextColor,
  shouldSuppressWorkShellPassivePanel,
  shouldUseCompactAssistantSurface,
} from "../../packages/tui/src/work-shell-view.tsx";

function getLastWorkShellFrame(output) {
  const frameStart = output.lastIndexOf("UncleCode ·");
  return stripVTControlCharacters(frameStart >= 0 ? output.slice(frameStart) : output);
}

test("formatWorkShellLiveActivityLine shows nothing while idle", () => {
  assert.equal(formatWorkShellLiveActivityLine({ isBusy: false }), null);
  assert.equal(
    formatWorkShellLiveActivityLine({ isBusy: false, busyStatus: "Reading files" }),
    null,
  );
});

test("formatWorkShellLiveActivityLine surfaces a live progress line while busy", () => {
  const fallback = formatWorkShellLiveActivityLine({ isBusy: true, spinnerFrame: 0 });
  assert.ok(typeof fallback === "string" && fallback.length > 0);
  assert.match(fallback, /Thinking through the next step/);

  const withStatus = formatWorkShellLiveActivityLine({
    isBusy: true,
    busyStatus: "Reading project files",
    spinnerFrame: 0,
  });
  assert.ok(typeof withStatus === "string" && withStatus.length > 0);
  // a concrete status replaces the generic fallback
  assert.match(withStatus, /Reading context/);
});

test("busy WorkShellView renders one inline activity in the status strip", async () => {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "gemini",
      model: "gemini-2.5-flash",
      reasoningLabel: "unsupported",
      reasoningSupported: false,
      mode: "Work",
      authLabel: "env-key",
      entries: [{ role: "user", text: "한글 스피너 QA" }],
      isBusy: true,
      busyStatus: "thinking",
      currentTurnStartedAt: Date.now() - 500,
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement("span", null, ""),
      inputValue: "",
      slashSuggestionCount: 0,
      terminalColumns: 100,
      cwd: "/Users/parkeungje/project/unclecode",
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  const frame = getLastWorkShellFrame(getOutput());
  instance.unmount();
  instance.cleanup();

  const spinnerLines = frame
    .split("\n")
    .filter((line) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u.test(line));
  assert.equal(spinnerLines.length, 1, `expected one motion surface, received:\n${frame}`);
  assert.match(spinnerLines[0], /gemini-2\.5-flash.*Thinking through the next step.*\d+(?:\.\d+)?(?:ms|s)/u);
  assert.doesNotMatch(frame, /\bBusy\b/u);
});

test("busy status remains one readable row in a narrow terminal", async () => {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "gemini",
      model: "gemini-2.5-flash",
      reasoningLabel: "unsupported",
      reasoningSupported: false,
      mode: "Work",
      authLabel: "env-key",
      entries: [{ role: "user", text: "좁은 화면 QA" }],
      isBusy: true,
      busyStatus: "thinking",
      currentTurnStartedAt: Date.now() - 500,
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement("span", null, ""),
      inputValue: "",
      slashSuggestionCount: 0,
      terminalColumns: 52,
      cwd: "/Users/parkeungje/project/unclecode",
    }),
    { columns: 52, rows: 30 },
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  const frame = getLastWorkShellFrame(getOutput());
  instance.unmount();
  instance.cleanup();

  const statusLine = frame
    .split("\n")
    .find((line) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u.test(line));
  assert.ok(statusLine, `expected an inline status row, received:\n${frame}`);
  assert.match(statusLine, /gemini-2\.5-flash.*Thinking.*\d+(?:\.\d+)?(?:ms|s)/u);
  assert.ok(getDisplayWidth(statusLine) <= 52, `status row exceeded terminal width: ${statusLine}`);
});

test("streaming WorkShellView keeps a visible cursor after partial assistant text", async () => {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-4.1-mini",
      reasoningLabel: "medium",
      reasoningSupported: true,
      mode: "default",
      authLabel: "env-key",
      entries: [],
      streamingAssistantText: "OPENAI_STREAM_FIRST_TOKEN",
      isBusy: true,
      busyStatus: "streaming",
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

  assert.match(output, /OPENAI_STREAM_FIRST_TOKEN/);
  assert.match(output, /▌/);
});

test("busy WorkShellView keeps the idle empty-state card hidden", async () => {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "gemini",
      model: "gemini-2.5-flash",
      reasoningLabel: "unsupported",
      reasoningSupported: false,
      mode: "Work",
      authLabel: "env-key",
      entries: [],
      isBusy: true,
      busyStatus: "preparing context",
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

  assert.match(output, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+gemini-2\.5-flash.*Preparing context/u);
  assert.doesNotMatch(output, /\bBusy\b/u);
  assert.doesNotMatch(output, /Ready for the next move/);
  assert.doesNotMatch(
    output,
    /╭─|╰─/,
    "busy empty conversation should not render the idle bordered card",
  );
});

test("status row surfaces auth only when it needs action", async () => {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.4",
      reasoningLabel: "medium",
      reasoningSupported: true,
      mode: "YOLO",
      authLabel: "OAuth needs refresh",
      entries: [],
      isBusy: false,
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

  assert.match(output, /needs refresh/);
});

test("WorkShellView render keeps the light-terminal status frame visible", async () => {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.4",
      reasoningLabel: "medium",
      reasoningSupported: true,
      mode: "YOLO",
      authLabel: "Saved OAuth",
      entries: [],
      isBusy: false,
      activePanel: {
        title: "Session status",
        lines: [
          "Work context ready. Type a task, /context, or @file; UncleCode carries only useful workspace context into the next answer.",
        ],
      },
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

  assert.match(output, /UncleCode · OpenAI/);
  // Status row carries identity and state only. Healthy auth is deliberately
  // absent: "Saved OAuth" never changes mid-session, so it spent a slot
  // confirming nothing was wrong. See the warning case below.
  assert.match(output, /gpt-5\.4 · YOLO 모드 · Ready/);
  assert.doesNotMatch(output, /Saved OAuth/);
  // A fresh session reports no timing rather than the words "no reply yet".
  assert.doesNotMatch(output, /no reply yet/);
  assert.match(output, /Ready for the next move/);
  assert.match(output, /Type a task, \/context to see what gets sent/);
  // The Start/Inspect/Recover triplet is gone; the hint and the composer's own
  // key legend already carry it.
  assert.doesNotMatch(output, /Type the task in plain language/);
  assert.doesNotMatch(output, /Use Ctrl\+O for saved sessions/);
  assert.match(output, /prompt deck/);
});

test("WorkShellView renders an intentional empty state for blank panels", async () => {
  assert.deepEqual(formatWorkShellPanelEmptyLines("MCP"), ["No details in MCP yet.", "Keep typing, or use / for commands."]);

  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.4",
      reasoningLabel: "medium",
      reasoningSupported: true,
      mode: "YOLO",
      authLabel: "Saved OAuth",
      entries: [{ role: "user", text: "show me the empty panel" }],
      isBusy: false,
      activePanel: { title: "MCP", lines: [] },
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

  assert.match(output, /No details in MCP yet/);
  assert.match(output, /Keep typing, or use \/ for commands/);
});

test("resolveReadableWorkShellTextColor converts every hex to the ANSI palette", () => {
  // This file forces a light terminal background, so the palette's primary
  // text tier is "black" and its muted tier is "gray".
  //
  // No hex may survive: a raw hex ignores the user's terminal theme and can
  // land unreadable on their background. Values the old palette used for
  // de-emphasis map to the muted tier; everything else maps to primary text.
  assert.equal(resolveReadableWorkShellTextColor("#f8fafc"), "black");
  assert.equal(resolveReadableWorkShellTextColor("#e2e8f0"), "black");
  assert.equal(resolveReadableWorkShellTextColor("#0f172a"), "black");
  assert.equal(resolveReadableWorkShellTextColor("#334155"), "black");
  assert.equal(resolveReadableWorkShellTextColor("#475569"), "black");
  assert.equal(resolveReadableWorkShellTextColor("#94a3b8"), "gray");
  assert.equal(resolveReadableWorkShellTextColor("#0d9488"), "gray");
  assert.equal(resolveReadableWorkShellTextColor("#7d8590"), "gray");
  // An unknown hex still resolves rather than leaking through.
  assert.equal(resolveReadableWorkShellTextColor("#115e59"), "black");
  // ANSI names pass through untouched.
  assert.equal(resolveReadableWorkShellTextColor("cyan"), "cyan");
  assert.equal(resolveReadableWorkShellTextColor(undefined), undefined);
});

test("shouldUseCompactAssistantSurface keeps every assistant reply out of heavy cards", () => {
  assert.equal(
    shouldUseCompactAssistantSurface({
      text: "하이요! 무엇을 도와드릴까요?",
      width: 92,
    }),
    true,
  );
  assert.equal(
    shouldUseCompactAssistantSurface({
      text: "하이요! 편하게 말씀 주세요.",
      width: 92,
    }),
    true,
  );
  assert.equal(
    shouldUseCompactAssistantSurface({
      text: "Done. What should we tighten next?",
      width: 92,
    }),
    true,
  );
  // DESIGN.md "compact assistant replies avoid heavy cards" + "borders are
  // structural, not decorative": long replies stay on the same rail surface
  // instead of flipping to a rounded heavy card.
  assert.equal(
    shouldUseCompactAssistantSurface({
      text: [
        "Here is the detailed result.",
        "- Routing now ignores context metadata.",
        "- The full-screen TUI smoke guards YOLO greetings.",
        "- Live OpenAI remains blocked by missing OAuth model.request scope.",
      ].join("\n"),
      width: 92,
    }),
    true,
  );
});


test("idle transient slash pickers are hidden after command submit", () => {
  assert.equal(
    shouldSuppressWorkShellPassivePanel({
      panelDisplayMode: "bottom",
      panelTitle: "Reasoning picker",
      inputValue: "",
      isBusy: false,
      latestSystemText: "Reasoning · Deep selected.",
    }),
    true,
  );
  assert.equal(
    shouldSuppressWorkShellPassivePanel({
      panelDisplayMode: "bottom",
      panelTitle: "Reasoning picker",
      inputValue: "",
      isBusy: false,
      latestSystemText: "Reasoning · Deep. Choose Light, Balanced, or Deep.",
    }),
    false,
  );
  assert.equal(
    shouldSuppressWorkShellPassivePanel({
      panelDisplayMode: "bottom",
      panelTitle: "Reasoning picker",
      inputValue: "/reasoning",
      isBusy: false,
    }),
    false,
  );
  assert.equal(
    shouldSuppressWorkShellPassivePanel({
      panelDisplayMode: "bottom",
      panelTitle: "Context",
      inputValue: "",
      isBusy: false,
    }),
    false,
  );
});
