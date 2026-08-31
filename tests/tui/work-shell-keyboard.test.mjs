import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { Box, render, Text } from "ink";
import React from "react";
import CursorContext from "../../node_modules/ink/build/components/CursorContext.js";
import { resolveQueueOverlayKeyAction } from "../../packages/tui/src/work-shell-hooks.ts";

import {
  Composer,
  WorkShellPane,
  useWorkShellInputController,
} from "../../packages/tui/src/index.tsx";
import {
  getWorkShellSlashSuggestions,
  shouldBlockSlashSubmit,
} from "../../packages/orchestrator/src/index.ts";

test("Queue overlay owns selection and mutation keys without leaking composer input", () => {
  assert.deepEqual(resolveQueueOverlayKeyAction("", { downArrow: true }, true), { action: "select", delta: 1 });
  assert.deepEqual(resolveQueueOverlayKeyAction("", { upArrow: true, shift: true }, true), { action: "move", direction: "up" });
  assert.deepEqual(resolveQueueOverlayKeyAction("d", {}, true), { action: "remove" });
  assert.deepEqual(resolveQueueOverlayKeyAction("c", {}, true), { action: "clear" });
  assert.deepEqual(resolveQueueOverlayKeyAction("r", {}, true), { action: "resume" });
  assert.deepEqual(resolveQueueOverlayKeyAction("t", {}, true), { action: "retry" });
  assert.deepEqual(resolveQueueOverlayKeyAction("x", {}, true), { action: "discard" });
  assert.deepEqual(resolveQueueOverlayKeyAction("한", {}, true), { action: "consume" });
  assert.deepEqual(resolveQueueOverlayKeyAction("한", {}, false), { action: "pass" });
});

test("Queue overlay dispatches stable selected-id actions and consumes Korean input", async () => {
  const calls = [];
  const { engine, submittedLines } = createWorkShellPaneEngine({
    panel: {
      title: "Queue · follow-ups",
      lines: [
        "Running · 2 follow-ups",
        "",
        "Next · id 41 · 첫 번째 긴 후속 요청",
        "#2 · id 77 · 두 번째 긴 후속 요청",
        "",
        "↑/↓ select · Shift+↑/↓ reorder · d remove",
      ],
    },
  });
  engine.removeQueueItem = async (id) => { calls.push(["remove", id]); return true; };
  engine.moveQueueItem = async (id, direction) => { calls.push(["move", id, direction]); return true; };
  engine.clearQueueItems = async () => { calls.push(["clear"]); };
  engine.resumeQueueItems = async () => { calls.push(["resume"]); };
  engine.retryQueueItem = async (id) => { calls.push(["retry", id]); return true; };
  engine.discardQueueItem = async (id) => { calls.push(["discard", id]); return true; };
  engine.closeOverlay = () => { calls.push(["close"]); };
  const { stdin, instance, getOutput } = renderKeyboardWorkPane(engine);
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(getLastWorkFrame(getOutput()), /› Next · id 41/);
    stdin.write("\u001b[B");
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("d");
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("한");
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("r");
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("t");
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("x");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(calls, [["remove", 77], ["resume"], ["retry", 41], ["discard", 41]]);
    assert.deepEqual(submittedLines, []);
    assert.doesNotMatch(getLastWorkFrame(getOutput()), /› 한/);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("Queue overlay renders mutation failures instead of swallowing them", async () => {
  const { engine } = createWorkShellPaneEngine({
    panel: {
      title: "Queue · follow-ups",
      lines: ["Paused · 1 follow-up", "", "Next · id 9 · 복구가 필요한 요청"],
    },
  });
  engine.removeQueueItem = async () => { throw new Error("backend denied mutation"); };
  const { stdin, instance, getOutput } = renderKeyboardWorkPane(engine);
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("d");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(getLastWorkFrame(getOutput()), /Queue action failed · backend denied mutation/);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("Queue clear preserves a selected requires-action id that survives pending cleanup", async () => {
  const harness = createWorkShellPaneEngine({
    panel: {
      title: "Queue · follow-ups",
      lines: [
        "Paused · 3 total · 1 pending · 0 in flight · 2 requires action",
        "",
        "Next · id 41 · pending · pending follow-up",
        "#2 · id 88 · requires action · first recovery",
        "#3 · id 77 · requires action · selected recovery",
      ],
    },
  });
  harness.engine.clearQueueItems = async () => {
    harness.updateState({
      panel: {
        title: "Queue · follow-ups",
        lines: [
          "Paused · 2 total · 0 pending · 0 in flight · 2 requires action",
          "",
          "Next · id 88 · requires action · first recovery",
          "#2 · id 77 · requires action · selected recovery",
        ],
      },
    });
  };
  const { stdin, instance, getOutput } = renderKeyboardWorkPane(harness.engine);
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("\u001b[B");
    stdin.write("\u001b[B");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(getLastWorkFrame(getOutput()), /› #3 · id 77/);

    stdin.write("c");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(getLastWorkFrame(getOutput()), /› #2 · id 77/);
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
    stdout,
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
    updateState: (patch) => {
      state = { ...state, ...patch };
      for (const listener of listeners) {
        listener(state);
      }
    },
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
  return renderWithInput(createKeyboardWorkPaneElement(engine));
}

function createKeyboardWorkPaneElement(engine) {
  return React.createElement(WorkShellPane, {
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
    });
}

function WorkShellInputControllerHarness(props) {
  const { submit } = useWorkShellInputController({
    value: props.value ?? "",
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
    ...(props.toggleQualityPlan ? { toggleQualityPlan: props.toggleQualityPlan } : {}),
    ...(props.toggleToolHistoryDisplay
      ? { toggleToolHistoryDisplay: props.toggleToolHistoryDisplay }
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

test("Ctrl+T toggles quality plan while Ctrl+O only toggles tool history", async () => {
  const actions = [];
  const replaced = [];
  const { stdin, instance } = renderWithInput(
    React.createElement(WorkShellInputControllerHarness, {
      value: "keep this draft",
      replaceValue: (value) => replaced.push(value),
      handleSubmit: async () => {},
      closeSlashPicker: () => {},
      toggleQualityPlan: () => actions.push("plan"),
      toggleToolHistoryDisplay: () => actions.push("tools"),
      onRequestSessionsView: () => actions.push("sessions"),
      onSubmitReady: () => {},
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  stdin.write("\u0014");
  await new Promise((resolve) => setTimeout(resolve, 50));
  stdin.write("\u000f");
  await new Promise((resolve) => setTimeout(resolve, 200));
  instance.unmount();
  instance.cleanup();
  assert.deepEqual(actions, ["plan", "tools"]);
  assert.deepEqual(replaced, []);
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

test("Work Ctrl+O toggles tool history without opening sessions", async () => {
  let toggleCount = 0;
  let sessionCount = 0;
  const { stdin, instance } = renderWithInput(
    React.createElement(WorkShellInputControllerHarness, {
      replaceValue: () => {},
      handleSubmit: async () => {},
      closeSlashPicker: () => {},
      toggleToolHistoryDisplay: () => {
        toggleCount += 1;
      },
      onRequestSessionsView: () => {
        sessionCount += 1;
      },
      onSubmitReady: () => {},
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  stdin.write("\u000f");
  await new Promise((resolve) => setTimeout(resolve, 200));
  instance.unmount();
  instance.cleanup();

  assert.equal(toggleCount, 1);
  assert.equal(sessionCount, 0);
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

test("Composer maps raw Backspace and forward Delete to whole grapheme edits", async () => {
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  const changedValues = [];

  function ControlledComposerHarness() {
    const [value, setValue] = React.useState("");
    return React.createElement(Composer, {
      value,
      onChange: (nextValue) => {
        changedValues.push(nextValue);
        setValue(nextValue);
      },
      onSubmit: () => {},
    });
  }

  const { stdin, instance } = renderWithInput(React.createElement(ControlledComposerHarness));

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write(`A${family}한`);
    await waitForCondition(() => changedValues.at(-1) === `A${family}한`);

    // Ink 7 maps DEL (0x7f) to Backspace. Each event must remove the whole
    // grapheme to the left, including an extended ZWJ emoji sequence.
    stdin.write("\u007f");
    await waitForCondition(() => changedValues.at(-1) === `A${family}`);
    stdin.write("\u007f");
    await waitForCondition(() => changedValues.at(-1) === "A");

    stdin.write(`${family}한`);
    await waitForCondition(() => changedValues.at(-1) === `A${family}한`);
    stdin.write("\u001b[D");
    stdin.write("\u001b[D");
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Ink 7 maps CSI 3~ to forward Delete. It must remove the whole grapheme
    // to the right without changing the cursor's preceding text.
    stdin.write("\u001b[3~");
    await waitForCondition(() => changedValues.at(-1) === "A한");
    assert.equal(changedValues.at(-1), "A한");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
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

test("Work pane routes repeated Ctrl+O to persisted tool-history mode without submitting text", async () => {
  const { engine, submittedLines } = createWorkShellPaneEngine();
  let toggleCount = 0;
  engine.toggleToolHistoryDisplay = async () => {
    toggleCount += 1;
  };
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
      onRequestSessionsView: () => assert.fail("Ctrl+O must not open sessions"),
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

  assert.equal(toggleCount, 2);
  assert.deepEqual(submittedLines, []);
});

test("Work pane has one prompt owner across Korean edits, Ctrl+O, overlays, and busy follow-up submit", async () => {
  const harness = createWorkShellPaneEngine();
  let toggleCount = 0;
  harness.engine.toggleToolHistoryDisplay = async () => {
    toggleCount += 1;
  };
  const { stdin, instance, getOutput } = renderKeyboardWorkPane(harness.engine);

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stdin.write("ASCII 한글XYZ");
    await waitForCondition(() => /› ASCII 한글XYZ(?:▏)?/.test(getLastWorkFrame(getOutput())));

    // Cursor before X: Backspace removes the committed Hangul grapheme to the
    // left, while forward Delete removes X to the right.
    stdin.write("\u001b[D");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\u001b[D");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\u001b[D");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\u007f");
    await waitForCondition(() => /› ASCII 한XYZ(?:▏)?/.test(getLastWorkFrame(getOutput())));
    stdin.write("\u001b[3~");
    await waitForCondition(() => /› ASCII 한YZ(?:▏)?/.test(getLastWorkFrame(getOutput())));

    stdin.write("\u000f");
    await waitForCondition(() => toggleCount === 1);
    assert.match(
      getLastWorkFrame(getOutput()),
      /› ASCII 한YZ(?:▏)?/,
      "Ctrl+O must reproject tool history without taking or clearing the draft",
    );

    harness.updateState({
      panel: { title: "Session status", lines: ["Non-owning status refresh."] },
    });
    await waitForCondition(() => getLastWorkFrame(getOutput()).includes("Non-owning status refresh."));
    assert.match(
      getLastWorkFrame(getOutput()),
      /› ASCII 한YZ(?:▏)?/,
      "a non-owning panel refresh must not write a stale parent draft",
    );

    harness.updateState({ isBusy: true, composerMode: "queue" });
    stdin.write("\u001b[C");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\u001b[C");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write(" 후속");
    stdin.write("\r");
    await waitForCondition(() => harness.submittedLines.length === 1);
    assert.deepEqual(harness.submittedLines, ["ASCII 한YZ 후속"]);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
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

test("anchored Composer never publishes the previous prompt row after surrounding layout moves", async () => {
  const positions = [];
  const cursorContext = {
    setCursorPosition(position) {
      positions.push(position);
    },
  };
  const composerProps = {
    value: "한",
    onChange: () => {},
    onSubmit: () => {},
    terminalColumns: 20,
    cursorAnchor: { x: 0, bottom: 3 },
  };
  const renderComposer = (prefix) => React.createElement(
    CursorContext.Provider,
    { value: cursorContext },
    React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(Text, null, prefix),
      React.createElement(Composer, composerProps),
    ),
  );
  const { instance } = renderWithInput(renderComposer("above"));

  await new Promise((resolve) => setTimeout(resolve, 100));
  positions.length = 0;
  instance.rerender(renderComposer("above\nnew transcript row\nanother row"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  instance.unmount();
  instance.cleanup();

  const visiblePositions = positions.filter((position) => position !== undefined);
  assert.deepEqual(
    visiblePositions,
    [{ x: 2, y: 3 }],
    "an IME candidate must never be anchored to the composer's stale pre-layout row",
  );
});

test("Work pane publishes only the resized bottom-dock cursor row", async () => {
  const positions = [];
  const cursorContext = {
    setCursorPosition(position) {
      positions.push(position);
    },
  };
  const { engine } = createWorkShellPaneEngine();
  const { instance, stdout } = renderWithInput(React.createElement(
    CursorContext.Provider,
    { value: cursorContext },
    createKeyboardWorkPaneElement(engine),
  ));

  await new Promise((resolve) => setTimeout(resolve, 150));
  positions.length = 0;
  stdout.rows = 30;
  stdout.emit("resize");
  await new Promise((resolve) => setTimeout(resolve, 150));
  instance.unmount();
  instance.cleanup();

  const visiblePositions = positions.filter((position) => position !== undefined);
  assert.equal(
    visiblePositions.at(-1)?.y,
    29,
    "the hardware cursor stays on the painted prompt instead of the divider above it",
  );
  assert.equal(
    visiblePositions.some((position) => position.y === 38),
    false,
    "a vertical split resize must not publish the pre-resize IME row",
  );
});
