import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import React from "react";

import { WorkShellView } from "../../packages/tui/src/work-shell-view.tsx";
import { getDisplayWidth } from "../../packages/tui/src/text-width.ts";
import { renderDebugFrame, waitForSettledFrame } from "./work-shell-render-harness.mjs";

process.env.UNCLECODE_TERMINAL_BACKGROUND = "light";

const RAW_PROMPT_SENTINEL = "RAW_EXECUTOR_PROMPT_SENTINEL_DO_NOT_SHOW";
const RAW_OUTPUT_SENTINEL = "RAW_TOOL_OUTPUT_SENTINEL_DO_NOT_SHOW";

const PATCH = [
  "@@ -8,7 +8,9 @@",
  "   resetProbedTerminalBackground,",
  "+// Restores env and the probe cache after `run` finishes.",
  "-  try {",
].join("\n");

function runningSnapshot() {
  return {
    profileId: "build",
    workGraph: {
      id: "goal-1",
      goal: "Ship authentication",
      approval: "approved",
      nodes: Array.from({ length: 6 }, (_, index) => ({
        id: `n${index + 1}`,
        title: `Task ${index + 1}`,
        prompt: `${RAW_PROMPT_SENTINEL} ${index + 1}`,
        status: index === 0 ? "completed" : index === 1 ? "running" : "ready",
        dependsOn: index === 0 ? [] : [`n${index}`],
        fileOwnership: [],
        acceptanceCriteria: ["observable proof"],
        evidenceRefs: [],
      })),
    },
    activity: [
      {
        id: "tool-1",
        toolCallId: "call-1",
        toolName: "read_file",
        kind: "read",
        intent: "Read session state",
        target: "session.json",
        status: "completed",
        summary: "completed · 12ms · 48 lines",
        startedAt: 1_010,
        completedAt: 1_022,
        agentRunId: "r1",
        preview: PATCH,
        output: RAW_OUTPUT_SENTINEL,
      },
    ],
    agents: [
      {
        id: "r1",
        displayName: "RuntimeMap",
        agentType: "scout",
        status: "running",
        parentRunId: "r0",
        currentActivity: "Reading runtime",
        startedAt: 1_000,
        usage: { eventIds: ["u1"], costUsd: 0.5, inputTokens: 1_200 },
      },
      {
        id: "r2",
        displayName: "DocsMap",
        agentType: "scout",
        status: "completed",
        startedAt: 1_000,
        completedAt: 4_000,
        summary: "Mapped docs.",
      },
    ],
    jobs: [
      {
        id: "job-1",
        type: "work-node",
        label: "Map runtime",
        status: "running",
        agentRunId: "r1",
        queuedAt: 900,
        startedAt: 1_000,
      },
    ],
    mainUsage: { eventIds: ["usage-main-1"], costUsd: 0.25 },
  };
}

function baseProps(overrides = {}) {
  return {
    provider: "openai",
    model: "gpt-5.4",
    reasoningLabel: "medium",
    reasoningSupported: true,
    mode: "Default",
    authLabel: "Saved OAuth",
    entries: [],
    isBusy: false,
    activePanel: { title: "", lines: [] },
    composer: React.createElement("span", null, ""),
    inputValue: "",
    slashSuggestionCount: 0,
    cwd: "/tmp/unclecode-test-workspace",
    agentConsole: runningSnapshot(),
    ...overrides,
  };
}

async function renderFrame(overrides, columns) {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, { ...baseProps(overrides), terminalColumns: columns }),
    { columns, rows: 44 },
  );
  await waitForSettledFrame(getOutput);
  const output = stripVTControlCharacters(getOutput());
  instance.unmount();
  instance.cleanup();
  return output;
}

function consoleView(overrides = {}) {
  return {
    open: true,
    tab: "agents",
    cursor: 0,
    inspectorVisible: true,
    control: { kind: "browse" },
    ...overrides,
  };
}

test("the Agent Console shows roster and inspector side by side at 100 columns", async () => {
  const frame = await renderFrame({ agentConsoleView: consoleView() }, 100);

  assert.match(frame, /\[Agents\]/, "the active tab must be marked with text, not colour alone");
  assert.match(frame, /Jobs/);
  assert.match(frame, /Plan/);
  // `DocsMap` is a roster-only row (the cursor selects `RuntimeMap`), and
  // `Elapsed` is an inspector-only fact label. Both present means two panes.
  assert.match(frame, /DocsMap/, "the roster pane must stay visible beside the inspector");
  assert.match(frame, /Elapsed/, "the inspector pane must render beside the roster");
  assert.match(frame, /Esc close/, "key hints are always visible");
  assert.doesNotMatch(frame, new RegExp(RAW_PROMPT_SENTINEL));
  assert.doesNotMatch(frame, new RegExp(RAW_OUTPUT_SENTINEL));
});

test("the Agent Console renders only the inspector pane at 80 columns", async () => {
  const frame = await renderFrame({ agentConsoleView: consoleView() }, 80);

  assert.match(frame, /Elapsed/, "the selected pane is the inspector while it is visible");
  assert.doesNotMatch(frame, /DocsMap/, "the roster pane must not share a narrow terminal");
  assert.match(frame, /\[Agents\]/);
  assert.match(frame, /Esc close/);
  assert.doesNotMatch(frame, new RegExp(RAW_PROMPT_SENTINEL));
  assert.doesNotMatch(frame, new RegExp(RAW_OUTPUT_SENTINEL));
});

test("the Agent Console falls back to the roster pane at 80 columns with the inspector hidden", async () => {
  const frame = await renderFrame(
    { agentConsoleView: consoleView({ inspectorVisible: false }) },
    80,
  );

  assert.match(frame, /DocsMap/, "the roster is the selected pane once the inspector is hidden");
  assert.doesNotMatch(frame, /Elapsed/, "a hidden inspector must not share a narrow terminal");
  assert.match(frame, /Esc close/);
});

test("the default shell shows a bounded goal and agent HUD instead of the detailed tool ledger", async () => {
  const frame = await renderFrame({}, 100);

  assert.match(frame, /Ship authentication · 1\/6/, "goal progress stays in the default HUD");
  assert.match(frame, /RuntimeMap · running/, "active agent rows stay in the default HUD");
  assert.match(frame, /… \+3 more/, "the WorkGraph HUD is bounded to three rows");

  // The removed detailed ledger: per-call kind column, its metric tail, and
  // the diff preview it hung under each write.
  assert.doesNotMatch(frame, /Read session state/, "detailed tool-ledger rows are gone");
  assert.doesNotMatch(frame, /48 lines/, "the tool metric column is gone");
  assert.doesNotMatch(frame, /⎿ Added/, "the default shell no longer previews diffs");
  assert.doesNotMatch(frame, new RegExp(RAW_PROMPT_SENTINEL));
  assert.doesNotMatch(frame, new RegExp(RAW_OUTPUT_SENTINEL));
});

/**
 * Ink writes one whole frame per render in debug mode and the harness
 * accumulates them, so physical-height assertions must read the newest frame.
 * Every frame opens on the work-shell header.
 */
function lastFrame(output) {
  const marker = output.lastIndexOf("UncleCode ·");
  return (marker < 0 ? output : output.slice(marker)).trimEnd();
}

function physicalRows(output) {
  return lastFrame(output).split("\n").length;
}

const HOSTILE_TAIL = "\n두 번째 줄\u0007 그리고 아주 긴 한국어 문자열이 계속 이어집니다 계속 계속 계속";

/**
 * Same shape as the benign fixture, hostile values. `parseAgentConsoleSnapshot`
 * accepts every one of these strings, so the renderer is the only thing that
 * can keep them on one row.
 */
function hostileSnapshot() {
  const base = runningSnapshot();
  const nastier = (value) => `${value}${HOSTILE_TAIL}`;
  return {
    ...base,
    workGraph: {
      ...base.workGraph,
      goal: nastier(base.workGraph.goal),
      nodes: base.workGraph.nodes.map((node) => ({ ...node, title: nastier(node.title) })),
    },
    activity: base.activity.map((entry) => ({
      ...entry,
      intent: nastier(entry.intent),
      summary: nastier(entry.summary),
    })),
    agents: base.agents.map((run) => ({
      ...run,
      displayName: nastier(run.displayName),
      ...(run.currentActivity ? { currentActivity: nastier(run.currentActivity) } : {}),
      ...(run.summary ? { summary: nastier(run.summary) } : {}),
    })),
    jobs: base.jobs.map((job) => ({ ...job, label: nastier(job.label) })),
  };
}

test("the Agent Console breakpoint follows the terminal, not the inner layout width", async () => {
  const narrow = await renderFrame({ agentConsoleView: consoleView() }, 83);
  assert.match(narrow, /Elapsed/, "83 columns is one pane: the visible inspector");
  assert.doesNotMatch(narrow, /DocsMap/, "83 columns must not open a second pane");

  // The console breakpoint is a terminal-width contract. Charging the chrome's
  // own four columns against it moved the real breakpoint to 88.
  for (const columns of [84, 87]) {
    const wide = await renderFrame({ agentConsoleView: consoleView() }, columns);
    assert.match(wide, /DocsMap/, `${columns} columns must show the roster pane`);
    assert.match(wide, /Elapsed/, `${columns} columns must show the inspector pane`);
  }
});

test("hostile agent, job and task strings never change the console's physical height", async () => {
  // Every tab: the agents tab carries lineage and activity, the jobs tab adds
  // the owner name, and the plan tab adds dependency and ownership lists.
  for (const tab of ["agents", "jobs", "plan"]) {
    const benign = await renderFrame({ agentConsoleView: consoleView({ tab }) }, 84);
    const hostile = await renderFrame(
      { agentConsole: hostileSnapshot(), agentConsoleView: consoleView({ tab }) },
      84,
    );

    assert.equal(
      physicalRows(hostile),
      physicalRows(benign),
      `${tab}: a newline or over-long field must be flattened and budgeted, not wrapped by ink`,
    );
    assert.match(hostile, /Esc close/, `${tab}: key hints survive hostile content`);
    assert.match(hostile, /Jobs/, `${tab}: tabs survive hostile content`);
  }
});

test("hostile goal, task and agent strings never change the default HUD's physical height", async () => {
  const benign = await renderFrame({}, 84);
  const hostile = await renderFrame({ agentConsole: hostileSnapshot() }, 84);

  assert.equal(physicalRows(hostile), physicalRows(benign));
});

test("emoji task titles are measured as ink renders them, so the HUD row never wraps", async () => {
  const withTitle = (title) => {
    const base = runningSnapshot();
    return {
      ...base,
      workGraph: {
        ...base.workGraph,
        nodes: base.workGraph.nodes.map((node, index) => (index === 1 ? { ...node, title } : node)),
      },
    };
  };

  const ascii = await renderFrame({ agentConsole: withTitle("R".repeat(40)) }, 60);
  const emoji = await renderFrame({ agentConsole: withTitle("\u{1F680}".repeat(40)) }, 60);

  // Counting a rocket as one cell keeps twice the glyphs the row can hold, so
  // ink wraps the "truncated" row onto a second line.
  assert.equal(physicalRows(emoji), physicalRows(ascii));
});

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

test("an idle main turn still advances elapsed labels while an agent is running", async () => {
  const base = runningSnapshot();
  const startedAt = Date.now() - 2_000;
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      ...baseProps({
        agentConsole: {
          ...base,
          agents: [{ ...base.agents[0], startedAt }],
          jobs: [],
        },
      }),
      terminalColumns: 100,
    }),
    { columns: 100, rows: 44 },
  );
  try {
    await waitForSettledFrame(getOutput);
    assert.match(stripVTControlCharacters(getOutput()), /RuntimeMap · running 2s/);
    // No keypress, no engine event — only the shell's own clock.
    await delay(1_400);
    const elapsed = [...stripVTControlCharacters(getOutput()).matchAll(/RuntimeMap · running (\d+)s/g)]
      .map((match) => Number(match[1]));
    assert.ok(Math.max(...elapsed) > 2, `elapsed label did not advance: ${elapsed.join(", ")}`);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("the shell clock stops once no console record is still active", async () => {
  const base = runningSnapshot();
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      ...baseProps({
        agentConsole: {
          ...base,
          agents: base.agents.map((run) => ({ ...run, status: "completed", completedAt: run.startedAt + 10 })),
          jobs: base.jobs.map((job) => ({ ...job, status: "completed", completedAt: job.queuedAt + 10 })),
        },
      }),
      terminalColumns: 100,
    }),
    { columns: 100, rows: 44 },
  );
  try {
    await waitForSettledFrame(getOutput);
    const settled = getOutput();
    await delay(1_400);
    assert.equal(getOutput(), settled, "a settled console must not repaint the shell on a timer");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

/**
 * A CRLF patch carrying a tab, a BEL, and a real ANSI colour sequence — all of
 * it contract-valid preview content.
 */
const CONTROL_PATCH = [
  "@@ -8,7 +8,9 @@",
  "   resetProbedTerminalBackground,\r",
  "+\tconst label = \u001b[31mred\u001b[0m;\r",
  "+\u0007alert();\r",
  "-  try {\r",
].join("\n");

/** C0 except newline, plus C1 and the Unicode line/paragraph separators. */
const LAYOUT_BREAKING = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/;

test("a diff preview cannot smuggle control bytes into the rendered console", async () => {
  const base = runningSnapshot();
  const columns = 100;
  const frame = await renderFrame(
    {
      agentConsole: {
        ...base,
        activity: base.activity.map((entry) => ({ ...entry, preview: CONTROL_PATCH })),
      },
      agentConsoleView: consoleView(),
    },
    columns,
  );

  // `stripVTControlCharacters` removes ink's own colour sequences but leaves a
  // stray tab, CR, or BEL behind — exactly the bytes a preview must not carry.
  const offending = frame
    .split("\n")
    .filter((line) => LAYOUT_BREAKING.test(line))
    .map((line) => JSON.stringify(line));
  assert.deepEqual(offending, [], "a preview row reached the terminal with a control byte");

  for (const line of frame.split("\n")) {
    assert.ok(
      getDisplayWidth(line) <= columns,
      `frame line measured ${getDisplayWidth(line)} cells: ${line}`,
    );
  }
  assert.match(frame, /⎿ Added \d+ lines?, removed \d+ lines?/, "the diff summary row survives");
  assert.match(frame, /const label/, "the changed content survives");
  assert.match(frame, /Esc close/, "key hints stay visible");
});

// Task 8 left the console's two control states invisible: `x` armed a modal
// confirmation with nothing on screen saying so, and every rejected or
// undeliverable operation produced silence. Both are rendered from view state
// alone, so a settled console cannot strand a question or a stale outcome.

test("an armed cancel confirmation asks an explicit question naming the selected run", async () => {
  const frame = await renderFrame(
    {
      agentConsoleView: consoleView({
        control: { kind: "confirm-cancel", agentRunId: "r1" },
      }),
    },
    100,
  );

  assert.match(frame, /Cancel RuntimeMap\?/, "the question must name the run it will cancel");
  assert.match(frame, /y confirm/, "y is the accepted confirmation key");
  assert.match(frame, /n keep running/, "n is the accepted decline key");
  assert.match(frame, /Esc dismiss/, "Esc is the accepted dismissal key");
});

test("a browsing console carries no cancel question and no outcome row", async () => {
  const frame = await renderFrame({ agentConsoleView: consoleView() }, 100);

  assert.doesNotMatch(frame, /Cancel RuntimeMap\?/, "an unarmed console must not ask");
  assert.doesNotMatch(frame, /y confirm/);
  assert.match(frame, /Esc close/, "the ordinary key hints are still there");
});

test("a declined confirmation leaves no stale question behind", async () => {
  const frame = await renderFrame(
    {
      agentConsoleView: consoleView({
        control: { kind: "browse" },
        receipt: { status: "rejected", message: "Select a running agent to cancel." },
      }),
    },
    100,
  );

  assert.doesNotMatch(frame, /Cancel RuntimeMap\?/);
  assert.match(frame, /Control rejected/);
});

test("an accepted control outcome is visible to the operator", async () => {
  const frame = await renderFrame(
    {
      agentConsoleView: consoleView({
        receipt: { status: "accepted", message: "Cancellation requested for RuntimeMap." },
      }),
    },
    100,
  );

  assert.match(frame, /Control accepted/);
});

test("an undeliverable control outcome is visible to the operator", async () => {
  const frame = await renderFrame(
    {
      agentConsoleView: consoleView({
        receipt: { status: "not_delivered", message: "Agent controls are unavailable." },
      }),
    },
    100,
  );

  assert.match(frame, /Control not delivered/);
});

test("a hostile control receipt cannot break the console frame or leak its raw text", async () => {
  const columns = 100;
  const hostile = `steer failed\r\n\u0007\tat Object.<anonymous> (/Users/dev/.config/token=${"S".repeat(400)})`;
  const frame = await renderFrame(
    {
      agentConsoleView: consoleView({
        receipt: { status: "rejected", message: hostile },
      }),
    },
    columns,
  );

  const offending = frame
    .split("\n")
    .filter((line) => LAYOUT_BREAKING.test(line))
    .map((line) => JSON.stringify(line));
  assert.deepEqual(offending, [], "a receipt reached the terminal with a control byte");
  for (const line of frame.split("\n")) {
    assert.ok(
      getDisplayWidth(line) <= columns,
      `frame line measured ${getDisplayWidth(line)} cells: ${line}`,
    );
  }
  assert.doesNotMatch(frame, /steer failed|token=|\/Users\/|S{10}/, "engine receipt prose must not reach the frame");
  assert.match(frame, /Control rejected/, "the operator still learns the control status");
});
