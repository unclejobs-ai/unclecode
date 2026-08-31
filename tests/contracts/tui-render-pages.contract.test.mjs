import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { Box, Text, render } from "ink";
import React from "react";

import {
  DetailPanel,
  McpServerList,
  SessionList,
  createDashboardElement,
  createSessionCenterModel,
} from "../../packages/tui/src/index.tsx";
import {
  applyShellEvents,
  createInitialShellState,
} from "../../packages/tui/src/shell-state.ts";

const ANSI_SEQUENCE_PATTERN = String.raw`\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))`;

function stripAnsi(value) {
  return value.replace(new RegExp(ANSI_SEQUENCE_PATTERN, "g"), "");
}

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

async function captureInkElement(element, columns = 120) {
  const stdout = new PassThrough();
  stdout.columns = columns;
  stdout.rows = 40;
  stdout.isTTY = true;
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      output += `\nSTDERR:${chunk.toString()}`;
      callback();
    },
  });
  stderr.columns = columns;
  stderr.rows = 40;
  stderr.isTTY = true;

  const instance = render(element, {
    stdout,
    stdin: createInkInput(),
    stderr,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  instance.unmount();
  instance.cleanup();
  return stripAnsi(output);
}

async function captureDashboardFrame(initialView, columns = 120) {
  const stdout = new PassThrough();
  stdout.columns = columns;
  stdout.rows = 40;
  stdout.isTTY = true;
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      output += `\nSTDERR:${chunk.toString()}`;
      callback();
    },
  });
  stderr.columns = columns;
  stderr.rows = 40;
  stderr.isTTY = true;

  const element = createDashboardElement({
    workspaceRoot: process.cwd(),
    modeLabel: "default",
    authLabel: "api-key-env",
    sessionCount: 1,
    mcpServerCount: 1,
    mcpServers: [
      {
        name: "memory",
        transport: "stdio",
        scope: "project",
        trustTier: "project",
        originLabel: "project config",
      },
    ],
    sessions: [
      {
        sessionId: "work-1",
        state: "idle",
        updatedAt: "2026-06-01T00:00:00.000Z",
        model: "gpt-5.4",
        taskSummary: "Review ESC flow",
      },
    ],
    contextLines: ["Loaded guidance: AGENTS.md"],
    bridgeLines: ["Bridge ready"],
    memoryLines: ["Memory ready"],
    initialView,
    renderWorkPane: () =>
      React.createElement(
        Box,
        { flexDirection: "column" },
        React.createElement(Text, null, "Work composer"),
        React.createElement(Text, null, "Ctrl+O tool history"),
      ),
  });

  const instance = render(element, {
    stdout,
    stdin: createInkInput(),
    stderr,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  instance.unmount();
  instance.cleanup();
  return stripAnsi(output);
}

test("dashboard trace copy frames agent progress as activity, not raw steps", async () => {
  const homeState = {
    modeLabel: "default",
    authLabel: "api-key-env",
    sessionCount: 0,
    mcpServerCount: 0,
    mcpServers: [],
    sessions: [],
  };
  const shellState = applyShellEvents(
    createInitialShellState(homeState, { initialView: "work" }),
    [{ type: "action.started", actionId: "doctor" }],
  );
  const model = createSessionCenterModel({
    workspaceRoot: process.cwd(),
    ...homeState,
  });
  const frame = await captureInkElement(
    React.createElement(DetailPanel, {
      selectedSession: undefined,
      selectedAction: undefined,
      selectedApproval: undefined,
      selectedActionId: undefined,
      view: "work",
      shellState,
      model,
      promptDraft: "",
      primarySelectionIndex: 0,
      contextLines: [],
      bridgeLines: [],
      memoryLines: [],
    }),
  );

  assert.match(frame, /Run activity/);
  assert.doesNotMatch(frame, /\bSteps\b/);
});

test("dashboard empty states are structured and name a next action", async () => {
  const historyEmpty = await captureInkElement(
    React.createElement(SessionList, {
      sessions: [],
      selectedIndex: 0,
      isActive: true,
      emptyState: "No saved sessions yet.",
      emptyStateDetail:
        "Start a Work session and saved conversations will appear here.",
      emptyStateActionKey: "W",
      emptyStateActionLabel: "start work",
    }),
  );
  const mcpEmpty = await captureInkElement(
    React.createElement(McpServerList, {
      servers: [],
      selectedIndex: 0,
      isActive: true,
    }),
  );

  assert.match(historyEmpty, /No saved sessions yet/);
  assert.match(historyEmpty, /W\s+start work/);
  assert.ok(
    historyEmpty.trim().split(/\n/).length >= 2,
    "history empty state should not collapse to one bare sentence",
  );
  assert.match(mcpEmpty, /No MCP servers configured/);
  assert.match(mcpEmpty, /M\s+inspect setup/);
  assert.ok(
    mcpEmpty.trim().split(/\n/).length >= 2,
    "MCP empty state should not collapse to one bare sentence",
  );
});

async function runDashboardInputScenario(inputValue, options = {}) {
  const stdout = new PassThrough();
  stdout.columns = 120;
  stdout.rows = 40;
  stdout.isTTY = true;
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const stdin = createInkInput();
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      output += `\nSTDERR:${chunk.toString()}`;
      callback();
    },
  });
  stderr.columns = 120;
  stderr.rows = 40;
  stderr.isTTY = true;

  const calls = [];
  const element = createDashboardElement({
    workspaceRoot: process.cwd(),
    modeLabel: "default",
    authLabel: "api-key-env",
    sessionCount: 1,
    mcpServerCount: 0,
    mcpServers: [],
    sessions: [
      {
        sessionId: "work-1",
        state: "idle",
        updatedAt: "2026-06-01T00:00:00.000Z",
        model: "gpt-5.4",
        taskSummary: "Review ESC flow",
      },
    ],
    initialView: "sessions",
    runAction: async (input) => {
      calls.push(["runAction", input.actionId, input.prompt ?? null]);
      return [`ran ${input.actionId}`];
    },
    runSession: async (sessionId) => {
      calls.push(["runSession", sessionId]);
      return ["resumed"];
    },
    ...options,
  });

  const instance = render(element, {
    stdout,
    stdin,
    stderr,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  stdin.write(inputValue);
  await new Promise((resolve) => setTimeout(resolve, 250));
  instance.unmount();
  instance.cleanup();
  return { calls, frame: stripAnsi(output) };
}

async function captureDashboardAfterInputs(inputs, options = {}) {
  const stdout = new PassThrough();
  stdout.columns = options.columns ?? 120;
  stdout.rows = 40;
  stdout.isTTY = true;
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const stdin = createInkInput();
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      output += `\nSTDERR:${chunk.toString()}`;
      callback();
    },
  });
  stderr.columns = stdout.columns;
  stderr.rows = stdout.rows;
  stderr.isTTY = true;

  const calls = [];
  let workPaneLabel = "Work composer";
  let workPaneContext = "Ctrl+O tool history";
  const element = createDashboardElement({
    workspaceRoot: process.cwd(),
    modeLabel: "default",
    authLabel: "api-key-env",
    sessionCount: 1,
    mcpServerCount: 1,
    mcpServers: [
      {
        name: "memory",
        transport: "stdio",
        scope: "project",
        trustTier: "project",
        originLabel: "project config",
      },
    ],
    sessions: [
      {
        sessionId: "work-1",
        state: "idle",
        updatedAt: "2026-06-01T00:00:00.000Z",
        model: "gpt-5.4",
        taskSummary: "Review ESC flow",
      },
    ],
    contextLines: ["Loaded guidance: AGENTS.md"],
    bridgeLines: ["Bridge ready"],
    memoryLines: ["Memory ready"],
    initialView: "sessions",
    renderWorkPane: () =>
      React.createElement(
        Box,
        { flexDirection: "column" },
        React.createElement(Text, null, workPaneLabel),
        React.createElement(Text, null, workPaneContext),
      ),
    openEmbeddedWorkSession: async (args) => {
      calls.push(["openEmbeddedWorkSession", args.join(" ")]);
      workPaneLabel = `Resumed ${args.at(-1)}`;
      workPaneContext = "Recovered saved conversation context";
      return {
        selectedSessionId: args.at(-1),
        contextLines: ["Recovered saved conversation context"],
      };
    },
    runAction: async ({ actionId, prompt }) => {
      calls.push(["runAction", actionId, prompt ?? ""]);
      return [`${actionId} ok`];
    },
    ...options.props,
  });

  const instance = render(element, {
    stdout,
    stdin,
    stderr,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const input of inputs) {
    stdin.write(input);
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  instance.unmount();
  instance.cleanup();
  return { output: stripAnsi(output), calls };
}

function OpenSessionsOnMount(props) {
  React.useEffect(() => {
    props.openSessions();
  }, [props.openSessions]);

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(Text, null, "Work composer"),
    React.createElement(Text, null, "Ctrl+O tool history"),
  );
}

test("dashboard renders distinct Work, History, and MCP pages", async () => {
  const work = await captureDashboardFrame("work");
  assert.match(work, /Work composer/);
  assert.match(work, /Ctrl\+O tool history/);

  const history = await captureDashboardFrame("sessions");
  assert.match(history, /work context/);
  assert.match(history, /history/);
  assert.match(history, /Conversation/);
  assert.match(history, /Review ESC flow/);
  assert.match(history, /Enter · resume/);
  assert.doesNotMatch(history, /W\s+Work/);
  assert.doesNotMatch(history, /R\s+Research/);
  assert.doesNotMatch(history, /D\s+Doctor/);
  assert.doesNotMatch(history, /B\s+Browser/);
  assert.doesNotMatch(history, /K\s+Key/);
  assert.doesNotMatch(history, /L\s+Logout/);

  const mcp = await captureDashboardFrame("mcp");
  assert.match(mcp, /Servers/);
  assert.match(mcp, /MCP detail/);
  assert.match(mcp, /Selected server/);
  assert.match(mcp, /A\s+Add/);
  assert.match(mcp, /X\s+Remove/);
  assert.match(mcp, /M\s+MCP/);
  assert.match(mcp, /I\s+Inspect/);
  assert.match(mcp, /unclecode mcp inspect memory/);
  assert.match(mcp, /M lists merged config/);
  assert.doesNotMatch(mcp, /D\s+Doctor/);
  assert.doesNotMatch(mcp, /W\s+Work/);
  assert.doesNotMatch(mcp, /B\s+Browser/);
  assert.doesNotMatch(mcp, /K\s+Key/);
  assert.doesNotMatch(mcp, /L\s+Logout/);
});

test("History Enter resumes the selected conversation when no work-pane handoff is available", async () => {
  const { calls } = await runDashboardInputScenario("\r");

  assert.deepEqual(calls, [["runSession", "work-1"]]);
});

test("History Enter resumes the selected conversation through the embedded Work pane", async () => {
  const resumed = await captureDashboardAfterInputs(["\r"]);

  assert.deepEqual(resumed.calls, [
    ["openEmbeddedWorkSession", "--session-id work-1"],
  ]);
  assert.match(resumed.output, /Resumed work-1/);
  assert.match(resumed.output, /Recovered saved conversation context/);
  assert.ok(
    resumed.output.lastIndexOf("Resumed work-1") >
      resumed.output.lastIndexOf("History · 1 saved"),
    "final frame should be the resumed Work pane, not the History list",
  );
});

test("session center number keys expose all three top-level sections", async () => {
  const work = await runDashboardInputScenario("1");
  assert.match(work.frame, /Work detail/);
  assert.match(work.frame, /W\s+Work/);

  const history = await runDashboardInputScenario("2", { initialView: "mcp" });
  assert.match(history.frame, /Conversation/);
  assert.match(history.frame, /Enter resumes this conversation in Work/);

  const mcp = await runDashboardInputScenario("3");
  assert.match(mcp.frame, /MCP detail/);
  assert.match(mcp.frame, /MCP = external tools and data servers/);

  const noFourthTab = await runDashboardInputScenario("4");
  assert.doesNotMatch(
    noFourthTab.frame,
    /Work context is automatic/,
    "key 4 must not navigate to the removed research/context view",
  );
});

test("session center shortcuts only fire actions visible in the active palette", async () => {
  const hiddenBrowser = await runDashboardInputScenario("B", {
    initialView: "mcp",
  });
  assert.deepEqual(hiddenBrowser.calls, []);
  assert.doesNotMatch(hiddenBrowser.frame, /Browser OAuth/);

  const visibleMcp = await runDashboardInputScenario("M", {
    initialView: "mcp",
  });
  assert.deepEqual(visibleMcp.calls, [["runAction", "mcp-list", null]]);
  assert.match(visibleMcp.frame, /ran mcp-list/);
});

test("embedded session center keeps numeric tabs and three shortcut actions working from History", async () => {
  const mcp = await captureDashboardAfterInputs(["3"]);
  assert.match(mcp.output, /MCP detail/);
  assert.match(mcp.output, /Selected server/);

  const noFourthTab = await captureDashboardAfterInputs(["4"]);
  assert.doesNotMatch(
    noFourthTab.output,
    /Work context is automatic/,
    "key 4 must not navigate to removed research/context view",
  );

  const work = await captureDashboardAfterInputs(["1"]);
  assert.match(work.output, /Work composer/);
  assert.match(work.output, /Ctrl\+O tool history/);

  const mcpShortcut = await captureDashboardAfterInputs(["m"]);
  assert.match(mcpShortcut.output, /MCP detail/);
  assert.match(mcpShortcut.output, /Selected server/);
  assert.deepEqual(mcpShortcut.calls, []);

  const doctorShortcut = await captureDashboardAfterInputs(["d"]);
  assert.deepEqual(doctorShortcut.calls, [["runAction", "doctor", ""]]);

  const workShortcut = await captureDashboardAfterInputs(["w"]);
  assert.match(workShortcut.output, /Work composer/);
});

test("embedded work can explicitly open History even when context refresh fails", async () => {
  const opened = await captureDashboardAfterInputs([], {
    props: {
      initialView: "work",
      refreshHomeState: async () => {
        throw new Error("refresh unavailable");
      },
      renderWorkPane: ({ openSessions }) =>
        React.createElement(OpenSessionsOnMount, { openSessions }),
    },
  });

  assert.match(opened.output, /Conversation/);
  assert.match(opened.output, /Enter resumes this conversation in Work/);
  assert.doesNotMatch(
    opened.output,
    /Work context is automatic/,
    "the explicit session request must open History, not the removed Context/research view",
  );
  assert.ok(
    opened.output.lastIndexOf("Conversation") >
      opened.output.lastIndexOf("Work composer"),
    "final frame should be History even if the background refresh rejects",
  );
});
