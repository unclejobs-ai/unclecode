import { writeFileSync } from "node:fs";

import { escapeRegExp, run, sleep } from "./cli-helpers.mjs";

const runtimeTmuxSocketName = `unclecode-runtime-qa-${process.pid}`;

export function runtimeTmuxArgs(args) {
  return ["-L", runtimeTmuxSocketName, ...args];
}

export function runTmux(args, options = {}) {
  return run("tmux", runtimeTmuxArgs(args), process.env, options);
}

export async function killRuntimeTmuxServer() {
  await runTmux(["kill-server"], { allowFailure: true });
}

export async function sendKeys(session, line) {
  await runTmux(["send-keys", "-t", session, line, "C-m"]);
}

export async function submitLine(session, line, paneFile, typedPattern = new RegExp(escapeRegExp(line))) {
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
  writeFileSync(paneFile, capture.stdout);
  return capture.stdout;
}

export async function waitForIdlePromptDeck(session, paneFile) {
  await waitForPane(session, /Ready · last reply/, paneFile);
  await waitForPane(session, /prompt deck/, paneFile);
  await sleep(100);
  return capturePane(session, paneFile);
}

export async function waitForPane(session, pattern, paneFile) {
  let lastPane = "";
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const pane = await capturePane(session, paneFile);
    lastPane = pane;
    if (pattern.test(pane)) {
      return pane;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${pattern}\nLast pane:\n${lastPane.trimEnd()}`);
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
  const spinnerPattern = "[◜◠◝◞◡◟]";
  if (detail === undefined) {
    return new RegExp(`\n\\s*${spinnerPattern}\\s+[^\n]+`, "u");
  }
  return new RegExp(`\n\\s*${spinnerPattern}\\s+${escapeRegExp(detail)}`, "u");
}
