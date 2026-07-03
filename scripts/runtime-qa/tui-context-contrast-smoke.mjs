import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { repoRoot } from "./constants.mjs";
import { run, shellQuote } from "./cli-helpers.mjs";
import { calculatePaneWidth, runTmux, submitLine, waitForPane } from "./tmux-helpers.mjs";

const TRUECOLOR_FOREGROUND_PATTERN = /\x1b\[38;2;(\d+);(\d+);(\d+)m/g;

export async function runContextContrastTuiSmoke({ tmp }) {
  const tmux = await run("sh", ["-lc", "command -v tmux"], process.env);
  assert.equal(tmux.code, 0, "tmux is required for the context contrast TUI QA gate");

  const session = `unclecode-context-contrast-qa-${process.pid}`;
  const paneFile = path.join(tmp, "context-contrast-pane.txt");
  const ansiPaneFile = path.join(tmp, "context-contrast-pane.ansi.txt");
  const widthFile = path.join(tmp, "context-contrast-width.json");
  await runTmux(["kill-session", "-t", session], { allowFailure: true });

  const command = [
    `cd ${shellQuote(repoRoot)}`,
    [
      "UNCLECODE_MODE=default",
      "OPENAI_API_KEY=sk-local-context-contrast-test-key",
      "NO_PROXY=127.0.0.1,localhost",
      "FORCE_COLOR=3",
      "node bin/unclecode.cjs tui --provider openai --model gpt-5.4",
    ].join(" "),
    "echo EXIT:$?",
    "sleep 20",
  ].join(" && ");

  try {
    await runTmux(["new-session", "-d", "-x", "140", "-y", "34", "-s", session, command]);
    await waitForPane(session, /prompt deck|UncleCode · OpenAI/, paneFile);
    await submitLine(session, "/context", paneFile);
    const pane = await waitForPane(session, /Context expanded|Included in next answer|Held back locally/, paneFile);
    const ansiCapture = await runTmux(["capture-pane", "-t", session, "-e", "-p", "-S", "-240"], {
      allowFailure: true,
    });
    writeFileSync(ansiPaneFile, ansiCapture.stdout);

    assert.match(pane, /Context expanded/);
    assert.match(pane, /Included in next answer/);
    assert.match(pane, /Held back locally/);
    assert.match(pane, /Warnings/);
    assertReadableForegroundEscapes(
      ansiCapture.stdout,
      "/context expanded overlay should not paint low-contrast text on a light terminal",
    );

    const width = calculatePaneWidth(pane, 140);
    writeFileSync(widthFile, JSON.stringify(width, null, 2));
    assert.deepEqual(width.over, [], `Context overlay display overflow: ${JSON.stringify(width.over)}`);
    return {
      contextLightContrast: true,
      paneExcerpt: pane.trimEnd(),
      width,
      foregroundColors: uniqueForegroundColors(ansiCapture.stdout),
    };
  } finally {
    await runTmux(["kill-session", "-t", session], { allowFailure: true });
  }
}

function assertReadableForegroundEscapes(ansiText, message) {
  const foregroundColors = [...ansiText.matchAll(TRUECOLOR_FOREGROUND_PATTERN)].map((match) => ({
    red: Number.parseInt(match[1], 10),
    green: Number.parseInt(match[2], 10),
    blue: Number.parseInt(match[3], 10),
  }));
  assert.ok(foregroundColors.length > 0, "context overlay should emit explicit truecolor foregrounds");
  const lowContrastColors = foregroundColors
    .filter((color) => contrastRatio(color, { red: 255, green: 255, blue: 255 }) < 7)
    .map((color) => `${color.red};${color.green};${color.blue}`);
  assert.deepEqual([...new Set(lowContrastColors)], [], message);
}

function uniqueForegroundColors(ansiText) {
  return [
    ...new Set(
      [...ansiText.matchAll(TRUECOLOR_FOREGROUND_PATTERN)]
        .map((match) => `${match[1]};${match[2]};${match[3]}`),
    ),
  ];
}

function contrastRatio(left, right) {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color) {
  const [red, green, blue] = [color.red, color.green, color.blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
