import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  OMP_CONTROL_URL_ENV,
  writeOmpExecutorFixture,
} from "./agent-console-smoke-fixture.mjs";
import {
  ALPHA,
  BETA,
  PROMPT_TEXT,
  startAgentConsoleControlServer,
  STEER_MESSAGE,
} from "./agent-console-smoke-server.mjs";
import { binEntrypoint, repoRoot, reportPath } from "./constants.mjs";
import { escapeRegExp, run, shellQuote } from "./cli-helpers.mjs";
import {
  calculatePaneWidth,
  capturePane,
  IDLE_COMPOSER_PATTERN,
  pressEnter,
  READY_LAST_STATUS_PATTERN,
  runTmux,
  submitLine,
  typeKeys,
  waitForPane,
} from "./tmux-helpers.mjs";

// Offline end-to-end gate for the Agent Console control surface.
//
// Two delegated runs stay genuinely live while this smoke inspects, steers,
// cancels, drains, re-reads, and resumes them. The direct Gemini transport and
// OMP worker boundary are scripted without mutating the runner environment.
// Every wait uses a frame predicate rather than a fixed delay.
//
// The status line reads `2 jobs`, not `2 agents`: a run is charged to its
// owning job once. The console header still asserts both projections.


const HEADER_PATTERN = /▤ Agent Console/;
const COUNTS_PATTERN = /2 agents · 2 jobs/;
const AGENTS_TAB_PATTERN = /\[Agents\]/;
const JOBS_TAB_PATTERN = /\[Jobs\]/;
const INSPECTOR_RUNNING_PATTERN = /executor · running/;
const ACCEPTED_PATTERN = /✔ Control accepted/;
const PHANTOM_PATTERN = /· (?:queued|running|waiting|interrupted)\b/;
const CRASH_PATTERN = /Unknown command|panic|TypeError|ReferenceError/;

const rowPattern = (label, status) => new RegExp(`${escapeRegExp(label)} · ${status}`);

export async function runAgentConsoleTuiSmoke({ tmp }) {
  const tmux = await run("sh", ["-lc", "command -v tmux"], process.env);
  assert.equal(tmux.code, 0, "tmux is required for the Agent Console TUI QA gate");

  const live = `unclecode-agent-console-qa-${process.pid}`;
  const resumed = `unclecode-agent-console-resume-qa-${process.pid}`;
  const server = await startAgentConsoleControlServer();
  try {
    const sessionStoreRoot = path.join(tmp, "agent-console-session-store");
    mkdirSync(sessionStoreRoot, { recursive: true });
    const omp = writeOmpExecutorFixture(tmp);

    const paneFile = path.join(tmp, "agent-console-pane.txt");
    const consoleFile = path.join(tmp, "agent-console-console-pane.txt");
    const cancelFile = path.join(tmp, "agent-console-cancel-pane.txt");
    const settledFile = path.join(tmp, "agent-console-settled-pane.txt");
    const jobsFile = path.join(tmp, "agent-console-jobs-pane.txt");
    const resumeFile = path.join(tmp, "agent-console-resume-pane.txt");
    const widthFile = path.join(tmp, "agent-console-width.json");

    const tuiCommand = (extraArgs) => [
      `cd ${shellQuote(repoRoot)}`,
      [
        "UNCLECODE_MODE=ultrawork",
        `GEMINI_API_BASE_URL=${shellQuote(`http://127.0.0.1:${server.port}/v1beta`)}`,
        "GEMINI_API_KEY=local-provider-test-key",
        "NO_PROXY=127.0.0.1,localhost",
        "HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= http_proxy= https_proxy= all_proxy=",
        `UNCLECODE_SESSION_STORE_ROOT=${shellQuote(sessionStoreRoot)}`,
        `UNCLECODE_OMP_BIN=${shellQuote(omp.binPath)}`,
        `UNCLECODE_OMP_BUN_BIN=${shellQuote(omp.bunPath)}`,
        `${OMP_CONTROL_URL_ENV}=${shellQuote(`http://127.0.0.1:${server.port}/omp`)}`,
        `${shellQuote(process.execPath)} bin/unclecode.cjs tui --provider gemini --model gemini-2.5-flash${extraArgs}`,
      ].join(" "),
      "exit_code=$?",
      "echo EXIT:$exit_code",
      "while :; do sleep 3600; done",
    ].join("; ");

    await runTmux(["kill-session", "-t", live], { allowFailure: true });
    await runTmux(["kill-session", "-t", resumed], { allowFailure: true });

    // 1. Submit the deterministic complex-work fixture.
    await runTmux(["new-session", "-d", "-x", "100", "-y", "44", "-s", live, tuiCommand("")]);
    await waitForPane(live, /prompt deck|UncleCode · Gemini/, paneFile);
    await submitLine(live, PROMPT_TEXT, paneFile);

    // 2. Two executor jobs report as live work on the status row.
    const busyPane = await waitForPane(live, /\b2 jobs\b/, paneFile);
    assert.doesNotMatch(busyPane, CRASH_PATTERN);

    // 3. Alt+A opens the roster plus, at 100 columns, the paired inspector.
    //    Each row is awaited on its own: a job counts as live the moment the
    //    plan queues it, so `2 jobs` can land a frame before the second
    //    executor run has actually opened.
    await runTmux(["send-keys", "-t", live, "M-a"]);
    await waitForPane(live, HEADER_PATTERN, consoleFile);
    await waitForPane(live, rowPattern(ALPHA, "running"), consoleFile);
    await waitForPane(live, rowPattern(BETA, "running"), consoleFile);
    await Promise.all([server.waitForLane("alpha"), server.waitForLane("beta")]);
    const consolePane = await waitForPane(live, INSPECTOR_RUNNING_PATTERN, consoleFile);
    assert.match(consolePane, AGENTS_TAB_PATTERN);
    assert.match(consolePane, COUNTS_PATTERN, "the console header reports both projections");
    assert.match(
      consolePane,
      new RegExp(`› ◐ ${escapeRegExp(ALPHA)}`),
      "the console should open with the first run selected",
    );

    // 4. Steer the first run and take the accepted receipt.
    await typeKeys(live, "s");
    await typeKeys(live, STEER_MESSAGE);
    await waitForPane(live, new RegExp(escapeRegExp(STEER_MESSAGE)), consoleFile);
    await pressEnter(live);
    const steeredPane = await waitForPane(live, ACCEPTED_PATTERN, consoleFile);
    assert.match(steeredPane, rowPattern(ALPHA, "running"));

    // 5. Select the second run and confirm its cancellation with `y`.
    await typeKeys(live, "j");
    await waitForPane(live, new RegExp(`› ◐ ${escapeRegExp(BETA)}`), cancelFile);
    await typeKeys(live, "x");
    const confirmPane = await waitForPane(
      live,
      new RegExp(`⚠ Cancel ${escapeRegExp(BETA)}\\?`),
      cancelFile,
    );
    assert.match(confirmPane, /y confirm · n keep running · Esc dismiss/);
    await typeKeys(live, "y");

    // 6. The cancelled run settles and one delegated run stays active.
    const cancelledPane = await waitForPane(live, rowPattern(BETA, "cancelled"), cancelFile);
    assert.match(cancelledPane, ACCEPTED_PATTERN);
    assert.match(cancelledPane, rowPattern(ALPHA, "running"));
    assert.doesNotMatch(
      cancelledPane,
      rowPattern(BETA, "(?:queued|running|waiting)"),
      "the cancelled run must not still read as executing",
    );

    // 7. Select and release the surviving lane: the steer lands, the run
    //    completes, and every live count leaves the shell.
    await typeKeys(live, "k");
    await waitForPane(live, new RegExp(`› ◐ ${escapeRegExp(ALPHA)}`), settledFile);
    server.releaseLane("alpha");
    await waitForPane(live, /executor · completed/, settledFile);
    await runTmux(["send-keys", "-t", live, "Escape"]);
    await waitForPane(live, READY_LAST_STATUS_PATTERN, settledFile);
    const settledPane = await waitForPane(live, IDLE_COMPOSER_PATTERN, settledFile);
    assert.doesNotMatch(settledPane, HEADER_PATTERN, "Esc should close the console");
    assert.doesNotMatch(settledPane, /\b\d+ agents?\b/, "no active agent count should survive");
    assert.doesNotMatch(settledPane, /\b\d+ jobs?\b/, "no active job count should survive");
    assert.doesNotMatch(settledPane, CRASH_PATTERN);

    // 8. `/jobs` still holds both settled records.
    await submitLine(live, "/jobs", paneFile);
    const jobsPane = await waitForPane(live, JOBS_TAB_PATTERN, jobsFile);
    assert.match(jobsPane, new RegExp(escapeRegExp(ALPHA)));
    assert.match(jobsPane, new RegExp(escapeRegExp(BETA)));
    assert.match(jobsPane, /executor · completed/);
    await typeKeys(live, "j");
    const cancelledJobPane = await waitForPane(live, /executor · cancelled/, jobsFile);
    assert.match(cancelledJobPane, COUNTS_PATTERN, "both job records should survive the turn");
    assert.match(jobsPane, COUNTS_PATTERN, "both job records should survive the turn");
    assert.doesNotMatch(jobsPane, CRASH_PATTERN);

    await runTmux(["send-keys", "-t", live, "Escape"]);
    await waitForPane(live, IDLE_COMPOSER_PATTERN, paneFile);
    await submitLine(live, "/exit", paneFile);
    await waitForPane(live, /EXIT:/, paneFile);

    // 9. Resuming rebuilds the settled console without resurrecting a run that
    //    is no longer executing anywhere.
    const sessionId = await readPersistedSessionId(sessionStoreRoot);
    const resumeArgs = ` --session-id ${shellQuote(sessionId)}`;
    await runTmux([
      "new-session", "-d", "-x", "100", "-y", "44", "-s", resumed, tuiCommand(resumeArgs),
    ]);
    await waitForPane(resumed, /prompt deck|UncleCode · Gemini/, resumeFile);
    await submitLine(resumed, "/agents", resumeFile);
    let resumedPane = await waitForPane(resumed, AGENTS_TAB_PATTERN, resumeFile);
    assert.match(resumedPane, new RegExp(escapeRegExp(ALPHA)));
    assert.match(resumedPane, new RegExp(escapeRegExp(BETA)));
    assert.match(resumedPane, /executor · completed/);
    await typeKeys(resumed, "j");
    resumedPane = await waitForPane(resumed, /executor · cancelled/, resumeFile);
    assert.doesNotMatch(resumedPane, PHANTOM_PATTERN, "a resumed session must not show a phantom");
    assert.doesNotMatch(resumedPane, CRASH_PATTERN);

    const width = calculatePaneWidth(consolePane);
    writeFileSync(widthFile, JSON.stringify(width, null, 2));
    assert.deepEqual(width.over, [], `Agent Console overflow: ${JSON.stringify(width.over)}`);
    const laneMessage = "two executor lanes plus one steered follow-up should dispatch";
    assert.deepEqual(server.executorLanes(), ["alpha", "beta", "steer"], laneMessage);

    return {
      paneExcerpt: settledPane.trimEnd(),
      consolePaneExcerpt: consolePane.trimEnd(),
      jobsPaneExcerpt: jobsPane.trimEnd(),
      resumePaneExcerpt: resumedPane.trimEnd(),
      width,
      sessionId,
      providerRequests: server.geminiRequestCount(),
      executorTurns: server.executorLanes(),
      twoRunFanout: true,
      steerAccepted: true,
      cancelConfirmed: true,
      settledCountsCleared: true,
      jobRecordsRetained: true,
      resumePhantomRegression: false,
    };
  } catch (error) {
    const frames = [
      await captureFailureFrame(live, "live"),
      await captureFailureFrame(resumed, "resume"),
    ].filter((frame) => frame !== undefined);
    if (frames.length === 0) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nCaptured frames: ${frames.join(", ")}`, { cause: error });
  } finally {
    try {
      await runTmux(["kill-session", "-t", live], { allowFailure: true });
      await runTmux(["kill-session", "-t", resumed], { allowFailure: true });
    } finally {
      await server.close();
    }
  }
}

/** Persist a failing session's last frame beside the runtime-QA report, so the
 * evidence outlives the runner's temporary directory. */
async function captureFailureFrame(session, label) {
  try {
    const dir = path.dirname(reportPath);
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `agent-console-${label}-failure-frame.txt`);
    await capturePane(session, target);
    return target;
  } catch {
    return undefined;
  }
}

async function readPersistedSessionId(sessionStoreRoot) {
  const listed = await run(process.execPath, [binEntrypoint, "sessions"], {
    ...process.env,
    UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
  });
  const match = /^(\S+) \| state=/m.exec(listed.stdout);
  assert.ok(match, `the console turn should persist a resumable session, got:\n${listed.stdout}`);
  return match[1];
}

