import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { repoRoot } from "./constants.mjs";
import { assertReadableForegroundEscapes, run, shellQuote, TRUECOLOR_FOREGROUND_PATTERN } from "./cli-helpers.mjs";
import { calculatePaneWidth, runTmux, submitLine, waitForPane } from "./tmux-helpers.mjs";

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
      "UNCLECODE_TERMINAL_BACKGROUND=light",
      `${shellQuote(process.execPath)} bin/unclecode.cjs tui --provider openai --model gpt-5.4`,
    ].join(" "),
    "echo EXIT:$?",
    "sleep 20",
  ].join(" && ");

  try {
    await runTmux(["new-session", "-d", "-x", "140", "-y", "34", "-s", session, command]);
    await waitForPane(session, /prompt deck|UncleCode · OpenAI/, paneFile);
    await submitLine(session, "/context", paneFile);
    const pane = await waitForPane(session, /Context expanded|Included in next answer|Sources ·|Warnings ·/, paneFile);
    const ansiCapture = await runTmux(["capture-pane", "-t", session, "-e", "-p", "-S", "-240"], {
      allowFailure: true,
    });
    writeFileSync(ansiPaneFile, ansiCapture.stdout);

    assert.match(pane, /Context expanded|Sources ·/);
    assert.match(pane, /Included in next answer/);
    assert.match(pane, /Held back locally/);
    assert.match(pane, /Warnings|✓ none/i);
    assertReadableForegroundEscapes(
      ansiCapture.stdout,
      "/context expanded overlay should not paint low-contrast text on a light terminal",
      { requireNonEmpty: true },
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

function uniqueForegroundColors(ansiText) {
  return [
    ...new Set(
      [...ansiText.matchAll(TRUECOLOR_FOREGROUND_PATTERN)]
        .map((match) => `${match[1]};${match[2]};${match[3]}`),
    ),
  ];
}
