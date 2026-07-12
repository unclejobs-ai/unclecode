import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { repoRoot, ttyResponseText } from "./constants.mjs";
import { run, shellQuote, sleep } from "./cli-helpers.mjs";
import { calculatePaneWidth, runTmux, sendKeys, waitForPane } from "./tmux-helpers.mjs";

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
    `status=$?`,
    `echo EXIT:$status`,
    `sleep 20`,
    `exit $status`,
  ].join("; ");

  try {
    await runTmux(["new-session", "-d", "-x", "100", "-y", "30", "-s", session, command]);
    await waitForPane(session, /UncleCode|unclecode>/, paneFile);
    await sendKeys(session, "/status");
    await sleep(400);
    await sendKeys(session, "/context");
    await sleep(600);
    await sendKeys(session, "Say hello from runtime TTY QA.");
    try {
      await waitForPane(session, new RegExp(ttyResponseText), paneFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\nRecent provider observations:\n${JSON.stringify(observations.slice(beforeRequests), null, 2)}`);
    }
    const pane = readFileSync(paneFile, "utf8");
    assert.match(pane, /UncleCode · Gemini/);
    assert.match(pane, /Work context status|Context opened|context \d+ ready|▤ \d+ ctx/i);
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
