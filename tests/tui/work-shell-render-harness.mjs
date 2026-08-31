import { PassThrough, Writable } from "node:stream";

import { render } from "ink";

function createWritableOutput(columns = 100, rows = 30) {
  const output = new PassThrough();
  output.columns = columns;
  output.rows = rows;
  output.isTTY = true;
  output.getColorDepth = () => 24;
  output.hasColors = () => true;
  return output;
}

function createReadableInput() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  input.resume = () => input;
  input.pause = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

function createWritableError(columns = 100, rows = 30) {
  const error = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  error.columns = columns;
  error.rows = rows;
  error.isTTY = true;
  error.getColorDepth = () => 24;
  error.hasColors = () => true;
  return error;
}

export function renderDebugFrame(element, options = {}) {
  const columns = options.columns ?? 100;
  const rows = options.rows ?? 30;
  const stdout = createWritableOutput(columns, rows);
  let output = "";
  let frame = "";
  stdout.on("data", (chunk) => {
    const rendered = chunk.toString();
    // Ink may publish a cursor-position escape as a standalone write after
    // the complete debug frame. Keep the newest physical frame, not that
    // trailing control-only chunk.
    if (rendered.includes("\n")) frame = rendered;
    output += rendered;
  });
  const stdin = createReadableInput();
  const instance = render(element, {
    stdin,
    stdout,
    stderr: createWritableError(columns, rows),
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    instance,
    stdin,
    getOutput: () => output,
    getFrame: () => frame,
  };
}

/**
 * Wait until the frame stops changing, rather than for a fixed delay.
 *
 * Ink paints asynchronously, so a `setTimeout(100)` is a bet that the render
 * finished in time. As the work shell grew — tool calls now render inline in
 * the transcript — that bet started losing under load, and these tests failed
 * a different handful of assertions on every run. Polling for a settled frame
 * makes them wait exactly as long as the render actually takes.
 */
export async function waitForSettledFrame(getOutput, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const quietMs = options.quietMs ?? 40;
  const pollMs = options.pollMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  const baseline = options.baseline;
  let previous = getOutput();
  let observedChange = baseline === undefined || previous !== baseline;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const current = getOutput();
    if (current !== previous) {
      previous = current;
      stableSince = Date.now();
      if (baseline === undefined || current !== baseline) {
        observedChange = true;
      }
      continue;
    }
    // Require a non-empty frame; an empty one has simply not started yet.
    if (observedChange && current.length > 0 && Date.now() - stableSince >= quietMs) {
      return current;
    }
  }
  return getOutput();
}
