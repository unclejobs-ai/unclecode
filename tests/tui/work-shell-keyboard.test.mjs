import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { render } from "ink";
import React from "react";

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
          panel: {
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

test("Work pane context inspector shortcuts do not steal keys while composer has text", async () => {
  const resolvedValues = [];
  const forgetCalls = [];
  const state = {
    entries: [],
    model: "gpt-5.4",
    mode: "yolo",
    reasoning: "medium",
    authLabel: "oauth-file",
    isBusy: false,
    bridgeLines: [],
    memoryLines: [],
    contextInspectorCursor: 0,
    contextInspectorExpanded: null,
    contextPacket: {
      id: "packet-test",
      version: 1,
      generatedAt: "2026-07-07T00:00:00.000Z",
      title: "Next answer context",
      included: [{
        id: "src-1",
        category: "workspace",
        label: "AGENTS.md",
        reason: "workspace guidance",
        preview: "Use narrow diffs.",
        salience: 0.5,
        includedInModel: true,
      }],
      excluded: [],
      warnings: [],
      preview: ["ready"],
      sourceCounts: { included: 1, excluded: 0, warnings: 0 },
      tokenEstimate: 10,
    },
    panel: {
      title: "Context expanded",
      lines: ["Context expanded"],
    },
  };
  const engine = {
    getState: () => state,
    subscribe: () => () => {},
    initialize: async () => {},
    dispose: () => {},
    handleSubmit: async () => {},
    setMode: async () => {},
    openSessionsPanel: async () => {},
    moveContextInspectorCursor: () => {},
    forgetContextSourceAtCursor: async () => {
      forgetCalls.push("forget");
    },
  };
  const { stdin, instance } = renderWithInput(
    React.createElement(WorkShellPane, {
      provider: "OpenAI",
      model: "gpt-5.4",
      mode: "yolo",
      engine,
      cwd: "/Users/parkeungje/project/unclecode",
      resolveComposerInput: async (value) => {
        resolvedValues.push(value);
        return {
          prompt: value,
          attachments: [],
          transcriptText: value,
        };
      },
      getSuggestions: (value) =>
        getWorkShellSlashSuggestions(value, {
          provider: "openai",
          currentModel: "gpt-5.4",
        }),
      onExit: () => {},
      shouldBlockSlashSubmit: () => false,
      getReasoningLabel: () => "default medium",
      isReasoningSupported: () => true,
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  stdin.write("f");
  await waitForCondition(() => forgetCalls.length === 1);
  assert.equal(resolvedValues.includes("f"), false);

  stdin.write("a");
  await waitForCondition(() => resolvedValues.includes("a"));
  stdin.write("f");
  await waitForCondition(() => resolvedValues.includes("af"));
  instance.unmount();
  instance.cleanup();

  assert.deepEqual(forgetCalls, ["forget"]);
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
