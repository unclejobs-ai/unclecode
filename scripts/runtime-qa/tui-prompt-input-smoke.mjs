import assert from "node:assert/strict";
import path from "node:path";

import {
  koreanBusyPromptText,
  koreanBusyResponseText,
  koreanBusyStatusPattern,
  realUseQueuedPromptText,
  realUseQueuedResponseText,
  repoRoot,
} from "./constants.mjs";
import { escapeRegExp, run, shellQuote } from "./cli-helpers.mjs";
import {
  pressEnter,
  runTmux,
  typeKeys,
  waitForIdleComposer,
  waitForPane,
} from "./tmux-helpers.mjs";

const EDIT_SOURCE = "한글 스피너 QXAY";

/**
 * Real bin -> Rust -> Node -> Ink prompt-line gate. The source draft contains
 * committed Hangul and ASCII, then uses both CSI 3~ (forward Delete) and the
 * terminal DEL byte (Backspace) to reach the fake provider's delayed prompt.
 */
export async function runPromptInputTuiSmoke({ port, tmp, observations }) {
  const tmux = await run("sh", ["-lc", "command -v tmux"], process.env);
  assert.equal(tmux.code, 0, "tmux is required for the prompt input TUI gate");

  const session = `unclecode-prompt-input-qa-${process.pid}`;
  const paneFile = path.join(tmp, "prompt-input-pane.txt");
  const editedPaneFile = path.join(tmp, "prompt-input-edited-pane.txt");
  const ctrlOPaneFile = path.join(tmp, "prompt-input-ctrl-o-pane.txt");
  const busyPaneFile = path.join(tmp, "prompt-input-busy-pane.txt");
  await runTmux(["kill-session", "-t", session], { allowFailure: true });

  const beforeRequests = observations.length;
  const command = [
    `cd ${shellQuote(repoRoot)}`,
    [
      "UNCLECODE_MODE=default",
      `GEMINI_API_BASE_URL=${shellQuote(`http://127.0.0.1:${port}/v1beta`)}`,
      "GEMINI_API_KEY=local-provider-test-key",
      "NO_PROXY=127.0.0.1,localhost",
      `${shellQuote(process.execPath)} bin/unclecode.cjs tui --provider gemini --model gemini-2.5-flash`,
    ].join(" "),
    "echo EXIT:$?",
    "sleep 20",
  ].join(" && ");

  try {
    await runTmux(["new-session", "-d", "-x", "100", "-y", "30", "-s", session, command]);
    await waitForPane(session, /prompt deck|UncleCode · Gemini/, paneFile);
    await typeKeys(session, EDIT_SOURCE);
    await waitForPane(session, new RegExp(escapeRegExp(EDIT_SOURCE)), paneFile);

    // Cursor before Y, forward Delete Y, cursor before A, Backspace X.
    await runTmux(["send-keys", "-t", session, "Left"]);
    await runTmux(["send-keys", "-t", session, "DC"]);
    await runTmux(["send-keys", "-t", session, "Left"]);
    await runTmux(["send-keys", "-t", session, "BSpace"]);
    const editedPane = await waitForPane(
      session,
      new RegExp(escapeRegExp(koreanBusyPromptText)),
      editedPaneFile,
    );
    assert.doesNotMatch(editedPane, new RegExp(escapeRegExp(EDIT_SOURCE)));

    // Ctrl+O owns only trace presentation. It must not clear the live draft,
    // open Sessions/Plan/Context, or add a second composer row.
    await runTmux(["send-keys", "-t", session, "C-o"]);
    const ctrlOPane = await waitForPane(
      session,
      new RegExp(escapeRegExp(koreanBusyPromptText)),
      ctrlOPaneFile,
    );
    assert.doesNotMatch(ctrlOPane, /Sessions|Context Desk|Quality Plan/);
    assert.equal(
      ctrlOPane.split(koreanBusyPromptText).length - 1,
      1,
      "Ctrl+O must retain exactly one prompt draft",
    );

    await pressEnter(session);
    const busyPane = await waitForPane(
      session,
      koreanBusyStatusPattern,
      busyPaneFile,
    );
    assert.doesNotMatch(
      busyPane,
      /Preparing context|Thinking|Working|Queue a follow-up|Enter queue/,
      "Korean prompt input must switch busy and composer guidance before the reply",
    );
    await typeKeys(session, realUseQueuedPromptText);
    await waitForPane(session, new RegExp(escapeRegExp(realUseQueuedPromptText)), busyPaneFile);
    await pressEnter(session);
    await waitForPane(session, /queued|follow-up|대기열|후속 요청|\/queue/i, busyPaneFile);

    await waitForPane(session, new RegExp(escapeRegExp(koreanBusyResponseText)), paneFile);
    await waitForPane(session, new RegExp(escapeRegExp(realUseQueuedResponseText)), paneFile);
    const pane = await waitForIdleComposer(session, paneFile);
    const requests = observations.slice(beforeRequests);
    assert.equal(requests.length, 2);
    assert.match(pane, new RegExp(escapeRegExp(koreanBusyPromptText)));
    assert.match(pane, new RegExp(escapeRegExp(realUseQueuedPromptText)));
    assert.doesNotMatch(pane, /Stop hook|hook failed|Unknown command|panic|TypeError|ReferenceError/i);

    return {
      paneExcerpt: pane.trimEnd(),
      editedPaneExcerpt: editedPane.trimEnd(),
      ctrlOPaneExcerpt: ctrlOPane.trimEnd(),
      busyPaneExcerpt: busyPane.trimEnd(),
      requestDelta: requests.length,
      committedHangulAndAscii: true,
      cursorBackspaceForwardDelete: true,
      ctrlODraftPreserved: true,
      busyFollowUpSubmitted: true,
      stopHookChromeAbsent: true,
    };
  } finally {
    await runTmux(["kill-session", "-t", session], { allowFailure: true });
  }
}
