import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  openAIStreamFinalMarkerText,
  openAIStreamPartialMarkerText,
  openAIStreamPromptText,
  repoRoot,
  tmpPrefix,
} from "./constants.mjs";
import { escapeRegExp, run, shellQuote } from "./cli-helpers.mjs";
import { startOpenAIChatServer } from "./fake-openai-server.mjs";
import {
  capturePane,
  killRuntimeTmuxServer,
  pressEnter,
  runTmux,
  typeKeys,
  waitForIdlePromptDeck,
  waitForPane,
} from "./tmux-helpers.mjs";

const STREAM_CHUNK_DELAY_MS = 900;
const STREAMING_CURSOR = "▌";

/**
 * Prove OpenAI chat streaming end to end: while the fake server drips SSE
 * content chunks, the TUI must show the partial text with the streaming
 * cursor before the final chunk lands, then settle into the idle deck with
 * the full reply. Runs against its own fake OpenAI server instance so the
 * shared tool-call server keeps its request-count contract.
 */
export async function runOpenAIStreamTuiSmoke({ tmp }) {
  const tmux = await run("sh", ["-lc", "command -v tmux"], process.env);
  assert.equal(tmux.code, 0, "tmux is required for the OpenAI streaming TUI QA gate");

  const observations = [];
  const server = await startOpenAIChatServer(
    (observation) => observations.push(observation),
    { streamChunkDelayMs: STREAM_CHUNK_DELAY_MS },
  );

  const session = `unclecode-openai-stream-qa-${process.pid}`;
  const paneFile = path.join(tmp, "openai-stream-pane.txt");
  const partialPaneFile = path.join(tmp, "openai-stream-partial-pane.txt");
  await runTmux(["kill-session", "-t", session], { allowFailure: true });

  const command = [
    `cd ${shellQuote(repoRoot)}`,
    [
      "UNCLECODE_MODE=default",
      `OPENAI_API_BASE_URL=${shellQuote(`http://127.0.0.1:${server.port}/v1`)}`,
      "OPENAI_API_KEY=sk-local-provider-test-key",
      "NO_PROXY=127.0.0.1,localhost",
      // Clear inherited proxy configuration so the provider stays on the
      // live-stream fetch path instead of the proxy-aware Rust transport.
      "HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= http_proxy= https_proxy= all_proxy=",
      "node bin/unclecode.cjs tui --provider openai --model gpt-4.1-mini",
    ].join(" "),
    "echo EXIT:$?",
    "sleep 20",
  ].join(" && ");

  try {
    await runTmux(["new-session", "-d", "-x", "100", "-y", "30", "-s", session, command]);
    await waitForPane(session, /prompt deck|UncleCode · OpenAI/i, paneFile);

    await typeKeys(session, openAIStreamPromptText);
    await waitForPane(session, new RegExp(escapeRegExp(openAIStreamPromptText)), paneFile);
    await pressEnter(session);

    // Mid-stream evidence: the first chunk plus the streaming cursor must be
    // visible while later chunks are still pending on the wire.
    const partialPane = await waitForPane(
      session,
      new RegExp(`${escapeRegExp(openAIStreamPartialMarkerText)}[\\s\\S]*${STREAMING_CURSOR}`, "u"),
      partialPaneFile,
    );
    const partialTextVisible = partialPane.includes(openAIStreamPartialMarkerText);
    const streamingCursorVisible = partialPane.includes(STREAMING_CURSOR);
    const partialCapturedMidStream = !partialPane.includes(openAIStreamFinalMarkerText);
    assert.equal(partialTextVisible, true, "partial streamed text must be visible mid-turn");
    assert.equal(streamingCursorVisible, true, "streaming cursor must accompany the partial text");
    assert.equal(
      partialCapturedMidStream,
      true,
      `partial capture already contained the final chunk; stream chunk delay ${STREAM_CHUNK_DELAY_MS}ms was not observable`,
    );

    await waitForPane(session, new RegExp(escapeRegExp(openAIStreamFinalMarkerText)), paneFile);
    const pane = await waitForIdlePromptDeck(session, paneFile);
    assert.ok(
      pane.replace(/\n/g, "").includes(openAIStreamFinalMarkerText),
      `final stream marker missing from pane: ${openAIStreamFinalMarkerText}`,
    );
    assert.doesNotMatch(pane, /Unknown command|panic|TypeError|ReferenceError/);
    assert.doesNotMatch(
      pane,
      new RegExp(`${escapeRegExp(openAIStreamFinalMarkerText)}${STREAMING_CURSOR}`, "u"),
      "streaming cursor must clear once the turn settles",
    );

    const streamRequests = observations.filter((request) => request.stream === true);
    assert.ok(
      streamRequests.length >= 1,
      `TUI turn should request chat completions with stream:true, saw ${JSON.stringify(observations)}`,
    );

    return {
      paneExcerpt: pane.trimEnd(),
      partialPaneExcerpt: partialPane.trimEnd(),
      requestDelta: observations.length,
      streamRequestObserved: true,
      partialTextVisible: true,
      streamingCursorVisible: true,
      partialCapturedMidStream: true,
      finalTextVisible: true,
      streamingCursorCleared: true,
    };
  } finally {
    await runTmux(["kill-session", "-t", session], { allowFailure: true });
    await capturePane(session, paneFile).catch(() => undefined);
    await server.close();
  }
}

const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const tmp = mkdtempSync(path.join(tmpdir(), `${tmpPrefix}openai-stream-`));
  try {
    const result = await runOpenAIStreamTuiSmoke({ tmp });
    writeFileSync(
      path.join(tmp, "openai-stream-result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    console.log(JSON.stringify(
      {
        status: "pass",
        streamRequestObserved: result.streamRequestObserved,
        partialTextVisible: result.partialTextVisible,
        streamingCursorVisible: result.streamingCursorVisible,
        partialCapturedMidStream: result.partialCapturedMidStream,
        finalTextVisible: result.finalTextVisible,
        streamingCursorCleared: result.streamingCursorCleared,
        requestDelta: result.requestDelta,
      },
      null,
      2,
    ));
    console.log("--- partial pane (mid-stream) ---");
    console.log(result.partialPaneExcerpt);
  } finally {
    await killRuntimeTmuxServer();
    rmSync(tmp, { recursive: true, force: true });
  }
}
