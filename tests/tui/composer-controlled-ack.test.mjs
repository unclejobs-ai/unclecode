import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { render } from "ink";
import React from "react";

import {
  Composer,
  resolveComposerCursorOffsetAfterValueChange,
} from "../../packages/tui/src/index.tsx";

test("a stale controlled-parent acknowledgement preserves the newer local cursor", () => {
  assert.equal(
    resolveComposerCursorOffsetAfterValueChange({
      nextValue: "a",
      currentCursorOffset: 2,
      pendingLocalValue: "ab",
    }),
    2,
  );
});

test("Composer preserves newer local input across a delayed controlled-parent acknowledgement", async () => {
  const changedValues = [];
  const acknowledgedValues = [];
  let acknowledgeValue;

  function DelayedControlledComposerHarness() {
    const [value, setValue] = React.useState("");
    acknowledgeValue = (nextValue) => {
      acknowledgedValues.push(nextValue);
      setValue(nextValue);
    };
    return React.createElement(Composer, {
      value,
      onChange: (nextValue) => {
        changedValues.push(nextValue);
      },
      onSubmit: () => {},
    });
  }

  const stdin = createInkInput();
  const instance = render(React.createElement(DelayedControlledComposerHarness), {
    stdin,
    stdout: createWritableOutput(),
    stderr: createWritableError(),
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("a");
    await waitForCondition(() => changedValues.includes("a"));
    stdin.write("b");
    await waitForCondition(() => changedValues.includes("ab"));
    acknowledgeValue("a");
    await waitForCondition(() => acknowledgedValues.includes("a"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write("c");
    await waitForCondition(() => changedValues.includes("abc"));
    assert.equal(changedValues.includes("ac"), false, "a late ack must not erase the newer local b");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("Composer submits a long single-chunk prompt on the first following Enter", async () => {
  const submittedValues = [];
  const longPrompt = "x".repeat(64);
  let markChanged;
  const changed = new Promise(resolve => { markChanged = resolve; });

  function LongPromptHarness() {
    const [value, setValue] = React.useState("");
    return React.createElement(Composer, {
      value,
      onChange: nextValue => {
        setValue(nextValue);
        markChanged();
      },
      onSubmit: value => submittedValues.push(value),
    });
  }

  const stdin = createInkInput();
  const instance = render(React.createElement(LongPromptHarness), {
    stdin,
    stdout: createWritableOutput(),
    stderr: createWritableError(),
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    stdin.write(longPrompt);
    await changed;
    stdin.write("\r");
    await waitForCondition(() => submittedValues.length > 0);
    assert.deepEqual(submittedValues, [longPrompt]);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("Composer keeps one visible IME draft through preedit replacement and async parent renders", async () => {
  const changedValues = [];
  const submittedValues = [];
  let forceParentRender;
  let output = "";

  function ImeHarness() {
    const [, setEpoch] = React.useState(0);
    forceParentRender = () => setEpoch((current) => current + 1);
    return React.createElement(Composer, {
      value: "",
      onChange: (nextValue) => changedValues.push(nextValue),
      onSubmit: (value) => submittedValues.push(value),
    });
  }

  const stdin = createInkInput();
  const stdout = createWritableOutput();
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const instance = render(React.createElement(ImeHarness), {
    stdin,
    stdout,
    stderr: createWritableError(),
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    // A real preedit replacement sequence: the input method retracts the
    // previous grapheme before publishing the longer decomposed Hangul
    // cluster. Split the final UTF-8 bytes across writes as a PTY can.
    stdin.write("ᄒ");
    await waitForCondition(() => changedValues.at(-1) === "ᄒ");
    stdin.write("\u007f");
    await waitForCondition(() => changedValues.at(-1) === "");
    stdin.write("하");
    await waitForCondition(() => changedValues.at(-1) === "하");
    forceParentRender();
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write("\u007f");
    await waitForCondition(() => changedValues.at(-1) === "");
    const committed = Buffer.from("한");
    stdin.write(committed.subarray(0, 2));
    stdin.write(committed.subarray(2, 5));
    stdin.write(committed.subarray(5));
    await waitForCondition(() => changedValues.at(-1) === "한");
    output = "";
    forceParentRender();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.match(output, /한/u, "the current preedit cluster remains visible before parent acknowledgement");
    assert.doesNotMatch(output, /ᄒ하/u, "retracted preedit text is never duplicated");

    stdin.write("\r");
    await waitForCondition(() => submittedValues.length === 1);
    assert.deepEqual(submittedValues, ["한"]);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

function createInkInput() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  input.resume = () => input;
  input.pause = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

function createWritableOutput() {
  const output = new PassThrough();
  output.columns = 120;
  output.rows = 40;
  output.isTTY = true;
  output.resume();
  return output;
}

function createWritableError() {
  const error = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  error.columns = 120;
  error.rows = 40;
  error.isTTY = true;
  return error;
}

async function waitForCondition(predicate, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition was not satisfied before timeout");
}
