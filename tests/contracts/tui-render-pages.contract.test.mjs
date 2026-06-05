import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { Box, Text, render } from "ink";
import React from "react";

import { createDashboardElement } from "../../packages/tui/src/index.tsx";

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
    latestResearchSessionId: "research-1",
    latestResearchSummary: "Prepared research",
    latestResearchTimestamp: "2026-06-01T00:00:00.000Z",
    researchRunCount: 1,
    recentResearchRuns: [
      {
        sessionId: "research-1",
        prompt: "audit workflow",
        status: "completed",
        summary: "Prepared research",
        timestamp: "2026-06-01T00:00:00.000Z",
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
        React.createElement(Text, null, "Ctrl+O context"),
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
    latestResearchSessionId: null,
    latestResearchSummary: null,
    latestResearchTimestamp: null,
    researchRunCount: 0,
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
  let workPaneContext = "Ctrl+O context";
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
    latestResearchSessionId: "research-1",
    latestResearchSummary: "Prepared research",
    latestResearchTimestamp: "2026-06-01T00:00:00.000Z",
    researchRunCount: 1,
    recentResearchRuns: [
      {
        sessionId: "research-1",
        prompt: "audit workflow",
        status: "completed",
        summary: "Prepared research",
        timestamp: "2026-06-01T00:00:00.000Z",
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

test("dashboard renders distinct Work, History, MCP, and Research pages", async () => {
  const work = await captureDashboardFrame("work");
  assert.match(work, /Work composer/);
  assert.match(work, /Ctrl\+O context/);

  const history = await captureDashboardFrame("sessions");
  assert.match(history, /context cockpit/);
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

  const research = await captureDashboardFrame("research");
  assert.match(research, /Briefs/);
  assert.match(research, /Context brief detail/);
  assert.match(research, /Selected brief/);
  assert.match(research, /audit workflow/);
  assert.match(research, /Press N to draft a context\s+brief/);
  assert.match(research, /Context Briefs shape the next packet/);
  assert.match(research, /N\s+New brief/);
  assert.doesNotMatch(research, /\b4\s+Research\b/);
  assert.doesNotMatch(research, /R\s+Research/);
  assert.match(research, /S\s+Status/);
  assert.doesNotMatch(research, /W\s+Work/);
  assert.doesNotMatch(research, /M\s+MCP/);
  assert.doesNotMatch(research, /D\s+Doctor/);
  assert.doesNotMatch(research, /B\s+Browser/);
  assert.doesNotMatch(research, /K\s+Key/);
  assert.doesNotMatch(research, /L\s+Logout/);
});

test("dashboard keeps Research readable in a narrow terminal", async () => {
  const research = await captureDashboardFrame("research", 60);
  assert.match(research, /context briefs/);
  assert.match(research, /Context brief detail/);
  assert.match(research, /N\s+New brief/);
  assert.match(research, /Press N to draft a context\s+brief/);
  assert.doesNotMatch(research, /\b4\s+Research\b/);
  assert.doesNotMatch(research, /R\s+Research/);
  assert.doesNotMatch(research, /W\s+Work/);
  assert.doesNotMatch(research, /M\s+MCP/);
  assert.doesNotMatch(research, /Quick actions/);
  assert.doesNotMatch(research, /Inspector/);
  assert.equal(
    research.split("\n").some((line) => /^──$/.test(line.trim())),
    false,
    "divider must not wrap into orphan fragments at 60 columns",
  );
});

test("History Enter resumes the selected conversation when no work-pane handoff is available", async () => {
  const { calls } = await runDashboardInputScenario("\r");

  assert.deepEqual(calls, [["runSession", "work-1"]]);
});

test("History Enter resumes the selected conversation through the embedded Work pane", async () => {
  const resumed = await captureDashboardAfterInputs(["\r"]);

  assert.deepEqual(resumed.calls, [["openEmbeddedWorkSession", "--session-id work-1"]]);
  assert.match(resumed.output, /Resumed work-1/);
  assert.match(resumed.output, /Recovered saved conversation context/);
  assert.ok(
    resumed.output.lastIndexOf("Resumed work-1") >
      resumed.output.lastIndexOf("History · 1 saved"),
    "final frame should be the resumed Work pane, not the History list",
  );
});

test("session center number keys expose all four Ctrl+O sections", async () => {
  const work = await runDashboardInputScenario("1");
  assert.match(work.frame, /Work detail/);
  assert.match(work.frame, /W\s+Work/);

  const history = await runDashboardInputScenario("2", { initialView: "mcp" });
  assert.match(history.frame, /Conversation/);
  assert.match(history.frame, /Enter resumes this conversation in Work/);

  const mcp = await runDashboardInputScenario("3");
  assert.match(mcp.frame, /MCP detail/);
  assert.match(mcp.frame, /MCP = external tools and data servers/);

  const research = await runDashboardInputScenario("4");
  assert.match(research.frame, /Context brief detail/);
  assert.match(research.frame, /Context Briefs shape the next packet/);
  assert.doesNotMatch(research.frame, /Research = workspace brief/);
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

test("embedded session center keeps numeric tabs and four shortcut actions working from Ctrl+O History", async () => {
  const mcp = await captureDashboardAfterInputs(["3"]);
  assert.match(mcp.output, /MCP detail/);
  assert.match(mcp.output, /Selected server/);

  const research = await captureDashboardAfterInputs(["4"]);
  assert.match(research.output, /Context brief detail/);
  assert.match(research.output, /Press N to draft a context brief/);

  const work = await captureDashboardAfterInputs(["1"]);
  assert.match(work.output, /Work composer/);
  assert.match(work.output, /Ctrl\+O context/);

  const researchShortcut = await captureDashboardAfterInputs(["n"]);
  assert.deepEqual(researchShortcut.calls, []);
  assert.match(researchShortcut.output, /Prompt draft/);
  assert.match(researchShortcut.output, /Enter or Ctrl\+R runs/);

  const mcpShortcut = await captureDashboardAfterInputs(["m"]);
  assert.match(mcpShortcut.output, /MCP detail/);
  assert.match(mcpShortcut.output, /Selected server/);
  assert.deepEqual(mcpShortcut.calls, []);

  const doctorShortcut = await captureDashboardAfterInputs(["d"]);
  assert.deepEqual(doctorShortcut.calls, [["runAction", "doctor", ""]]);

  const workShortcut = await captureDashboardAfterInputs(["w"]);
  assert.match(workShortcut.output, /Work composer/);
});
