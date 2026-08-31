import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const CLEAR_SCREEN_AND_SCROLLBACK = "\u001B[2J\u001B[3J\u001B[H";

/**
 * Minimal VT100 screen model for asserting what a real terminal would show
 * after replaying the child's raw byte stream. Handles exactly the sequences
 * ink 6.8 emits (cursor moves, line/screen erases, alt-screen switches,
 * synchronized-output and cursor-visibility toggles) — color is disabled in
 * the children, so no SGR handling is needed beyond skipping it.
 *
 * The screen is snapshotted when the app leaves the alternate screen: that
 * is the final settled frame the user saw.
 */
function createTerminalEmulator() {
  const lines = [];
  let row = 0;
  let col = 0;
  let pending = "";
  let snapshot = null;
  let sawLeaveAlternateScreen = false;

  const ensure = (index) => {
    while (lines.length <= index) lines.push("");
  };
  const putText = (text) => {
    ensure(row);
    const line = lines[row];
    lines[row] = line.length >= col
      ? line.slice(0, col) + text
      : line + " ".repeat(col - line.length) + text;
    col += text.length;
  };
  const applySequence = (params, final) => {
    const numeric = params.replace(/[?>=<]/g, "");
    const count = Math.max(0, Number.parseInt(numeric || "1", 10) || (numeric === "" ? 1 : 0));
    switch (final) {
      case "A": row = Math.max(0, row - (numeric === "" ? 1 : count)); break;
      case "B": row += numeric === "" ? 1 : count; break;
      case "E": row += numeric === "" ? 1 : count; col = 0; break;
      case "F": row = Math.max(0, row - (numeric === "" ? 1 : count)); col = 0; break;
      case "G": col = numeric === "" ? 0 : Math.max(0, count - 1); break;
      case "H": row = 0; col = 0; break;
      case "J": {
        if (numeric === "" || numeric === "0") {
          ensure(row);
          lines[row] = lines[row].slice(0, col);
          for (let i = row + 1; i < lines.length; i += 1) lines[i] = "";
        } else if (numeric === "1") {
          ensure(row);
          for (let i = 0; i < row; i += 1) lines[i] = "";
          lines[row] = lines[row].slice(col);
        } else {
          for (let i = 0; i < lines.length; i += 1) lines[i] = "";
        }
        break;
      }
      case "K": {
        ensure(row);
        if (numeric === "" || numeric === "0") lines[row] = lines[row].slice(0, col);
        else if (numeric === "1") lines[row] = " ".repeat(col) + lines[row].slice(col);
        else lines[row] = "";
        break;
      }
      case "h":
      case "l": {
        if (params.includes("?1049")) {
          if (final === "l" && !sawLeaveAlternateScreen) {
            sawLeaveAlternateScreen = true;
            snapshot = lines.map((line) => line);
          }
          for (let i = 0; i < lines.length; i += 1) lines[i] = "";
          row = 0;
          col = 0;
        }
        // ?25 (cursor visibility) and ?2026 (synchronized output): no screen effect.
        break;
      }
      default:
        // m (SGR; children run with NO_COLOR), u (kitty), others: ignored.
        break;
    }
  };

  const consume = (text) => {
    let index = 0;
    while (index < text.length) {
      const char = text[index];
      if (char === "\u001B") {
        if (text[index + 1] === "[") {
          const paramsStart = index + 2;
          let end = paramsStart;
          while (end < text.length && /[\d;?>=<]/.test(text[end])) end += 1;
          if (end >= text.length) return text.slice(index); // incomplete sequence
          if (text[end] !== undefined) {
            applySequence(text.slice(paramsStart, end), text[end]);
            index = end + 1;
            continue;
          }
        } else if (text[index + 1] !== undefined) {
          index += 2; // two-character escape (OSC/other): skip
          continue;
        } else {
          return text.slice(index);
        }
      }
      if (char === "\n") {
        row += 1;
        col = 0;
        index += 1;
        continue;
      }
      if (char === "\r") {
        col = 0;
        index += 1;
        continue;
      }
      // Consume a run of printable characters at once.
      let runEnd = index;
      while (runEnd < text.length && text[runEnd] !== "\u001B" && text[runEnd] !== "\n" && text[runEnd] !== "\r") {
        runEnd += 1;
      }
      putText(text.slice(index, runEnd));
      index = runEnd;
    }
    return "";
  };

  return {
    feed(chunk) {
      pending = consume(pending + chunk);
    },
    getFinalScreen() {
      return (snapshot ?? lines).map((line) => line.replace(/\s+$/u, ""));
    },
  };
}

const CHILD_SOURCE = String.raw`
import React from "react";
import { Box, Text } from "ink";
import { renderEmbeddedWorkShellPaneDashboard } from "./packages/tui/src/tui-entry.tsx";

const scenario = process.env.TEST_SCENARIO;

let columns = Number(process.env.TEST_INITIAL_COLUMNS);
let rows = Number(process.env.TEST_INITIAL_ROWS);
Object.defineProperty(process.stdin, "isTTY", { value: true });
process.stdin.setRawMode = () => process.stdin;
Object.defineProperties(process.stdout, {
  isTTY: { value: true },
  columns: { get: () => columns },
  rows: { get: () => rows },
});

function resize(nextColumns, nextRows) {
  columns = nextColumns;
  rows = nextRows;
  process.stdout.emit("resize");
}

function TestPane() {
  const [frame, setFrame] = React.useState(0);
  const [size, setSize] = React.useState(() => ({ columns, rows }));
  React.useEffect(() => {
    if (scenario === "streaming") {
      const interval = setInterval(() => setFrame((value) => value + 1), 40);
      return () => clearInterval(interval);
    }
    const onResize = () => setSize({ columns, rows });
    process.stdout.on("resize", onResize);
    return () => process.stdout.off("resize", onResize);
  }, []);
  React.useEffect(() => {
    // Measure the scenario from the first mounted frame. On a loaded machine,
    // scheduling these timers before Ink mounts can let the exit timer win
    // before the streaming interval or resize listener ever becomes active.
    const timers = [];
    for (const step of schedule) {
      if (step.at > 0 && step.columns > 0) {
        timers.push(setTimeout(() => resize(step.columns, step.rows), step.at));
      }
    }
    timers.push(setTimeout(() => process.exit(0), runForMs));
    return () => timers.forEach(clearTimeout);
  }, []);

  const children = [React.createElement(Text, null, "STATIC CONVERSATION")];
  if (scenario === "column-shrink") {
    children.push(React.createElement(Text, null, "V".repeat(size.columns)));
  }
  if (scenario === "row-shrink-reflow" || scenario === "row-grow") {
    const fillerCount = Math.max(2, Math.floor(size.rows / 2) - 2);
    for (let index = 0; index < fillerCount; index += 1) {
      children.push(React.createElement(Text, { key: "filler-" + index }, "filler row"));
    }
  }
  children.push(React.createElement(Text, null, "busy frame " + frame));
  return React.createElement(Box, { flexDirection: "column" }, ...children);
}

const schedule = [
  { at: Number(process.env.TEST_RESIZE_AT_MS || 0), columns: Number(process.env.TEST_NEXT_COLUMNS || 0), rows: Number(process.env.TEST_NEXT_ROWS || 0) },
];
const runForMs = Number(process.env.TEST_RUN_FOR_MS);
await renderEmbeddedWorkShellPaneDashboard({
  initialView: "work",
  renderWorkPane: () => React.createElement(TestPane),
});
`;

function runDashboardChild(settings) {
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
        CHILD_SOURCE,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          CI: "false",
          CONTINUOUS_INTEGRATION: "false",
          NO_COLOR: "1",
          UNCLECODE_TERMINAL_BACKGROUND: "dark",
          TEST_SCENARIO: settings.scenario,
          TEST_INITIAL_COLUMNS: String(settings.columns),
          TEST_INITIAL_ROWS: String(settings.rows),
          TEST_RUN_FOR_MS: String(settings.runForMs),
          ...(settings.resizeAtMs && settings.nextColumns
            ? {
              TEST_RESIZE_AT_MS: String(settings.resizeAtMs),
              TEST_NEXT_COLUMNS: String(settings.nextColumns),
              TEST_NEXT_ROWS: String(settings.nextRows),
            }
            : {}),
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
        reject(new Error(`dashboard child exited ${String(code)}: ${stderr}`));
        return;
      }
      const emulator = createTerminalEmulator();
      emulator.feed(stdout);
      resolve({
        raw: stdout,
        screen: emulator.getFinalScreen(),
      });
    });
  });
}

function screenRowsContaining(screen, pattern) {
  return screen.filter((line) => pattern.test(line));
}

test("streaming publishes keep exactly one stable row on screen (no drift, no stacking)", async () => {
  const { raw, screen } = await runDashboardChild({
    scenario: "streaming",
    columns: 100,
    rows: 40,
    runForMs: 900,
  });

  const frameWrites = (raw.match(/busy frame \d+/gu) ?? []).length;
  assert.ok(
    frameWrites >= 2,
    `expected at least two streamed publishes, saw ${String(frameWrites)}`,
  );

  // Ink 7's incremental renderer fixes the cursor rewind that stacked rows in
  // Ink 6. The real-terminal guard remains exactly one stable and busy row.
  const stableRows = screenRowsContaining(screen, /STATIC CONVERSATION/u);
  assert.equal(stableRows.length, 1, `stable row must appear exactly once on screen:\n${screen.join("\n")}`);
  const busyRows = screenRowsContaining(screen, /busy frame \d+/u);
  assert.equal(busyRows.length, 1, `busy row must appear exactly once on screen:\n${screen.join("\n")}`);
  assert.match(busyRows[0] ?? "", /busy frame \d+/u, "final frame must contain the latest busy row");
});

test("incrementalRendering is enabled with the pinned Ink 7 line", async () => {
  const entrySource = readFileSync(
    path.join(REPO_ROOT, "packages/tui/src/tui-entry.tsx"),
    "utf8",
  );
  const tuiPackage = JSON.parse(readFileSync(
    path.join(REPO_ROOT, "packages/tui/package.json"),
    "utf8",
  ));
  const inkConstraint = String(tuiPackage.dependencies?.ink ?? "");
  assert.match(inkConstraint, /\^?7\./u);

  assert.match(
    entrySource,
    /incrementalRendering:\s*true/u,
    "Ink 7 fixes incremental trailing-newline cursor rewind; keep the renderer and dependency pin aligned.",
  );
});

test("column shrink clears and leaves a single clean reflowed frame", async () => {
  const { raw, screen } = await runDashboardChild({
    scenario: "column-shrink",
    columns: 100,
    rows: 40,
    resizeAtMs: 450,
    nextColumns: 72,
    nextRows: 40,
    runForMs: 1100,
  });

  const clears = raw.split(CLEAR_SCREEN_AND_SCROLLBACK).length - 1;
  assert.ok(clears >= 1, "narrowing must emit the external screen+scrollback clear");

  assert.equal(screenRowsContaining(screen, /STATIC CONVERSATION/u).length, 1);
  const wideRows = screenRowsContaining(screen, /^V+$/u);
  assert.equal(wideRows.length, 1, "the width probe row must appear exactly once");
  assert.equal(
    (wideRows[0] ?? "").length,
    72,
    `the width probe row must reflow to the narrowed width, saw ${(wideRows[0] ?? "").length}`,
  );
  const overflowing = screen.filter((line) => line.length > 72 && line.length > 0);
  assert.deepEqual(
    overflowing.filter((line) => !/busy frame/.test(line)),
    [],
    `no stale rows wider than the narrowed terminal:\n${overflowing.join("\n")}`,
  );
  assert.equal(screenRowsContaining(screen, /busy frame \d+/u).length, 1);
});

test("row shrink never clears: the frame stays intact without a repaint", async () => {
  // Static pane, exactly the shape of the real boot screen: frame smaller
  // than the terminal, content independent of rows, nothing ticking. ink 6.8
  // resets nothing on a row-only shrink, so an external clear would blank
  // the screen until the next state change — that is why the clear predicate
  // is columns-only and this test pins it.
  const { raw, screen } = await runDashboardChild({
    scenario: "row-shrink-static",
    columns: 100,
    rows: 40,
    resizeAtMs: 450,
    nextColumns: 100,
    nextRows: 30,
    runForMs: 1100,
  });

  assert.ok(!raw.includes(CLEAR_SCREEN_AND_SCROLLBACK), "row-only shrink must not clear the screen");
  assert.equal(screenRowsContaining(screen, /STATIC CONVERSATION/u).length, 1, "static frame must survive the row shrink");
  assert.equal(screenRowsContaining(screen, /busy frame \d+/u).length, 1);
});

test("row shrink with row-aware content reflows correctly without a clear", async () => {
  const { raw, screen } = await runDashboardChild({
    scenario: "row-shrink-reflow",
    columns: 100,
    rows: 40,
    resizeAtMs: 450,
    nextColumns: 100,
    nextRows: 30,
    runForMs: 1100,
  });

  assert.ok(!raw.includes(CLEAR_SCREEN_AND_SCROLLBACK), "row-only shrink must not clear the screen");
  const expectedFillers = Math.max(2, Math.floor(30 / 2) - 2);
  assert.equal(
    screenRowsContaining(screen, /filler row/u).length,
    expectedFillers,
    `filler budget must follow the shrunk terminal (${String(expectedFillers)} rows):\n${screen.join("\n")}`,
  );
  assert.equal(screenRowsContaining(screen, /STATIC CONVERSATION/u).length, 1);
  assert.equal(screenRowsContaining(screen, /busy frame \d+/u).length, 1);
});

test("row grow reflows correctly without any clear", async () => {
  const { raw, screen } = await runDashboardChild({
    scenario: "row-grow",
    columns: 100,
    rows: 30,
    resizeAtMs: 450,
    nextColumns: 100,
    nextRows: 48,
    runForMs: 1100,
  });

  assert.ok(!raw.includes(CLEAR_SCREEN_AND_SCROLLBACK), "growing must never clear the screen");
  const expectedFillers = Math.max(2, Math.floor(48 / 2) - 2);
  assert.equal(
    screenRowsContaining(screen, /filler row/u).length,
    expectedFillers,
    `filler budget must follow the grown terminal (${String(expectedFillers)} rows):\n${screen.join("\n")}`,
  );
  assert.equal(screenRowsContaining(screen, /STATIC CONVERSATION/u).length, 1);
  assert.equal(screenRowsContaining(screen, /busy frame \d+/u).length, 1);
  const overflowing = screen.filter((line) => line.length > 100);
  assert.deepEqual(overflowing, [], `no rows wider than the terminal:\n${overflowing.join("\n")}`);
});
