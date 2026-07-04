import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

// Force truecolor before ink/chalk evaluate color support so the rendered
// frames include real ANSI style sequences (bold assertion below).
process.env.FORCE_COLOR = "3";

const { render } = await import("ink");
const React = (await import("react")).default;
const { WorkShellView } = await import("../../packages/tui/src/work-shell-view.tsx");

const BOLD = "\u001B[1m";

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

test("selected slash suggestion is emphasized with bold, unselected stays regular", async () => {
  const stdout = createWritableOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const instance = render(
    React.createElement(WorkShellView, {
      provider: "gemini",
      model: "gemini-2.5-flash",
      reasoningLabel: "unsupported",
      reasoningSupported: false,
      mode: "default",
      authLabel: "env-key",
      entries: [],
      isBusy: false,
      activePanel: {
        title: "Commands",
        lines: [
          "/ matches",
          "",
          "› /con  Alias for /context.",
          "  /stop  Alias for /cancel.",
          "",
          "↑↓ move · Enter run",
        ],
      },
      composer: React.createElement("span", null, ""),
      inputValue: "/",
      slashSuggestionCount: 2,
      terminalColumns: 100,
      cwd: "/Users/example/project/unclecode",
    }),
    {
      stdout,
      stderr: createWritableError(),
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  instance.unmount();
  instance.cleanup();

  const selectedLine = output.split("\n").find((line) => line.includes("Alias for /context."));
  const unselectedLine = output.split("\n").find((line) => line.includes("Alias for /cancel."));
  assert.ok(selectedLine, "selected suggestion line must render");
  assert.ok(unselectedLine, "unselected suggestion line must render");
  assert.ok(
    selectedLine.includes(BOLD),
    `selected suggestion must be bold (DESIGN.md: bold for hierarchy). Line: ${JSON.stringify(selectedLine)}`,
  );
  assert.ok(
    !unselectedLine.includes(BOLD),
    `unselected suggestion must stay regular. Line: ${JSON.stringify(unselectedLine)}`,
  );
});
