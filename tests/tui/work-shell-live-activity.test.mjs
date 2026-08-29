import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { PassThrough, Writable } from "node:stream";

import React from "react";
import { render } from "ink";

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
import { WorkShellPane } from "../../packages/tui/src/index.tsx";
import {
  getWorkShellSlashSuggestions,
  shouldBlockSlashSubmit,
} from "../../packages/orchestrator/src/index.ts";

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

test("busy WorkShellView renders one inline activity in the composer dock", async () => {
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

  const rows = frame.split("\n");
  const spinnerLines = rows.filter((line) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u.test(line));
  assert.equal(spinnerLines.length, 1, `expected one motion surface, received:\n${frame}`);
  assert.match(spinnerLines[0], /Thinking through the next step · \d+(?:\.\d+)?(?:ms|s)/u);
  // The activity row is pinned directly above the dock's hint row — the busy
  // display rides with the input, and the top status row is idle-only.
  const activityIndex = rows.indexOf(spinnerLines[0]);
  const hintIndex = rows.findIndex((row) => row.includes("Enter queue"));
  assert.ok(hintIndex > activityIndex, `activity row should sit above the hint row, received:\n${frame}`);
  // User entries also carry a `◇` badge, so the idle row is asserted by its
  // text: no `◇ Ready` while the busy dock row owns the frame.
  assert.doesNotMatch(frame, /◇ Ready/u, "the idle status row must not render while busy");
  // Identity lives in the header; the busy row carries live state only.
  const headerLine = rows.find((line) => line.includes("UncleCode"));
  assert.ok(headerLine !== undefined, "the header wordmark line should render");
  assert.match(headerLine, /gemini-2\.5-flash/u);
  assert.doesNotMatch(spinnerLines[0], /gemini-2\.5-flash/u);
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
  // Task 9: the narrow busy row lives in the dock without the model — the
  // header still carries the identity facts it can fit.
  assert.match(statusLine, /Thinking.*\d+(?:\.\d+)?(?:ms|s)/u);
  assert.ok(getDisplayWidth(statusLine) <= 52, `status row exceeded terminal width: ${statusLine}`);
  assert.match(frame, /gemini-2\.5-flash/u, "the header keeps the model visible when it fits");
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

  assert.match(output, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+Preparing context/u);
  assert.doesNotMatch(output, /\bBusy\b/u);
  assert.doesNotMatch(output, /Ready for the next move/);
  assert.doesNotMatch(
    output,
    /╭─|╰─/,
    "busy empty conversation should not render the idle bordered card",
  );
});

test("the shell surfaces auth only when it needs action", async () => {
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
  // Identity (model · mode) lives in the header now, so the status row is
  // state only: a fresh session reads as one slim "◇ Ready" line. Healthy
  // auth is deliberately absent everywhere: "Saved OAuth" never changes
  // mid-session, so it spent a slot confirming nothing was wrong. See the
  // warning case below.
  const statusFrame = getLastWorkShellFrame(output);
  const headerLine = statusFrame.split("\n").find((line) => line.includes("UncleCode"));
  assert.ok(headerLine !== undefined, "the header wordmark line should render");
  assert.match(headerLine, /gpt-5\.4 · YOLO mode/u);
  const idleLine = statusFrame.split("\n").find((line) => line.includes("◇"));
  assert.ok(idleLine !== undefined, "the idle status row should render");
  assert.match(idleLine, /◇ Ready\s*$/u);
  assert.doesNotMatch(idleLine, /gpt-5\.4|YOLO mode/u);
  assert.doesNotMatch(output, /Saved OAuth/);
  // A fresh session reports no timing rather than the words "no reply yet".
  assert.doesNotMatch(output, /no reply yet/);
  assert.match(output, /Ready for the next move/);
  assert.match(output, /Type a task, \/context to see what gets sent/);
  // The Start/Inspect/Recover triplet is gone; the hint and the composer's own
  // key legend already carry it.
  assert.doesNotMatch(output, /Type the task in plain language/);
  assert.doesNotMatch(output, /Use Ctrl\+O for saved sessions/);
  // The composer dock keeps its unlabeled soft rule — a full `─` row directly
  // above the `›` input row. (The header rule is also a `─` row, so the
  // adjacent glyph row is what identifies the dock's own divider.)
  const statusRows = statusFrame.split("\n");
  const dockDividerRow = statusRows.findIndex(
    (row, index) => /^─+$/.test(row.trim()) && (statusRows[index + 1] ?? "").trimStart().startsWith("›"),
  );
  assert.ok(dockDividerRow > 0, "the composer dock divider should render below the status row");
  // The dock activity row is busy-only: an idle frame carries no spinner
  // glyph anywhere (one spinner per surface, and idle has none at all).
  assert.doesNotMatch(statusFrame, SPINNER, "idle frames must not render a spinner glyph");
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

// Task 9: the live activity row the dock owns reports how much delegated work
// is running, and its elapsed label is anchored to a monotonic clock so an NTP
// correction cannot make a running turn look younger than it is.

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
    /4 agents · 4 jobs · Reading context · \d+s\s*$/u,
  );
  assert.doesNotMatch(lines[0], /gpt-5\.4|Work mode/u, "identity belongs to the header, not the busy row");
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
  assert.match(lines[0], /Reading context · 3\.\ds\s*$/u);
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
  assert.match(lines[0], /2 agents · 1 job · Working\s*$/u);
  assert.doesNotMatch(lines[0], /◇/u, "the idle glyph must yield to the busy spinner");
});

test("an auth warning rides the header while the busy row counts live work", async () => {
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
    /1 agent · Reading context · \d\.\ds\s*$/u,
  );
  assert.doesNotMatch(lines[0], /needs API key/u, "the warning chip belongs to the header now");
  const headerLine = frame.split("\n").find((line) => line.includes("UncleCode"));
  assert.ok(headerLine !== undefined, "the header wordmark line should render");
  assert.match(
    headerLine,
    /gpt-5\.4 · Work mode · OAuth · needs API key/u,
    "the auth warning chip should ride after the session facts on the header row",
  );
});

test("a formatted auth warning remains visible in the narrow header while the busy row lives in the dock", async () => {
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
  // Task 9: the narrow busy row moved to the dock and no longer repeats the
  // model or auth; the header keeps carrying the warning chip.
  assert.match(lines[0], /1 agent · Reading context/u);
  assert.doesNotMatch(lines[0], /gpt-5\.4|OAuth/u);
  assert.match(frame, /OAuth · needs API key/u, "the header chip keeps the warning visible");
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

// Task 10: the running turn's trace tail rides the composer dock — dim rows
// directly under the activity line and above the hint row, newest line last,
// one truncated row per line. The transcript's own trace filtering is
// unchanged: these raw lines never enter the conversation rail.

test("busy WorkShellView streams the newest trace lines above the prompt row", async () => {
  const traceLines = [
    "→ read packages/tui/src/work-shell-view.tsx",
    "→ search \"traceLines\" in packages/tui/src",
    "✓ edit packages/tui/src/work-shell-pane.tsx",
  ];
  const frame = await renderStatusFrame({
    isBusy: true,
    busyStatus: "read src/app.ts",
    currentTurnStartedAt: Date.now() - 1_000,
    liveToolTraceLines: traceLines,
  });

  const rows = frame.split("\n");
  const activityIndex = rows.findIndex((row) => SPINNER.test(row));
  assert.ok(activityIndex >= 0, `expected the dock activity row, received:\n${frame}`);
  const promptIndex = rows.findIndex((row) => row.trimStart().startsWith("›"));
  assert.ok(promptIndex > activityIndex, `the prompt row should sit below the activity row, received:\n${frame}`);
  const feedIndexes = traceLines.map((line) => rows.findIndex((row) => row.includes(line)));
  for (const [position, feedIndex] of feedIndexes.entries()) {
    assert.ok(
      feedIndex > activityIndex,
      `trace line ${position} should render below the activity row, received:\n${frame}`,
    );
    assert.ok(
      feedIndex < promptIndex,
      `trace line ${position} should render above the › row, received:\n${frame}`,
    );
    if (position > 0) {
      assert.ok(
        feedIndex > feedIndexes[position - 1],
        `trace lines should keep chronological order (newest last), received:\n${frame}`,
      );
    }
  }
});

test("idle WorkShellView renders no tool trace feed", async () => {
  const frame = await renderStatusFrame({
    liveToolTraceLines: ["→ read src/app.ts"],
  });

  assert.doesNotMatch(frame, /→ read src\/app\.ts/u, "the feed is busy-only");
  assert.doesNotMatch(frame, SPINNER, "idle frames must not render a spinner glyph");
});

test("an over-width trace line truncates to a single dock row", async () => {
  const frame = await renderStatusFrame({
    terminalColumns: 52,
    isBusy: true,
    busyStatus: "read src/app.ts",
    currentTurnStartedAt: Date.now() - 1_000,
    liveToolTraceLines: [`→ read ${"packages/tui/src/work-shell-".repeat(8)}pane.tsx`],
  });

  const feedRows = frame.split("\n").filter((row) => row.includes("→ read packages/tui/src"));
  assert.equal(feedRows.length, 1, `expected one truncated feed row, received:\n${frame}`);
  assert.ok(getDisplayWidth(feedRows[0]) <= 52, `feed row exceeded terminal width: ${feedRows[0]}`);
  assert.match(feedRows[0], /…/u, "truncation should leave an ellipsis");
  assert.doesNotMatch(frame, /pane\.tsx/u, "the truncated tail must not wrap onto a second row");
});

// Task 5: the feed's source is the engine's always-filled `liveTraceLines`
// buffer, not the verbose-only `traceLines` — so the busy dock stays alive in
// default (minimal) trace mode. These pane-level cases inject the buffer the
// way the engine does and prove the wiring end to end.

function createLiveFeedPaneEngine(overrides = {}) {
  let state = {
    entries: [],
    model: "gpt-5.4",
    mode: "default",
    reasoning: "medium",
    authLabel: "oauth-file",
    isBusy: false,
    bridgeLines: [],
    memoryLines: [],
    panel: { title: "Session status", lines: ["Work context ready."] },
    traceMode: "minimal",
    traceLines: [],
    ...overrides,
  };
  const listeners = new Set();
  return {
    engine: {
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      initialize: async () => {},
      dispose: () => {},
      handleSubmit: async () => {},
      setMode: async () => {},
      openSessionsPanel: async () => {},
    },
  };
}

function renderLiveFeedPane(engine) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.resume = () => stdin;
  stdin.pause = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.isTTY = true;
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const stderr = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  stderr.columns = 100;
  stderr.rows = 30;
  stderr.isTTY = true;
  const instance = render(
    React.createElement(WorkShellPane, {
      provider: "OpenAI",
      model: "gpt-5.4",
      mode: "default",
      engine,
      cwd: "/tmp/unclecode-live-feed-workspace",
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
    {
      stdin,
      stdout,
      stderr,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  return { instance, getOutput: () => output };
}

test("busy pane streams the liveTraceLines tail in minimal trace mode", async () => {
  const liveTraceLines = Array.from(
    { length: 8 },
    (_, index) => `→ read src/step-0${index + 1}.ts`,
  );
  const { instance, getOutput } = renderLiveFeedPane(createLiveFeedPaneEngine({
    isBusy: true,
    busyStatus: "read src/app.ts",
    currentTurnStartedAt: Date.now() - 1_000,
    liveTraceLines,
  }).engine);

  await waitForSettledFrame(getOutput);
  const frame = getLastWorkShellFrame(getOutput());
  instance.unmount();
  instance.cleanup();

  const rows = frame.split("\n");
  const activityIndex = rows.findIndex((row) => SPINNER.test(row));
  assert.ok(activityIndex >= 0, `expected the dock activity row, received:\n${frame}`);
  const promptIndex = rows.findIndex((row) => row.trimStart().startsWith("›"));
  assert.ok(promptIndex > activityIndex, `the prompt row should sit below the activity row, received:\n${frame}`);
  for (const line of liveTraceLines.slice(-3)) {
    const feedIndex = rows.findIndex((row) => row.includes(line));
    assert.ok(
      feedIndex > activityIndex && feedIndex < promptIndex,
      `feed line ${line} should render between the activity row and the › row, received:\n${frame}`,
    );
  }
  for (const line of liveTraceLines.slice(0, liveTraceLines.length - 3)) {
    assert.ok(
      !frame.includes(line),
      `older buffer line ${line} must stay out of the 3-row dock feed, received:\n${frame}`,
    );
  }
});

test("idle pane renders no liveTraceLines feed even with a filled buffer", async () => {
  const { instance, getOutput } = renderLiveFeedPane(createLiveFeedPaneEngine({
    liveTraceLines: ["→ read src/app.ts"],
  }).engine);

  await waitForSettledFrame(getOutput);
  const frame = getLastWorkShellFrame(getOutput());
  instance.unmount();
  instance.cleanup();

  assert.doesNotMatch(frame, /→ read src\/app\.ts/u, "the liveTraceLines feed is busy-only");
  assert.doesNotMatch(frame, SPINNER, "idle frames must not render a spinner glyph");
});
