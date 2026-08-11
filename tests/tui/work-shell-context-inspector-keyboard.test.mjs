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
  const replaceValue = (nextValue) => {
    props.onReplace?.(nextValue);
    setValue(nextValue);
  };
  useWorkShellInputController({
    value,
    replaceValue,
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
    contextDeskPane: props.pane ?? "sources",
    contextSourceActionsEnabled: props.actionsEnabled,
    contextAdviceActionsEnabled: props.adviceActionsEnabled,
    acceptContextSuggestion: async () => props.onAccept?.(),
    rejectContextSuggestion: async () => props.onReject?.(),
    contextInspectorExpanded: props.expandedId,
    cycleContextDeskPane: () => props.onCycle?.(),
    moveContextInspectorCursor: (direction) => props.onMove?.(direction),
    moveContextDeskPreviewOffset: (direction) => props.onPreviewScroll?.(direction),
    moveContextInspectorDetailOffset: (direction) => props.onDetailScroll?.(direction),
    enterContextDesk: async () => props.onEnter?.(),
    toggleContextInspectorPin: async () => props.onPin?.(),
    toggleContextSourceDelivery: async () => props.onToggleDelivery?.(),
    closeOverlay: () => props.onClose?.(),
    ...(props.onRequestSessionsView
      ? { onRequestSessionsView: props.onRequestSessionsView }
      : {}),
  });
  return props.mountComposer
    ? React.createElement(Composer, {
        value,
        onChange: (nextValue) => {
          props.onComposerChange?.(nextValue);
          setValue(nextValue);
        },
        onSubmit: async () => {},
        suppressInspectorKeys: true,
        suppressInspectorMutationKeys: true,
        suppressInspectorAdviceKeys: true,
      })
    : null;
}

test("context desk resolver routes navigation by pane and consumes gated keys", () => {
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "",
    key: { downArrow: true },
    panelTitle: "Context expanded",
    pane: "sources",
    actionsEnabled: false,
  }), { type: "move-source", direction: 1 });
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "",
    key: { upArrow: true },
    panelTitle: "Context expanded",
    pane: "preview",
  }), { type: "move-preview", direction: -1 });
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "",
    key: { downArrow: true },
    panelTitle: "Context expanded",
    pane: "details",
  }), { type: "move-details", direction: 1 });
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "",
    key: { tab: true },
    panelTitle: "Context expanded",
    pane: "details",
  }), { type: "cycle-pane" });
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "",
    key: { return: true },
    panelTitle: "Context expanded",
    pane: "preview",
  }), { type: "enter" });
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "",
    key: { escape: true },
    panelTitle: "Context expanded",
    pane: "details",
  }), { type: "close" });
  for (const value of [" ", "p", "a", "r"]) {
    assert.deepEqual(resolveWorkShellContextInspectorAction({
      value,
      key: {},
      panelTitle: "Context expanded",
      pane: "sources",
      actionsEnabled: false,
      adviceActionsEnabled: false,
    }), { type: "consume" });
  }
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "P",
    key: {},
    panelTitle: "Context expanded",
    pane: "sources",
    actionsEnabled: true,
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
      onEnter: () => readOnlyCalls.push("enter"),
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
      onEnter: () => writableCalls.push("enter"),
      onAccept: () => writableCalls.push("accept"),
      onReject: () => writableCalls.push("reject"),
    }),
  );
  writable.stdin.write(" ");
  await waitForCondition(() => writableCalls.includes("delivery"));
  writable.stdin.write("p");
  await waitForCondition(() => writableCalls.includes("pin"));
  writable.stdin.write("\r");
  await waitForCondition(() => writableCalls.includes("enter"));
  writable.stdin.write("a");
  await waitForCondition(() => writableCalls.includes("accept"));
  writable.stdin.write("r");
  await waitForCondition(() => writableCalls.includes("reject"));
  writable.instance.unmount();
  writable.instance.cleanup();
  assert.deepEqual(writableCalls, ["delivery", "pin", "enter", "accept", "reject"]);
});
test("context desk actions own nonempty, whitespace, and leading-slash drafts", async () => {
  const calls = [];
  for (const [initialValue, label] of [["draft", "draft"], [" ", "whitespace"]]) {
    const view = renderWithInput(
      React.createElement(ContextInputControllerHarness, {
        initialValue,
        adviceActionsEnabled: true,
        onAccept: () => calls.push(label),
      }),
    );
    view.stdin.write("a");
    await waitForCondition(() => calls.includes(label));
    view.instance.unmount();
    view.instance.cleanup();
  }

  const slash = renderWithInput(
    React.createElement(ContextInputControllerHarness, {
      initialValue: "/model",
      onCycle: () => calls.push("slash-tab"),
    }),
  );
  slash.stdin.write("\t");
  await waitForCondition(() => calls.includes("slash-tab"));
  slash.instance.unmount();
  slash.instance.cleanup();

  assert.deepEqual(calls, ["draft", "whitespace", "slash-tab"]);
});

test("unexpanded Details routes arrows to the complete details surface", async () => {
  const calls = [];
  const view = renderWithInput(
    React.createElement(ContextInputControllerHarness, {
      pane: "details",
      onMove: () => calls.push("move"),
      onPreviewScroll: () => calls.push("preview"),
      onDetailScroll: (direction) => calls.push(`details:${direction}`),
    }),
  );
  try {
    view.stdin.write("\u001b[B");
    await waitForCondition(() => calls.length > 0);
    assert.deepEqual(calls, ["details:1"]);
  } finally {
    view.instance.unmount();
    view.instance.cleanup();
  }
});

test("disabled Context mutation keys are consumed before a nonempty composer", async () => {
  const changes = [];
  const view = renderWithInput(
    React.createElement(ContextInputControllerHarness, {
      initialValue: "draft",
      actionsEnabled: false,
      adviceActionsEnabled: false,
      mountComposer: true,
      onComposerChange: (value) => changes.push(value),
    }),
  );
  try {
    view.stdin.write("p");
    view.stdin.write(" ");
    view.stdin.write("a");
    view.stdin.write("r");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(changes, []);
  } finally {
    view.instance.unmount();
    view.instance.cleanup();
  }
});

test("Ctrl+O opens Session Desk without clearing the controlled Work draft", async () => {
  const calls = [];
  const view = renderWithInput(
    React.createElement(ContextInputControllerHarness, {
      initialValue: "preserve this draft",
      onRequestSessionsView: () => calls.push("sessions"),
      onReplace: (value) => calls.push(`replace:${value}`),
    }),
  );
  try {
    view.stdin.write("\u000f");
    await waitForCondition(() => calls.includes("sessions"));
    assert.deepEqual(calls, ["sessions"]);
  } finally {
    view.instance.unmount();
    view.instance.cleanup();
  }
});

test("composer suppresses Context mutation keys even with a nonempty draft", async () => {
  const changes = [];
  const { stdin, instance } = renderWithInput(
    React.createElement(Composer, {
      value: "draft",
      onChange: (value) => changes.push(value),
      onSubmit: async () => {},
      suppressInspectorKeys: true,
      suppressInspectorMutationKeys: true,
    }),
  );
  try {
    stdin.write("p");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(changes, []);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("composer suppresses optimizer keys only while advice actions are enabled", async () => {
  const changes = [];
  const { stdin, instance } = renderWithInput(
    React.createElement(Composer, {
      value: "draft",
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

test("composer suppresses a Context mutation after locally pending text", async () => {
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
    stdin.write("x");
    await waitForCondition(() => changes.includes("x"));
    stdin.write("p");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(changes.at(-1), "x");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});
test("composer suppresses optimizer letters after a whitespace-only draft", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(changes, []);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

