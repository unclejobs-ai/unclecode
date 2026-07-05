import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  parallelModeKoreanCleanResponseText,
  parallelModeKoreanPromptText,
  repoRoot,
} from "./constants.mjs";
import { escapeRegExp, run, shellQuote } from "./cli-helpers.mjs";
import { calculatePaneWidth, pressEnter, runTmux, typeKeys, waitForIdlePromptDeck, waitForPane } from "./tmux-helpers.mjs";

const HANGUL_PATTERN = /[\u3131-\uD79D]/u;

export async function runParallelModeKoreanTuiSmoke({ port, tmp, observations }) {
  const tmux = await run("sh", ["-lc", "command -v tmux"], process.env);
  assert.equal(tmux.code, 0, "tmux is required for parallel-mode Korean TUI QA");

  const session = `unclecode-parallel-ko-qa-${process.pid}`;
  const paneFile = path.join(tmp, "parallel-ko-pane.txt");
  const widthFile = path.join(tmp, "parallel-ko-width.json");
  await runTmux(["kill-session", "-t", session], { allowFailure: true });

  const beforeRequests = observations.length;
  const command = [
    `cd ${shellQuote(repoRoot)}`,
    [
      `UNCLECODE_MODE=ultrawork`,
      `GEMINI_API_BASE_URL=${shellQuote(`http://127.0.0.1:${port}/v1beta`)}`,
      `GEMINI_API_KEY=local-provider-test-key`,
      `NO_PROXY=127.0.0.1,localhost`,
      `FORCE_COLOR=3`,
      `node bin/unclecode.cjs tui --provider gemini --model gemini-2.5-flash`,
    ].join(" "),
    `echo EXIT:$?`,
    `sleep 25`,
  ].join(" && ");

  try {
    await runTmux(["new-session", "-d", "-x", "100", "-y", "30", "-s", session, command]);
    await waitForPane(session, /prompt deck|UncleCode · Gemini|Parallel mode/, paneFile);
    await typeKeys(session, parallelModeKoreanPromptText);
    await waitForPane(session, new RegExp(parallelModeKoreanPromptText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), paneFile);
    await pressEnter(session);
    await waitForPane(session, /병렬 모드/, paneFile);
    const pane = await waitForIdlePromptDeck(session, paneFile);
    const requestDelta = observations.length - beforeRequests;

    assert.ok(requestDelta >= 1, `parallel-mode Korean QA should call provider, got ${requestDelta}`);
    assert.match(pane, new RegExp(parallelModeKoreanPromptText));
    assert.match(pane, HANGUL_PATTERN, "assistant pane should contain Korean text");
    assert.match(pane, new RegExp(escapeRegExp(parallelModeKoreanCleanResponseText)));
    assert.doesNotMatch(pane, /\[\{"id":/);
    assert.doesNotMatch(pane, /I'll trace|Parallel mode runs subtasks/i);
    assert.doesNotMatch(pane, /read packages\//i);
    assert.doesNotMatch(pane, /Unknown command|panic|TypeError|ReferenceError/);

    const width = calculatePaneWidth(pane);
    writeFileSync(widthFile, JSON.stringify(width, null, 2));
    assert.deepEqual(width.over, [], `parallel-mode Korean TUI overflow: ${JSON.stringify(width.over)}`);
    return {
      paneExcerpt: pane.trimEnd(),
      width,
      requestDelta,
      plannerJsonLeakRegression: false,
      englishMetaLeakRegression: false,
      rawPathBusyStripRegression: false,
    };
  } finally {
    await runTmux(["kill-session", "-t", session], { allowFailure: true });
  }
}
