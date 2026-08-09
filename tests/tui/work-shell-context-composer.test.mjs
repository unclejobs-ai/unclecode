import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { render, Text } from "ink";
import React from "react";

import {
  getWorkShellSlashSuggestions,
  shouldBlockSlashSubmit,
} from "../../packages/orchestrator/src/index.ts";
import { WorkShellPane } from "../../packages/tui/src/work-shell-pane.tsx";
import {
  resolveWorkShellComposerAdditionalRows,
  WorkShellView,
} from "../../packages/tui/src/work-shell-view.tsx";

process.env.UNCLECODE_TERMINAL_BACKGROUND = "light";

const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;
const PROMPT_GLYPH = "\u203a";

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

function createWritableOutput(columns, rows) {
  const output = new PassThrough();
  output.columns = columns;
  output.rows = rows;
  output.isTTY = true;
  return output;
}

function createWritableError(columns, rows) {
  const error = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  error.columns = columns;
  error.rows = rows;
  error.isTTY = true;
  return error;
}

/**
 * Ink in debug mode writes one complete frame per render, so the newest chunk
 * is the current screen. Accumulated output would still hold the frames from
 * before the keystrokes and would happily "prove" a composer that has since
 * been dropped from the tree.
 */
function renderFrames(element, options = {}) {
  const columns = options.columns ?? 120;
  const rows = options.rows ?? 40;
  const stdin = createInkInput();
  const stdout = createWritableOutput(columns, rows);
  let frame = "";
  stdout.on("data", (chunk) => {
    frame = chunk.toString().replace(ANSI, "");
  });
  const instance = render(element, {
    stdin,
    stdout,
    stderr: createWritableError(columns, rows),
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return { stdin, instance, getFrame: () => frame };
}

async function waitForCondition(predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function typeKeys(stdin, keys) {
  stdin.write(keys.join(""));
  await new Promise((resolve) => setTimeout(resolve, 100));
}

/** The prompt deck's composer row: the glyph followed by the live draft. */
function composerLine(frame) {
  const lines = frame
    .split("\n")
    .filter((line) => line.trimStart().startsWith(PROMPT_GLYPH));
  return lines.length === 0 ? undefined : lines[lines.length - 1].trim();
}

function sourceItem(overrides) {
  return {
    category: "workspace",
    reason: "workspace guidance",
    preview: "Workspace instructions stay active.",
    tokenEstimate: 8,
    salience: 0.5,
    includedInModel: true,
    ...overrides,
  };
}

function packet(overrides = {}) {
  const included = [
    sourceItem({ id: "workspace-1", label: "AGENTS.md", salience: 1 }),
    sourceItem({ id: "bridge-1", category: "bridge", label: "recent Q&A", reason: "session bridge" }),
  ];
  return {
    id: "packet-desk",
    version: 1,
    generatedAt: "2026-08-09T00:00:00.000Z",
    title: "Next answer context",
    included,
    excluded: [
      sourceItem({
        id: "loop-1",
        category: "loop-trail",
        label: "session ledger",
        reason: "raw trail stays local",
        includedInModel: false,
      }),
    ],
    warnings: [],
    preview: [],
    sourceCounts: { included: included.length, excluded: 1, warnings: 0 },
    tokenEstimate: 24,
    tokenEstimateState: "estimated",
    ...overrides,
  };
}

const ADVICE = {
  id: "advice-1",
  packetReceiptId: "receipt-1",
  sourceId: "workspace-1",
  action: "summarize",
  reasonCode: "large-source",
  reasonText: "Summarize the workspace guide to save tokens.",
  status: "proposed",
  createdAt: "2026-08-09T00:00:00.000Z",
};

const UNDOABLE_RECEIPT = {
  id: "action-1",
  action: "pin",
  sourceId: "workspace-1",
  sourceLabel: "AGENTS.md",
  message: "Pinned AGENTS.md.",
  canUndo: true,
  succeeded: true,
};

function createContextDeskEngine(stateOverrides = {}) {
  const calls = [];
  const state = {
    entries: [],
    model: "gpt-5.4",
    mode: "yolo",
    reasoning: "medium",
    authLabel: "oauth-file",
    isBusy: false,
    bridgeLines: [],
    memoryLines: [],
    panel: { title: "Context expanded", lines: [] },
    contextPacket: packet(),
    contextInspectorCursor: 0,
    contextSourceActionsEnabled: true,
    contextAdviceActionsEnabled: true,
    contextPolicySuggestions: [ADVICE],
    contextActionReceipt: UNDOABLE_RECEIPT,
    modelWindow: 200_000,
    ...stateOverrides,
  };

  return {
    calls,
    engine: {
      getState: () => state,
      subscribe: () => () => {},
      initialize: async () => {},
      dispose: () => {},
      handleSubmit: async (line) => {
        calls.push(`submit:${line}`);
      },
      setMode: async () => {},
      openSessionsPanel: async () => {},
      moveContextInspectorCursor: (direction) => {
        calls.push(`move:${direction}`);
      },
      moveContextInspectorDetailOffset: (direction) => {
        calls.push(`scroll:${direction}`);
      },
      toggleContextInspectorPin: async () => {
        calls.push("pin");
      },
      forgetContextSourceAtCursor: async () => {
        calls.push("hold-back");
      },
      includeContextSourceAtCursor: async () => {
        calls.push("include");
      },
      toggleContextInspectorExpanded: async () => {
        calls.push("expand");
      },
      undoLastContextSourceAction: async () => {
        calls.push("undo");
      },
      acceptContextSuggestion: async (id) => {
        calls.push(`accept:${id}`);
      },
      rejectContextSuggestion: async (id) => {
        calls.push(`reject:${id}`);
      },
    },
  };
}

function paneProps(engine) {
  return {
    provider: "OpenAI",
    model: "gpt-5.4",
    mode: "yolo",
    engine,
    cwd: "/tmp/unclecode-context-desk",
    resolveComposerInput: async (value) => ({
      prompt: value,
      attachments: [],
      transcriptText: value,
    }),
    getSuggestions: (value) =>
      getWorkShellSlashSuggestions(value, { provider: "openai", currentModel: "gpt-5.4" }),
    onExit: () => {},
    shouldBlockSlashSubmit: (line) =>
      shouldBlockSlashSubmit(line, { provider: "openai", currentModel: "gpt-5.4" }),
    getReasoningLabel: () => "default medium",
    isReasoningSupported: () => true,
  };
}

test("Context Desk keeps the composer dock mounted and the draft visible", async () => {
  const { engine } = createContextDeskEngine();
  const { stdin, instance, getFrame } = renderFrames(
    React.createElement(WorkShellPane, paneProps(engine)),
  );

  try {
    await waitForCondition(() => getFrame().includes("UncleCode Context Desk"), "the Context Desk");

    const idle = getFrame();
    assert.match(idle, /prompt deck/, "the composer dock divider must survive the desk overlay");
    assert.match(
      idle,
      /Enter send · Shift\+Enter newline/,
      "the desk reuses the shell's own composer dock, hint and all",
    );
    assert.equal(composerLine(idle), PROMPT_GLYPH, "an untouched desk starts with an empty draft");

    await typeKeys(stdin, [..."note"]);
    await waitForCondition(
      () => composerLine(getFrame()) === `${PROMPT_GLYPH} note`,
      "the typed draft to reach the composer row",
    );

    const drafting = getFrame();
    assert.match(drafting, /UncleCode Context Desk/, "the desk stays open while the user drafts");
    assert.match(drafting, /prompt deck/);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("context source, advice, and undo keys act only on an empty composer", async () => {
  const { engine, calls } = createContextDeskEngine();
  const { stdin, instance, getFrame } = renderFrames(
    React.createElement(WorkShellPane, paneProps(engine)),
  );

  try {
    await waitForCondition(() => getFrame().includes("UncleCode Context Desk"), "the Context Desk");

    // Empty composer: the desk owns the action keys and they never become text.
    stdin.write("p");
    await waitForCondition(() => calls.includes("pin"), "the pin action");
    stdin.write(" ");
    await waitForCondition(() => calls.includes("hold-back"), "the send/hold action");
    stdin.write("a");
    await waitForCondition(() => calls.includes("accept:advice-1"), "the advice accept action");
    stdin.write("u");
    await waitForCondition(() => calls.includes("undo"), "the undo action");
    assert.equal(
      composerLine(getFrame()),
      PROMPT_GLYPH,
      "desk action keys must not leak into the draft",
    );

    // Non-empty composer: the same keys are ordinary text and the desk is inert.
    await typeKeys(stdin, [..."note"]);
    await waitForCondition(
      () => composerLine(getFrame()) === `${PROMPT_GLYPH} note`,
      "the typed draft to reach the composer row",
    );
    const callsWhenDraftStarted = [...calls];

    await typeKeys(stdin, [" ", "p", "a", "r", "u"]);
    await waitForCondition(
      () => composerLine(getFrame()) === `${PROMPT_GLYPH} note paru`,
      "the action letters to land in the draft",
    );

    assert.deepEqual(
      calls,
      callsWhenDraftStarted,
      "no context mutation, advice, or undo callback may fire while a draft is pending",
    );
    assert.match(getFrame(), /UncleCode Context Desk/, "the desk stays open while the user drafts");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

function crowdedDeskPacket() {
  const included = Array.from({ length: 36 }, (_, index) =>
    sourceItem({
      id: `src-included-${index}`,
      label: `source ${index}`,
      preview: `preview body for source ${index}`,
    }),
  );
  const excluded = Array.from({ length: 8 }, (_, index) =>
    sourceItem({
      id: `src-held-${index}`,
      label: `held source ${index}`,
      reason: "held fixture",
      includedInModel: false,
    }),
  );
  return packet({
    included,
    excluded,
    sourceCounts: { included: included.length, excluded: excluded.length, warnings: 0 },
    tokenEstimate: 320,
  });
}

function deskViewProps(overrides = {}) {
  return {
    provider: "openai",
    model: "gpt-5.4",
    reasoningLabel: "medium",
    reasoningSupported: true,
    mode: "Default",
    authLabel: "Saved OAuth",
    entries: [],
    isBusy: false,
    activePanel: { title: "Context expanded", lines: [] },
    composer: React.createElement(Text, null, "budget check"),
    inputValue: "budget check",
    slashSuggestionCount: 0,
    terminalColumns: 52,
    terminalRows: 40,
    cwd: "/tmp/unclecode-context-desk",
    contextSourceActionsEnabled: true,
    contextInspectorCursor: 0,
    contextPacket: crowdedDeskPacket(),
    ...overrides,
  };
}

test("Context Desk and composer dock both fit a 52x40 terminal", async () => {
  const { instance, getFrame } = renderFrames(
    React.createElement(WorkShellView, deskViewProps()),
    { columns: 52, rows: 40 },
  );

  try {
    await waitForCondition(() => getFrame().includes("UncleCode Context Desk"), "the Context Desk");

    const frame = getFrame();
    assert.match(frame, /prompt deck/, "the desk must not claim the whole frame");
    assert.equal(composerLine(frame), `${PROMPT_GLYPH} budget check`);
    assert.ok(
      frame.split("\n").length <= 40,
      `desk plus composer must fit 40 rows, got ${frame.split("\n").length}`,
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("Context Desk yields rows to a wrapped multiline composer", async () => {
  const draft = [
    "first line keeps the active request visible while reviewing context",
    "second line is intentionally long enough to wrap again in a narrow terminal",
  ].join("\n");
  assert.ok(
    resolveWorkShellComposerAdditionalRows({
      inputValue: draft,
      terminalColumns: 52,
    }) >= 3,
    "the row budget must count explicit newlines and narrow-width wrapping",
  );
  const nearlyFullLine = "x".repeat(44);
  assert.equal(
    resolveWorkShellComposerAdditionalRows({
      inputValue: nearlyFullLine,
      terminalColumns: 52,
    }),
    0,
  );
  assert.equal(
    resolveWorkShellComposerAdditionalRows({
      inputValue: nearlyFullLine,
      terminalColumns: 52,
      attachmentCount: 5,
    }),
    1,
    "an attachment badge that wraps must yield another row to the composer",
  );
  const { instance, getFrame } = renderFrames(
    React.createElement(
      WorkShellView,
      deskViewProps({
        composer: React.createElement(Text, null, `${PROMPT_GLYPH} ${draft}`),
        inputValue: draft,
      }),
    ),
    { columns: 52, rows: 40 },
  );

  try {
    await waitForCondition(() => getFrame().includes("UncleCode Context Desk"), "the Context Desk");
    const frame = getFrame();
    assert.match(frame, /first line keeps the active request/);
    assert.match(frame, /Preview · source 0/);
    assert.ok(
      frame.split("\n").length <= 40,
      `wrapped draft plus Context Desk must fit 40 rows, got ${frame.split("\n").length}`,
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

/**
 * The dock stays first in reading order, while the shared terminal-row budget
 * keeps the full desk bounded. This preserves the active draft without relying
 * on clipping the desk's proof or controls.
 */
test("the composer dock is drawn above the Context Desk on a crowded 52x40 frame", async () => {
  const suggestions = Array.from({ length: 6 }, (_, index) => ({
    ...ADVICE,
    id: `advice-${index}`,
    sourceId: `src-included-${index}`,
    reasonText: `Summarize source ${index} to save tokens.`,
  }));
  const { instance, getFrame } = renderFrames(
    React.createElement(
      WorkShellView,
      deskViewProps({
        contextPolicySuggestions: suggestions,
        contextAdviceActionsEnabled: true,
      }),
    ),
    { columns: 52, rows: 40 },
  );

  try {
    await waitForCondition(() => getFrame().includes("UncleCode Context Desk"), "the Context Desk");

    const frame = getFrame();
    assert.equal(composerLine(frame), `${PROMPT_GLYPH} budget check`);
    const dockAt = frame.indexOf("prompt deck");
    const deskAt = frame.indexOf("UncleCode Context Desk");
    assert.ok(dockAt >= 0, "the composer dock must survive an advice-heavy desk");
    assert.ok(
      dockAt < deskAt,
      "the composer dock must render before the desk so desk overflow never hides the draft",
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});
