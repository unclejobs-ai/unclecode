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

async function captureDashboardFrame(initialView) {
  const stdout = new PassThrough();
  stdout.columns = 120;
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
  stderr.columns = 120;
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
        React.createElement(Text, null, "Esc sessions"),
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

test("dashboard renders distinct Work, History, MCP, and Research pages", async () => {
  const work = await captureDashboardFrame("work");
  assert.match(work, /Work composer/);
  assert.match(work, /Esc sessions/);

  const history = await captureDashboardFrame("sessions");
  assert.match(history, /History & context/);
  assert.match(history, /History detail/);
  assert.match(history, /Review ESC flow/);
  assert.match(history, /Enter resume/);
  assert.doesNotMatch(history, /W\s+Work/);
  assert.doesNotMatch(history, /R\s+Research/);
  assert.doesNotMatch(history, /D\s+Doctor/);
  assert.doesNotMatch(history, /B\s+Browser/);
  assert.doesNotMatch(history, /K\s+Key/);
  assert.doesNotMatch(history, /L\s+Logout/);

  const mcp = await captureDashboardFrame("mcp");
  assert.match(mcp, /MCP servers/);
  assert.match(mcp, /Selected server/);
  assert.match(mcp, /M\s+MCP/);
  assert.match(mcp, /I\s+Inspect/);
  assert.match(mcp, /D\s+Doctor/);
  assert.match(mcp, /unclecode mcp inspect memory/);
  assert.match(mcp, /Health · not checked from this page yet/);
  assert.doesNotMatch(mcp, /B\s+Browser/);
  assert.doesNotMatch(mcp, /K\s+Key/);
  assert.doesNotMatch(mcp, /L\s+Logout/);

  const research = await captureDashboardFrame("research");
  assert.match(research, /Research runs/);
  assert.match(research, /Selected research/);
  assert.match(research, /audit workflow/);
  assert.match(research, /Press R to start research/);
  assert.match(research, /R\s+Research/);
  assert.match(research, /W\s+Work/);
  assert.match(research, /M\s+MCP/);
  assert.doesNotMatch(research, /B\s+Browser/);
  assert.doesNotMatch(research, /K\s+Key/);
  assert.doesNotMatch(research, /L\s+Logout/);
});
