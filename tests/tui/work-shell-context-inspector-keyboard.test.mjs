import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { render, Text } from "ink";
import React from "react";

import {
  Composer,
  resolveWorkShellContextInspectorAction,
  useWorkShellInputController,
} from "../../packages/tui/src/index.tsx";
import {
  getSelectedVisibleContextPolicySuggestion,
  getVisibleContextPolicySuggestions,
} from "../../packages/tui/src/work-shell-context-advice.tsx";
import {
  buildContextInspectorControls,
  resolveContextInspectorSourceCapabilities,
} from "../../packages/tui/src/work-shell-context-inspector.tsx";
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
  return { stdin, instance, getOutput: () => output };
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
    contextUndoActionsEnabled: props.undoEnabled,
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
    undoContextSourceAction: async () => props.onUndo?.(),
  });
  return React.createElement(Text, null, "ready");
}
function TelemetryInputControllerHarness(props) {
  const [value, setValue] = React.useState("");
  React.useEffect(() => {
    props.onValueChange(value);
  }, [props.onValueChange, value]);
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
    handleSubmit: props.onSubmit,
    hasOverlayOpen: true,
    activePanelTitle: props.activePanelTitle,
  });
  return React.createElement(Text, null, `draft:${value}`);
}

test("telemetry panel hotkeys switch views without entering composer text", async () => {
  for (const [activePanelTitle, key, expectedCommand] of [
    ["Cache Telemetry", "A", "/agents"],
    ["Agent History", "C", "/cache"],
  ]) {
    const submissions = [];
    const values = [];
    const view = renderWithInput(
      React.createElement(TelemetryInputControllerHarness, {
        activePanelTitle,
        onSubmit: async (command) => submissions.push(command),
        onValueChange: (value) => values.push(value),
      }),
    );

    try {
      view.stdin.write(key);
      await waitForCondition(() => submissions.length === 1);
      assert.deepEqual(submissions, [expectedCommand]);
      await waitForCondition(() => values.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(values.at(-1), "");
    } finally {
      view.instance.unmount();
      view.instance.cleanup();
    }
  }
});

test("composer suppresses telemetry action keys while a telemetry overlay is open", async () => {
  for (const key of ["A", "C", "a", "c"]) {
    const changes = [];
    const view = renderWithInput(
      React.createElement(Composer, {
        value: "",
        onChange: (value) => changes.push(value),
        onSubmit: async () => {},
        suppressTelemetryHotkeys: true,
      }),
    );

    try {
      view.stdin.write(key);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(changes, []);
    } finally {
      view.instance.unmount();
      view.instance.cleanup();
    }
  }
});


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
    value: "u",
    key: {},
    panelTitle: "Context expanded",
    undoActionsEnabled: true,
  }), { type: "undo" });
  assert.deepEqual(resolveWorkShellContextInspectorAction({
    value: "u",
    key: {},
    panelTitle: "Context expanded",
    undoActionsEnabled: false,
  }), { type: "none" });
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

test("the selected source's advice stays actionable past the visible window", () => {
  const suggestions = Array.from({ length: 6 }, (_, index) => ({
    id: `suggestion-${index}`,
    packetReceiptId: "receipt-1",
    sourceId: `source-${index}`,
    action: "keep",
    reasonCode: "mandatory-guidance",
    reasonText: "Keep mandatory guidance.",
    status: "proposed",
    createdAt: "2026-07-13T00:00:00.000Z",
  }));
  const visible = getVisibleContextPolicySuggestions(suggestions, "source-5");

  assert.equal(visible.length, 4);
  assert.deepEqual(
    visible.map((suggestion) => suggestion.sourceId),
    ["source-0", "source-1", "source-2", "source-5"],
  );
  assert.equal(
    getSelectedVisibleContextPolicySuggestion({ suggestions, selectedSourceId: "source-5" })?.id,
    "suggestion-5",
  );
  assert.equal(areContextAdviceActionsAvailable({
    enabled: true,
    selectedSuggestion: getSelectedVisibleContextPolicySuggestion({
      suggestions,
      selectedSourceId: "source-5",
    }),
    accept: async () => {},
    reject: async () => {},
  }), true);
  // A resolved suggestion is not pulled forward; only proposed advice is actionable.
  assert.equal(
    getSelectedVisibleContextPolicySuggestion({
      suggestions: suggestions.map((suggestion, index) =>
        index === 5 ? { ...suggestion, status: "accepted" } : suggestion),
      selectedSourceId: "source-5",
    }),
    undefined,
  );
});

test("source controls follow the selected item's declared actions", () => {
  const pinned = resolveContextInspectorSourceCapabilities({
    id: "pinned-guidance",
    category: "workspace",
    label: "AGENTS.md",
    reason: "workspace guidance",
    salience: 1,
    actions: ["unpin", "hold-back", "preview"],
  });
  const held = resolveContextInspectorSourceCapabilities({
    id: "held-trail",
    category: "loop-trail",
    label: "session loop trail",
    reason: "held locally",
    includedInModel: false,
    actions: ["include", "preview"],
  });
  const frozen = resolveContextInspectorSourceCapabilities({
    id: "system-frame",
    category: "system",
    label: "provider system prompt",
    reason: "provider requirement",
    actions: ["preview"],
  });

  assert.deepEqual(pinned, { pin: false, unpin: true, delivery: "hold-back" });
  assert.deepEqual(held, { pin: false, unpin: false, delivery: "include" });
  assert.deepEqual(frozen, { pin: false, unpin: false, delivery: undefined });

  assert.equal(
    buildContextInspectorControls({
      capabilities: pinned,
      actionsEnabled: true,
      expanded: false,
      undoAvailable: true,
    }),
    "↑↓ move · Enter details · Space hold back · P unpin · U undo · Esc close",
  );
  assert.equal(
    buildContextInspectorControls({
      capabilities: held,
      actionsEnabled: true,
      expanded: false,
      undoAvailable: false,
    }),
    "↑↓ move · Enter details · Space include · Esc close",
  );
  assert.equal(
    buildContextInspectorControls({
      capabilities: frozen,
      actionsEnabled: true,
      expanded: false,
      undoAvailable: false,
    }),
    "↑↓ move · Enter details · Esc close",
  );
  assert.equal(
    buildContextInspectorControls({
      capabilities: frozen,
      actionsEnabled: true,
      expanded: true,
      undoAvailable: false,
    }),
    "↑↓ scroll · Enter back · Esc close",
  );
});

test("sources without a declared action list keep their state-derived controls", () => {
  const unpinnedInPacket = resolveContextInspectorSourceCapabilities({
    id: "bridge-1",
    category: "bridge",
    label: "recent Q&A",
    reason: "session bridge",
    salience: 0.7,
    includedInModel: true,
  });
  const heldInPacket = resolveContextInspectorSourceCapabilities({
    id: "loop-1",
    category: "loop-trail",
    label: "session loop trail",
    reason: "raw trail stays local",
    includedInModel: false,
  });

  assert.deepEqual(unpinnedInPacket, { pin: true, unpin: false, delivery: "hold-back" });
  assert.deepEqual(heldInPacket, { pin: true, unpin: false, delivery: "include" });
  assert.equal(
    buildContextInspectorControls({
      capabilities: resolveContextInspectorSourceCapabilities(undefined),
      actionsEnabled: true,
      expanded: false,
      undoAvailable: false,
    }),
    "↑↓ move · Enter details · Esc close",
  );
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
      undoEnabled: true,
      onUndo: () => writableCalls.push("undo"),
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
  writable.stdin.write("u");
  await waitForCondition(() => writableCalls.includes("undo"));
  writable.instance.unmount();
  writable.instance.cleanup();
  assert.deepEqual(writableCalls, ["delivery", "pin", "expand", "accept", "reject", "undo"]);
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
  const { stdin, instance, getOutput } = renderWithInput(
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

test("composer suppresses the undo key only while undo is available", async () => {
  const activeChanges = [];
  const active = renderWithInput(
    React.createElement(Composer, {
      value: "",
      onChange: (value) => activeChanges.push(value),
      onSubmit: async () => {},
      suppressInspectorKeys: true,
      suppressInspectorMutationKeys: true,
      suppressInspectorUndoKey: true,
    }),
  );
  active.stdin.write("u");
  await new Promise((resolve) => setTimeout(resolve, 100));
  active.instance.unmount();
  active.instance.cleanup();
  assert.deepEqual(activeChanges, []);

  const inactiveChanges = [];
  const inactive = renderWithInput(
    React.createElement(Composer, {
      value: "",
      onChange: (value) => inactiveChanges.push(value),
      onSubmit: async () => {},
      suppressInspectorKeys: true,
      suppressInspectorMutationKeys: false,
      suppressInspectorUndoKey: false,
    }),
  );
  inactive.stdin.write("u");
  await waitForCondition(() => inactiveChanges.includes("u"));
  inactive.instance.unmount();
  inactive.instance.cleanup();
  assert.deepEqual(inactiveChanges, ["u"]);
});

