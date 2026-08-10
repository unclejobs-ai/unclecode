import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import React from "react";

import { renderDebugFrame, waitForSettledFrame } from "./work-shell-render-harness.mjs";
import { getDisplayWidth } from "../../packages/tui/src/text-width.ts";

// Force light terminal background for the render tests below — they were
// authored against the light palette and assert specific hex values.
process.env.UNCLECODE_TERMINAL_BACKGROUND = "light";

import {
  formatWorkShellLiveActivityLine,
  formatWorkShellPanelEmptyLines,
  formatWorkShellStatusActivityFacts,
  resolveWorkShellActivityNow,
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

// Task 9: the one status row the shell owns now reports how much delegated
// work is live, and its elapsed label is anchored to a monotonic clock so an
// NTP correction cannot make a running turn look younger than it is.

function agentRun(id, overrides = {}) {
  return {
    id,
    displayName: id,
    agentType: "scout",
    status: "running",
    startedAt: 1_000,
    ...overrides,
  };
}

function asyncJob(id, overrides = {}) {
  return {
    id,
    type: "work-node",
    label: id,
    status: "running",
    queuedAt: 900,
    startedAt: 1_000,
    ...overrides,
  };
}

function consoleSnapshot(overrides = {}) {
  return { profileId: "build", activity: [], agents: [], jobs: [], ...overrides };
}

function statusProps(overrides = {}) {
  return {
    provider: "openai",
    model: "gpt-5.4",
    reasoningLabel: "medium",
    reasoningSupported: true,
    mode: "default",
    authLabel: "Saved OAuth",
    entries: [],
    isBusy: false,
    activePanel: { title: "", lines: [] },
    composer: React.createElement("span", null, ""),
    inputValue: "",
    slashSuggestionCount: 0,
    terminalColumns: 120,
    cwd: "/tmp/unclecode-status-workspace",
    ...overrides,
  };
}

const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u;

function spinnerLines(frame) {
  return frame.split("\n").filter((line) => SPINNER.test(line));
}

async function renderStatusFrame(overrides) {
  const columns = overrides.terminalColumns ?? 120;
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, statusProps(overrides)),
    { columns, rows: 40 },
  );
  await waitForSettledFrame(getOutput);
  const frame = getLastWorkShellFrame(getOutput());
  instance.unmount();
  instance.cleanup();
  return frame;
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

test("status activity facts order counts, activity and elapsed and drop every zero", () => {
  assert.equal(
    formatWorkShellStatusActivityFacts({
      activeAgents: 4,
      activeJobs: 4,
      activity: "Reading context",
      elapsed: "16s",
    }),
    "4 agents · 4 jobs · Reading context · 16s",
  );
  assert.equal(
    formatWorkShellStatusActivityFacts({
      activeAgents: 0,
      activeJobs: 0,
      activity: "Ready",
      elapsed: "last 1.2s",
    }),
    "Ready · last 1.2s",
  );
  assert.equal(
    formatWorkShellStatusActivityFacts({ activeAgents: 1, activeJobs: 1, activity: "Working" }),
    "1 agent · 1 job · Working",
  );
  assert.equal(
    formatWorkShellStatusActivityFacts({ activeAgents: 0, activeJobs: 2, activity: "Working" }),
    "2 jobs · Working",
  );
});

test("the shell clock reads display time from a monotonic anchor, not the wall clock", () => {
  assert.equal(resolveWorkShellActivityNow({ wall: 1_000, monotonic: 5_000 }, 5_250), 1_250);
  assert.equal(resolveWorkShellActivityNow({ wall: 1_000, monotonic: 5_000 }, 5_000), 1_000);
});

test("the busy status row states live agent and job counts before activity and elapsed", async () => {
  const frame = await renderStatusFrame({
    isBusy: true,
    busyStatus: "read src/app.ts",
    currentTurnStartedAt: Date.now() - 16_200,
    agentConsole: consoleSnapshot({
      agents: [
        agentRun("r1"),
        agentRun("r2"),
        agentRun("r3", { status: "waiting" }),
        agentRun("r4"),
        agentRun("r5", { status: "completed", completedAt: 2_000 }),
      ],
      jobs: [
        asyncJob("j1"),
        asyncJob("j2"),
        asyncJob("j3"),
        asyncJob("j4", { status: "queued" }),
        asyncJob("j5", { status: "completed", completedAt: 2_000 }),
      ],
    }),
  });

  const lines = spinnerLines(frame);
  assert.equal(lines.length, 1, `expected exactly one motion surface, received:\n${frame}`);
  assert.match(
    lines[0],
    /gpt-5\.4 · 작업 모드 · 4 agents · 4 jobs · Reading context · \d+s\s*$/u,
  );
});

test("the status row counts a job and its owning agent once", async () => {
  const frame = await renderStatusFrame({
    agentConsole: consoleSnapshot({
      agents: [agentRun("r1")],
      jobs: [asyncJob("j1", { agentRunId: "r1" })],
    }),
  });

  const lines = spinnerLines(frame);
  assert.equal(lines.length, 1, `expected exactly one motion surface, received:\n${frame}`);
  assert.match(lines[0], /1 job · Working/u);
  assert.doesNotMatch(lines[0], /1 agent/u);
});

test("the status row omits agent and job counts once nothing is live", async () => {
  const frame = await renderStatusFrame({
    isBusy: true,
    busyStatus: "read src/app.ts",
    currentTurnStartedAt: Date.now() - 3_200,
    agentConsole: consoleSnapshot({
      agents: [agentRun("r1", { status: "completed", completedAt: 2_000 })],
      jobs: [asyncJob("j1", { status: "cancelled", completedAt: 2_000 })],
    }),
  });

  const lines = spinnerLines(frame);
  assert.equal(lines.length, 1, `expected exactly one motion surface, received:\n${frame}`);
  assert.match(lines[0], /gpt-5\.4 · 작업 모드 · Reading context · 3\.\ds\s*$/u);
  assert.doesNotMatch(lines[0], /agent|job/u);
});

test("delegated work alone keeps the status row live while the main turn is idle", async () => {
  const frame = await renderStatusFrame({
    isBusy: false,
    agentConsole: consoleSnapshot({
      agents: [agentRun("r1"), agentRun("r2")],
      jobs: [asyncJob("j1", { status: "queued" })],
    }),
  });

  const lines = spinnerLines(frame);
  assert.equal(lines.length, 1, `expected exactly one motion surface, received:\n${frame}`);
  assert.match(lines[0], /gpt-5\.4 · 작업 모드 · 2 agents · 1 job · Working\s*$/u);
  assert.doesNotMatch(frame, /◇ gpt-5\.4/u, "the idle glyph must yield to the busy spinner");
});

test("an auth warning keeps its slot beside the live counts", async () => {
  const frame = await renderStatusFrame({
    authLabel: "OAuth · needs API key",
    isBusy: true,
    busyStatus: "read src/app.ts",
    currentTurnStartedAt: Date.now() - 2_100,
    agentConsole: consoleSnapshot({ agents: [agentRun("r1")] }),
  });

  const lines = spinnerLines(frame);
  assert.equal(lines.length, 1, `expected exactly one motion surface, received:\n${frame}`);
  assert.match(
    lines[0],
    /gpt-5\.4 · 작업 모드 · OAuth · needs API key · 1 agent · Reading context · \d\.\ds\s*$/u,
  );
});

test("a formatted auth warning remains visible in the narrow status row", async () => {
  const frame = await renderStatusFrame({
    authLabel: "OAuth · needs API key",
    isBusy: true,
    busyStatus: "read src/app.ts",
    currentTurnStartedAt: Date.now() - 2_100,
    terminalColumns: 52,
    agentConsole: consoleSnapshot({ agents: [agentRun("r1")] }),
  });

  const lines = spinnerLines(frame);
  assert.equal(lines.length, 1, `expected exactly one motion surface, received:\n${frame}`);
  assert.match(lines[0], /gpt-5\.4 · OAuth · needs API key/u);
});

test("elapsed labels keep advancing when the wall clock jumps back", async () => {
  const realNow = Date.now;
  const start = realNow();
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, statusProps({
      isBusy: true,
      busyStatus: "read src/app.ts",
      currentTurnStartedAt: start - 30_000,
    })),
    { columns: 120, rows: 40 },
  );

  const readElapsedSeconds = () => {
    const line = spinnerLines(getLastWorkShellFrame(getOutput()))[0] ?? "";
    const match = /·\s+(\d+)s\s*$/u.exec(line);
    assert.ok(match, `expected a whole-second elapsed label, received: ${JSON.stringify(line)}`);
    return Number(match[1]);
  };

  try {
    await waitForSettledFrame(getOutput);
    const before = readElapsedSeconds();
    // A backwards NTP correction. Nothing about the turn changed.
    Date.now = () => start - 600_000;
    await delay(1_200);
    const after = readElapsedSeconds();
    assert.ok(
      after > before,
      `elapsed froze after the wall-clock correction: ${before}s then ${after}s`,
    );
  } finally {
    Date.now = realNow;
    instance.unmount();
    instance.cleanup();
  }
});
