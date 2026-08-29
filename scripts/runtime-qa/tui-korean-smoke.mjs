import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { koreanBusyPromptText, koreanBusyResponseText, repoRoot } from "./constants.mjs";
import { escapeRegExp, run, shellQuote } from "./cli-helpers.mjs";
import {
  calculatePaneWidth,
  lowerBusyActivityRowPattern,
  pressEnter,
  runTmux,
  typeKeys,
  waitForIdleComposer,
  waitForPane,
} from "./tmux-helpers.mjs";

export async function runKoreanBusyTuiSmoke({ port, tmp, observations }) {
  const tmux = await run("sh", ["-lc", "command -v tmux"], process.env);
  assert.equal(tmux.code, 0, "tmux is required for the Korean busy TUI QA gate");

  const session = `unclecode-korean-busy-qa-${process.pid}`;
  const paneFile = path.join(tmp, "korean-busy-pane.txt");
  const typedAnsiPaneFile = path.join(tmp, "korean-busy-typed-pane.ansi.txt");
  const busyPaneFile = path.join(tmp, "korean-busy-during-pane.txt");
  const widthFile = path.join(tmp, "korean-busy-width.json");
  await runTmux(["kill-session", "-t", session], { allowFailure: true });

  const beforeRequests = observations.length;
  const command = [
    `cd ${shellQuote(repoRoot)}`,
    [
      `UNCLECODE_MODE=default`,
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
    await typeKeys(session, koreanBusyPromptText);
    await waitForPane(session, new RegExp(escapeRegExp(koreanBusyPromptText)), paneFile);
    const typedAnsiCapture = await runTmux(["capture-pane", "-t", session, "-e", "-p", "-S", "-80"], {
      allowFailure: true,
    });
    writeFileSync(typedAnsiPaneFile, typedAnsiCapture.stdout);
    const typedPromptLine = typedAnsiCapture.stdout
      .split(/\r?\n/)
      .find((line) => line.includes(koreanBusyPromptText)) ?? "";
    assert.match(
      typedPromptLine,
      new RegExp(escapeRegExp(koreanBusyPromptText)),
      "Korean prompt input should render before submission",
    );
    assert.doesNotMatch(
      typedPromptLine,
      /\x1b\[7m/,
      "Korean prompt input should not render an inverse block cursor that looks like a Hangul residual",
    );
    await pressEnter(session);
    const busyPane = await waitForPane(
      session,
      /컨텍스트 준비 중|생각 중|작업 중|후속 요청 대기열 추가/,
      busyPaneFile,
    );
    assert.doesNotMatch(
      busyPane,
      new RegExp(`${escapeRegExp(koreanBusyPromptText)}${escapeRegExp(koreanBusyPromptText)}`),
      "Korean input duplicated while the delayed turn was busy",
    );

    await waitForPane(session, new RegExp(escapeRegExp(koreanBusyResponseText)), paneFile);
    const pane = await waitForIdleComposer(session, paneFile);
    const requestDelta = observations.length - beforeRequests;

    assert.equal(requestDelta, 1, `Korean busy QA should make one provider call, got ${requestDelta}`);
    assert.match(pane, new RegExp(escapeRegExp(koreanBusyResponseText)));
    assert.match(busyPane, /컨텍스트 준비 중|생각 중|작업 중|후속 요청 대기열 추가/);
    assert.doesNotMatch(
      busyPane,
      /Preparing context|Thinking|Working|Enter queues follow-up/,
      "Korean work status must not leak English runtime guidance",
    );
    assert.doesNotMatch(
      busyPane,
      lowerBusyActivityRowPattern("thinking"),
      "Korean busy state should rely on the status spinner instead of adding a duplicate lower activity row",
    );
    assert.doesNotMatch(
      busyPane,
      /Work context · session state|╭─|╰─/,
      "Korean busy state should not swap the compact status row for a large bordered card",
    );
    assert.doesNotMatch(pane, /│ ▌ 하이요! 편하게 말씀 주세요\./);
    assert.doesNotMatch(
      pane,
      new RegExp(`${escapeRegExp(koreanBusyPromptText)}${escapeRegExp(koreanBusyPromptText)}`),
    );
    assert.doesNotMatch(pane, /Unknown command|panic|TypeError|ReferenceError/);

    const width = calculatePaneWidth(pane);
    writeFileSync(widthFile, JSON.stringify(width, null, 2));
    assert.deepEqual(width.over, [], `Korean busy TUI display overflow: ${JSON.stringify(width.over)}`);
    return {
      busyPaneExcerpt: busyPane.trimEnd(),
      paneExcerpt: pane.trimEnd(),
      width,
      requestDelta,
      busySpinnerVisible: true,
      duplicateBusyActivityRegression: false,
      compactKoreanShortReply: true,
      hangulDuplicateRegression: false,
      hangulBlockCursorRegression: false,
    };
  } finally {
    await runTmux(["kill-session", "-t", session], { allowFailure: true });
  }
}
