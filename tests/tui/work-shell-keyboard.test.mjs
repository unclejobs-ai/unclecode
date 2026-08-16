import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { render } from "ink";
import React from "react";
import CursorContext from "../../node_modules/ink/build/components/CursorContext.js";

import {
  Composer,
  WorkShellPane,
  useWorkShellInputController,
} from "../../packages/tui/src/index.tsx";
import {
  getWorkShellSlashSuggestions,
  shouldBlockSlashSubmit,
} from "../../packages/orchestrator/src/index.ts";

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

function renderWithInput(element) {
  const stdin = createInkInput();
  const stdout = createWritableOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const instance = render(element, {
    stdin,
    stdout,
    stderr: createWritableError(),
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    stdin,
    instance,
    getOutput: () => output,
    clearOutput: () => {
      output = "";
    },
  };
}

async function waitForCondition(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function getLastWorkFrame(output) {
  const finalFrameStart = output.lastIndexOf("UncleCode · OpenAI");
  return finalFrameStart >= 0 ? output.slice(finalFrameStart) : output;
}

function createWorkShellPaneEngine(overrides = {}) {
  const submittedLines = [];
  let state = {
    entries: [],
    model: "gpt-5.4",
    mode: "yolo",
    reasoning: "medium",
    authLabel: "oauth-file",
    isBusy: false,
    bridgeLines: [],
    memoryLines: [],
    panel: {
      title: "Session status",
      lines: ["Work context ready."],
    },
    ...overrides,
  };
  const listeners = new Set();

  return {
    submittedLines,
    engine: {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      initialize: async () => {},
      dispose: () => {},
      handleSubmit: async (line) => {
        submittedLines.push(line);
        state = {
          ...state,
          // /help opens the Rust-owned help panel; every other submit keeps
          // the Model picker behavior the existing tests assert against.
          panel: line === "/help"
            ? {
                title: "Work-first shell",
                lines: ["Composer is live.", "/ starts commands. Tab completes."],
              }
            : {
                title: "Model picker",
                lines: ["Model · gpt-5.4"],
              },
        };
        for (const listener of listeners) {
          listener(state);
        }
      },
      setMode: async () => {},
      openSessionsPanel: async () => {},
    },
  };
}

function renderKeyboardWorkPane(engine) {
  return renderWithInput(
    React.createElement(WorkShellPane, {
      provider: "OpenAI",
      model: "gpt-5.4",
      mode: "yolo",
      engine,
      cwd: "/tmp/unclecode-test-workspace",
      resolveComposerInput: async (value) => ({
        prompt: value,
        attachments: [],
        transcriptText: value,
      }),
      getSuggestions: (value) =>
        getWorkShellSlashSuggestions(value, {
          provider: "openai",
          currentModel: "gpt-5.4",
        }),
      onExit: () => {},
      shouldBlockSlashSubmit: (line) =>
        shouldBlockSlashSubmit(line, {
          provider: "openai",
          currentModel: "gpt-5.4",
        }),
      getReasoningLabel: () => "default medium",
      isReasoningSupported: () => true,
    }),
  );
}

function WorkShellInputControllerHarness(props) {
  const { submit } = useWorkShellInputController({
    value: "",
    replaceValue: props.replaceValue,
    slashSuggestionCount: 1,
    selectedSlashCommand: "/model gpt-5.5",
    activeSlashInput: "/model",
    setSelectedSlashIndex: () => {},
    isBusy: false,
    currentMode: "default",
    onExit: () => {},
    ...(props.onRequestSessionsView
      ? { onRequestSessionsView: props.onRequestSessionsView }
      : {}),
    openEngineSessions: () => {},
    cycleMode: () => {},
    shouldBlockSlashSubmit: (line) => line === "/model",
    handleSubmit: props.handleSubmit,
    activePanelTitle: "Model picker",
    closeSlashPicker: props.closeSlashPicker,
  });

  React.useEffect(() => {
    props.onSubmitReady(submit);
  }, [props.onSubmitReady, submit]);

  return null;
}

test("Work model picker closes after Enter submits the selected model option", async () => {
  const submittedLines = [];
  let closeCount = 0;
  let submitOption = undefined;
  const { instance } = renderWithInput(
    React.createElement(WorkShellInputControllerHarness, {
      replaceValue: () => {},
      handleSubmit: async (line) => {
        submittedLines.push(line);
      },
      closeSlashPicker: () => {
        closeCount += 1;
      },
      onSubmitReady: (submit) => {
        submitOption = submit;
      },
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(typeof submitOption, "function");
  await submitOption("");
  instance.unmount();
  instance.cleanup();

  assert.deepEqual(submittedLines, ["/model gpt-5.5"]);
  assert.equal(closeCount, 1);
});

test("Work model picker submits the visibly selected model instead of hidden controls", async () => {
  const suggestions = [
    { command: "/model", description: "Show model picker" },
    ...Array.from({ length: 8 }, (_, index) => ({
      command: `/model gpt-test-${index + 1}`,
      description: index === 0 ? "current · reasoning medium" : "reasoning medium",
    })),
    { command: "/model list", description: "Show full model catalog" },
  ];
  const { engine, submittedLines } = createWorkShellPaneEngine({
    panel: {
      title: "Model picker",
      lines: ["Model · gpt-test-1"],
    },
  });
  const { stdin, instance, getOutput } = renderWithInput(
    React.createElement(WorkShellPane, {
      provider: "OpenAI",
      model: "gpt-test-1",
      mode: "yolo",
      engine,
      cwd: "/tmp/unclecode-test-workspace",
      resolveComposerInput: async (value) => ({
        prompt: value,
        attachments: [],
        transcriptText: value,
      }),
      getSuggestions: () => suggestions,
      onExit: () => {},
      shouldBlockSlashSubmit: (line) => line === "/model",
      getReasoningLabel: () => "default medium",
      isReasoningSupported: () => true,
    }),
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("\u001b[A");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(getLastWorkFrame(getOutput()), /› \/model gpt-test-8/);
    stdin.write("\r");
    await waitForCondition(() => submittedLines.length === 1, 2_000);
    assert.deepEqual(submittedLines, ["/model gpt-test-8"]);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("Work Ctrl+O opens the work context", async () => {
  let openCount = 0;
  const { stdin, instance } = renderWithInput(
    React.createElement(WorkShellInputControllerHarness, {
      replaceValue: () => {},
      handleSubmit: async () => {},
      closeSlashPicker: () => {},
      onRequestSessionsView: () => {
        openCount += 1;
      },
      onSubmitReady: () => {},
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  stdin.write("\u000f");
  await new Promise((resolve) => setTimeout(resolve, 200));
  instance.unmount();
  instance.cleanup();

  assert.equal(openCount, 1);
});

test("Composer leaves Ctrl+O for Work shell shortcuts instead of inserting it", async () => {
  const changedValues = [];
  const submittedValues = [];
  const { stdin, instance } = renderWithInput(
    React.createElement(Composer, {
      value: "",
      onChange: (value) => {
        changedValues.push(value);
      },
      onSubmit: (value) => {
        submittedValues.push(value);
      },
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  stdin.write("\u000f");
  await new Promise((resolve) => setTimeout(resolve, 200));
  instance.unmount();
  instance.cleanup();

  assert.deepEqual(changedValues, []);
  assert.deepEqual(submittedValues, []);
});

test("Composer ignores repeated non-text control shortcuts", async () => {
  const changedValues = [];
  const submittedValues = [];
  const { stdin, instance } = renderWithInput(
    React.createElement(Composer, {
      value: "",
      onChange: (value) => {
        changedValues.push(value);
      },
      onSubmit: (value) => {
        submittedValues.push(value);
      },
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  stdin.write("\u000f");
  stdin.write("\u000f");
  stdin.write("\u0012");
  await new Promise((resolve) => setTimeout(resolve, 200));
  instance.unmount();
  instance.cleanup();

  assert.deepEqual(changedValues, []);
  assert.deepEqual(submittedValues, []);
});

test("Composer does not append new typing to a just-submitted stale parent value", async () => {
  const changedValues = [];
  const submittedValues = [];

  function StickyComposerHarness() {
    const [value, setValue] = React.useState("");
    return React.createElement(Composer, {
      value,
      onChange: (nextValue) => {
        changedValues.push(nextValue);
        setValue(nextValue);
      },
      onSubmit: (submittedValue) => {
        submittedValues.push(submittedValue);
      },
    });
  }

  const { stdin, instance } = renderWithInput(React.createElement(StickyComposerHarness));

  await new Promise((resolve) => setTimeout(resolve, 100));
  stdin.write("first\r");
  await waitForCondition(() => submittedValues.length === 1);
  stdin.write("second\r");
  await waitForCondition(() => submittedValues.length === 2);
  instance.unmount();
  instance.cleanup();

  assert.deepEqual(submittedValues, ["first", "second"]);
  assert.equal(changedValues.includes("firstsecond"), false);
});

test("Work pane routes repeated Ctrl+O to work context without submitting text", async () => {
  const { engine, submittedLines } = createWorkShellPaneEngine();
  let openCount = 0;
  const { stdin, instance } = renderWithInput(
    React.createElement(WorkShellPane, {
      provider: "OpenAI",
      model: "gpt-5.4",
      mode: "yolo",
      engine,
      cwd: "/Users/parkeungje/project/unclecode",
      resolveComposerInput: async (value) => ({
        prompt: value,
        attachments: [],
        transcriptText: value,
      }),
      getSuggestions: (value) =>
        getWorkShellSlashSuggestions(value, {
          provider: "openai",
          currentModel: "gpt-5.4",
        }),
      onExit: () => {},
      onRequestSessionsView: () => {
        openCount += 1;
      },
      shouldBlockSlashSubmit: (line) =>
        shouldBlockSlashSubmit(line, {
          provider: "openai",
          currentModel: "gpt-5.4",
        }),
      getReasoningLabel: () => "default medium",
      isReasoningSupported: () => true,
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  stdin.write("\u000f");
  stdin.write("\u000f");
  await new Promise((resolve) => setTimeout(resolve, 300));
  instance.unmount();
  instance.cleanup();

  assert.equal(openCount, 2);
  assert.deepEqual(submittedLines, []);
});

test("Work pane keeps plain c and a keystrokes in the composer", async () => {
  for (const word of ["cat", "agent"]) {
    const { engine, submittedLines } = createWorkShellPaneEngine();
    const { stdin, instance, getOutput } = renderWithInput(
      React.createElement(WorkShellPane, {
        provider: "OpenAI",
        model: "gpt-5.4",
        mode: "yolo",
        engine,
        cwd: "/Users/parkeungje/project/unclecode",
        resolveComposerInput: async (value) => ({
          prompt: value,
          attachments: [],
          transcriptText: value,
        }),
        getSuggestions: (value) =>
          getWorkShellSlashSuggestions(value, {
            provider: "openai",
            currentModel: "gpt-5.4",
          }),
        onExit: () => {},
        shouldBlockSlashSubmit: (line) =>
          shouldBlockSlashSubmit(line, {
            provider: "openai",
            currentModel: "gpt-5.4",
          }),
        getReasoningLabel: () => "default medium",
        isReasoningSupported: () => true,
      }),
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      stdin.write(word);
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.deepEqual(submittedLines, []);
      assert.match(getLastWorkFrame(getOutput()), new RegExp(`› ${word}(?:▏)?`));
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  }
});

test("Work pane without Agent Console support leaves Alt+A as ordinary typing", async () => {
  const { engine, submittedLines } = createWorkShellPaneEngine();
  const { stdin, instance, getOutput } = renderWithInput(
    React.createElement(WorkShellPane, {
      provider: "OpenAI",
      model: "gpt-5.4",
      mode: "yolo",
      engine,
      cwd: "/Users/parkeungje/project/unclecode",
      resolveComposerInput: async (value) => ({
        prompt: value,
        attachments: [],
        transcriptText: value,
      }),
      getSuggestions: (value) =>
        getWorkShellSlashSuggestions(value, {
          provider: "openai",
          currentModel: "gpt-5.4",
        }),
      onExit: () => {},
      shouldBlockSlashSubmit: (line) =>
        shouldBlockSlashSubmit(line, {
          provider: "openai",
          currentModel: "gpt-5.4",
        }),
      getReasoningLabel: () => "default medium",
      isReasoningSupported: () => true,
    }),
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("\u001ba");
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.deepEqual(submittedLines, []);
    // An engine with no console methods has nothing to toggle, so the chord
    // must not become a dead key.
    assert.match(getLastWorkFrame(getOutput()), /› a(?:▏)?/);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("Composer yields a keystroke to the Agent Console predicate instead of the draft", async () => {
  const changedValues = [];
  const seen = [];
  const { stdin, instance } = renderWithInput(
    React.createElement(Composer, {
      value: "",
      onChange: (value) => {
        changedValues.push(value);
      },
      onSubmit: () => {},
      suppressAgentConsoleKey: (input, key, composerEmpty) => {
        seen.push({ input, meta: key.meta === true, composerEmpty });
        return key.meta === true && input === "a";
      },
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  stdin.write("\u001ba");
  await new Promise((resolve) => setTimeout(resolve, 150));
  stdin.write("b");
  await new Promise((resolve) => setTimeout(resolve, 150));
  instance.unmount();
  instance.cleanup();

  assert.deepEqual(changedValues, ["b"], "the owned chord never becomes draft text");
  assert.deepEqual(
    seen,
    [
      { input: "a", meta: true, composerEmpty: true },
      { input: "b", meta: false, composerEmpty: true },
    ],
    "the predicate sees the normalized keystroke and the raw-empty state",
  );
});

test("Work pane submits an explicit model command from the composer and closes the picker", async () => {
  const { engine, submittedLines } = createWorkShellPaneEngine();
  const { stdin, instance, getOutput, clearOutput } = renderWithInput(
    React.createElement(WorkShellPane, {
      provider: "OpenAI",
      model: "gpt-5.4",
      mode: "yolo",
      engine,
      cwd: "/Users/parkeungje/project/unclecode",
      resolveComposerInput: async (value) => ({
        prompt: value,
        attachments: [],
        transcriptText: value,
      }),
      getSuggestions: (value) =>
        getWorkShellSlashSuggestions(value, {
          provider: "openai",
          currentModel: "gpt-5.4",
        }),
      onExit: () => {},
      shouldBlockSlashSubmit: (line) =>
        shouldBlockSlashSubmit(line, {
          provider: "openai",
          currentModel: "gpt-5.4",
        }),
      getReasoningLabel: () => "default medium",
      isReasoningSupported: () => true,
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  clearOutput();
  stdin.write("/model gpt-5.4");
  stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const output = getOutput();
  instance.unmount();
  instance.cleanup();

  assert.deepEqual(submittedLines, ["/model gpt-5.4"]);
  assert.doesNotMatch(output, /\/model gpt-5\.4/);
  assert.doesNotMatch(output, /Model picker/);
});

test("Work pane preserves split fast model command chunks before Enter", async () => {
  const { engine, submittedLines } = createWorkShellPaneEngine();
  const { stdin, instance, getOutput, clearOutput } = renderWithInput(
    React.createElement(WorkShellPane, {
      provider: "OpenAI",
      model: "gpt-5.4",
      mode: "yolo",
      engine,
      cwd: "/Users/parkeungje/project/unclecode",
      resolveComposerInput: async (value) => ({
        prompt: value,
        attachments: [],
        transcriptText: value,
      }),
      getSuggestions: (value) =>
        getWorkShellSlashSuggestions(value, {
          provider: "openai",
          currentModel: "gpt-5.4",
        }),
      onExit: () => {},
      shouldBlockSlashSubmit: (line) =>
        shouldBlockSlashSubmit(line, {
          provider: "openai",
          currentModel: "gpt-5.4",
        }),
      getReasoningLabel: () => "default medium",
      isReasoningSupported: () => true,
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  clearOutput();
  stdin.write("/model ");
  await new Promise((resolve) => setTimeout(resolve, 1));
  stdin.write("gpt-5.4\r");
  await waitForCondition(() => submittedLines.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const output = getOutput();
  instance.unmount();
  instance.cleanup();

  assert.deepEqual(submittedLines, ["/model gpt-5.4"]);
  assert.doesNotMatch(output, /gpt-5\.4\/model/);
  const finalFrame = getLastWorkFrame(output);
  assert.doesNotMatch(finalFrame, /Model picker/);
});

test("Work pane opens the help panel when ? is pressed on an empty composer", async () => {
  const { engine, submittedLines } = createWorkShellPaneEngine();
  const { stdin, instance, getOutput } = renderKeyboardWorkPane(engine);

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("?");
    await waitForCondition(() => submittedLines.length === 1);
    await waitForCondition(() =>
      getLastWorkFrame(getOutput()).includes("Work-first shell")
    );
    const frame = getLastWorkFrame(getOutput());

    // The keymap dispatches through the same route as typing "/help" +
    // Enter, so the engine's slash handling owns the panel that opens.
    assert.deepEqual(submittedLines, ["/help"]);
    assert.match(frame, /Work-first shell/);
    assert.match(frame, /Composer is live\./);
    // The keymap character never lands in the draft.
    assert.doesNotMatch(frame, /› \?/);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("Work pane types ? into the composer with a draft or during api-key entry", async () => {
  // A non-empty draft owns the keyboard outright, so `?` is ordinary text.
  {
    const { engine, submittedLines } = createWorkShellPaneEngine();
    const { stdin, instance, getOutput } = renderKeyboardWorkPane(engine);

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      stdin.write("x");
      await waitForCondition(() => /› x/.test(getLastWorkFrame(getOutput())));
      stdin.write("?");
      await waitForCondition(() => /› x\?/.test(getLastWorkFrame(getOutput())));
      const frame = getLastWorkFrame(getOutput());

      assert.match(frame, /› x\?/);
      assert.deepEqual(submittedLines, []);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  }

  // Sensitive entry must receive every character exactly as typed.
  {
    const { engine, submittedLines } = createWorkShellPaneEngine({
      composerMode: "api-key-entry",
    });
    const { stdin, instance, getOutput } = renderKeyboardWorkPane(engine);

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      stdin.write("?");
      await waitForCondition(() => /› •/.test(getLastWorkFrame(getOutput())));
      const frame = getLastWorkFrame(getOutput());

      // Exactly one masked character: the keymap never claims it here.
      assert.match(frame, /› •/);
      assert.doesNotMatch(frame, /› ••/);
      assert.deepEqual(submittedLines, []);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  }
});

test("Composer publishes the current Hangul cursor position in the same render", async () => {
  const positions = [];
  const cursorContext = {
    setCursorPosition(position) {
      positions.push(position);
    },
  };
  const composerProps = {
    onChange: () => {},
    onSubmit: () => {},
    terminalColumns: 20,
  };
  const renderComposer = (value) => React.createElement(
    CursorContext.Provider,
    { value: cursorContext },
    React.createElement(Composer, { ...composerProps, value }),
  );
  const { instance } = renderWithInput(renderComposer(""));

  await new Promise((resolve) => setTimeout(resolve, 100));
  positions.length = 0;
  instance.rerender(renderComposer("한"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const finalPosition = positions.at(-1);
  instance.unmount();
  instance.cleanup();

  assert.deepEqual(
    finalPosition,
    { x: 2, y: 0 },
    "one double-width Hangul grapheme should publish the terminal cursor in column 2",
  );
});
