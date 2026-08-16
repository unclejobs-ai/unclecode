import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { repoRoot, ttyResponseText } from "./constants.mjs";
import { run, shellQuote } from "./cli-helpers.mjs";
import {
  calculatePaneWidth,
  IDLE_COMPOSER_PATTERN,
  runTmux,
  sendKeys,
  waitForPane,
} from "./tmux-helpers.mjs";

export async function runTtySmoke({ port, tmp, observations }) {
  const tmux = await run("sh", ["-lc", "command -v tmux"], process.env);
  assert.equal(tmux.code, 0, "tmux is required for the runtime TTY QA gate");

  const session = `unclecode-runtime-qa-${process.pid}`;
  const paneFile = path.join(tmp, "work-pane.txt");
  const widthFile = path.join(tmp, "work-width.json");
  const beforeRequests = observations.length;
  await runTmux(["kill-session", "-t", session], { allowFailure: true });

  const launchCommand = [
    `UNCLECODE_MODE=default`,
    `HOME=${shellQuote(tmp)}`,
    `UNCLECODE_SESSION_STORE_ROOT=${shellQuote(path.join(tmp, "session-store"))}`,
    `GEMINI_API_BASE_URL=${shellQuote(`http://127.0.0.1:${port}/v1beta`)}`,
    `GEMINI_API_KEY=local-provider-test-key`,
    `NO_PROXY=127.0.0.1,localhost`,
    `${shellQuote(process.execPath)} bin/unclecode.cjs work --provider gemini --model gemini-2.5-flash`,
  ].join(" ");
  const command = [
    `cd ${shellQuote(repoRoot)} && ${launchCommand}`,
    `exit_code=$?`,
    `echo EXIT:$exit_code`,
    `sleep 20`,
    `exit $exit_code`,
  ].join("; ");

  try {
    await runTmux(["new-session", "-d", "-x", "100", "-y", "30", "-s", session, command]);
    const initialPane = await waitForPane(session, /UncleCode|unclecode>/, paneFile);
    await sendKeys(session, "/status");
    await waitForPane(session, /Status shown\. Live steps return on the next action\./, paneFile);
    await waitForPane(session, IDLE_COMPOSER_PATTERN, paneFile);
    await sendKeys(session, "/context");
    const contextPane = await waitForPane(session, /Sources · \d+ sent · \d+ held/, paneFile);
    await runTmux(["send-keys", "-t", session, "Escape"]);
    await waitForPane(session, IDLE_COMPOSER_PATTERN, paneFile);
    await sendKeys(session, "Say hello from runtime TTY QA.");
    try {
      await waitForPane(session, new RegExp(ttyResponseText), paneFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\nRecent provider observations:\n${JSON.stringify(observations.slice(beforeRequests), null, 2)}`);
    }
    const pane = readFileSync(paneFile, "utf8");
    assert.match(initialPane, /UncleCode|unclecode>/);
    assert.match(contextPane, /Sources · \d+ sent · \d+ held/);
    assert.doesNotMatch(pane, /Unknown command|panic|TypeError|ReferenceError/);

    const width = calculatePaneWidth(pane);
    writeFileSync(widthFile, JSON.stringify(width, null, 2));
    assert.deepEqual(width.over, [], `TTY display overflow: ${JSON.stringify(width.over)}`);
    return {
      paneExcerpt: pane.trimEnd(),
      width,
    };
  } finally {
    await runTmux(["kill-session", "-t", session], { allowFailure: true });
  }
}
