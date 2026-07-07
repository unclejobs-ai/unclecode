import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { render } from "ink";
import React from "react";

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
  assert.deepEqual(formatWorkShellPanelEmptyLines("MCP"), [
    "No details in MCP yet.",
    "Keep typing, or use / for commands.",
  ]);

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

test("WorkShellView renders /context as an interactive source inspector", async () => {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.4",
      reasoningLabel: "medium",
      reasoningSupported: true,
      mode: "Default",
      authLabel: "Saved OAuth",
      entries: [],
      isBusy: false,
      activePanel: { title: "Context expanded", lines: ["fallback line"] },
      contextInspectorCursor: 1,
      contextInspectorExpanded: "bridge-1",
      contextPacket: {
        id: "packet-test",
        version: 1,
        generatedAt: "2026-07-07T00:00:00.000Z",
        title: "Next answer context",
        included: [
          {
            id: "workspace-1",
            category: "workspace",
            label: "AGENTS.md",
            reason: "workspace guidance",
            preview: "Workspace instructions stay active.",
            tokenEstimate: 42,
            salience: 1,
            includedInModel: true,
          },
          {
            id: "bridge-1",
            category: "bridge",
            label: "recent Q&A",
            reason: "session bridge",
            preview: "반갑다. 컨텍스트 인스펙터에서 선택한 행은 펼쳐져야 한다.",
            tokenEstimate: 24,
            salience: 0.7,
            includedInModel: true,
          },
        ],
        excluded: [
          {
            id: "loop-1",
            category: "loop-trail",
            label: ".omo/ulw-loop/session/ledger.jsonl",
            reason: "raw trail stays local",
            preview: ".omo/ulw-loop/session/ledger.jsonl contains raw evidence",
            sourceCount: 3,
            includedInModel: false,
          },
        ],
        warnings: [],
        preview: ["UncleCode will carry selected summaries into the next answer."],
        sourceCounts: { included: 2, excluded: 3, warnings: 0 },
        tokenEstimate: 66,
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

  assert.match(output, /UncleCode Runbook/);
  assert.match(output, /Enter pin\/unpin/);
  assert.match(output, /◆ pinned.*AGENTS\.md/s);
  assert.match(output, /▶ .*bridge.*◇ pin.*recent Q&A/s);
  assert.match(output, /반갑다\. 컨텍스트 인스펙터에서 선택한 행은 펼쳐져야 한다\./);
  assert.match(output, /⊘ Held back locally/);
  assert.match(output, /i include.*session loop trail/s);
  assert.doesNotMatch(output, /\.omo\/ulw-loop/);
});

test("WorkShellView keeps model picker overlay visible when a context packet exists", async () => {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.5",
      reasoningLabel: "low",
      reasoningSupported: true,
      mode: "Default",
      authLabel: "Saved OAuth",
      entries: [],
      isBusy: false,
      activePanel: {
        title: "Model picker",
        lines: [
          "Current model",
          "Model · gpt-5.5",
          "Thinking choices · low / medium / high / default",
          "Controls",
          "Type filter · /model <name> [low|medium|high|default] · Esc close",
        ],
      },
      contextPacket: {
        id: "packet-test",
        version: 1,
        generatedAt: "2026-07-07T00:00:00.000Z",
        title: "Next answer context",
        included: [
          {
            id: "workspace-1",
            category: "workspace",
            label: "AGENTS.md",
            reason: "workspace guidance",
            preview: "Workspace instructions stay active.",
          },
        ],
        excluded: [],
        warnings: [],
        preview: [],
        sourceCounts: { included: 1, excluded: 0, warnings: 0 },
        tokenEstimate: 42,
      },
      composer: React.createElement("span", null, ""),
      inputValue: "",
      slashSuggestionCount: 1,
      terminalColumns: 100,
      cwd: "/Users/parkeungje/project/unclecode",
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  const output = getOutput();
  instance.unmount();
  instance.cleanup();

  assert.match(output, /Model picker/);
  assert.match(output, /Thinking choices · low \/ medium \/ high \/ default/);
  assert.doesNotMatch(output, /UncleCode Runbook/);
});

test("WorkShellView windows long /context source lists around the cursor", async () => {
  const included = Array.from({ length: 24 }, (_, index) => ({
    id: `workspace-${index}`,
    category: "workspace",
    label: `workspace source ${index}`,
    reason: "workspace context",
    preview: `workspace preview ${index}`,
    tokenEstimate: 5,
    includedInModel: true,
  }));
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.4",
      reasoningLabel: "medium",
      reasoningSupported: true,
      mode: "Default",
      authLabel: "Saved OAuth",
      entries: [],
      isBusy: false,
      activePanel: { title: "Context expanded", lines: ["fallback line"] },
      contextInspectorCursor: 14,
      contextPacket: {
        id: "packet-long-test",
        version: 1,
        generatedAt: "2026-07-07T00:00:00.000Z",
        title: "Next answer context",
        included,
        excluded: [],
        warnings: [],
        preview: [],
        sourceCounts: { included: included.length, excluded: 0, warnings: 0 },
        tokenEstimate: 120,
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

  assert.match(output, /… \d+ more above/);
  assert.match(output, /… \d+ more below/);
  assert.match(output, /▶ .*workspace source 14/s);
  assert.doesNotMatch(output, /workspace source 0/);
});

test("resolveReadableWorkShellTextColor keeps primary text explicit for light terminals", () => {
  assert.equal(resolveReadableWorkShellTextColor("#f8fafc"), "#0f172a");
  assert.equal(resolveReadableWorkShellTextColor("#e2e8f0"), "#0f172a");
  assert.equal(resolveReadableWorkShellTextColor("#0f172a"), "#0f172a");
  // Rust entry-presentation body colors that are too dark on dark backgrounds
  // are resolved to the palette's primary text color for readability.
  assert.equal(resolveReadableWorkShellTextColor("#334155"), "#0f172a");
  assert.equal(resolveReadableWorkShellTextColor("#475569"), "#0f172a");
  assert.equal(resolveReadableWorkShellTextColor("#94a3b8"), "#475569");
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
