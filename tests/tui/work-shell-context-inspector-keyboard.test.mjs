import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { render } from "ink";
import React from "react";

import {
  Composer,
  resolveWorkShellContextInspectorAction,
  useWorkShellInputController,
} from "../../packages/tui/src/index.tsx";

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
  stdout.on("data", () => {});
  const instance = render(element, {
    stdin,
    stdout,
    stderr: createWritableError(),
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return { stdin, instance };
}

async function waitForCondition(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

function ContextInputControllerHarness(props) {
  const [value, setValue] = React.useState("");
  useWorkShellInputController({
    value,
    replaceValue: setValue,
    slashSuggestionCount: 0,
    setSelectedSlashIndex: () => {},
    isBusy: false,
    currentMode: "yolo",
    onExit: () => {},
    openEngineSessions: () => {},
    cycleMode: () => {},
    shouldBlockSlashSubmit: () => false,
    handleSubmit: async () => {},
    hasOverlayOpen: true,
    activePanelTitle: "Context expanded",
    contextSourceActionsEnabled: props.actionsEnabled,
    moveContextInspectorCursor: props.onMove,
    toggleContextInspectorPin: async () => props.onPin(),
    forgetContextSourceAtCursor: async () => props.onForget(),
    includeContextSourceAtCursor: async () => props.onInclude(),
    toggleContextInspectorExpanded: props.onExpand,
  });
  return null;
}

test("context inspector resolver keeps navigation live while read-only mutation actions are disabled", () => {
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "j",
    key: {},
    panelTitle: "Context expanded",
    actionsEnabled: false,
  }), { type: "move-cursor", direction: 1 });
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "e",
    key: {},
    panelTitle: "Context expanded",
    actionsEnabled: false,
  }), { type: "expand" });
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "f",
    key: {},
    panelTitle: "Context expanded",
    actionsEnabled: false,
  }), { type: "none" });
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "i",
    key: {},
    panelTitle: "Context expanded",
    actionsEnabled: false,
  }), { type: "none" });
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "",
    key: { return: true },
    panelTitle: "Context expanded",
    actionsEnabled: false,
  }), { type: "none" });
});

test("context inspector input controller dispatches mutation shortcuts only when actions are enabled", async () => {
  const readOnlyCalls = [];
  const readOnly = renderWithInput(
    React.createElement(ContextInputControllerHarness, {
      actionsEnabled: false,
      onMove: () => {},
      onPin: () => readOnlyCalls.push("pin"),
      onForget: () => readOnlyCalls.push("forget"),
      onInclude: () => readOnlyCalls.push("include"),
      onExpand: () => {},
    }),
  );
  readOnly.stdin.write("f");
  await new Promise((resolve) => setTimeout(resolve, 200));
  readOnly.instance.unmount();
  readOnly.instance.cleanup();
  assert.deepEqual(readOnlyCalls, []);

  const writableCalls = [];
  const writable = renderWithInput(
    React.createElement(ContextInputControllerHarness, {
      actionsEnabled: true,
      onMove: () => {},
      onPin: () => writableCalls.push("pin"),
      onForget: () => writableCalls.push("forget"),
      onInclude: () => writableCalls.push("include"),
      onExpand: () => {},
    }),
  );
  writable.stdin.write("f");
  await waitForCondition(() => writableCalls.includes("forget"));
  writable.instance.unmount();
  writable.instance.cleanup();
  assert.deepEqual(writableCalls, ["forget"]);
});

test("composer does not swallow read-only context mutation keys", async () => {
  const changes = [];
  const { stdin, instance } = renderWithInput(
    React.createElement(Composer, {
      value: "",
      onChange: (value) => changes.push(value),
      onSubmit: async () => {},
      suppressInspectorKeys: true,
      suppressInspectorMutationKeys: false,
    }),
  );

  stdin.write("f");
  await waitForCondition(() => changes.includes("f"));
  instance.unmount();
  instance.cleanup();

  assert.deepEqual(changes, ["f"]);
});
