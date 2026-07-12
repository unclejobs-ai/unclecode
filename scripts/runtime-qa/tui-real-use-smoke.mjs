import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  realUseFirstPromptText,
  realUseFirstResponseText,
  realUseQueuedPromptText,
  realUseQueuedResponseText,
  repoRoot,
} from "./constants.mjs";
import { escapeRegExp, run, shellQuote, sleep } from "./cli-helpers.mjs";
import { extractRuntimeQaUserRequest } from "./fake-gemini-server.mjs";
import {
  calculatePaneWidth,
  capturePane,
  lowerBusyActivityRowPattern,
  pressEnter,
  runTmux,
  submitLine,
  typeKeys,
  waitForIdlePromptDeck,
  waitForPane,
} from "./tmux-helpers.mjs";

const MAX_REAL_USE_LATENCY_MS = 12_000;

export async function runRealUseTuiStress({ port, tmp, observations }) {
  const tmux = await run("sh", ["-lc", "command -v tmux"], process.env);
  assert.equal(tmux.code, 0, "tmux is required for the real-use TUI stress gate");

  const session = `unclecode-real-use-qa-${process.pid}`;
  const paneFile = path.join(tmp, "real-use-pane.txt");
  const contextPaneFile = path.join(tmp, "real-use-context-pane.txt");
  const busyPaneFile = path.join(tmp, "real-use-busy-pane.txt");
  const queuePaneFile = path.join(tmp, "real-use-queue-pane.txt");
  const idlePaneAFile = path.join(tmp, "real-use-idle-a-pane.txt");
  const idlePaneBFile = path.join(tmp, "real-use-idle-b-pane.txt");
  const resize80PaneFile = path.join(tmp, "real-use-80-pane.txt");
  const resize120PaneFile = path.join(tmp, "real-use-120-pane.txt");
  const widthFile = path.join(tmp, "real-use-width.json");
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
    await runTmux(["new-session", "-d", "-x", "100", "-y", "32", "-s", session, command]);
    await waitForPane(session, /prompt deck|UncleCode · Gemini/, paneFile);

    await submitLine(session, "/context", paneFile);
    const contextPane = await waitForPane(
      session,
      /Sources · \d+ included|Warnings · none|✓ none/i,
      contextPaneFile,
    );
    assert.match(contextPane, /Sources · \d+ included/);
    assert.match(contextPane, /Held back locally|\d+ held back/);
    assert.match(contextPane, /Warnings · none|✓ none/i);
    assert.doesNotMatch(contextPane, /Unknown command|panic|TypeError|ReferenceError/);
    await runTmux(["send-keys", "-t", session, "Escape"]);
    await waitForPane(session, /prompt deck/, paneFile);
    await sleep(200);

    await submitLine(session, "/reasoning high", paneFile, /\/reasoning high matches|\/reasoning high/);
    const reasoningPane = await waitForPane(session, /Reasoning picker|Reasoning fixed|Reasoning ·/, paneFile);
    assert.doesNotMatch(reasoningPane, /Unknown command|panic|TypeError|ReferenceError/);
    await runTmux(["send-keys", "-t", session, "Escape"]);
    await waitForPane(session, /prompt deck/, paneFile);
    await sleep(200);

    const firstSubmitStartedAt = Date.now();
    await submitLine(session, realUseFirstPromptText, paneFile, new RegExp(escapeRegExp(realUseFirstPromptText)));
    const busyPane = await waitForPane(
      session,
      /preparing context|thinking|Working|Enter queues follow-up/,
      busyPaneFile,
    );
    assert.doesNotMatch(
      busyPane,
      lowerBusyActivityRowPattern(),
      "real-use busy state should rely on the status spinner instead of adding a duplicate lower activity row",
    );
    assert.doesNotMatch(
      busyPane,
      /Work context · session state|╭─|╰─/,
      "real-use busy state should stay on the compact status row",
    );

    await typeKeys(session, realUseQueuedPromptText);
    await waitForPane(session, new RegExp(escapeRegExp(realUseQueuedPromptText)), queuePaneFile);
    const queuedSubmitStartedAt = Date.now();
    await pressEnter(session);
    const queuePane = await waitForPane(session, /queued|follow-up|\/queue/i, queuePaneFile);
    assert.match(queuePane, /queued|follow-up|\/queue/i);

    await waitForPane(session, new RegExp(escapeRegExp(realUseFirstResponseText)), paneFile);
    const firstReplyMs = Date.now() - firstSubmitStartedAt;
    await waitForPane(session, new RegExp(escapeRegExp(realUseQueuedResponseText)), paneFile);
    const queueDrainMs = Date.now() - queuedSubmitStartedAt;
    assert.ok(firstReplyMs <= MAX_REAL_USE_LATENCY_MS, `first real-use TUI reply took ${firstReplyMs}ms`);
    assert.ok(queueDrainMs <= MAX_REAL_USE_LATENCY_MS, `queued real-use TUI reply took ${queueDrainMs}ms`);
    const pane = await waitForIdlePromptDeck(session, paneFile);
    await sleep(300);
    const idlePaneA = await capturePane(session, idlePaneAFile);
    await sleep(300);
    const idlePaneB = await capturePane(session, idlePaneBFile);
    assert.equal(
      normalizeIdlePane(idlePaneA),
      normalizeIdlePane(idlePaneB),
      "idle prompt deck should not keep changing after volatile reply age text is normalized",
    );
    const realUseRequests = observations.slice(beforeRequests);

    assert.equal(realUseRequests.length, 2, `real-use stress should make two provider calls, got ${realUseRequests.length}`);
    assert.match(pane, new RegExp(escapeRegExp(realUseFirstPromptText)));
    assert.match(pane, new RegExp(escapeRegExp(realUseFirstResponseText)));
    assert.match(pane, new RegExp(escapeRegExp(realUseQueuedPromptText)));
    assert.match(pane, new RegExp(escapeRegExp(realUseQueuedResponseText)));
    assert.match(pane, new RegExp(`Running queued follow-up #1: ${escapeRegExp(realUseQueuedPromptText)}`));
    assert.doesNotMatch(
      pane,
      new RegExp(escapeRegExp(`${realUseFirstPromptText}${realUseQueuedPromptText}`)),
      "queued prompt should not be appended to the just-submitted first prompt",
    );
    assert.doesNotMatch(pane, /Unknown command|panic|TypeError|ReferenceError/);
    assert.doesNotMatch(pane, /Work context · session state|╭─|╰─/);
    assert.deepEqual(
      realUseRequests.map((request) => Boolean(request.text?.includes("<unclecode_context_packet"))),
      [true, true],
      "real-use TUI turns should send model-bound context packets",
    );
    assert.ok(
      realUseRequests.every((request) =>
        request.text?.includes("Included:") &&
        request.text?.includes("Excluded raw artifacts:") &&
        request.text?.includes("Warnings:") &&
        request.text?.includes("User request:")),
      "real-use context packets should expose included/excluded/warnings/user request sections",
    );
    assert.match(realUseRequests[0]?.text ?? "", new RegExp(escapeRegExp(realUseFirstPromptText)));
    assert.match(realUseRequests[1]?.text ?? "", new RegExp(escapeRegExp(realUseQueuedPromptText)));
    assert.equal(extractRuntimeQaUserRequest(realUseRequests[0]?.text ?? ""), realUseFirstPromptText);
    assert.equal(extractRuntimeQaUserRequest(realUseRequests[1]?.text ?? ""), realUseQueuedPromptText);

    await runTmux(["resize-window", "-t", session, "-x", "80", "-y", "24"]);
    await sleep(500);
    const resize80 = await capturePane(session, resize80PaneFile);
    const width80 = calculatePaneWidth(resize80, 80);
    assert.deepEqual(width80.over, [], `Real-use TUI 80-column overflow: ${JSON.stringify(width80.over)}`);

    await runTmux(["resize-window", "-t", session, "-x", "120", "-y", "36"]);
    await sleep(500);
    const resize120 = await capturePane(session, resize120PaneFile);
    const width120 = calculatePaneWidth(resize120, 120);
    assert.deepEqual(width120.over, [], `Real-use TUI 120-column overflow: ${JSON.stringify(width120.over)}`);

    const width100 = calculatePaneWidth(pane, 100);
    writeFileSync(widthFile, JSON.stringify({ width100, width80, width120 }, null, 2));
    assert.deepEqual(width100.over, [], `Real-use TUI 100-column overflow: ${JSON.stringify(width100.over)}`);

    return {
      paneExcerpt: pane.trimEnd(),
      contextPaneExcerpt: contextPane.trimEnd(),
      queuePaneExcerpt: queuePane.trimEnd(),
      widths: { width100, width80, width120 },
      latencies: { firstReplyMs, queueDrainMs, maxMs: MAX_REAL_USE_LATENCY_MS },
      requestDelta: realUseRequests.length,
      contextPacketTransparency: true,
      queueDrainVerified: true,
      resizeVerified: true,
      idleStableVerified: true,
      latencyWithinBudget: true,
      duplicateBusyActivityRegression: false,
    };
  } finally {
    await runTmux(["kill-session", "-t", session], { allowFailure: true });
  }
}

function normalizeIdlePane(pane) {
  return pane.replace(/Ready · last(?: reply)? \d+(?:\.\d+)?s/g, "Ready · last <age>");
}
