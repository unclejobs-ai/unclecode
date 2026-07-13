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
import { getVisibleContextPolicySuggestions } from "../../packages/tui/src/work-shell-context-advice.tsx";
import { areContextAdviceActionsAvailable } from "../../packages/tui/src/work-shell-hooks.ts";

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
  const [value, setValue] = React.useState(props.initialValue ?? "");
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
    contextAdviceActionsEnabled: props.adviceActionsEnabled,
    ...(props.isComposerRawEmpty
      ? { isComposerRawEmpty: props.isComposerRawEmpty }
      : {}),
    acceptContextSuggestion: async () => props.onAccept?.(),
    rejectContextSuggestion: async () => props.onReject?.(),
    contextInspectorExpanded: props.expandedId,
    moveContextInspectorCursor: props.onMove,
    moveContextInspectorDetailOffset: props.onScroll ?? (() => {}),
    toggleContextInspectorPin: async () => props.onPin(),
    toggleContextSourceDelivery: async () => props.onToggleDelivery(),
    toggleContextInspectorExpanded: props.onExpand,
  });
  return null;
}

test("context inspector resolver uses human navigation and action keys", () => {
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "",
    key: { downArrow: true },
    panelTitle: "Context expanded",
    actionsEnabled: false,
  }), { type: "move-cursor", direction: 1 });
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "",
    key: { return: true },
    panelTitle: "Context expanded",
    actionsEnabled: false,
  }), { type: "expand" });
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: " ",
    key: {},
    panelTitle: "Context expanded",
    actionsEnabled: true,
  }), { type: "toggle-delivery" });
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "p",
    key: {},
    panelTitle: "Context expanded",
    actionsEnabled: true,
  }), { type: "toggle-pin" });
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: " ",
    key: {},
    panelTitle: "Context expanded",
    actionsEnabled: false,
  }), { type: "none" });
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "a",
    key: {},
    panelTitle: "Context expanded",
    adviceActionsEnabled: true,
  }), { type: "accept-advice" });
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "r",
    key: {},
    panelTitle: "Context expanded",
    adviceActionsEnabled: true,
  }), { type: "reject-advice" });
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "a",
    key: {},
    panelTitle: "Context expanded",
    adviceActionsEnabled: false,
  }), { type: "none" });
});
test("optimizer actions require both callbacks and a visible selected suggestion", () => {
  const suggestions = Array.from({ length: 5 }, (_, index) => ({
    id: `suggestion-${index}`,
    packetReceiptId: "receipt-1",
    sourceId: `source-${index}`,
    action: "keep",
    reasonCode: "mandatory-guidance",
    reasonText: "Keep mandatory guidance.",
    status: "proposed",
    createdAt: "2026-07-13T00:00:00.000Z",
  }));
  const visible = getVisibleContextPolicySuggestions(suggestions);
  const accept = async () => {};
  const reject = async () => {};

  assert.equal(visible.length, 4);
  assert.doesNotMatch(JSON.stringify(visible), /source-4/);
  assert.equal(areContextAdviceActionsAvailable({
    enabled: true,
    selectedSuggestion: visible[0],
    accept,
  }), false);
  assert.equal(areContextAdviceActionsAvailable({
    enabled: true,
    selectedSuggestion: visible[0],
    reject,
  }), false);
  assert.equal(areContextAdviceActionsAvailable({
    enabled: true,
    selectedSuggestion: visible[0],
    accept,
    reject,
  }), true);
});


test("context inspector input controller dispatches only enabled human actions", async () => {
  const readOnlyCalls = [];
  const readOnly = renderWithInput(
    React.createElement(ContextInputControllerHarness, {
      actionsEnabled: false,
      onMove: () => {},
      onPin: () => readOnlyCalls.push("pin"),
      onToggleDelivery: () => readOnlyCalls.push("delivery"),
      onExpand: () => readOnlyCalls.push("expand"),
    }),
  );
  readOnly.stdin.write(" ");
  readOnly.stdin.write("p");
  await new Promise((resolve) => setTimeout(resolve, 200));
  readOnly.instance.unmount();
  readOnly.instance.cleanup();
  assert.deepEqual(readOnlyCalls, []);

  const writableCalls = [];
  const writable = renderWithInput(
    React.createElement(ContextInputControllerHarness, {
      actionsEnabled: true,
      adviceActionsEnabled: true,
      onMove: () => {},
      onPin: () => writableCalls.push("pin"),
      onToggleDelivery: () => writableCalls.push("delivery"),
      onExpand: () => writableCalls.push("expand"),
      onAccept: () => writableCalls.push("accept"),
      onReject: () => writableCalls.push("reject"),
    }),
  );
  writable.stdin.write(" ");
  await waitForCondition(() => writableCalls.includes("delivery"));
  writable.stdin.write("p");
  await waitForCondition(() => writableCalls.includes("pin"));
  writable.stdin.write("\r");
  await waitForCondition(() => writableCalls.includes("expand"));
  writable.stdin.write("a");
  await waitForCondition(() => writableCalls.includes("accept"));
  writable.stdin.write("r");
  await waitForCondition(() => writableCalls.includes("reject"));
  writable.instance.unmount();
  writable.instance.cleanup();
  assert.deepEqual(writableCalls, ["delivery", "pin", "expand", "accept", "reject"]);
});
test("context advice keys never steal whitespace or locally pending drafts", async () => {
  const calls = [];
  const whitespace = renderWithInput(
    React.createElement(ContextInputControllerHarness, {
      initialValue: " ",
      adviceActionsEnabled: true,
      onAccept: () => calls.push("whitespace"),
    }),
  );
  whitespace.stdin.write("a");
  await new Promise((resolve) => setTimeout(resolve, 100));
  whitespace.instance.unmount();
  whitespace.instance.cleanup();

  const pending = renderWithInput(
    React.createElement(ContextInputControllerHarness, {
      adviceActionsEnabled: true,
      isComposerRawEmpty: () => false,
      onAccept: () => calls.push("pending"),
    }),
  );
  pending.stdin.write("a");
  await new Promise((resolve) => setTimeout(resolve, 100));
  pending.instance.unmount();
  pending.instance.cleanup();

  assert.deepEqual(calls, []);
});


test("expanded context details route arrow keys to scrolling instead of source movement", async () => {
  const calls = [];
  const view = renderWithInput(
    React.createElement(ContextInputControllerHarness, {
      actionsEnabled: true,
      expandedId: "configured-prompt",
      onMove: () => calls.push("move"),
      onScroll: (direction) => calls.push(`scroll:${direction}`),
      onPin: () => {},
      onToggleDelivery: () => {},
      onExpand: async () => {},
    }),
  );

  try {
    view.stdin.write("\u001b[B");
    await waitForCondition(() => calls.length > 0);
    assert.deepEqual(calls, ["scroll:1"]);
  } finally {
    view.instance.unmount();
    view.instance.cleanup();
  }
});

test("composer only suppresses context mutation keys when actions are enabled", async () => {
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

  stdin.write("p");
  await waitForCondition(() => changes.includes("p"));
  instance.unmount();
  instance.cleanup();

  assert.deepEqual(changes, ["p"]);
});

test("composer suppresses optimizer keys only while advice actions are enabled", async () => {
  const changes = [];
  const { stdin, instance } = renderWithInput(
    React.createElement(Composer, {
      value: "",
      onChange: (value) => changes.push(value),
      onSubmit: async () => {},
      suppressInspectorKeys: true,
      suppressInspectorMutationKeys: false,
      suppressInspectorAdviceKeys: true,
    }),
  );

  stdin.write("a");
  await new Promise((resolve) => setTimeout(resolve, 100));
  instance.unmount();
  instance.cleanup();

  assert.deepEqual(changes, []);
});

test("composer does not suppress a mutation letter after locally pending text", async () => {
  const changes = [];
  const { stdin, instance } = renderWithInput(
    React.createElement(Composer, {
      value: "",
      onChange: (value) => changes.push(value),
      onSubmit: async () => {},
      suppressInspectorKeys: true,
      suppressInspectorMutationKeys: true,
    }),
  );

  try {
    stdin.write("a");
    stdin.write("p");
    await waitForCondition(() => changes.includes("ap"));
    assert.equal(changes.at(-1), "ap");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});
test("composer preserves optimizer letters after a whitespace-only draft", async () => {
  const changes = [];
  const { stdin, instance } = renderWithInput(
    React.createElement(Composer, {
      value: " ",
      onChange: (value) => changes.push(value),
      onSubmit: async () => {},
      suppressInspectorKeys: true,
      suppressInspectorMutationKeys: true,
      suppressInspectorAdviceKeys: true,
    }),
  );

  try {
    stdin.write("a");
    await waitForCondition(() => changes.includes(" a"));
    assert.equal(changes.at(-1), " a");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

