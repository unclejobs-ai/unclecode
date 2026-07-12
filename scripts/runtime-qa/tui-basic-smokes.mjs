import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { fullTuiResponseText, repoRoot, yoloGreetingResponseText } from "./constants.mjs";
import { assertReadableForegroundEscapes, run, shellQuote, sleep } from "./cli-helpers.mjs";
import {
  calculatePaneWidth,
  READY_LAST_STATUS_PATTERN,
  runTmux,
  submitLine,
  waitForIdlePromptDeck,
  waitForPane,
} from "./tmux-helpers.mjs";

export async function runFullTuiSmoke({ port, tmp }) {
  const tmux = await run("sh", ["-lc", "command -v tmux"], process.env);
  assert.equal(tmux.code, 0, "tmux is required for the full-screen TUI QA gate");

  const session = `unclecode-full-tui-qa-${process.pid}`;
  const paneFile = path.join(tmp, "full-tui-pane.txt");
  const ansiPaneFile = path.join(tmp, "full-tui-pane.ansi.txt");
  const widthFile = path.join(tmp, "full-tui-width.json");
  await runTmux(["kill-session", "-t", session], { allowFailure: true });

  const command = [
    `cd ${shellQuote(repoRoot)}`,
    [
      `UNCLECODE_MODE=default`,
      `GEMINI_API_BASE_URL=${shellQuote(`http://127.0.0.1:${port}/v1beta`)}`,
      `GEMINI_API_KEY=local-provider-test-key`,
      `NO_PROXY=127.0.0.1,localhost`,
      `FORCE_COLOR=3`,
      `UNCLECODE_TERMINAL_BACKGROUND=light`,
      `${shellQuote(process.execPath)} bin/unclecode.cjs tui --provider gemini --model gemini-2.5-flash`,
    ].join(" "),
    `echo EXIT:$?`,
    `sleep 20`,
  ].join(" && ");

  try {
    await runTmux(["new-session", "-d", "-x", "100", "-y", "30", "-s", session, command]);
    await waitForPane(session, /prompt deck|UncleCode · Gemini/, paneFile);
    await submitLine(session, "Say hello from full-screen TUI QA.", paneFile);
    await waitForPane(session, new RegExp(fullTuiResponseText), paneFile);
    const pane = await waitForIdlePromptDeck(session, paneFile);
    const ansiCapture = await runTmux(["capture-pane", "-t", session, "-e", "-p", "-S", "-240"], {
      allowFailure: true,
    });
    writeFileSync(ansiPaneFile, ansiCapture.stdout);

    assert.match(pane, new RegExp(fullTuiResponseText));
    assert.match(pane, /prompt deck/);
    assert.match(pane, READY_LAST_STATUS_PATTERN);
    assert.doesNotMatch(pane, /Work context · session state/);
    assert.doesNotMatch(pane, /│ ▌ UNCLECODE_FULL_TUI_QA_OK/);
    assert.doesNotMatch(pane, /Unknown command|panic|TypeError|ReferenceError/);
    assert.doesNotMatch(
      ansiCapture.stdout,
      /\x1b\[38;2;248;250;252m[^\n]*UNCLECODE_FULL_TUI_QA_OK/,
      "full-screen assistant body is still painted near-white and can disappear on light terminals",
    );
    assert.match(
      ansiCapture.stdout,
      /\x1b\[38;2;(?:13;17;23|15;23;42|30;41;59)m(?:◢ )?UncleCode ·/,
      "full-screen header should use an explicit readable foreground instead of inheriting a potentially faint terminal default",
    );
    assert.match(
      ansiCapture.stdout,
      /\x1b\[38;2;(?:13;17;23|15;23;42)mUNCLECODE_FULL_TUI_QA_OK/,
      "full-screen assistant body should use an explicit readable foreground instead of inheriting a potentially faint terminal default",
    );
    assertReadableForegroundEscapes(
      ansiCapture.stdout,
      "full-screen TUI should not paint low-contrast text on a light terminal",
    );

    const width = calculatePaneWidth(pane);
    writeFileSync(widthFile, JSON.stringify(width, null, 2));
    assert.deepEqual(width.over, [], `Full-screen TUI display overflow: ${JSON.stringify(width.over)}`);
    return {
      paneExcerpt: pane.trimEnd(),
      width,
      hiddenBodyColorRegression: false,
      lightTerminalContrast: true,
      compactShortReply: true,
    };
  } finally {
    await runTmux(["kill-session", "-t", session], { allowFailure: true });
  }
}

export async function runReasoningCleanupTuiSmoke({ tmp, observations }) {
  const tmux = await run("sh", ["-lc", "command -v tmux"], process.env);
  assert.equal(tmux.code, 0, "tmux is required for the reasoning cleanup TUI QA gate");

  const session = `unclecode-reasoning-cleanup-qa-${process.pid}`;
  const paneFile = path.join(tmp, "reasoning-cleanup-pane.txt");
  const widthFile = path.join(tmp, "reasoning-cleanup-width.json");
  await runTmux(["kill-session", "-t", session], { allowFailure: true });

  const beforeRequests = observations.length;
  const command = [
    `cd ${shellQuote(repoRoot)}`,
    [
      `UNCLECODE_MODE=default`,
      `OPENAI_API_KEY=local-provider-test-key`,
      `NO_PROXY=127.0.0.1,localhost`,
      `${shellQuote(process.execPath)} bin/unclecode.cjs tui --provider openai --model gpt-5.5`,
    ].join(" "),
    `echo EXIT:$?`,
    `sleep 20`,
  ].join(" && ");

  try {
    await runTmux(["new-session", "-d", "-x", "100", "-y", "30", "-s", session, command]);
    await waitForPane(session, /prompt deck|UncleCode · OpenAI/, paneFile);
    await submitLine(session, "/reasoning high", paneFile, /\/reasoning high matches|\/reasoning high/);
    await waitForPane(session, /Reasoning · Deep selected\./, paneFile);
    await sleep(300);
    const paneCapture = await runTmux(["capture-pane", "-t", session, "-p", "-S", "-240"], {
      allowFailure: true,
    });
    writeFileSync(paneFile, paneCapture.stdout);
    const pane = paneCapture.stdout;
    const requestDelta = observations.length - beforeRequests;

    assert.equal(requestDelta, 0, `Reasoning picker cleanup should not call a provider, got ${requestDelta}`);
    assert.match(pane, /\/reasoning high/);
    assert.match(pane, /Reasoning · Deep selected\./);
    assert.doesNotMatch(pane, /Reasoning picker|Choose thinking depth|\/reasoning low|\/reasoning medium/);
    assert.doesNotMatch(pane, /Unknown command|panic|TypeError|ReferenceError/);

    const width = calculatePaneWidth(pane);
    writeFileSync(widthFile, JSON.stringify(width, null, 2));
    assert.deepEqual(width.over, [], `Reasoning cleanup TUI display overflow: ${JSON.stringify(width.over)}`);
    return {
      paneExcerpt: pane.trimEnd(),
      width,
      requestDelta,
      pickerResidualRegression: false,
    };
  } finally {
    await runTmux(["kill-session", "-t", session], { allowFailure: true });
  }
}

export async function runYoloGreetingTuiSmoke({ port, tmp, observations }) {
  const tmux = await run("sh", ["-lc", "command -v tmux"], process.env);
  assert.equal(tmux.code, 0, "tmux is required for the YOLO greeting TUI QA gate");

  const session = `unclecode-yolo-greeting-qa-${process.pid}`;
  const paneFile = path.join(tmp, "yolo-greeting-pane.txt");
  const widthFile = path.join(tmp, "yolo-greeting-width.json");
  await runTmux(["kill-session", "-t", session], { allowFailure: true });

  const beforeRequests = observations.length;
  const command = [
    `cd ${shellQuote(repoRoot)}`,
    [
      `UNCLECODE_MODE=yolo`,
      `GEMINI_API_BASE_URL=${shellQuote(`http://127.0.0.1:${port}/v1beta`)}`,
      `GEMINI_API_KEY=local-provider-test-key`,
      `NO_PROXY=127.0.0.1,localhost`,
      `${shellQuote(process.execPath)} bin/unclecode.cjs tui --provider gemini --model gemini-2.5-flash`,
    ].join(" "),
    `echo EXIT:$?`,
    `sleep 20`,
  ].join(" && ");

  try {
    await runTmux(["new-session", "-d", "-x", "100", "-y", "30", "-s", session, command]);
    await waitForPane(session, /prompt deck|UncleCode · Gemini/, paneFile);
    await submitLine(session, "hi", paneFile, /\bhi\b/);
    await waitForPane(session, new RegExp(yoloGreetingResponseText), paneFile);
    const pane = await waitForIdlePromptDeck(session, paneFile);
    const requestDelta = observations.length - beforeRequests;

    assert.equal(requestDelta, 1, `YOLO greeting should make one provider call, got ${requestDelta}`);
    assert.match(pane, /YOLO 모드/);
    assert.match(pane, new RegExp(yoloGreetingResponseText));
    assert.match(pane, READY_LAST_STATUS_PATTERN);
    assert.doesNotMatch(pane, /Work context · session state/);
    assert.doesNotMatch(pane, /│ ▌ UNCLECODE_YOLO_GREETING_QA_OK/);
    assert.doesNotMatch(pane, /subtask-1|Break this request|Guardian|Executable checks|No material contradiction/i);
    assert.doesNotMatch(pane, /Unknown command|panic|TypeError|ReferenceError/);

    const width = calculatePaneWidth(pane);
    writeFileSync(widthFile, JSON.stringify(width, null, 2));
    assert.deepEqual(width.over, [], `YOLO greeting TUI display overflow: ${JSON.stringify(width.over)}`);
    return {
      paneExcerpt: pane.trimEnd(),
      width,
      requestDelta,
      plannerLeakRegression: false,
      compactShortReply: true,
    };
  } finally {
    await runTmux(["kill-session", "-t", session], { allowFailure: true });
  }
}
