import { writeFileSync } from "node:fs";

import { escapeRegExp, run, sleep } from "./cli-helpers.mjs";

const runtimeTmuxSocketName = `unclecode-runtime-qa-${process.pid}`;
const DEFAULT_PANE_WAIT_TIMEOUT_MS = 30_000;
const PANE_POLL_INTERVAL_MS = 100;
export const READY_LAST_STATUS_PATTERN = /Ready · last(?: reply)?(?: \d+(?:\.\d+)?s)?/;
export const IDLE_COMPOSER_PATTERN = /Enter send · Shift\+Enter newline/;

export function runtimeTmuxArgs(args) {
  return ["-f", "/dev/null", "-L", runtimeTmuxSocketName, ...args];
}

export function typedComposerLinePattern(line) {
  return new RegExp(`(?:^|\\n)\\s*[›>]\\s*${escapeRegExp(line)}(?:▏)?\\s*(?=\\n|$)`, "u");
}

export function runtimeTmuxEnvironment(env = process.env) {
  const sanitized = { ...env };
  delete sanitized.CI;
  delete sanitized.NO_COLOR;
  return sanitized;
}

export function runTmux(args, options = {}) {
  return run("tmux", runtimeTmuxArgs(args), runtimeTmuxEnvironment(), {
    ...options,
    detached: false,
  });
}

export async function killRuntimeTmuxServer() {
  await runTmux(["kill-server"], { allowFailure: true });
}

export async function sendKeys(session, line) {
  await runTmux(["send-keys", "-t", session, line, "C-m"]);
}

export async function submitLine(session, line, paneFile, typedPattern = typedComposerLinePattern(line)) {
  await typeKeys(session, line);
  await waitForPane(session, typedPattern, paneFile);
  await pressEnter(session);
}

export async function typeKeys(session, line) {
  await runTmux(["send-keys", "-t", session, line]);
}

export async function pressEnter(session) {
  await runTmux(["send-keys", "-t", session, "C-m"]);
}

export async function capturePane(session, paneFile) {
  const capture = await runTmux(["capture-pane", "-t", session, "-p", "-S", "-240"], {
    allowFailure: true,
  });
  if (capture.code !== 0) {
    throw new Error(`Failed to capture tmux session ${session}: ${capture.stderr.trim()}`);
  }
  writeFileSync(paneFile, capture.stdout);
  return capture.stdout;
}

export async function waitForIdleComposer(session, paneFile) {
  await waitForPane(session, READY_LAST_STATUS_PATTERN, paneFile);
  await waitForPane(session, IDLE_COMPOSER_PATTERN, paneFile);
  await sleep(100);
  return capturePane(session, paneFile);
}

export async function waitForPane(
  session,
  pattern,
  paneFile,
  timeoutMs = DEFAULT_PANE_WAIT_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  let lastPane = "";
  while (Date.now() < deadline) {
    const pane = await capturePane(session, paneFile);
    lastPane = pane;
    if (pattern.test(pane)) {
      return pane;
    }
    await sleep(PANE_POLL_INTERVAL_MS);
  }
  const paneState = await runTmux(
    ["list-panes", "-t", session, "-F", "#{pane_pid} #{pane_dead} #{pane_dead_status} #{pane_current_command}"],
    { allowFailure: true },
  );
  throw new Error(
    `Timed out waiting for ${pattern}\nPane state: ${paneState.stdout.trim()} ${paneState.stderr.trim()}\nLast pane:\n${lastPane.trimEnd()}`,
  );
}

export function calculatePaneWidth(pane, expectedColumns = 100) {
  const rows = pane.split(/\r?\n/).map((line, index) => ({
    index: index + 1,
    width: displayWidth(line),
    line,
  }));
  const max = rows.reduce((left, right) => (right.width > left.width ? right : left), {
    index: 0,
    width: 0,
    line: "",
  });
  return {
    expectedColumns,
    maxWidth: max.width,
    maxLine: max.index,
    over: rows.filter((row) => row.width > expectedColumns).slice(0, 5),
  };
}

function displayWidth(line) {
  let total = 0;
  for (const char of line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")) {
    total += isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return total;
}

function isWide(codePoint) {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  );
}

export function lowerBusyActivityRowPattern(detail) {
  const spinnerPattern = "[⠁⠂⠄⠠⠐⠈]";
  if (detail === undefined) {
    return new RegExp(`\n\\s*${spinnerPattern}\\s+[^\n]+`, "u");
  }
  return new RegExp(`\n\\s*${spinnerPattern}\\s+${escapeRegExp(detail)}`, "u");
}
