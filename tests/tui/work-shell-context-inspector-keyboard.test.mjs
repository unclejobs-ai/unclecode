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
    ...(props.pane !== undefined
      ? { contextInspectorPane: props.pane }
      : {}),
    moveContextInspectorCursor: props.onMove,
    moveContextInspectorPane: props.onMovePane ?? (() => {}),
    moveContextInspectorPage: props.onMovePage ?? (() => {}),
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
  for (const value of ["U", "A", "R"]) {
    assert.deepEqual(resolveWorkShellContextInspectorAction({
      value,
      key: {},
      panelTitle: "Context expanded",
      actionsEnabled: true,
      adviceActionsEnabled: true,
      undoActionsEnabled: true,
    }), { type: "none" }, `${value} stays composer text`);
  }

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

  assert.deepEqual(pinned, { pin: false, unpin: true, delivery: "hold-back", preview: true });
  assert.deepEqual(held, { pin: false, unpin: false, delivery: "include", preview: true });
  assert.deepEqual(frozen, { pin: false, unpin: false, delivery: undefined, preview: true });

  assert.equal(
    buildContextInspectorControls({
      capabilities: pinned,
      actionsEnabled: true,
      expanded: false,
      undoAvailable: true,
    }),
    "↑↓ move · Enter details · Space hold back · P unpin · U undo · Esc close · ←→ pane",
  );
  assert.equal(
    buildContextInspectorControls({
      capabilities: held,
      actionsEnabled: true,
      expanded: false,
      undoAvailable: false,
    }),
    "↑↓ move · Enter details · Space include · Esc close · ←→ pane",
  );
  assert.equal(
    buildContextInspectorControls({
      capabilities: frozen,
      actionsEnabled: true,
      expanded: false,
      undoAvailable: false,
    }),
    "↑↓ move · Enter details · Esc close · ←→ pane",
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

  assert.deepEqual(unpinnedInPacket, { pin: true, unpin: false, delivery: "hold-back", preview: true });
  assert.deepEqual(heldInPacket, { pin: true, unpin: false, delivery: "include", preview: true });
  assert.equal(
    buildContextInspectorControls({
      capabilities: resolveContextInspectorSourceCapabilities(undefined),
      actionsEnabled: true,
      expanded: false,
      undoAvailable: false,
    }),
    "↑↓ move · Esc close · ←→ pane",
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
  for (const key of ["U", "A", "R"]) {
    writable.stdin.write(key);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
test("context inspector catches a rejected async expand and keeps dispatching desk keys", async () => {
  const calls = [];
  const unhandledReasons = [];
  const onUnhandledRejection = (reason) => {
    unhandledReasons.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  const view = renderWithInput(
    React.createElement(ContextInputControllerHarness, {
      onExpand: () => {
        calls.push("expand");
        return Promise.reject(new Error("expand failed"));
      },
      onMove: (direction) => calls.push(`move:${direction}`),
    }),
  );

  try {
    view.stdin.write("\r");
    await waitForCondition(() => calls.includes("expand"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    view.stdin.write("\u001b[B");
    await waitForCondition(() => calls.includes("move:1"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(calls, ["expand", "move:1"]);
    assert.deepEqual(
      unhandledReasons,
      [],
      "a rejected expansion must be handled inside desk dispatch",
    );
  } finally {
    view.instance.unmount();
    view.instance.cleanup();
    process.off("unhandledRejection", onUnhandledRejection);
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

test("uppercase context action letters stay composer text", async () => {
  for (const key of ["U", "A", "R"]) {
    const changes = [];
    const view = renderWithInput(
      React.createElement(Composer, {
        value: "",
        onChange: (value) => changes.push(value),
        onSubmit: async () => {},
        suppressInspectorKeys: true,
        suppressInspectorMutationKeys: true,
        suppressInspectorUndoKey: true,
        suppressInspectorAdviceKeys: true,
      }),
    );

    try {
      view.stdin.write(key);
      await waitForCondition(() => changes.includes(key));
      assert.equal(changes.at(-1), key);
    } finally {
      view.instance.unmount();
      view.instance.cleanup();
    }
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


// Pure Yazi navigation (Context Desk): h/l + left/right switch panes, j/k +
// up/down move the cursor, PgUp/PgDn page. Every entry is `[label, keystroke
// patch, expected action]` so the resolver and the controller are asserted
// against one shared table.
const PURE_YAZI_NAVIGATION_CASES = [
  ["h switches to the previous pane", { value: "h" }, { type: "move-pane", direction: -1 }],
  ["l switches to the next pane", { value: "l" }, { type: "move-pane", direction: 1 }],
  ["left arrow switches to the previous pane", { key: { leftArrow: true } }, { type: "move-pane", direction: -1 }],
  ["right arrow switches to the next pane", { key: { rightArrow: true } }, { type: "move-pane", direction: 1 }],
  ["k moves the cursor up", { value: "k" }, { type: "move-cursor", direction: -1 }],
  ["j moves the cursor down", { value: "j" }, { type: "move-cursor", direction: 1 }],
  ["up arrow moves the cursor up", { key: { upArrow: true } }, { type: "move-cursor", direction: -1 }],
  ["down arrow moves the cursor down", { key: { downArrow: true } }, { type: "move-cursor", direction: 1 }],
  ["pageUp pages backward", { key: { pageUp: true } }, { type: "move-page", direction: -1 }],
  ["pageDown pages forward", { key: { pageDown: true } }, { type: "move-page", direction: 1 }],
];

test("context inspector resolver maps Pure Yazi pane, cursor, and page keys", () => {
  // Navigation is read-only, so it resolves whether or not the mutation and
  // optimizer capabilities are live — and it outranks the mutation letters.
  for (const capabilities of [
    { actionsEnabled: false, adviceActionsEnabled: false, undoActionsEnabled: false },
    { actionsEnabled: true, adviceActionsEnabled: true, undoActionsEnabled: true },
  ]) {
    for (const [label, patch, expected] of PURE_YAZI_NAVIGATION_CASES) {
      assert.deepEqual(
        resolveWorkShellContextInspectorAction({
          value: patch.value ?? "",
          key: patch.key ?? {},
          panelTitle: "Context expanded",
          ...capabilities,
        }),
        expected,
        `${label} (actionsEnabled=${capabilities.actionsEnabled})`,
      );
    }
  }
});

test("context inspector resolver keeps Pure Yazi keys inert outside the overlay, under the slash picker, and over pending drafts", () => {
  for (const [label, patch] of PURE_YAZI_NAVIGATION_CASES) {
    assert.deepEqual(
      resolveWorkShellContextInspectorAction({
        value: patch.value ?? "",
        key: patch.key ?? {},
        panelTitle: "Cache Telemetry",
        actionsEnabled: true,
        adviceActionsEnabled: true,
        undoActionsEnabled: true,
      }),
      { type: "none" },
      `${label} outside the context overlay`,
    );
  }
  for (const value of ["/", "/context", "/ctx l"]) {
    assert.deepEqual(
      resolveWorkShellContextInspectorAction({
        value,
        key: {},
        panelTitle: "Context expanded",
        actionsEnabled: true,
        adviceActionsEnabled: true,
        undoActionsEnabled: true,
      }),
      { type: "none" },
      `slash picker keeps ${JSON.stringify(value)} inert`,
    );
  }
  // Every alias — letters, arrows, and page keys alike — must resolve to none
  // while the composer holds locally pending text. `value` stays the current
  // key payload (as production passes it); the pending draft is signalled by
  // the `composerEmpty: false` capability flag. Navigation gets no exemption
  // from draft protection.
  for (const [label, patch] of PURE_YAZI_NAVIGATION_CASES) {
    assert.deepEqual(
      resolveWorkShellContextInspectorAction({
        value: patch.value ?? "",
        key: patch.key ?? {},
        panelTitle: "Context expanded",
        actionsEnabled: true,
        adviceActionsEnabled: true,
        undoActionsEnabled: true,
        composerEmpty: false,
      }),
      { type: "none" },
      `${label} stays inert over a locally pending draft`,
    );
  }
});

test("context inspector controller dispatches Pure Yazi pane, cursor, and page callbacks", async () => {
  const calls = [];
  const view = renderWithInput(
    React.createElement(ContextInputControllerHarness, {
      actionsEnabled: true,
      adviceActionsEnabled: true,
      undoEnabled: true,
      onMove: (direction) => calls.push(`cursor:${direction}`),
      onMovePane: (direction) => calls.push(`pane:${direction}`),
      onMovePage: (direction) => calls.push(`page:${direction}`),
      onPin: () => calls.push("pin"),
      onToggleDelivery: () => calls.push("delivery"),
      onExpand: () => calls.push("expand"),
      onAccept: () => calls.push("accept"),
      onReject: () => calls.push("reject"),
      onUndo: () => calls.push("undo"),
    }),
  );

  const sequence = [
    ["h", "pane:-1"],
    ["l", "pane:1"],
    ["\u001b[D", "pane:-1"],
    ["\u001b[C", "pane:1"],
    ["k", "cursor:-1"],
    ["j", "cursor:1"],
    ["\u001b[A", "cursor:-1"],
    ["\u001b[B", "cursor:1"],
    ["\u001b[5~", "page:-1"],
    ["\u001b[6~", "page:1"],
  ];

  try {
    const expected = [];
    for (const [keystroke, expectation] of sequence) {
      view.stdin.write(keystroke);
      expected.push(expectation);
      await waitForCondition(() => calls.length >= expected.length);
      assert.deepEqual(calls, expected, `keystroke ${JSON.stringify(keystroke)}`);
    }
  } finally {
    view.instance.unmount();
    view.instance.cleanup();
  }
});

// Terminal byte sequence that produces each table entry's Ink keystroke, so
// the controller test drives the same shared table through real stdin input.
function pureYaziKeystroke(patch) {
  if (patch.value !== undefined) return patch.value;
  if (patch.key.leftArrow) return "\u001b[D";
  if (patch.key.rightArrow) return "\u001b[C";
  if (patch.key.upArrow) return "\u001b[A";
  if (patch.key.downArrow) return "\u001b[B";
  if (patch.key.pageUp) return "\u001b[5~";
  if (patch.key.pageDown) return "\u001b[6~";
  throw new Error("Pure Yazi navigation case has no keystroke mapping");
}

test("context inspector controller keeps every Pure Yazi alias out of a protected composer", async () => {
  for (const [stateLabel, protection] of [
    ["slash picker open", { initialValue: "/context" }],
    ["locally pending draft", { isComposerRawEmpty: () => false }],
  ]) {
    const calls = [];
    const view = renderWithInput(
      React.createElement(ContextInputControllerHarness, {
        actionsEnabled: true,
        adviceActionsEnabled: true,
        undoEnabled: true,
        ...protection,
        onMove: (direction) => calls.push(`cursor:${direction}`),
        onMovePane: (direction) => calls.push(`pane:${direction}`),
        onMovePage: (direction) => calls.push(`page:${direction}`),
        onPin: () => calls.push("pin"),
        onToggleDelivery: () => calls.push("delivery"),
        onExpand: () => calls.push("expand"),
        onAccept: () => calls.push("accept"),
        onReject: () => calls.push("reject"),
        onUndo: () => calls.push("undo"),
      }),
    );

    try {
      // Every navigation alias — letters, arrows, and page keys — must leave
      // pane, cursor, and page callbacks untouched while the composer is
      // protected. Asserting after each keystroke names the leaking alias.
      for (const [label, patch] of PURE_YAZI_NAVIGATION_CASES) {
        view.stdin.write(pureYaziKeystroke(patch));
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(calls, [], `${label} must stay inert with the ${stateLabel}`);
      }
      // The mutation letters and space stay composer text as well.
      for (const keystroke of ["p", "u", "a", "r", " "]) {
        view.stdin.write(keystroke);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(calls, [], stateLabel);
    } finally {
      view.instance.unmount();
      view.instance.cleanup();
    }
  }
});


// An expanded source owns the detail scrollback, but only while the Sources
// pane is active. Once the cursor crosses into Groups, j/k belong to the group
// list again — the expansion must not keep swallowing them.
test("an expanded source only owns j/k while the sources pane is active", async () => {
  for (const [label, paneProps, expected] of [
    ["groups pane", { pane: "groups" }, ["cursor:1", "cursor:-1"]],
    ["sources pane", { pane: "sources" }, ["scroll:1", "scroll:-1"]],
    ["legacy pane-blind host", {}, ["scroll:1", "scroll:-1"]],
  ]) {
    const calls = [];
    const view = renderWithInput(
      React.createElement(ContextInputControllerHarness, {
        actionsEnabled: true,
        expandedId: "configured-prompt",
        ...paneProps,
        onMove: (direction) => calls.push(`cursor:${direction}`),
        onScroll: (direction) => calls.push(`scroll:${direction}`),
        onPin: () => {},
        onToggleDelivery: () => {},
        onExpand: async () => {},
      }),
    );

    try {
      view.stdin.write("j");
      await waitForCondition(() => calls.length >= 1);
      view.stdin.write("k");
      await waitForCondition(() => calls.length >= 2);
      assert.deepEqual(calls, expected, label);
    } finally {
      view.instance.unmount();
      view.instance.cleanup();
    }
  }
});