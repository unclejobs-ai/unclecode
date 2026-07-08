import assert from "node:assert/strict";
import test from "node:test";

import React from "react";

import { renderDebugFrame } from "./work-shell-render-harness.mjs";

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

test("busy WorkShellView avoids a duplicate lower activity row", async () => {
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

  assert.match(output, /◆ .* Busy/u);
  assert.match(output, /\n\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+Thinking through the next step/u);
  assert.doesNotMatch(
    output,
    /\n\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+thinking/u,
    "busy screen should not add a second lower activity row when the status line already shows progress",
  );
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

  assert.match(output, /◆ .* Busy/u);
  assert.match(output, /\n\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+Preparing context/u);
  assert.doesNotMatch(output, /Ready for the next move/);
  assert.doesNotMatch(
    output,
    /╭─|╰─/,
    "busy empty conversation should not render the idle bordered card",
  );
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
  // Status bar uses · separators (redesigned — was │)
  assert.match(output, /gpt-5\.4 · YOLO mode.*·.*Saved OAuth/);
  assert.match(output, /Ready for the next move/);
  assert.match(output, /Work context ready/);
  assert.match(output, /Start\s+· Type the task in plain language/);
  assert.match(output, /Inspect\s+· Use \/context before a risky edit/);
  assert.match(output, /Recover\s+· Use Ctrl\+O for saved sessions/);
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

test("resolveReadableWorkShellTextColor keeps primary text explicit for light terminals", () => {
  assert.equal(resolveReadableWorkShellTextColor("#f8fafc"), "#0d1117");
  assert.equal(resolveReadableWorkShellTextColor("#e2e8f0"), "#0d1117");
  assert.equal(resolveReadableWorkShellTextColor("#0f172a"), "#0d1117");
  // Rust entry-presentation body colors that are too dark on dark backgrounds
  // are resolved to the palette's primary text color for readability.
  assert.equal(resolveReadableWorkShellTextColor("#334155"), "#0d1117");
  assert.equal(resolveReadableWorkShellTextColor("#475569"), "#0d1117");
  assert.equal(resolveReadableWorkShellTextColor("#94a3b8"), "#64748b");
  assert.equal(resolveReadableWorkShellTextColor("#0d9488"), "#64748b");
  assert.equal(resolveReadableWorkShellTextColor("#7d8590"), "#64748b");
  assert.equal(resolveReadableWorkShellTextColor("#115e59"), "#115e59");
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
