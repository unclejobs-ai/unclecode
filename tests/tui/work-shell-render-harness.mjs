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
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const instance = render(element, {
    stdout,
    stderr: createWritableError(columns, rows),
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    instance,
    getOutput: () => output,
  };
}
