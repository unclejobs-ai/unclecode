import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import { render } from "ink";
import React from "react";

import { Composer } from "../../packages/tui/src/composer.tsx";
import { WorkShellPane } from "../../packages/tui/src/work-shell-pane.tsx";
import {
  WORK_SHELL_COMPOSER_PLACEHOLDER,
  WORK_SHELL_SPINNER_INTERVAL_MS,
  resolveReadableWorkShellTextColor,
  resolveWorkShellComposerHint,
  WorkShellView,
} from "../../packages/tui/src/work-shell-view.tsx";

function createWritableOutput(columns = 100, rows = 30) {
  const output = new PassThrough();
  output.columns = columns;
  output.rows = rows;
  output.isTTY = true;
  output.getColorDepth = () => 24;
  output.hasColors = () => true;
  return output;
}

function createWritableError(columns = 100, rows = 30) {
  const error = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  error.columns = columns;
  error.rows = rows;
  error.isTTY = true;
  error.getColorDepth = () => 24;
  error.hasColors = () => true;
  return error;
}

function renderDebugFrame(element) {
  const stdout = createWritableOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const instance = render(element, {
    stdout,
    stderr: createWritableError(),
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    instance,
    getOutput: () => output,
  };
}

test("WORK_SHELL_SPINNER_INTERVAL_MS matches DESIGN.md Motion timing", () => {
  assert.equal(WORK_SHELL_SPINNER_INTERVAL_MS, 100);
});

test("resolveWorkShellComposerHint prioritizes busy queue guidance over slash hints", () => {
  assert.equal(
    resolveWorkShellComposerHint({
      isBusy: true,
      inputValue: "/model",
      slashSuggestionCount: 4,
      selectedSlashCommand: "/model gpt-5.4",
    }),
    "Queue a follow-up... · Enter queue · Esc interrupt · /queue",
  );
});

test("resolveWorkShellComposerHint surfaces paused queue recovery guidance", () => {
  assert.equal(
    resolveWorkShellComposerHint({
      isBusy: false,
      queuePaused: true,
      queuedCount: 2,
      inputValue: "",
      slashSuggestionCount: 0,
    }),
    "Queue paused after interrupt · check /queue · /queue clear drops",
  );
});

test("resolveWorkShellComposerHint keeps / commands in the normal empty-composer help", () => {
  // Pre-redesign copy, verbatim: the idle hint is the only place a new
  // operator is told slash commands exist. The redesign kept the paste
  // affordance and dropped the discovery half, taking slash discovery out of
  // the normal shell entirely.
  assert.equal(
    resolveWorkShellComposerHint({
      isBusy: false,
      inputValue: "",
      slashSuggestionCount: 0,
    }),
    "Enter send · Shift+Enter newline · / commands · Ctrl+V image",
  );
});

test("busy WorkShellView renders composer hint above the composer dock", async () => {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.4",
      reasoningLabel: "medium",
      reasoningSupported: true,
      mode: "default",
      authLabel: "Saved OAuth",
      entries: [{ role: "user", text: "ship it" }],
      isBusy: true,
      busyStatus: "thinking",
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement("span", null, ""),
      inputValue: "next task",
      slashSuggestionCount: 0,
      terminalColumns: 100,
      cwd: "/Users/parkeungje/project/unclecode",
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  const output = getOutput();
  instance.unmount();
  instance.cleanup();

  assert.match(output, /Queue a follow-up\.\.\. · Enter queue · Esc interrupt · \/queue/);
  const busyRows = output.split("\n");
  const hintIndex = busyRows.findIndex((row) => row.includes("Queue a follow-up"));
  const dockIndex = paneDockDividerIndex(busyRows);
  assert.ok(hintIndex >= 0 && dockIndex > hintIndex, "composer hint should appear above the composer dock divider");
  // Task 9: the live activity row is pinned directly above the hint row, so
  // the busy indicator rides with the input instead of the top status row.
  // Row-order proof by frame line indices: activity < hint < divider < `›`.
  const activityIndex = busyRows.findIndex((row) => BUSY_SPINNER_GLYPH.test(row));
  assert.ok(activityIndex >= 0, "busy frames should render the dock activity row");
  assert.ok(
    hintIndex > activityIndex,
    "the activity row should sit above the composer hint row",
  );
  const promptIndex = dockIndex >= 0 ? dockIndex + 1 : -1;
  assert.ok(
    promptIndex > hintIndex && (busyRows[promptIndex] ?? "").trimStart().startsWith(PROMPT_GLYPH),
    "the `›` prompt row should sit below the hint row",
  );
});

test("idle WorkShellView frames carry no spinner glyph", async () => {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.4",
      reasoningLabel: "medium",
      reasoningSupported: true,
      mode: "default",
      authLabel: "Saved OAuth",
      entries: [{ role: "user", text: "ship it" }],
      isBusy: false,
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement("span", null, ""),
      inputValue: "",
      slashSuggestionCount: 0,
      terminalColumns: 100,
      cwd: "/Users/parkeungje/project/unclecode",
    }),
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const output = getOutput();
    // The dock activity row is busy-only: an idle frame must not leak a
    // braille spinner glyph anywhere (tmux smoke pins the idle screen shape).
    assert.doesNotMatch(output, BUSY_SPINNER_GLYPH);
    assert.match(output, /◇ Ready/u);
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("queued WorkShellView keeps queue indicator and composer hint visible", async () => {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.4",
      reasoningLabel: "medium",
      reasoningSupported: true,
      mode: "default",
      authLabel: "Saved OAuth",
      entries: [{ role: "user", text: "first" }],
      isBusy: true,
      busyStatus: "thinking",
      queuedCount: 1,
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement("span", null, ""),
      inputValue: "",
      slashSuggestionCount: 0,
      terminalColumns: 100,
      cwd: "/Users/parkeungje/project/unclecode",
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  const output = getOutput();
  instance.unmount();
  instance.cleanup();

  assert.match(output, /1 follow-up/);
  assert.match(output, /Queue a follow-up/);
});

test("composer dock footer keeps context cost readable on dark terminals", async () => {
  const previousBackground = process.env.UNCLECODE_TERMINAL_BACKGROUND;
  process.env.UNCLECODE_TERMINAL_BACKGROUND = "dark";
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.6-terra",
      reasoningLabel: "medium",
      reasoningSupported: true,
      mode: "default",
      authLabel: "Saved OAuth",
      entries: [],
      isBusy: false,
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement("span", null, ""),
      inputValue: "",
      slashSuggestionCount: 0,
      terminalColumns: 100,
      cwd: "/Users/parkeungje/project/unclecode",
      contextIndicator: "▤ 44 ctx · ~2k · 113 held",
    }),
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const output = getOutput();
    assert.match(output, /▤ 44 ctx · ~2k/);
    // Dark terminal: the old invisible border hex resolves to the muted tier.
    assert.equal(resolveReadableWorkShellTextColor("#21262d"), "gray");
  } finally {
    instance.unmount();
    instance.cleanup();
    if (previousBackground === undefined) {
      delete process.env.UNCLECODE_TERMINAL_BACKGROUND;
    } else {
      process.env.UNCLECODE_TERMINAL_BACKGROUND = previousBackground;
    }
  }
});

test("the shell header shows the session identity when no caller supplies a hint", async () => {
  // The header's default right side is the session's identity — model and mode —
  // instead of a permanently-lit orientation hint. A host that passes no
  // `headerHint` is the normal shell, and it must still answer "what am I
  // talking to" from the header row alone.
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "gemini",
      model: "gemini-3-pro",
      reasoningLabel: "medium",
      reasoningSupported: true,
      mode: "default",
      authLabel: "Saved OAuth",
      entries: [],
      isBusy: false,
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement("span", null, ""),
      inputValue: "",
      slashSuggestionCount: 0,
      terminalColumns: 100,
      cwd: "/Users/parkeungje/project/unclecode",
    }),
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const output = getOutput();
    assert.match(
      output,
      /gemini-3-pro · 작업 모드/,
      "the header must carry the model and mode label when no headerHint is supplied",
    );
    assert.doesNotMatch(
      output,
      /work context · Ctrl\+O sessions/,
      "the default header hint must not light up without an explicit headerHint prop",
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("the shell header carries the auth warning chip when auth needs action", async () => {
  // "Not signed in" is the one auth state that changes what the operator must
  // do next, so it is the only wording that earns a slot — as a warning chip
  // riding after the session facts on the header row itself, not just in the
  // status strip.
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.4",
      reasoningLabel: "medium",
      reasoningSupported: true,
      mode: "default",
      authLabel: "Not signed in",
      entries: [],
      isBusy: false,
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement("span", null, ""),
      inputValue: "",
      slashSuggestionCount: 0,
      terminalColumns: 100,
      cwd: "/Users/parkeungje/project/unclecode",
    }),
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const output = getOutput();
    const headerLine = stripVTControlCharacters(output)
      .split("\n")
      .find((line) => line.includes("UncleCode"));
    assert.ok(headerLine !== undefined, "the header wordmark line should render");
    assert.match(
      headerLine,
      /gpt-5\.4 · 작업 모드 · No auth/,
      "the auth warning chip should ride after the session facts on the header row",
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("the shell header keeps the auth warning chip beside a long model id at 80 columns", async () => {
  // Regression class: a long model id used to evict the chip from the header
  // first, and the slimmed wide status row no longer carries auth — so between
  // 72 and 92 columns (the default terminal among them) the warning rendered
  // nowhere. Warnings beat identity facts: the facts truncate around the chip
  // while the header stays a single line above the rule.
  const stdout = createWritableOutput(80);
  const stderr = createWritableError(80);
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const instance = render(
    React.createElement(WorkShellView, {
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      reasoningLabel: "medium",
      reasoningSupported: true,
      mode: "ultrawork",
      authLabel: "OAuth file · API blocked",
      entries: [],
      isBusy: false,
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement("span", null, ""),
      inputValue: "",
      slashSuggestionCount: 0,
      terminalColumns: 80,
      cwd: "/Users/parkeungje/project/unclecode",
    }),
    {
      stdout,
      stderr,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const lines = stripVTControlCharacters(output).split("\n");
    const headerIndex = lines.findIndex((line) => line.includes("UncleCode"));
    assert.ok(headerIndex >= 0, "the header wordmark line should render");
    assert.match(
      lines[headerIndex],
      /OAuth · needs API key/,
      "the auth warning chip must survive a long model id on the header row",
    );
    assert.match(
      lines[headerIndex],
      /claude-sonnet-4-5/,
      "the truncated session facts should still share the header row with the chip",
    );
    assert.match(
      (lines[headerIndex + 1] ?? "").trim(),
      /^─+$/,
      "the header rule must follow immediately — the header stays a single line",
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Context Desk navigation ownership — the real Composer driven through Ink
// stdin. Pure Yaji moved the desk onto h/j/k/l, and those keys were reaching
// the draft at the same time they moved the desk cursor.
// ---------------------------------------------------------------------------

const CONTEXT_DESK_NAVIGATION_KEYS = ["h", "j", "k", "l"];

// Cursor sequences such as `\u001B[?25l` and `\u001B[?25h` end in the very
// letters under test, so frames must be stripped before they are searched.
// biome-ignore lint/suspicious/noControlCharactersInRegex: debug frames carry cursor and SGR sequences.
const COMPOSER_CSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/g;

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

function renderComposerWithInput(element) {
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
  return { stdin, instance, getFrames: () => output.replace(COMPOSER_CSI_PATTERN, "") };
}

async function waitForComposerCondition(predicate, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/**
 * Controlled parent for the real Composer: the draft the Composer paints is
 * the value this harness holds, so a suppressed key is one that reaches
 * neither `onChange` nor the value.
 */
function createControlledComposer(props) {
  const changes = [];
  function ControlledComposer() {
    const [value, setValue] = React.useState("");
    return React.createElement(Composer, {
      ...props,
      value,
      onChange: (nextValue) => {
        changes.push(nextValue);
        setValue(nextValue);
      },
      onSubmit: () => {},
    });
  }
  return { changes, element: React.createElement(ControlledComposer) };
}

test("Context Desk navigation keys never enter an empty composer draft", async () => {
  for (const key of CONTEXT_DESK_NAVIGATION_KEYS) {
    // One render per key: the desk only owns an empty composer, so every key
    // has to be judged from that same starting state rather than from the
    // draft the previous key would have left behind.
    const { changes, element } = createControlledComposer({
      suppressInspectorKeys: true,
      suppressInspectorNavigationKeys: true,
    });
    const { stdin, instance, getFrames } = renderComposerWithInput(element);

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      stdin.write(key);
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.deepEqual(changes, [], `${key} must not reach the composer onChange`);
      assert.ok(
        !getFrames().includes(key),
        `${key} must not paint into the composer row`,
      );
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  }
});

test("composer still types h/j/k/l when navigation suppression is off", async () => {
  for (const navigationOverride of [{}, { suppressInspectorNavigationKeys: false }]) {
    // The desk is open for both shapes; only the navigation flag differs, so
    // this pins the new prop rather than the pre-existing inspector gate.
    const { changes, element } = createControlledComposer({
      suppressInspectorKeys: true,
      ...navigationOverride,
    });
    const { stdin, instance } = renderComposerWithInput(element);

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const [index, key] of CONTEXT_DESK_NAVIGATION_KEYS.entries()) {
        stdin.write(key);
        await waitForComposerCondition(
          () => changes.length === index + 1,
          `the composer to accept ${key} as ordinary text`,
        );
      }

      assert.deepEqual(changes, ["h", "hj", "hjk", "hjkl"]);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  }
});

// ---------------------------------------------------------------------------
// Context Desk ownership as the real WorkShellPane decides it. The pane gates
// every one of h/j/k/l on a single engine capability, so an engine that wires
// cursor movement but no pane movement still claims h/l — and the controller
// then dispatches them into a handler that does not exist. The letters vanish:
// they neither move the desk nor reach the draft.
// ---------------------------------------------------------------------------

const PROMPT_GLYPH = "\u203a";
/** Braille busy-spinner frames — these mark the dock's live activity row. */
const BUSY_SPINNER_GLYPH = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u;

/**
 * Ink in debug mode writes one whole frame per render, so the newest chunk is
 * the current screen. Accumulated output would still hold the pre-keystroke
 * frames and would happily "prove" a draft that has since been dropped.
 */
function renderPaneFrames(element) {
  const stdin = createInkInput();
  const stdout = createWritableOutput(120, 40);
  let frame = "";
  stdout.on("data", (chunk) => {
    frame = chunk.toString().replace(COMPOSER_CSI_PATTERN, "");
  });
  const instance = render(element, {
    stdin,
    stdout,
    stderr: createWritableError(120, 40),
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return { stdin, instance, getFrame: () => frame };
}

/**
 * The dock divider is an unlabeled soft rule — a full row of `─` directly above
 * the composer's `›` row. The open desk paints its own selected rows with the
 * same `›` prefix (inside its border), so scanning the frame for the glyph
 * alone would read a desk row as the composer; the rule-above-a-glyph-row pair
 * is the dock's own.
 */
function paneDockDividerIndex(rows) {
  return rows.findIndex(
    (row, index) =>
      /^─+$/.test(row.trim())
      && (rows[index + 1] ?? "").trimStart().startsWith(PROMPT_GLYPH),
  );
}

/**
 * Both dock rows are found relative to that divider: the hint on the line
 * above it, the draft on the line below.
 */
function paneComposerLine(frame) {
  const rows = frame.split("\n");
  const dockIndex = paneDockDividerIndex(rows);
  return dockIndex < 0 ? undefined : rows[dockIndex + 1]?.trim();
}
/** The live draft without the prompt prefix or right-side terminal padding. */
function paneComposerDraft(frame) {
  const line = paneComposerLine(frame);
  if (line === undefined) return undefined;
  const promptEnd = line.indexOf(PROMPT_GLYPH);
  if (promptEnd < 0) return undefined;
  return line.slice(promptEnd + 2).replace(/[ ]+$/, "");
}


function paneComposerHintLine(frame) {
  const rows = frame.split("\n");
  const dockIndex = paneDockDividerIndex(rows);
  if (dockIndex <= 0) return undefined;
  const hint = rows[dockIndex - 1].trim();
  return hint.length === 0 ? undefined : hint;
}

function deskPacket(selectedActions) {
  const included = [
    {
      id: "workspace-1",
      category: "workspace",
      label: "AGENTS.md",
      reason: "workspace guidance",
      preview: "Workspace instructions stay active.",
      tokenEstimate: 8,
      salience: 1,
      includedInModel: true,
      ...(selectedActions === undefined ? {} : { actions: selectedActions }),
    },
    {
      id: "bridge-1",
      category: "bridge",
      label: "recent Q&A",
      reason: "session bridge",
      preview: "The last exchange stays in reach.",
      tokenEstimate: 8,
      salience: 0.5,
      includedInModel: true,
    },
  ];
  return {
    id: "packet-desk",
    version: 1,
    generatedAt: "2026-08-09T00:00:00.000Z",
    title: "Next answer context",
    included,
    excluded: [],
    warnings: [],
    preview: [],
    sourceCounts: { included: included.length, excluded: 0, warnings: 0 },
    tokenEstimate: 24,
    tokenEstimateState: "estimated",
  };
}


/**
 * An engine that can move the desk cursor and nothing else. This is the shape
 * every read-only host has: `moveContextInspectorPane` is optional on the
 * runtime interface, so h/l have no handler to reach.
 */
function createCursorOnlyDeskEngine(deskOpen, selectedActions) {
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
    panel: deskOpen
      ? { title: "Context expanded", lines: [] }
      : { title: "Session status", lines: ["Work context ready."] },
    contextPacket: deskPacket(selectedActions),
    contextInspectorOpen: deskOpen,
    contextInspectorPane: "sources",
    contextInspectorCollection: "all",
    contextInspectorCursor: 0,
    contextSourceActionsEnabled: deskOpen,
    modelWindow: 200_000,
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
        calls.push(`move-cursor:${direction}`);
      },
    },
  };
}

function deskPaneProps(engine) {
  return {
    provider: "OpenAI",
    model: "gpt-5.4",
    mode: "yolo",
    engine,
    cwd: "/tmp/unclecode-composer-workflow",
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
  };
}

test("a cursor-only Context Desk keeps j/k and hands h/l back to the composer", async () => {
  for (const { key, direction } of [{ key: "j", direction: 1 }, { key: "k", direction: -1 }]) {
    const { engine, calls } = createCursorOnlyDeskEngine(true);
    const { stdin, instance, getFrame } = renderPaneFrames(
      React.createElement(WorkShellPane, deskPaneProps(engine)),
    );

    try {
      await waitForComposerCondition(
        () => getFrame().includes("Context Desk ·"),
        "the Context Desk to mount",
        30_000,
      );
      stdin.write(key);
      await waitForComposerCondition(
        () => calls.includes(`move-cursor:${direction}`),
        `${key} to move the desk cursor`,
      );

      assert.equal(
        paneComposerLine(getFrame()),
        `${PROMPT_GLYPH} ${WORK_SHELL_COMPOSER_PLACEHOLDER}`,
        `${key} moves the cursor, so it must stay out of the draft`,
      );
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  }

  // One render per key: the desk owns only an empty composer, so the first
  // accepted letter ends its claim and a second key would be judged from a
  // draft the desk had already released.
  for (const key of ["h", "l"]) {
    const { engine, calls } = createCursorOnlyDeskEngine(true);
    const { stdin, instance, getFrame } = renderPaneFrames(
      React.createElement(WorkShellPane, deskPaneProps(engine)),
    );

    try {
      await waitForComposerCondition(
        () => getFrame().includes("Context Desk ·"),
        "the Context Desk to mount",
        30_000,
      );
      stdin.write(key);
      await waitForComposerCondition(
        () => paneComposerLine(getFrame()) === `${PROMPT_GLYPH} ${key}`,
        `${key} to be typed by a desk that exposes no pane movement`,
      );

      assert.deepEqual(
        calls,
        [],
        `${key} must not claim a pane movement this engine never wired`,
      );
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  }
});

test("the Context Desk names its key ownership in the composer hint", async () => {
  const { engine } = createCursorOnlyDeskEngine(true);
  const { instance, getFrame } = renderPaneFrames(
    React.createElement(WorkShellPane, deskPaneProps(engine)),
  );

  try {
    await waitForComposerCondition(
      () => getFrame().includes("Context Desk ·"),
      "the Context Desk to mount",
      30_000,
    );
    const hint = paneComposerHintLine(getFrame());

    assert.ok(hint, "the composer dock must keep a hint row while the desk is open");
    assert.doesNotMatch(
      hint,
      /Enter send/,
      "the desk swallows Enter on an empty composer, so the hint must not promise a send",
    );
    assert.match(hint, /Context Desk/, "the hint must name who took the keys");
    assert.match(
      hint,
      /h\/j\/k\/l|hjkl/,
      "the hint must name the navigation keys the desk has taken",
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("outside the Context Desk the composer hint stays the normal shell help", async () => {
  const { engine } = createCursorOnlyDeskEngine(false);
  const { instance, getFrame } = renderPaneFrames(
    React.createElement(WorkShellPane, deskPaneProps(engine)),
  );

  try {
    await waitForComposerCondition(
      () => paneComposerHintLine(getFrame()) !== undefined,
      "the composer hint row",
      30_000,
    );

    assert.equal(
      paneComposerHintLine(getFrame()),
      "Enter send · Shift+Enter newline · / commands · Ctrl+V image",
      "a shell with no desk open keeps the restored normal help verbatim",
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Enter ownership is a capability, not a mode. The open desk resolves Enter to
// its expansion action on every host, including one that never wired
// `toggleContextInspectorExpanded` — so the key reaches neither the desk nor
// the composer, and the dock advertises details nothing can open.
// ---------------------------------------------------------------------------

const DESK_CLIPBOARD_PNG = {
  type: "image",
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,AAA=",
  path: "(clipboard)",
  displayName: "clipboard.png",
};

const ATTACHMENT_ONLY_SUBMIT = "submit:Please inspect the attached image.";

/**
 * Both movement axes are wired here, so h/j/k/l ownership is settled and the
 * only variable left is whether this host can expand a source at all.
 */
function createDeskEngineWithExpansion(options) {
  const { engine, calls } = createCursorOnlyDeskEngine(true, options.selectedActions);
  return {
    calls,
    engine: {
      ...engine,
      moveContextInspectorPane: (direction) => {
        calls.push(`move-pane:${direction}`);
      },
      ...(options.canExpand
        ? {
            toggleContextInspectorExpanded: async () => {
              calls.push("toggle-expanded");
              if (options.rejectExpand) {
                throw new Error("expand failed");
              }
            },
          }
        : {}),
      ...(options.canPin
        ? {
            toggleContextInspectorPin: async () => {
              calls.push("pin");
            },
          }
        : {}),
      ...(options.canDelivery
        ? {
            forgetContextSourceAtCursor: async () => {
              calls.push("hold-back");
            },
            includeContextSourceAtCursor: async () => {
              calls.push("include");
            },
          }
        : {}),
    },
  };
}

function renderDeskPaneWithClipboard(engine) {
  let captureCalls = 0;
  const rendered = renderPaneFrames(
    React.createElement(WorkShellPane, {
      ...deskPaneProps(engine),
      captureClipboardImage: () => {
        captureCalls += 1;
        return { status: "ok", attachment: DESK_CLIPBOARD_PNG };
      },
    }),
  );
  return { ...rendered, getCaptureCalls: () => captureCalls };
}

/**
 * Enter on an empty draft is invisible on its own — the shell resolves an empty
 * line to a noop, so a composer that receives it looks exactly like a desk that
 * swallowed it. One parked clipboard attachment gives the composer's own submit
 * something to carry while the draft stays raw-empty, which is precisely the
 * state the desk claims: a composer-owned Enter now shows up as the
 * attachment-only prompt, and a desk-owned Enter still shows up as nothing.
 */
async function mountDeskWithParkedAttachment(rendered) {
  await waitForComposerCondition(
    () => rendered.getFrame().includes("Context Desk ·"),
    "the Context Desk to mount",
    30_000,
  );
  rendered.stdin.write("\u0016");
  await waitForComposerCondition(
    () => rendered.getCaptureCalls() === 1,
    "the injected clipboard capture",
    30_000,
  );
  await waitForComposerCondition(
    () => rendered.getFrame().includes("[1/5]"),
    "the parked clipboard attachment badge",
    30_000,
  );
}

/**
 * A swallowed Enter must fail on the assertion that names the ownership rule,
 * not on a timeout that reads like a slow render, so this wait never throws:
 * it gives the effect its window and then lets the assertion speak.
 */
async function settleComposerEffect(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("an open Context Desk with no expansion handler hands Enter back to the composer", async () => {
  const { engine, calls } = createDeskEngineWithExpansion({ canExpand: false });
  const rendered = renderDeskPaneWithClipboard(engine);

  try {
    await mountDeskWithParkedAttachment(rendered);
    rendered.stdin.write("\r");
    await settleComposerEffect(() => calls.length > 0);

    assert.deepEqual(
      calls,
      [ATTACHMENT_ONLY_SUBMIT],
      "a desk that wired no expansion handler must leave Enter to the composer's own submit",
    );
  } finally {
    rendered.instance.unmount();
    rendered.instance.cleanup();
  }
});

test("an open Context Desk that can expand keeps Enter for omitted or preview rows", async () => {
  for (const selectedActions of [undefined, ["preview"]]) {
    const { engine, calls } = createDeskEngineWithExpansion({
      canExpand: true,
      selectedActions,
    });
    const rendered = renderDeskPaneWithClipboard(engine);

    try {
      await mountDeskWithParkedAttachment(rendered);
      rendered.stdin.write("\r");
      // Hold past the window a leaked composer submit would need: the desk's own
      // handler runs on the keystroke, while a submit crosses an async resolver
      // first and would land behind a tighter assertion.
      await settleComposerEffect(() => calls.length > 1, 3_000);

      assert.deepEqual(
        calls,
        ["toggle-expanded"],
        `a wired expansion handler owns Enter for ${selectedActions === undefined ? "an omitted action list" : "a preview action"}`,
      );
    } finally {
      rendered.instance.unmount();
      rendered.instance.cleanup();
    }
  }
});

test("an explicit non-preview selected row leaves Enter with the composer", async () => {
  const { engine, calls } = createDeskEngineWithExpansion({
    canExpand: true,
    selectedActions: ["pin"],
  });
  const rendered = renderDeskPaneWithClipboard(engine);

  try {
    await mountDeskWithParkedAttachment(rendered);
    assert.doesNotMatch(
      paneComposerHintLine(rendered.getFrame()) ?? "",
      /Enter details/,
      "a non-preview row must not advertise a detail view Enter cannot open",
    );
    rendered.stdin.write("\r");
    await settleComposerEffect(() => calls.length > 0);

    assert.deepEqual(
      calls,
      [ATTACHMENT_ONLY_SUBMIT],
      "a non-preview row must leave Enter to the composer's own submit",
    );
  } finally {
    rendered.instance.unmount();
    rendered.instance.cleanup();
  }
});


test("the Context Desk hint promises details only when the selected source can preview", async () => {
  for (const [label, canExpand, selectedActions, expectsDetails] of [
    ["no expansion handler", false, undefined, false],
    ["omitted action list", true, undefined, true],
    ["preview action", true, ["preview"], true],
    ["explicit non-preview action", true, ["pin"], false],
  ]) {
    const { engine } = createDeskEngineWithExpansion({ canExpand, selectedActions });
    const { instance, getFrame } = renderPaneFrames(
      React.createElement(WorkShellPane, deskPaneProps(engine)),
    );

    try {
      await waitForComposerCondition(
        () => getFrame().includes("Context Desk ·"),
        "the Context Desk to mount",
        30_000,
      );
      const hint = paneComposerHintLine(getFrame());

      assert.ok(hint, "the composer dock must keep a hint row while the desk is open");
      assert.match(hint, /Context Desk/, "the hint must still name who took the keys");
      assert.match(
        hint,
        /h\/j\/k\/l|hjkl/,
        "the movement keys the desk owns are unaffected by the expansion capability",
      );
      assert.match(hint, /Esc closes?/, "the desk must keep saying how to leave");
      assert.match(hint, /type to draft/, "the desk must keep saying how to reach the composer");
      if (expectsDetails) {
        assert.match(
          hint,
          /Enter details/,
          `${label} keeps its details promise`,
        );
      } else {
        assert.doesNotMatch(
          hint,
          /Enter details/,
          `${label} must not advertise a detail view Enter never opens`,
        );
      }
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  }
});

test("rendered Context Desk handles a rejected expansion and keeps desk navigation usable", async () => {
  const unhandledReasons = [];
  const onUnhandledRejection = (reason) => {
    unhandledReasons.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  const { engine, calls } = createDeskEngineWithExpansion({
    canExpand: true,
    rejectExpand: true,
    selectedActions: ["preview"],
  });
  const rendered = renderPaneFrames(
    React.createElement(WorkShellPane, deskPaneProps(engine)),
  );

  try {
    await waitForComposerCondition(
      () => rendered.getFrame().includes("Context Desk ·"),
      "the Context Desk to mount",
      30_000,
    );
    rendered.stdin.write("\r");
    await waitForComposerCondition(
      () => calls.includes("toggle-expanded"),
      "the rejected expansion callback",
      30_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    rendered.stdin.write("\u001b[B");
    await waitForComposerCondition(
      () => calls.includes("move-cursor:1"),
      "desk navigation after the rejected expansion",
      30_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(calls, ["toggle-expanded", "move-cursor:1"]);
    assert.deepEqual(
      unhandledReasons,
      [],
      "the rendered desk must handle a rejected expansion callback",
    );
  } finally {
    rendered.instance.unmount();
    rendered.instance.cleanup();
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

test("explicit selected-row capabilities leave unavailable mutation keys in the composer", async () => {
  for (const {
    label,
    selectedActions,
    key,
    expectedDraft,
    canExpand,
    canPin,
    canDelivery,
  } of [
    {
      label: "preview-only p",
      selectedActions: ["preview"],
      key: "p",
      expectedDraft: "px",
      canExpand: true,
    },
    {
      label: "preview-only Space",
      selectedActions: ["preview"],
      key: " ",
      expectedDraft: " x",
      canExpand: true,
    },
    {
      label: "pin-only Space",
      selectedActions: ["pin"],
      key: " ",
      expectedDraft: " x",
      canExpand: true,
      canPin: true,
    },
    {
      label: "hold-back-only p",
      selectedActions: ["hold-back"],
      key: "p",
      expectedDraft: "px",
      canExpand: true,
      canDelivery: true,
    },
  ]) {
    const { engine, calls } = createDeskEngineWithExpansion({
      canExpand,
      canPin,
      canDelivery,
      selectedActions,
    });
    const rendered = renderPaneFrames(
      React.createElement(WorkShellPane, deskPaneProps(engine)),
    );

    try {
      await waitForComposerCondition(
        () => rendered.getFrame().includes("Context Desk ·"),
        `${label} desk to mount`,
        30_000,
      );
      // A visible sentinel preserves a leading Space in the rendered draft;
      // the whitespace itself paints like the empty composer row.
      rendered.stdin.write(key);
      await new Promise((resolve) => setTimeout(resolve, 100));
      rendered.stdin.write("x");
      await waitForComposerCondition(
        () => paneComposerDraft(rendered.getFrame()) === expectedDraft,
        `${label} to reach the composer`,
        30_000,
      );

      assert.deepEqual(calls, [], `${label} must not call an unavailable desk action`);
    } finally {
      rendered.instance.unmount();
      rendered.instance.cleanup();
    }
  }
});

test("explicit selected-row capabilities dispatch exact lowercase actions and keep uppercase in the draft", async () => {
  for (const {
    label,
    selectedActions,
    key,
    expectedCall,
    canPin,
    canDelivery,
  } of [
    {
      label: "pin-only row",
      selectedActions: ["pin"],
      key: "p",
      expectedCall: "pin",
      canPin: true,
    },
    {
      label: "hold-back-only row",
      selectedActions: ["hold-back"],
      key: " ",
      expectedCall: "hold-back",
      canDelivery: true,
    },
  ]) {
    const { engine, calls } = createDeskEngineWithExpansion({
      canExpand: true,
      canPin,
      canDelivery,
      selectedActions,
    });
    const rendered = renderPaneFrames(
      React.createElement(WorkShellPane, deskPaneProps(engine)),
    );

    try {
      await waitForComposerCondition(
        () => rendered.getFrame().includes("Context Desk ·"),
        `${label} desk to mount`,
        30_000,
      );
      rendered.stdin.write(key);
      await waitForComposerCondition(
        () => calls.includes(expectedCall),
        `${label} lowercase action`,
        30_000,
      );
      // The placeholder stands in for the empty draft row, so it proves the
      // lowercase action key never became text.
      assert.equal(paneComposerDraft(rendered.getFrame()), WORK_SHELL_COMPOSER_PLACEHOLDER);

      rendered.stdin.write("P");
      await waitForComposerCondition(
        () => paneComposerDraft(rendered.getFrame()) === "P",
        `${label} uppercase draft`,
        30_000,
      );
      assert.deepEqual(calls, [expectedCall]);
    } finally {
      rendered.instance.unmount();
      rendered.instance.cleanup();
    }
  }
});
