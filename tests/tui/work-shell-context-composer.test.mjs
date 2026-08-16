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
  WORK_SHELL_COMPOSER_PLACEHOLDER,
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

/** The composer dock's composer row: the glyph followed by the live draft. */
function composerLine(frame) {
  const lines = frame
    .split("\n")
    .filter((line) => line.trimStart().startsWith(PROMPT_GLYPH));
  return lines.length === 0 ? undefined : lines[lines.length - 1].trim();
}

/**
 * The dock divider is an unlabeled soft rule — a full row of `─` directly
 * above the composer's `›` row. Desk rows carry the desk border's `│` on the
 * left, so the rule-above-a-glyph-row pair is the dock's own even while the
 * desk paints selected rows with the same glyph.
 */
function dockDividerIndex(rows) {
  return rows.findIndex(
    (row, index) =>
      /^─+$/.test(row.trim())
      && (rows[index + 1] ?? "").trimStart().startsWith(PROMPT_GLYPH),
  );
}

/** The composer dock's hint row: the line directly above the dock divider. */
function composerHintLine(frame) {
  const rows = frame.split("\n");
  const dividerIndex = dockDividerIndex(rows);
  if (dividerIndex <= 0) return undefined;
  const hint = rows[dividerIndex - 1].trim();
  return hint.length === 0 ? undefined : hint;
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
      moveContextInspectorPane: (direction) => {
        calls.push(`pane:${direction}`);
      },
      moveContextInspectorPage: (direction) => {
        calls.push(`page:${direction}`);
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
    await waitForCondition(() => getFrame().includes("Context Desk ·"), "the Context Desk");

    const idle = getFrame();
    assert.ok(
      dockDividerIndex(idle.split("\n")) >= 0,
      "the composer dock divider must survive the desk overlay",
    );
    // An empty composer belongs to the desk: h/j/k/l walk it and Enter opens
    // the selected source, so the dock must name the desk rather than promise
    // a send it will not perform.
    assert.equal(
      composerHintLine(idle),
      "Context Desk · h/j/k/l move · Enter details · Esc close · type to draft",
      "the desk owns the empty composer, so the dock hint names the desk keys",
    );
    assert.equal(
      composerLine(idle),
      `${PROMPT_GLYPH} ${WORK_SHELL_COMPOSER_PLACEHOLDER}`,
      "an untouched desk starts with an empty draft",
    );

    await typeKeys(stdin, [..."note"]);
    await waitForCondition(
      () => composerLine(getFrame()) === `${PROMPT_GLYPH} note`,
      "the typed draft to reach the composer row",
    );

    const drafting = getFrame();
    assert.match(drafting, /Context Desk ·/, "the desk stays open while the user drafts");
    assert.ok(dockDividerIndex(drafting.split("\n")) >= 0);
    assert.equal(
      composerHintLine(drafting),
      "Enter send · Shift+Enter newline · Ctrl+V image",
      "a draft takes the keys back, and with them the shell's own composer help",
    );
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
    await waitForCondition(() => getFrame().includes("Context Desk ·"), "the Context Desk");

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
      `${PROMPT_GLYPH} ${WORK_SHELL_COMPOSER_PLACEHOLDER}`,
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
    assert.match(getFrame(), /Context Desk ·/, "the desk stays open while the user drafts");
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
    await waitForCondition(() => getFrame().includes("Context Desk ·"), "the Context Desk");

    const frame = getFrame();
    assert.ok(
      dockDividerIndex(frame.split("\n")) >= 0,
      "the desk must not claim the whole frame",
    );
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
    await waitForCondition(() => getFrame().includes("Context Desk ·"), "the Context Desk");
    const frame = getFrame();
    assert.match(frame, /first line keeps the active request/);
    assert.match(frame, /Selected · source 0/);
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
    await waitForCondition(() => getFrame().includes("Context Desk ·"), "the Context Desk");

    const frame = getFrame();
    assert.equal(composerLine(frame), `${PROMPT_GLYPH} budget check`);
    const rows = frame.split("\n");
    const dockAt = dockDividerIndex(rows);
    const deskAt = rows.findIndex((row) => row.includes("Context Desk ·"));
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

/**
 * Pure Yazi cursor identity. The desk cursor is an offset into the ACTIVE
 * COLLECTION's filtered rows — the very list the Sources pane drew — so every
 * keyboard action has to resolve its row through the same filter. Resolving
 * the unfiltered row that happens to sit at the same numeric offset quietly
 * acts on a different source than the one under the highlight.
 *
 * Canonical desk order for the fixture packet is workspace-1 (sent, guidance),
 * bridge-1 (sent, conversation), loop-1 (held, tools). Offset 0 therefore means
 * a different source in every collection, which is what these tests pin.
 */
function renderContextDesk(stateOverrides) {
  const { engine, calls } = createContextDeskEngine({
    contextInspectorOpen: true,
    contextInspectorPane: "sources",
    contextInspectorCursor: 0,
    ...stateOverrides,
  });
  const frames = renderFrames(React.createElement(WorkShellPane, paneProps(engine)));
  return { calls, ...frames };
}

test("Space on the held collection delivers the held row the cursor stands on", async () => {
  // Cursor 0 of `held` is loop-1, the only held source. Its delivery toggle is
  // "include"; unfiltered offset 0 is workspace-1, whose toggle is "hold back".
  const { calls, stdin, instance, getFrame } = renderContextDesk({
    contextInspectorCollection: "held",
  });

  try {
    await waitForCondition(() => getFrame().includes("Context Desk ·"), "the Context Desk");

    stdin.write(" ");
    await waitForCondition(() => calls.length > 0, "the delivery key to reach the engine");

    assert.deepEqual(
      calls,
      ["include"],
      "Space must re-include the selected held row, not hold back the unfiltered row at the same offset",
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

for (const { key, verb } of [
  { key: "a", verb: "accept" },
  { key: "r", verb: "reject" },
]) {
  test(`\`${key}\` on the conversation collection ${verb}s the advice for the selected conversation row`, async () => {
    // Two proposed suggestions with distinct ids, one per group. Cursor 0 of
    // `conversation` is bridge-1, so only the conversation advice is targetable;
    // unfiltered offset 0 is workspace-1, which points at the guidance advice.
    const { calls, stdin, instance, getFrame } = renderContextDesk({
      contextInspectorCollection: "conversation",
      contextPolicySuggestions: [
        { ...ADVICE, id: "advice-guidance", sourceId: "workspace-1" },
        {
          ...ADVICE,
          id: "advice-conversation",
          sourceId: "bridge-1",
          reasonText: "Summarize the recent Q&A bridge to save tokens.",
        },
      ],
    });

    try {
      await waitForCondition(() => getFrame().includes("Context Desk ·"), "the Context Desk");

      stdin.write(key);
      await waitForCondition(() => calls.length > 0, `the advice ${verb} key to reach the engine`);

      assert.deepEqual(
        calls,
        [`${verb}:advice-conversation`],
        `\`${key}\` must target the advice for bridge-1 — cursor 0 of the conversation collection — not the guidance advice at unfiltered offset 0`,
      );
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });
}

/**
 * Composer ownership. The Context Desk owns the keyboard only while the draft
 * is empty; the moment a draft exists every key belongs to the composer again.
 *
 * Navigation keys are the sharp edge: they carry no text, so a gate that
 * special-cases them keeps walking panes, paging the preview, and expanding
 * rows underneath a user who is mid-sentence — and Enter never reaches submit
 * at all, stranding the draft.
 */
const KEY_LEFT = "\u001B[D";
const KEY_RIGHT = "\u001B[C";
const KEY_PAGE_UP = "\u001B[5~";
const KEY_PAGE_DOWN = "\u001B[6~";
const KEY_ENTER = "\r";

/** Desk callbacks that only an empty composer may trigger. */
const DESK_NAVIGATION_CALL = /^(?:pane:|page:|move:|scroll:|expand$)/;

function deskNavigationCalls(calls) {
  return calls.filter((call) => DESK_NAVIGATION_CALL.test(call));
}

/** The live draft with the prompt glyph stripped off. */
function draftText(frame) {
  const line = composerLine(frame);
  return line === undefined ? undefined : line.slice(PROMPT_GLYPH.length).trim();
}

test("desk pane, page, and expand keys yield to a pending draft", async () => {
  const { calls, stdin, instance, getFrame } = renderContextDesk({});

  try {
    await waitForCondition(() => getFrame().includes("Context Desk ·"), "the Context Desk");

    // Control arm. On an empty composer the desk owns these keys outright, so
    // merely unwiring pane/page/expand cannot quietly satisfy the negative
    // assertion below. The letter keys already have their own coverage.
    stdin.write(KEY_LEFT);
    await waitForCondition(() => calls.includes("pane:-1"), "the pane key");
    stdin.write(KEY_PAGE_DOWN);
    await waitForCondition(() => calls.includes("page:1"), "the page key");
    stdin.write(KEY_ENTER);
    await waitForCondition(() => calls.includes("expand"), "the expand key");
    // The placeholder stands in for the empty draft row, so it proves the
    // navigation keys never became text.
    assert.equal(
      draftText(getFrame()),
      WORK_SHELL_COMPOSER_PLACEHOLDER,
      "desk navigation keys must not leak into the draft",
    );

    await typeKeys(stdin, [..."note"]);
    await waitForCondition(() => draftText(getFrame()) === "note", "the typed draft");
    const callsWhenDraftStarted = [...calls];

    // `z` is an ordering barrier: Ink drains one stdin stream in order, so once
    // it shows up in the draft every navigation key ahead of it has been
    // handled. Which column it lands in depends on where the arrows left the
    // text cursor — ordinary composer behaviour, and not what this pins.
    await typeKeys(stdin, [KEY_LEFT, KEY_RIGHT, KEY_PAGE_UP, KEY_PAGE_DOWN, "z"]);
    await waitForCondition(() => {
      const text = draftText(getFrame());
      return text !== undefined && text.length === 5 && text.replace("z", "") === "note";
    }, "the barrier keystroke to land in the draft");

    assert.deepEqual(
      deskNavigationCalls(calls),
      deskNavigationCalls(callsWhenDraftStarted),
      "a pending draft must keep every desk pane, cursor, page, and expand callback silent",
    );
    assert.match(getFrame(), /Context Desk ·/, "the desk stays open while the user drafts");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("Enter with a pending draft belongs to the composer, not the desk", async () => {
  // Fresh render: Enter is submit-sensitive, so it cannot share a pane with the
  // navigation burst above without clearing the draft out from under it.
  const { calls, stdin, instance, getFrame } = renderContextDesk({});

  try {
    await waitForCondition(() => getFrame().includes("Context Desk ·"), "the Context Desk");

    await typeKeys(stdin, [..."note"]);
    await waitForCondition(() => draftText(getFrame()) === "note", "the typed draft");

    stdin.write(KEY_ENTER);
    // Either outcome settles the key: the composer submits and clears, or the
    // desk steals it and records a call. Both end the wait; only one passes.
    await waitForCondition(
      () => calls.length > 0 || draftText(getFrame()) !== "note",
      "Enter to be handled by the composer or the desk",
    );

    assert.deepEqual(
      deskNavigationCalls(calls),
      [],
      "Enter on a pending draft must reach the composer, never expand the selected desk row",
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("submitting from the desk retires the overlay, typing alone keeps it open", async () => {
  // The mock mirrors the engine contract (Task 14): a turn submit closes the
  // desk through the Esc close path, so the pane must stop rendering the
  // overlay as soon as the engine state says closed. The engine-side close is
  // pinned in work-shell-engine.test.mjs.
  const { engine, calls } = createContextDeskEngine();
  const deskState = engine.getState();
  const { stdin, instance, getFrame } = renderFrames(
    React.createElement(WorkShellPane, paneProps({
      ...engine,
      handleSubmit: async (line) => {
        await engine.handleSubmit(line);
        deskState.panel = { title: "Context", lines: [] };
        deskState.contextInspectorOpen = false;
        deskState.contextInspectorCursor = -1;
      },
    })),
  );

  try {
    await waitForCondition(() => getFrame().includes("Context Desk ·"), "the Context Desk");

    // Typing a draft never closes the desk — only Esc, the /context toggle,
    // or a submit may (regression guard for the overlay-for-input contract).
    await typeKeys(stdin, [..."ship it"]);
    await waitForCondition(() => draftText(getFrame()) === "ship it", "the typed draft");
    assert.match(
      getFrame(),
      /Context Desk ·/,
      "typing alone must keep the Context Desk open",
    );

    stdin.write(KEY_ENTER);
    await waitForCondition(
      () => calls.includes("submit:ship it"),
      "the submit to reach the engine",
    );
    await waitForCondition(
      () => !getFrame().includes("Context Desk ·"),
      "the desk overlay to leave the frame after submit",
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});