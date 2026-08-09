import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const BUSY_DASHBOARD_SOURCE = String.raw`
import React from "react";
import { Box, Text } from "ink";
import { renderEmbeddedWorkShellPaneDashboard } from "./packages/tui/src/tui-entry.tsx";

Object.defineProperty(process.stdin, "isTTY", { value: true });
process.stdin.setRawMode = () => process.stdin;
Object.defineProperties(process.stdout, {
  isTTY: { value: true },
  columns: { value: 100 },
  rows: { value: 40 },
});

function BusyPane() {
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    const interval = setInterval(() => setFrame((value) => value + 1), 25);
    return () => clearInterval(interval);
  }, []);

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(Text, null, "STATIC CONVERSATION"),
    React.createElement(Text, null, "busy frame " + frame),
  );
}

setTimeout(() => process.exit(0), 800);
await renderEmbeddedWorkShellPaneDashboard({
  initialView: "work",
  renderWorkPane: () => React.createElement(BusyPane),
});
`;

function captureBusyDashboardOutput() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--no-warnings=ExperimentalWarning",
        "--conditions=source",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        BUSY_DASHBOARD_SOURCE,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          CI: "false",
          CONTINUOUS_INTEGRATION: "false",
          NO_COLOR: "1",
          UNCLECODE_TERMINAL_BACKGROUND: "dark",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`busy dashboard exited ${String(code)}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

test("busy dashboard updates do not repaint unchanged conversation rows", async () => {
  const output = await captureBusyDashboardOutput();
  const conversationWrites = output.match(/STATIC CONVERSATION/g) ?? [];

  assert.equal(conversationWrites.length, 1);
});
