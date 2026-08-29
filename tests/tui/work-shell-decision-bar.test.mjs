import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { render } from "ink";
import React from "react";

import { WorkShellPane } from "../../packages/tui/src/index.tsx";
import { formatWorkShellDecisionKindLabel } from "../../packages/tui/src/work-shell-view.tsx";
import {
  getWorkShellSlashSuggestions,
  shouldBlockSlashSubmit,
} from "../../packages/orchestrator/src/index.ts";

test("decision discriminant names security approval and user choice separately", () => {
  assert.equal(formatWorkShellDecisionKindLabel("security-approval"), "Security approval");
  assert.equal(formatWorkShellDecisionKindLabel("user-decision"), "User decision");
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
    instance,
    getOutput: () => output,
  };
}

async function waitForCondition(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function getLastWorkFrame(output) {
  const finalFrameStart = output.lastIndexOf("UncleCode · OpenAI");
  return finalFrameStart >= 0 ? output.slice(finalFrameStart) : output;
}

const SINGLE_QUESTION_DECISION = {
  kind: "user-decision",
  id: "decision-bar-1",
  title: "Execution choice",
  questions: [{
    id: "strategy",
    question: "Choose execution strategy.",
    options: [{ label: "Safe" }, { label: "Fast" }],
    recommended: 0,
  }],
};

const MULTI_QUESTION_DECISION = {
  kind: "user-decision",
  id: "decision-bar-2",
  title: "Scope",
  questions: [
    {
      id: "depth",
      question: "How deep?",
      options: [{ label: "Shallow" }, { label: "Deep" }],
    },
    {
      id: "breadth",
      question: "How wide?",
      options: [{ label: "Narrow" }, { label: "Wide" }],
    },
  ],
};

// The passive "Decision" panel the engine publishes alongside the pending
// request; without suppression its option lines would repeat the bar's.
const DECISION_PANEL_LINES = [
  "Execution choice",
  "Question · strategy: Choose execution strategy.",
  "1. Safe (recommended)",
  "2. Fast",
  "Reply with an option number or label · /cancel cancels",
];

function createDecisionPaneEngine(decision, overrides = {}) {
  const answeredIndexes = [];
  const answeredDecisionIds = [];
  const cancelCalls = [];
  let state = {
    entries: [{ role: "user", text: "run the migration" }],
    model: "gpt-5.4",
    mode: "yolo",
    reasoning: "medium",
    authLabel: "oauth-file",
    // A pending decision only exists mid-turn, so the realistic fake state
    // is busy with the request parked on the console snapshot.
    isBusy: true,
    bridgeLines: [],
    memoryLines: [],
    panel: {
      title: "Decision",
      lines: decision === SINGLE_QUESTION_DECISION ? DECISION_PANEL_LINES : [],
    },
    agentConsole: {
      profileId: "build",
      pendingDecision: decision,
      activity: [],
      agents: [],
      jobs: [],
    },
    ...overrides,
  };
  const listeners = new Set();

  return {
    answeredIndexes,
    answeredDecisionIds,
    cancelCalls,
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
      handleSubmit: async () => {},
      setMode: async () => {},
      openSessionsPanel: async () => {},
      answerPendingDecisionByIndex: (index, decisionId) => {
        answeredIndexes.push(index);
        answeredDecisionIds.push(decisionId);
        return true;
      },
      cancelPendingDecision: () => {
        cancelCalls.push(true);
        return true;
      },
    },
  };
}

function renderWorkShellPane(engine) {
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

test("a pending single-question decision renders the interactive bar above the composer", async () => {
  const { engine } = createDecisionPaneEngine(SINGLE_QUESTION_DECISION);
  const { instance, getOutput } = renderWorkShellPane(engine);

  try {
    await waitForCondition(() =>
      getLastWorkFrame(getOutput()).includes("Execution choice")
    );
    const frame = getLastWorkFrame(getOutput());

    // Header, numbered options with the recommended marker, and the key hint.
    assert.match(frame, /◆ User decision · Execution choice/);
    assert.match(frame, /1\. Safe \(recommended\)/);
    assert.match(frame, /2\. Fast/);
    assert.match(frame, /1-2 answer · Esc cancel · or type/);
    // The composer hint swaps its busy Esc meaning for the decision's.
    assert.match(frame, /1-2 answer · Esc cancels decision · or type/);
    assert.doesNotMatch(frame, /Enter queues follow-up · Ctrl\+C\/Esc interrupt/);

    // The passive "Decision" panel is suppressed for this frame, so every
    // option label appears exactly once — no double render under the bar.
    for (const label of ["Safe", "Fast"]) {
      const occurrences = frame.split(label).length - 1;
      assert.equal(
        occurrences,
        1,
        `"${label}" must appear exactly once in the frame (found ${occurrences})`,
      );
    }
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("a pending multi-question decision renders one pointer line", async () => {
  const { engine } = createDecisionPaneEngine(MULTI_QUESTION_DECISION);
  const { instance, getOutput } = renderWorkShellPane(engine);

  try {
    await waitForCondition(() =>
      getLastWorkFrame(getOutput()).includes("◆ Scope")
    );
    const frame = getLastWorkFrame(getOutput());

    assert.match(frame, /◆ User decision · Scope · 2 questions · type answers · \/cancel/);
    assert.match(frame, /type answers · Esc cancels decision · \/cancel/);
    // No one-key options are advertised for a multi-question decision.
    assert.doesNotMatch(frame, /1\. Shallow/);
    assert.doesNotMatch(frame, /answer · Esc cancel · or type/);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("pressing 1 answers the pending decision without typing into the draft", async () => {
  const { engine, answeredIndexes, answeredDecisionIds, cancelCalls } = createDecisionPaneEngine(
    SINGLE_QUESTION_DECISION,
  );
  const { stdin, instance, getOutput } = renderWorkShellPane(engine);

  try {
    await waitForCondition(() =>
      getLastWorkFrame(getOutput()).includes("◆ Execution choice")
    );
    stdin.write("1");
    await waitForCondition(() => answeredIndexes.length === 1);

    assert.deepEqual(answeredIndexes, [1]);
    assert.deepEqual(answeredDecisionIds, ["decision-bar-1"]);
    assert.deepEqual(cancelCalls, []);
    // The digit was consumed as the reply, not typed as draft text.
    assert.doesNotMatch(getLastWorkFrame(getOutput()), /› 1/);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("pressing Esc cancels the pending decision", async () => {
  const { engine, answeredIndexes, cancelCalls } = createDecisionPaneEngine(
    SINGLE_QUESTION_DECISION,
  );
  const { stdin, instance, getOutput } = renderWorkShellPane(engine);

  try {
    await waitForCondition(() =>
      getLastWorkFrame(getOutput()).includes("◆ Execution choice")
    );
    stdin.write("\u001b");
    await waitForCondition(() => cancelCalls.length === 1);

    assert.deepEqual(cancelCalls, [true]);
    assert.deepEqual(answeredIndexes, []);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("a multi-question decision keeps digits as draft input while Esc still cancels", async () => {
  const { engine, answeredIndexes, cancelCalls } = createDecisionPaneEngine(
    MULTI_QUESTION_DECISION,
  );
  const { stdin, instance, getOutput } = renderWorkShellPane(engine);

  try {
    await waitForCondition(() =>
      getLastWorkFrame(getOutput()).includes("◆ Scope")
    );

    // Esc first, while the draft is still empty: cancel works for a
    // multi-question decision exactly as it does for a single question.
    stdin.write("\u001b");
    await waitForCondition(() => cancelCalls.length === 1);
    assert.deepEqual(cancelCalls, [true]);
    assert.deepEqual(answeredIndexes, []);

    // The fake engine keeps the request pending, so the digit below still
    // faces a live multi-question decision. There is no one-key range for
    // it, so `1` must type into the draft — never swallowed, never answered.
    stdin.write("1");
    await waitForCondition(() => /› 1/.test(getLastWorkFrame(getOutput())));

    assert.match(getLastWorkFrame(getOutput()), /› 1/);
    assert.deepEqual(answeredIndexes, []);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("a rejected typed reply surfaces the engine's Input needed feedback inside the bar", async () => {
  // What the engine publishes after a garbage reply: the decision lines plus
  // the `Input needed · …` rejection message on the passive panel.
  const { engine } = createDecisionPaneEngine(SINGLE_QUESTION_DECISION, {
    panel: {
      title: "Decision",
      lines: [
        ...DECISION_PANEL_LINES,
        "Input needed · Choose an option for strategy.",
      ],
    },
  });
  const { instance, getOutput } = renderWorkShellPane(engine);

  try {
    await waitForCondition(() =>
      getLastWorkFrame(getOutput()).includes("Input needed · Choose an option for strategy.")
    );
    const frame = getLastWorkFrame(getOutput());

    // The warning rides below the bar's options/hint instead of being lost
    // with the suppressed panel.
    assert.match(frame, /Input needed · Choose an option for strategy\./);
    assert.match(frame, /1\. Safe \(recommended\)/);
    // The passive "Decision" panel stays suppressed: its option labels and
    // the feedback line each appear exactly once — no double render.
    for (const needle of ["Safe", "Fast", "Input needed"]) {
      const occurrences = frame.split(needle).length - 1;
      assert.equal(
        occurrences,
        1,
        `"${needle}" must appear exactly once in the frame (found ${occurrences})`,
      );
    }
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("a digit beyond the rendered options stays ordinary draft input", async () => {
  const { engine, answeredIndexes } = createDecisionPaneEngine(
    SINGLE_QUESTION_DECISION,
  );
  const { stdin, instance, getOutput } = renderWorkShellPane(engine);

  try {
    await waitForCondition(() =>
      getLastWorkFrame(getOutput()).includes("◆ Execution choice")
    );
    stdin.write("7");
    await waitForCondition(() => /› 7/.test(getLastWorkFrame(getOutput())));

    // Only options 1-2 exist, so `7` is not a one-key reply: it must type
    // into the draft rather than be swallowed with no action.
    assert.deepEqual(answeredIndexes, []);
    assert.match(getLastWorkFrame(getOutput()), /› 7/);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});
