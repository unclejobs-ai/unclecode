import assert from "node:assert/strict";
import path from "node:path";

import { repoRoot, responseText, scrollbackResponseText } from "./constants.mjs";
import { escapeRegExp, run, shellQuote, sleep } from "./cli-helpers.mjs";
import { extractRuntimeQaUserRequest } from "./fake-gemini-server.mjs";
import {
  capturePane,
  IDLE_COMPOSER_PATTERN,
  runTmux,
  submitLine,
  waitForPane,
} from "./tmux-helpers.mjs";

/**
 * Task 7 scrollback smoke: prove PageUp scrollback works through the REAL boot
 * chain (bin/unclecode.cjs -> rust -> node dist), not just the src test
 * harness. 12 short turns overflow any plausible transcript capacity at -y 30,
 * so a single PageUp must paint the frozen indicator row and Escape must clear
 * it. Failure shape is throw-only: every wait helper below throws on timeout
 * and nothing in here catches, because the runtime-QA runner hardcodes the
 * pass status — a swallowed failure would silently pass the gate.
 */
const SCROLLBACK_TURN_COUNT = 12;
const SCROLLBACK_INDICATOR_PATTERN = /↑ (\d+) earlier rows · Fn\+Up\/PageUp · ↓ \d+ newer rows · Fn\+Down\/PageDown · Esc latest/u;
const REQUEST_WAIT_TIMEOUT_MS = 30_000;
const PANE_POLL_INTERVAL_MS = 100;
/**
 * Once the transcript overflows the pane (the whole point of this smoke), the
 * "Ready · last reply" status row scrolls off-screen, so idle cannot be
 * detected via waitForIdleComposer. Turn completion is instead anchored to the
 * always-visible bottom region: the turn's prompt echoed in the transcript,
 * the empty-composer placeholder back in place, and the idle composer hint.
 * A busy frame swaps the hint for "Enter queues follow-up"; a still-typing
 * frame replaces the placeholder with the draft — neither can match.
 */
const COMPOSER_PLACEHOLDER_TEXT = "Describe a task · / for commands";

function turnCompletionPattern(prompt, reply) {
  // Every branch needs its own `.*` prefix: a bare lookahead would pin the
  // match anchor to that one string's position, breaking the "all of these
  // somewhere in the pane" semantics (same composition the context smoke uses).
  return new RegExp(
    `(?=.*\\b${escapeRegExp(prompt)}\\b)` +
      `(?=.*${escapeRegExp(reply)})` +
      `(?=.*${escapeRegExp(COMPOSER_PLACEHOLDER_TEXT)})` +
      `(?=.*${IDLE_COMPOSER_PATTERN.source})`,
    "is",
  );
}

export async function runScrollbackTuiSmoke({ port, tmp, observations }) {
  const tmux = await run("sh", ["-lc", "command -v tmux"], process.env);
  assert.equal(tmux.code, 0, "tmux is required for the scrollback TUI QA gate");

  const session = `unclecode-scrollback-qa-${process.pid}`;
  const paneFile = path.join(tmp, "scrollback-pane.txt");
  const scrolledPaneFile = path.join(tmp, "scrollback-scrolled-pane.txt");
  const restedPaneFile = path.join(tmp, "scrollback-rested-pane.txt");
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

    for (let turn = 1; turn <= SCROLLBACK_TURN_COUNT; turn += 1) {
      const prompt = `scroll turn ${String(turn).padStart(2, "0")}`;
      const observationIndex = observations.length;
      await submitLine(session, prompt, paneFile);
      // SCC may issue additional reviewer/quality requests. A global request
      // count can therefore be satisfied before this exact user turn reaches
      // the provider, and the smoke would kill the TUI while owner work is
      // still starting. Bind the barrier to this turn's extracted user input.
      await waitForProviderRequest({
        observations,
        afterIndex: observationIndex,
        prompt,
      });
      // Wait out the full turn before the next submit: submitting during the
      // busy window arms the composer queue instead of starting a turn, and
      // the queue drain can race the idle transition (a queued follow-up can
      // then strand the engine idle with a backlog). The completion pattern
      // below only matches once this turn's reply landed and the composer is
      // back to idle, so the next Enter always starts a fresh turn.
      await waitForPane(
        session,
        turnCompletionPattern(prompt, scrollbackResponseText(prompt)),
        paneFile,
      );
    }
    await sleep(400);
    const idlePane = await capturePane(session, paneFile);
    const lastPrompt = `scroll turn ${String(SCROLLBACK_TURN_COUNT).padStart(2, "0")}`;
    assert.match(
      idlePane,
      new RegExp(`\\b${escapeRegExp(lastPrompt)}\\b`),
      "idle pane should show the last scrollback turn's user entry",
    );
    assert.match(idlePane, new RegExp(responseText), "idle pane should show the canned reply");
    assert.doesNotMatch(idlePane, /Unknown command|panic|TypeError|ReferenceError/);
    const requestDelta = observations.length - beforeRequests;

    await runTmux(["send-keys", "-t", session, "PageUp"]);
    const scrolledPane = await waitForPane(session, SCROLLBACK_INDICATOR_PATTERN, scrolledPaneFile);
    const indicatorMatch = scrolledPane.match(SCROLLBACK_INDICATOR_PATTERN);
    const entriesAbove = Number(indicatorMatch?.[1] ?? 0);
    assert.ok(
      entriesAbove >= 1,
      `PageUp should hide at least one older entry above the window, got ${entriesAbove}`,
    );

    await runTmux(["send-keys", "-t", session, "Escape"]);
    const restedPane = await waitForPaneGone(
      session,
      SCROLLBACK_INDICATOR_PATTERN,
      restedPaneFile,
    );
    assert.doesNotMatch(restedPane, SCROLLBACK_INDICATOR_PATTERN);
    assert.match(
      restedPane,
      IDLE_COMPOSER_PATTERN,
      "Escape should return the transcript to newest without disturbing the composer",
    );
    assert.match(restedPane, new RegExp(responseText), "newest transcript entries should be back after Escape");

    return {
      paneExcerpt: idlePane.trimEnd(),
      scrolledPaneExcerpt: scrolledPane.trimEnd(),
      restedPaneExcerpt: restedPane.trimEnd(),
      turns: SCROLLBACK_TURN_COUNT,
      entriesAbove,
      requestDelta,
      pageUpIndicatorVerified: true,
      escapeReturnVerified: true,
    };
  } finally {
    await runTmux(["kill-session", "-t", session], { allowFailure: true });
  }
}

/**
 * Bounded wait for this exact user turn's fake-provider response to finish.
 * Extra SCC reviewer calls and merely accepted-but-unsettled requests cannot
 * satisfy the barrier. Throws on timeout — no swallowing, per the runner.
 */
export async function waitForProviderRequest({
  observations,
  afterIndex,
  prompt,
  timeoutMs = REQUEST_WAIT_TIMEOUT_MS,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let index = afterIndex; index < observations.length; index += 1) {
      const observation = observations[index];
      if (
        observation?.responseFinished === true
        && extractRuntimeQaUserRequest(observation.text ?? "") === prompt
      ) {
        return observation;
      }
    }
    await sleep(PANE_POLL_INTERVAL_MS);
  }
  const observedRequests = observations
    .slice(afterIndex)
    .map((observation) => extractRuntimeQaUserRequest(observation?.text ?? ""));
  throw new Error(
    `Timed out waiting for provider request ${JSON.stringify(prompt)}; `
      + `observed ${JSON.stringify(observedRequests)} in the scrollback smoke`,
  );
}

/**
 * Bounded wait for a pane pattern to DISAPPEAR. Absence cannot be asserted off
 * a single capture (the clearing repaint may not have flushed yet), so poll
 * until it is gone and throw if the deadline passes with it still painted.
 */
async function waitForPaneGone(session, pattern, paneFile, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastPane = "";
  while (Date.now() < deadline) {
    lastPane = await capturePane(session, paneFile);
    if (!pattern.test(lastPane)) {
      return lastPane;
    }
    await sleep(PANE_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for pattern to disappear: ${pattern}\nLast pane:\n${lastPane.trimEnd()}`);
}
