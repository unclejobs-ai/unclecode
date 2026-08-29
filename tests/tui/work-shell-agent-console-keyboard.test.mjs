import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import { render } from "ink";
import React from "react";

import { resolveAgentConsoleInputDecision } from "../../packages/tui/src/work-shell-agent-console-input.ts";
import { useWorkShellPaneState } from "../../packages/tui/src/work-shell-hooks.ts";
import {
  resolveAttachmentOnlyInspectionPrompt,
  WorkShellPane,
} from "../../packages/tui/src/work-shell-pane.tsx";
import {
  closeAgentConsoleView,
  createAgentConsoleViewState,
  isSettledAgentRun,
  moveAgentConsoleCursor,
  openAgentConsoleView,
  requestAgentConsoleCancel,
  resolveAgentConsoleSelection,
  selectAgentConsoleTab,
  settleAgentConsoleControl,
  toggleAgentConsoleInspector,
} from "../../packages/orchestrator/src/work-shell-agent-console-state.ts";

// ---------------------------------------------------------------------------
// Pure resolver — the precedence ladder every keystroke walks.
// ---------------------------------------------------------------------------

const NO_KEY = Object.freeze({});

function context(overrides = {}) {
  return {
    value: "",
    key: NO_KEY,
    open: true,
    tab: "agents",
    control: "browse",
    composerMode: "default",
    composerEmpty: true,
    slashPickerActive: false,
    ...overrides,
  };
}

/** Every key the console claims when it owns an empty composer. */
const CONSOLE_KEYSTROKES = [
  { label: "j", value: "j", key: NO_KEY },
  { label: "k", value: "k", key: NO_KEY },
  { label: "s", value: "s", key: NO_KEY },
  { label: "x", value: "x", key: NO_KEY },
  { label: "r", value: "r", key: NO_KEY },
  { label: "up arrow", value: "", key: { upArrow: true } },
  { label: "down arrow", value: "", key: { downArrow: true } },
  { label: "tab", value: "", key: { tab: true } },
  { label: "enter", value: "", key: { return: true } },
  { label: "escape", value: "", key: { escape: true, meta: true } },
];

const ALT_A = { value: "a", key: { meta: true } };

const CLIPBOARD_PNG = {
  type: "image",
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,AAA=",
  path: "(clipboard)",
  displayName: "clipboard.png",
};

const PASS = { kind: "pass" };
const CONSUME = { kind: "consume" };
const COMPOSE = { kind: "compose" };

function decide(overrides) {
  return resolveAgentConsoleInputDecision(context(overrides));
}

function dispatch(action) {
  return { kind: "dispatch", action };
}

test("secure API-key entry never leaks a keystroke to the Agent Console", () => {
  for (const stroke of [...CONSOLE_KEYSTROKES, { label: "Alt+A", ...ALT_A }, { label: "y", value: "y", key: NO_KEY }]) {
    for (const control of ["browse", "confirm-cancel"]) {
      assert.deepEqual(
        decide({
          value: stroke.value,
          key: stroke.key,
          control,
          composerMode: "api-key-entry",
        }),
        PASS,
        `${stroke.label} must stay inside secure entry (control=${control})`,
      );
    }
  }
});

test("the slash command picker consumes its keys before the Agent Console sees them", () => {
  for (const stroke of [...CONSOLE_KEYSTROKES, { label: "Alt+A", ...ALT_A }]) {
    assert.deepEqual(
      decide({ value: stroke.value, key: stroke.key, slashPickerActive: true }),
      PASS,
      `${stroke.label} belongs to the slash picker`,
    );
  }
});

test("Alt+A toggles the console from any non-secure composer state", () => {
  assert.deepEqual(decide({ ...ALT_A, open: false }), dispatch({ kind: "open" }));
  assert.deepEqual(decide({ ...ALT_A, open: true }), dispatch({ kind: "close" }));
  // A draft in the composer must not gate the toggle — only the console's
  // navigation keys are conditioned on an empty composer.
  assert.deepEqual(
    decide({ ...ALT_A, open: false, composerEmpty: false }),
    dispatch({ kind: "open" }),
  );
  assert.deepEqual(
    decide({ ...ALT_A, open: true, composerMode: "agent-steer", composerEmpty: false }),
    dispatch({ kind: "close" }),
  );
  assert.deepEqual(
    decide({ ...ALT_A, open: true, control: "confirm-cancel" }),
    dispatch({ kind: "close" }),
  );
  // Alt+Shift+A is the same physical chord.
  assert.deepEqual(
    decide({ value: "A", key: { meta: true, shift: true }, open: false }),
    dispatch({ kind: "open" }),
  );
});

test("a plain a keystroke is ordinary typing, never the console toggle", () => {
  assert.deepEqual(decide({ value: "a", open: false }), PASS);
  assert.deepEqual(decide({ value: "a", open: true }), PASS);
  assert.deepEqual(decide({ value: "a", key: { ctrl: true }, open: false }), PASS);
  // Ink reports Escape with meta = true; it is not a meta+character chord.
  assert.deepEqual(
    decide({ value: "", key: { escape: true, meta: true } }),
    dispatch({ kind: "close" }),
  );
});

test("an open console with an empty composer owns navigation and control keys", () => {
  const cases = [
    [{ value: "j" }, { kind: "move", delta: 1 }],
    [{ value: "k" }, { kind: "move", delta: -1 }],
    [{ value: "", key: { downArrow: true } }, { kind: "move", delta: 1 }],
    [{ value: "", key: { upArrow: true } }, { kind: "move", delta: -1 }],
    [{ value: "", key: { return: true } }, { kind: "toggle-inspector" }],
    [{ value: "s" }, { kind: "begin-steer" }],
    [{ value: "x" }, { kind: "request-cancel" }],
    [{ value: "r" }, { kind: "continue" }],
    [{ value: "", key: { escape: true, meta: true } }, { kind: "close" }],
  ];
  for (const [stroke, action] of cases) {
    assert.deepEqual(
      decide(stroke),
      dispatch(action),
      `${stroke.value || JSON.stringify(stroke.key)} should resolve to ${action.kind}`,
    );
  }
});

test("Tab walks the console tabs forward and Shift+Tab walks them back", () => {
  const forward = [["agents", "jobs"], ["jobs", "plan"], ["plan", "agents"]];
  for (const [from, to] of forward) {
    assert.deepEqual(
      decide({ key: { tab: true }, tab: from }),
      dispatch({ kind: "tab", tab: to }),
    );
  }
  const backward = [["agents", "plan"], ["jobs", "agents"], ["plan", "jobs"]];
  for (const [from, to] of backward) {
    assert.deepEqual(
      decide({ key: { tab: true, shift: true }, tab: from }),
      dispatch({ kind: "tab", tab: to }),
    );
  }
});

test("a composer with a draft keeps every console key as ordinary editing", () => {
  for (const stroke of CONSOLE_KEYSTROKES) {
    assert.deepEqual(
      decide({ value: stroke.value, key: stroke.key, composerEmpty: false }),
      PASS,
      `${stroke.label} must not be stolen from a non-empty composer`,
    );
  }
});

test("a closed console owns nothing but the Alt+A toggle", () => {
  for (const stroke of CONSOLE_KEYSTROKES) {
    assert.deepEqual(
      decide({ value: stroke.value, key: stroke.key, open: false }),
      PASS,
      `${stroke.label} must stay with the shell while the console is closed`,
    );
  }
});

test("the cancel confirmation answers y, n and Esc and swallows everything else", () => {
  const confirming = { control: "confirm-cancel" };
  assert.deepEqual(
    decide({ ...confirming, value: "y" }),
    dispatch({ kind: "confirm-cancel", confirmed: true }),
  );
  assert.deepEqual(
    decide({ ...confirming, value: "n" }),
    dispatch({ kind: "confirm-cancel", confirmed: false }),
  );
  assert.deepEqual(
    decide({ ...confirming, value: "", key: { escape: true, meta: true } }),
    dispatch({ kind: "confirm-cancel", confirmed: false }),
  );
  // The question is modal. Every other key is swallowed — never dispatched,
  // never inserted, and never handed to a panel behind the console — because
  // a stray character that reached the draft would make the composer
  // non-empty and leave `y`/`n` unable to answer.
  for (const stroke of [...CONSOLE_KEYSTROKES, { label: "b", value: "b", key: NO_KEY }]) {
    if (stroke.label === "escape") continue;
    for (const composerEmpty of [true, false]) {
      assert.deepEqual(
        decide({ ...confirming, value: stroke.value, key: stroke.key, composerEmpty }),
        CONSUME,
        `${stroke.label} must be swallowed while the cancel confirmation is armed`,
      );
    }
  }
});

test("agent-steer yields printable text and submit to the Composer alone", () => {
  const steering = { composerMode: "agent-steer", composerEmpty: false };
  assert.deepEqual(
    decide({ ...steering, value: "", key: { escape: true, meta: true } }),
    dispatch({ kind: "cancel-steer" }),
  );
  // `compose` is the third outcome: the console keeps the key away from the
  // telemetry hotkeys, the Context Inspector and the Rust resolver, but the
  // Composer still turns it into steer text.
  for (const stroke of [...CONSOLE_KEYSTROKES, { label: "a", value: "a", key: NO_KEY }, { label: "c", value: "c", key: NO_KEY }]) {
    if (stroke.label === "escape") continue;
    for (const composerEmpty of [true, false]) {
      assert.deepEqual(
        decide({ ...steering, value: stroke.value, key: stroke.key, composerEmpty }),
        COMPOSE,
        `${stroke.label} belongs to the steer composer and to nothing behind it`,
      );
    }
  }
});

test("ctrl chords are never console keys", () => {
  for (const value of ["a", "j", "k", "s", "x", "r", "y", "n", "o"]) {
    for (const state of [
      {},
      { control: "confirm-cancel" },
      { composerMode: "agent-steer", composerEmpty: false },
    ]) {
      assert.deepEqual(
        decide({ ...state, value, key: { ctrl: true } }),
        PASS,
        `Ctrl+${value} belongs to the shell`,
      );
    }
    assert.deepEqual(
      decide({ value, key: { ctrl: true, meta: true }, open: false }),
      PASS,
      `Ctrl+Alt+${value} belongs to the shell`,
    );
  }
});

test("one decision drives dispatch, Composer suppression and downstream handoff", () => {
  const contexts = [];
  for (const open of [false, true]) {
    for (const control of ["browse", "confirm-cancel"]) {
      for (const composerMode of ["default", "agent-steer", "api-key-entry"]) {
        for (const composerEmpty of [false, true]) {
          for (const slashPickerActive of [false, true]) {
            for (const stroke of [...CONSOLE_KEYSTROKES, { label: "Alt+A", ...ALT_A }, { label: "y", value: "y", key: NO_KEY }, { label: "n", value: "n", key: NO_KEY }, { label: "b", value: "b", key: NO_KEY }]) {
              contexts.push(
                context({
                  value: stroke.value,
                  key: stroke.key,
                  open,
                  control,
                  composerMode,
                  composerEmpty,
                  slashPickerActive,
                }),
              );
            }
          }
        }
      }
    }
  }
  assert.ok(contexts.length > 100, "the ownership matrix should be exhaustive");
  for (const candidate of contexts) {
    const decision = resolveAgentConsoleInputDecision(candidate);
    assert.ok(
      ["dispatch", "consume", "compose", "pass"].includes(decision.kind),
      `unknown decision ${JSON.stringify(decision)} for ${JSON.stringify(candidate)}`,
    );
    assert.equal(
      decision.kind === "dispatch",
      "action" in decision,
      `only a dispatch carries an action: ${JSON.stringify(decision)}`,
    );
    const steering = candidate.composerMode === "agent-steer";
    const confirming = candidate.control === "confirm-cancel";
    // The toggle chord outranks both modal states, so it is never swallowed.
    const altA = candidate.key.meta === true
      && candidate.key.escape !== true
      && candidate.value.toLowerCase() === "a";
    const claimable = candidate.composerMode !== "api-key-entry"
      && !candidate.slashPickerActive
      && candidate.key.ctrl !== true
      && candidate.open
      && !altA
      && candidate.key.escape !== true;
    // `compose` is the steer composer's outcome and nothing else's: it is the
    // only state where the console stops the shell without owning the text.
    assert.equal(
      decision.kind === "compose",
      claimable && steering,
      `compose escaped the steer composer for ${JSON.stringify(candidate)}`,
    );
    // `consume` is the armed confirmation's outcome and nothing else's.
    assert.equal(
      decision.kind === "consume",
      claimable && !steering && confirming && !["y", "n"].includes(candidate.value.toLowerCase()),
      `consume escaped the cancel confirmation for ${JSON.stringify(candidate)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Real Ink keyboard drive — PassThrough stdin through WorkShellPane.
// ---------------------------------------------------------------------------

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
  };
}

async function waitForCondition(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function lastFrame(output) {
  const plain = stripVTControlCharacters(output);
  const start = plain.lastIndexOf("UncleCode · OpenAI");
  return start >= 0 ? plain.slice(start) : plain;
}

function consoleSnapshot() {
  return {
    profileId: "build",
    workGraph: {
      id: "goal-1",
      goal: "Ship the console",
      approval: "approved",
      nodes: [
        {
          id: "n1",
          title: "Wire keyboard",
          prompt: "RAW_PROMPT_DO_NOT_SHOW",
          status: "running",
          dependsOn: [],
          fileOwnership: [],
          acceptanceCriteria: ["observable proof"],
          evidenceRefs: [],
        },
      ],
    },
    activity: [],
    agents: [
      {
        id: "r1",
        displayName: "RuntimeMap",
        agentType: "scout",
        status: "running",
        currentActivity: "Reading runtime",
        startedAt: 1_000,
      },
      {
        id: "r2",
        displayName: "DocsMap",
        agentType: "scout",
        status: "running",
        currentActivity: "Reading docs",
        startedAt: 1_100,
      },
    ],
    jobs: [
      {
        id: "job-1",
        type: "work-node",
        label: "Map runtime",
        status: "running",
        agentRunId: "r1",
        queuedAt: 900,
        startedAt: 1_000,
      },
    ],
  };
}

/**
 * A fake engine built on the real console state reducers, so the cursor the
 * keyboard moves and the run the controls target are resolved exactly as
 * `WorkShellEngine` resolves them.
 */
function createAgentConsoleEngine(overrides = {}) {
  const calls = {
    steer: [],
    cancel: [],
    continue: [],
    submitted: [],
    inspectorCursor: [],
    inspectorExpand: 0,
  };
  let state = {
    entries: [],
    model: "gpt-5.4",
    mode: "yolo",
    reasoning: "medium",
    authLabel: "oauth-file",
    isBusy: false,
    bridgeLines: [],
    memoryLines: [],
    composerMode: "default",
    panel: { title: "Session status", lines: ["Work context ready."] },
    agentConsole: consoleSnapshot(),
    agentConsoleView: createAgentConsoleViewState(),
    ...(overrides.panel ? { panel: overrides.panel } : {}),
    ...(overrides.contextInspector
      ? { contextInspectorCursor: 0, contextSourceActionsEnabled: true }
      : {}),
  };
  const listeners = new Set();
  const setState = (patch) => {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener(state);
    }
  };
  const engine = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    initialize: async () => {},
    dispose: () => {},
    setMode: async () => {},
    openSessionsPanel: async () => {},
    handleSubmit: async (line) => {
      if (state.composerMode === "agent-steer") {
        const selection = resolveAgentConsoleSelection(state.agentConsoleView, state.agentConsole);
        calls.steer.push({
          agentRunId: selection?.tab === "agents" ? selection.run.id : undefined,
          message: line,
        });
        setState({
          composerMode: "default",
          agentConsoleView: settleAgentConsoleControl(state.agentConsoleView, {
            status: "accepted",
            message: "Steered.",
          }),
        });
        return;
      }
      calls.submitted.push(line);
    },
    cancelSensitiveInput: () => {
      if (state.composerMode !== "agent-steer") {
        return;
      }
      setState({
        composerMode: "default",
        agentConsoleView: settleAgentConsoleControl(state.agentConsoleView),
      });
    },
    openAgentConsole: (tab) => {
      setState({
        agentConsoleView: openAgentConsoleView(state.agentConsoleView, state.agentConsole, tab),
      });
    },
    closeAgentConsole: () => {
      setState({ agentConsoleView: closeAgentConsoleView(state.agentConsoleView) });
    },
    selectAgentConsoleTab: (tab) => {
      setState({
        agentConsoleView: selectAgentConsoleTab(state.agentConsoleView, state.agentConsole, tab),
      });
    },
    moveAgentConsoleCursor: (delta) => {
      setState({
        agentConsoleView: moveAgentConsoleCursor(state.agentConsoleView, state.agentConsole, delta),
      });
    },
    toggleAgentConsoleInspector: () => {
      setState({ agentConsoleView: toggleAgentConsoleInspector(state.agentConsoleView) });
    },
    beginAgentSteer: () => {
      const view = state.agentConsoleView;
      const selection = resolveAgentConsoleSelection(view, state.agentConsole);
      if (!view.open || selection?.tab !== "agents" || isSettledAgentRun(selection.run)) {
        setState({
          agentConsoleView: settleAgentConsoleControl(view, {
            status: "rejected",
            message: "Select a running agent to steer.",
          }),
        });
        return;
      }
      setState({
        composerMode: "agent-steer",
        agentConsoleView: settleAgentConsoleControl(view),
      });
    },
    requestAgentCancel: () => {
      setState({
        agentConsoleView: requestAgentConsoleCancel(state.agentConsoleView, state.agentConsole),
      });
    },
    confirmAgentCancel: async (confirm) => {
      const control = state.agentConsoleView.control;
      if (control.kind !== "confirm-cancel") {
        return;
      }
      setState({ agentConsoleView: settleAgentConsoleControl(state.agentConsoleView) });
      if (!confirm) {
        return;
      }
      calls.cancel.push(control.agentRunId);
      setState({
        agentConsoleView: settleAgentConsoleControl(state.agentConsoleView, {
          status: "accepted",
          message: "Cancelled.",
        }),
      });
    },
    continueSelectedAgent: async () => {
      const selection = resolveAgentConsoleSelection(state.agentConsoleView, state.agentConsole);
      if (selection?.tab !== "agents") {
        setState({
          agentConsoleView: settleAgentConsoleControl(state.agentConsoleView, {
            status: "rejected",
            message: "Select an agent run to continue.",
          }),
        });
        return;
      }
      calls.continue.push(selection.run.id);
      setState({
        agentConsoleView: settleAgentConsoleControl(state.agentConsoleView, {
          status: "accepted",
          message: "Continued.",
        }),
      });
    },
    ...(overrides.contextInspector
      ? {
        moveContextInspectorCursor: (direction) => {
          calls.inspectorCursor.push(direction);
        },
        toggleContextInspectorExpanded: async () => {
          calls.inspectorExpand += 1;
        },
      }
      : {}),
  };
  return { engine, calls, getState: () => state };
}

function renderConsolePane(engine, extraProps = {}) {
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
      getSuggestions: () => [],
      onExit: () => {},
      shouldBlockSlashSubmit: () => false,
      getReasoningLabel: () => "default medium",
      isReasoningSupported: () => true,
      ...extraProps,
    }),
  );
}

test("Alt+A preserves a normal composer draft byte-for-byte across the toggle", async () => {
  const { engine, calls, getState } = createAgentConsoleEngine();
  const { stdin, instance, getOutput } = renderConsolePane(engine);

  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.write("hello");
    await waitForCondition(() => /› hello/.test(lastFrame(getOutput())));
    assert.match(lastFrame(getOutput()), /› hello/, "the draft should be typed before the toggle");

    // The real terminal chord: one write of ESC followed by `a`.
    stdin.write("\u001ba");
    await waitForCondition(() => getState().agentConsoleView.open);

    assert.equal(getState().agentConsoleView.open, true, "Alt+A should open the console");
    const frame = lastFrame(getOutput());
    assert.match(frame, /▤ Agent Console/);
    assert.match(frame, /› hello/, "the draft must survive the toggle byte-for-byte");
    assert.doesNotMatch(frame, /helloa/, "Alt+A must never reach the composer as printable `a`");

    stdin.write("\u001ba");
    await waitForCondition(() => !getState().agentConsoleView.open);
    assert.equal(getState().agentConsoleView.open, false, "Alt+A should close the console again");
    assert.match(lastFrame(getOutput()), /› hello/, "closing must not edit the draft either");

    // A normal draft is the operator's chat prompt: it survives the round trip
    // intact and still submits exactly what was typed.
    stdin.write("\r");
    await waitForCondition(() => calls.submitted.length === 1);
    assert.deepEqual(calls.submitted, ["hello"], "the preserved draft is the one that submits");
    assert.deepEqual(calls.steer, [], "a normal draft is never a steer");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("an open Agent Console still lets a plain letter type into the composer", async () => {
  const { engine, getState } = createAgentConsoleEngine();
  const { stdin, instance, getOutput } = renderConsolePane(engine);

  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.write("\u001ba");
    await waitForCondition(() => getState().agentConsoleView.open);
    stdin.write("a");
    await waitForCondition(() => /› a/.test(lastFrame(getOutput())));

    assert.match(lastFrame(getOutput()), /› a/, "plain `a` is ordinary typing");
    assert.equal(getState().agentConsoleView.open, true, "typing must not close the console");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("the console keyboard drives steer, cancel and continue at the selected run", async () => {
  const { engine, calls, getState } = createAgentConsoleEngine();
  const { stdin, instance, getOutput } = renderConsolePane(engine);

  try {
    await new Promise((resolve) => setTimeout(resolve, 150));

    stdin.write("\u001ba");
    await waitForCondition(() => getState().agentConsoleView.open);
    assert.equal(getState().agentConsoleView.cursor, 0);

    stdin.write("j");
    await waitForCondition(() => getState().agentConsoleView.cursor === 1);
    assert.equal(getState().agentConsoleView.cursor, 1, "j moves the cursor down one row");
    const rosterFrame = lastFrame(getOutput());
    assert.match(rosterFrame, /› \S+ DocsMap/, "the second run should carry the cursor");
    assert.doesNotMatch(rosterFrame, /› \S+ RuntimeMap/, "the first run should lose the cursor");
    assert.doesNotMatch(rosterFrame, /› j/, "j must never reach the composer draft");

    stdin.write("s");
    await waitForCondition(() => getState().composerMode === "agent-steer");
    assert.equal(getState().composerMode, "agent-steer", "s opens the steer composer");
    assert.doesNotMatch(lastFrame(getOutput()), /› s/, "s must never reach the composer draft");

    stdin.write("focus on tests");
    await waitForCondition(() => /› focus on tests/.test(lastFrame(getOutput())));
    assert.match(
      lastFrame(getOutput()),
      /› focus on tests/,
      "steer mode hands printable text back to the composer",
    );

    stdin.write("\r");
    await waitForCondition(() => calls.steer.length === 1);
    assert.deepEqual(
      calls.steer,
      [{ agentRunId: "r2", message: "focus on tests" }],
      "steer dispatches once, at the selected run",
    );
    await waitForCondition(() => getState().composerMode === "default");

    stdin.write("x");
    await waitForCondition(() => getState().agentConsoleView.control.kind === "confirm-cancel");
    assert.deepEqual(
      getState().agentConsoleView.control,
      { kind: "confirm-cancel", agentRunId: "r2" },
      "x arms the confirmation for the selected run",
    );

    stdin.write("n");
    await waitForCondition(() => getState().agentConsoleView.control.kind === "browse");
    assert.deepEqual(calls.cancel, [], "answering n must not cancel anything");

    stdin.write("x");
    await waitForCondition(() => getState().agentConsoleView.control.kind === "confirm-cancel");
    stdin.write("y");
    await waitForCondition(() => calls.cancel.length === 1);
    assert.deepEqual(calls.cancel, ["r2"], "cancel dispatches once, at the selected run");

    stdin.write("r");
    await waitForCondition(() => calls.continue.length === 1);
    assert.deepEqual(calls.continue, ["r2"], "continue dispatches once, at the selected run");

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(calls.steer.length, 1, "no command may dispatch twice");
    assert.deepEqual(calls.cancel.length, 1, "no command may dispatch twice");
    assert.deepEqual(calls.continue.length, 1, "no command may dispatch twice");
    assert.deepEqual(calls.submitted, [], "no console keystroke may open a provider turn");
    assert.doesNotMatch(lastFrame(getOutput()), /› [jsxrny]/, "no console key reached the draft");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("Escape leaves the steer composer without closing the console", async () => {
  const { engine, calls, getState } = createAgentConsoleEngine();
  const { stdin, instance, getOutput } = renderConsolePane(engine);

  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.write("\u001ba");
    await waitForCondition(() => getState().agentConsoleView.open);
    stdin.write("s");
    await waitForCondition(() => getState().composerMode === "agent-steer");
    stdin.write("half typed");
    await waitForCondition(() => /› half typed/.test(lastFrame(getOutput())));

    stdin.write("\u001b");
    await waitForCondition(() => getState().composerMode === "default");
    assert.equal(getState().composerMode, "default", "Esc cancels the steer mode");
    assert.equal(getState().agentConsoleView.open, true, "Esc in steer mode keeps the console open");
    assert.deepEqual(calls.steer, [], "an abandoned steer never reaches the runtime");
    assert.doesNotMatch(
      lastFrame(getOutput()),
      /› half typed/,
      "the abandoned steer draft is cleared, not handed to the chat composer",
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("Tab switches console tabs and Esc closes the console", async () => {
  const { engine, getState } = createAgentConsoleEngine();
  const { stdin, instance, getOutput } = renderConsolePane(engine);

  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.write("\u001ba");
    await waitForCondition(() => getState().agentConsoleView.open);

    stdin.write("\t");
    await waitForCondition(() => getState().agentConsoleView.tab === "jobs");
    await waitForCondition(() => /\[Jobs\]/.test(lastFrame(getOutput())));
    assert.equal(getState().agentConsoleView.tab, "jobs");
    assert.match(lastFrame(getOutput()), /\[Jobs\]/);

    stdin.write("\t");
    await waitForCondition(() => getState().agentConsoleView.tab === "plan");
    assert.equal(getState().agentConsoleView.tab, "plan");

    stdin.write("\u001b");
    await waitForCondition(() => !getState().agentConsoleView.open);
    await waitForCondition(() => !/▤ Agent Console/.test(lastFrame(getOutput())));
    assert.equal(getState().agentConsoleView.open, false, "Esc closes the console");
    assert.doesNotMatch(lastFrame(getOutput()), /▤ Agent Console/);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("agent-steer keeps hidden telemetry panels from stealing the steer message", async () => {
  for (const [title, word] of [["Agent History", "agents now"], ["Cache Telemetry", "cache now"]]) {
    const { engine, calls, getState } = createAgentConsoleEngine({
      panel: { title, lines: [title] },
    });
    const { stdin, instance, getOutput } = renderConsolePane(engine);

    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      stdin.write("\u001ba");
      await waitForCondition(() => getState().agentConsoleView.open);
      stdin.write("s");
      await waitForCondition(() => getState().composerMode === "agent-steer");

      // Typed one keystroke at a time, so the panel's own single-character
      // hotkey (`a` / `c`) really is the first key of the steer message.
      let typedPrefix = "";
      for (const character of word) {
        typedPrefix += character;
        stdin.write(character);
        const visiblePrefix = typedPrefix.trimEnd();
        await waitForCondition(() => new RegExp(`› ${visiblePrefix}`).test(lastFrame(getOutput())));
      }
      await waitForCondition(() => new RegExp(`› ${word}`).test(lastFrame(getOutput())));
      assert.match(
        lastFrame(getOutput()),
        new RegExp(`› ${word}`),
        `${title} must not swallow the first steer character`,
      );

      stdin.write("\r");
      await waitForCondition(() => calls.steer.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.deepEqual(
        calls.steer,
        [{ agentRunId: "r1", message: word }],
        `${title} must not submit its slash command as the steer message`,
      );
      assert.deepEqual(calls.submitted, [], "no provider turn may open from steer text");
      assert.equal(getState().panel.title, title, "the hidden panel must not change");
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  }
});

test("agent-steer keeps a hidden Context Inspector from stealing arrows and Enter", async () => {
  const { engine, calls, getState } = createAgentConsoleEngine({
    panel: { title: "Context expanded", lines: ["Context"] },
    contextInspector: true,
  });
  const { stdin, instance } = renderConsolePane(engine);

  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.write("\u001ba");
    await waitForCondition(() => getState().agentConsoleView.open);
    stdin.write("s");
    await waitForCondition(() => getState().composerMode === "agent-steer");

    stdin.write("\u001b[B");
    stdin.write("\u001b[A");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(
      calls.inspectorCursor,
      [],
      "the inspector behind the console must not move while a steer is being typed",
    );

    // An empty steer is a real control: the engine rejects it and exits the
    // mode, so the generic submit resolver must not swallow it as a noop.
    stdin.write("\r");
    await waitForCondition(() => calls.steer.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(calls.inspectorExpand, 0, "Enter must not expand the hidden inspector");
    assert.deepEqual(calls.steer, [{ agentRunId: "r1", message: "" }]);
    assert.deepEqual(calls.submitted, []);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("the cancel confirmation stays modal until it is answered", async () => {
  const { engine, calls, getState } = createAgentConsoleEngine();
  const { stdin, instance, getOutput } = renderConsolePane(engine);

  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.write("\u001ba");
    await waitForCondition(() => getState().agentConsoleView.open);
    stdin.write("j");
    await waitForCondition(() => getState().agentConsoleView.cursor === 1);
    stdin.write("x");
    await waitForCondition(() => getState().agentConsoleView.control.kind === "confirm-cancel");

    for (const stray of ["b", "\u001b[B", "\t", "\r", "j", "s"]) {
      stdin.write(stray);
      await new Promise((resolve) => setTimeout(resolve, 90));
      assert.deepEqual(
        getState().agentConsoleView.control,
        { kind: "confirm-cancel", agentRunId: "r2" },
        `${JSON.stringify(stray)} must not settle the confirmation`,
      );
    }

    const frame = lastFrame(getOutput());
    assert.doesNotMatch(frame, /› [bjs]/, "no stray key may enter the draft");
    assert.equal(getState().agentConsoleView.cursor, 1, "the cursor must not move");
    assert.equal(getState().agentConsoleView.tab, "agents", "the tab must not change");
    assert.equal(getState().composerMode, "default", "no stray key may open the steer composer");
    assert.deepEqual(calls.submitted, [], "no stray key may open a provider turn");
    assert.deepEqual(calls.steer, [], "no stray key may reach the agent");
    assert.equal(getState().panel.title, "Session status", "the panel must not change");

    stdin.write("y");
    await waitForCondition(() => calls.cancel.length === 1);
    assert.deepEqual(calls.cancel, ["r2"], "only y, n and Esc settle the confirmation");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});


test("an Esc-cancelled steer draft never becomes a provider prompt", async () => {
  const { engine, calls, getState } = createAgentConsoleEngine();
  const { stdin, instance, getOutput } = renderConsolePane(engine);

  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.write("\u001ba");
    await waitForCondition(() => getState().agentConsoleView.open);
    stdin.write("s");
    await waitForCondition(() => getState().composerMode === "agent-steer");
    stdin.write("abandon me");
    await waitForCondition(() => /› abandon me/.test(lastFrame(getOutput())));

    stdin.write("\u001b");
    await waitForCondition(() => getState().composerMode === "default");
    stdin.write("\u001ba");
    await waitForCondition(() => !getState().agentConsoleView.open);

    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(calls.submitted, [], "the abandoned steer must not become a chat prompt");
    assert.deepEqual(calls.steer, [], "the abandoned steer must not reach the agent either");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("Alt+A out of the steer composer tears the steer draft down with the mode", async () => {
  const { engine, calls, getState } = createAgentConsoleEngine();
  const { stdin, instance, getOutput } = renderConsolePane(engine);

  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.write("\u001ba");
    await waitForCondition(() => getState().agentConsoleView.open);
    stdin.write("s");
    await waitForCondition(() => getState().composerMode === "agent-steer");
    stdin.write("never sent");
    await waitForCondition(() => /› never sent/.test(lastFrame(getOutput())));

    stdin.write("\u001ba");
    await waitForCondition(() => !getState().agentConsoleView.open);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(getState().composerMode, "default", "closing the console leaves the steer mode");
    assert.doesNotMatch(
      lastFrame(getOutput()),
      /› never sent/,
      "a steer draft is a message to an agent, never a leftover chat prompt",
    );

    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(calls.submitted, []);
    assert.deepEqual(calls.steer, []);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("an empty steer with a pending attachment stays empty and keeps the attachment queued", async () => {
  const { engine, calls, getState } = createAgentConsoleEngine();
  let captureCalls = 0;
  const { stdin, instance, getOutput } = renderConsolePane(engine, {
    captureClipboardImage: () => {
      captureCalls += 1;
      return { status: "ok", attachment: CLIPBOARD_PNG };
    },
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.write("\u0016");
    await waitForCondition(() => captureCalls === 1 && getOutput().includes("[1/5]"));

    stdin.write("\u001ba");
    await waitForCondition(() => getState().agentConsoleView.open);
    stdin.write("s");
    await waitForCondition(() => getState().composerMode === "agent-steer");

    stdin.write("\r");
    await waitForCondition(() => calls.steer.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The control mailbox carries no attachments, so the pane's
    // attachment-only rewrite must never speak for the operator here.
    assert.deepEqual(
      calls.steer,
      [{ agentRunId: "r1", message: "" }],
      "the selected run receives the empty line, not a synthetic inspection prompt",
    );
    assert.notEqual(calls.steer[0].message, resolveAttachmentOnlyInspectionPrompt(1));
    assert.deepEqual(calls.submitted, [], "no provider turn may open");
    assert.equal(getState().composerMode, "default", "the empty steer still exits the mode");

    // The attachment is untouched and still belongs to the next normal turn.
    stdin.write("\u001ba");
    await waitForCondition(
      () => !getState().agentConsoleView.open && !/▤ Agent Console/.test(lastFrame(getOutput())),
    );
    assert.match(lastFrame(getOutput()), /\[1\/5\]/, "the attachment badge survives the steer");
    assert.equal(getState().composerMode, "default", "normal turn starts outside steer mode");

    stdin.write("\r");
    await waitForCondition(() => calls.submitted.length === 1);
    assert.deepEqual(
      calls.submitted,
      [resolveAttachmentOnlyInspectionPrompt(1)],
      "the queued attachment is still there for the next normal turn",
    );
    assert.equal(calls.steer.length, 1, "the steer never dispatched twice");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Decision cache — one decision per physical key event, never one per chunk.
// ---------------------------------------------------------------------------

test("two Shift+Tab chords in one terminal chunk walk two tabs, not the same one twice", async () => {
  const { engine, getState } = createAgentConsoleEngine();
  const { stdin, instance, getOutput } = renderConsolePane(engine);

  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.write("\u001ba");
    await waitForCondition(() => getState().agentConsoleView.open);
    assert.equal(getState().agentConsoleView.tab, "agents");

    // Ink splits one readable chunk into two CSI key events and delivers both
    // inside the same synchronous pass, so no microtask separates them. The
    // Composer short-circuits `Tab` before it ever consults the console, so
    // the first event's decision is cached and never read — and the second
    // event must still decide against the tab the first one selected.
    stdin.write("\u001b[Z\u001b[Z");
    await waitForCondition(() => getState().agentConsoleView.tab === "jobs", 1500);

    assert.equal(
      getState().agentConsoleView.tab,
      "jobs",
      "agents → plan → jobs: the second chord must not replay the first decision",
    );
    assert.equal(getState().agentConsoleView.open, true, "neither chord may close the console");
    assert.match(lastFrame(getOutput()), /\[Jobs\]/, "the rendered console agrees with the state");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

/**
 * Drives the pane controller's console seam directly, so the two handler
 * phases of one keystroke can be separated by a console transition the way
 * Ink separates two key events inside a single terminal chunk.
 */
function AgentConsoleKeyboardProbe({ engine, onController }) {
  const controller = useWorkShellPaneState({
    engine,
    cwd: "/tmp/unclecode-test-workspace",
    resolveComposerInput: async (value) => ({
      prompt: value,
      attachments: [],
      transcriptText: value,
    }),
    getSuggestions: () => [],
    onExit: () => {},
    shouldBlockSlashSubmit: () => false,
  });
  onController(controller);
  return null;
}

test("a cached console decision never outlives the console it was taken against", async () => {
  const { engine, calls, getState } = createAgentConsoleEngine();
  let controller;
  const { instance } = renderWithInput(
    React.createElement(AgentConsoleKeyboardProbe, {
      engine,
      onController: (value) => {
        controller = value;
      },
    }),
  );

  try {
    await waitForCondition(() => controller?.suppressAgentConsoleKey !== undefined);
    engine.openAgentConsole("agents");
    engine.requestAgentCancel();
    assert.deepEqual(
      getState().agentConsoleView.control,
      { kind: "confirm-cancel", agentRunId: "r1" },
      "the confirmation has to be armed for the first phase to own n",
    );
    // Deliberately the callback from the render before the arm: the Composer
    // holds exactly that, and it has to read the live console anyway.
    const suppress = controller.suppressAgentConsoleKey;

    // No `await` from here on: everything below is one synchronous pass, the
    // window in which a cached decision is still live.
    const armed = suppress("n", NO_KEY, true);
    engine.closeAgentConsole();
    engine.openAgentConsole("agents");
    const reopened = suppress("n", NO_KEY, true);

    assert.equal(armed, true, "the armed confirmation owns n");
    assert.equal(getState().agentConsoleView.open, true, "the console is open again");
    assert.equal(getState().agentConsoleView.control.kind, "browse", "the reopened console asks nothing");
    assert.equal(
      getState().composerMode,
      "default",
      "composer mode never moved, so mode equality is all a stale key could match on",
    );
    assert.equal(
      reopened,
      false,
      "a reopened console has no question pending, so n is ordinary typing again",
    );
    assert.deepEqual(calls.cancel, [], "no phase may cancel a run on its own");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});
