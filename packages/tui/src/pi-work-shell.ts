/**
 * Work shell on `@earendil-works/pi-tui` (strangler shell, Slice B).
 *
 * Carries one journey end to end — prompt → streaming answer → tool trace →
 * scroll while streaming — over the same engine the Ink shell renders
 * (`getState`/`subscribe`/`handleSubmit`), so both shells can run against one
 * owner session. pi-tui's alternate-screen viewport owns scrolling: the
 * transcript is a follow-end `ScrollView`, so PageUp or the wheel stops
 * following while the answer keeps streaming, and End/scrolling back down
 * resumes it. Screens move over from the Ink shell one at a time; until then
 * `UNCLECODE_TUI_SHELL=pi` selects this shell.
 */
import {
  type Component,
  Container,
  Editor,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Text,
  truncateToWidth,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";

import { selectWorkShellLiveToolTraceLines } from "./work-shell-live-activity.js";

export type PiShellEntry = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly text: string;
};

export type PiShellState = {
  readonly entries: readonly PiShellEntry[];
  readonly streamingAssistantText: string;
  readonly isBusy: boolean;
  readonly busyStatus: string;
  readonly model: string;
  readonly lastTurnDurationMs: number | undefined;
  readonly currentTurnStartedAt: number | undefined;
  /** Newest tool row of the live trace (`→ read .`), as the Ink dock shows it. */
  readonly liveToolLine: string | undefined;
};

/** The slice of the work-shell engine this shell drives (local or owner-remote). */
export type PiShellEngine = {
  getState(): unknown;
  subscribe(listener: (state: unknown) => void): () => void;
  initialize?(): unknown;
  handleSubmit(line: string): Promise<unknown>;
  interruptTurn?(): unknown;
  updateTerminalColumns?(columns: number): unknown;
};

const STREAMING_CURSOR = "▌";
const REASONING_PREFIX = "✻ ";
const TOOL_RESULT_ROWS_MAX = 8;
const BUSY_TICK_MS = 1_000;
const ENTRY_ROLES = new Set(["system", "user", "assistant", "tool"]);

const sgr = (open: number, close: number) => (text: string) => `\u001b[${open}m${text}\u001b[${close}m`;
const bold = sgr(1, 22);
const dim = sgr(2, 22);
const italic = sgr(3, 23);
const underline = sgr(4, 24);
const strike = sgr(9, 29);
const cyan = sgr(36, 39);
const green = sgr(32, 39);
const yellow = sgr(33, 39);

const MARKDOWN_THEME: MarkdownTheme = {
  heading: bold,
  link: underline,
  linkUrl: dim,
  code: cyan,
  codeBlock: (text) => text,
  codeBlockBorder: dim,
  quote: italic,
  quoteBorder: dim,
  hr: dim,
  listBullet: cyan,
  bold,
  italic,
  strikethrough: strike,
  underline,
};

const EDITOR_THEME = {
  borderColor: dim,
  selectList: {
    selectedPrefix: cyan,
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  },
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isPiShellEntry(value: unknown): value is PiShellEntry {
  return isRecord(value)
    && typeof value.role === "string"
    && ENTRY_ROLES.has(value.role)
    && typeof value.text === "string";
}

/** Owner-remote state arrives as a plain record; read only the fields this shell shows. */
export function readPiShellState(value: unknown): PiShellState {
  const state = isRecord(value) ? value : {};
  const entries = Array.isArray(state.entries) ? state.entries.filter(isPiShellEntry) : [];
  return {
    entries,
    streamingAssistantText: typeof state.streamingAssistantText === "string" ? state.streamingAssistantText : "",
    isBusy: state.isBusy === true,
    busyStatus: typeof state.busyStatus === "string" ? state.busyStatus : "",
    model: typeof state.model === "string" ? state.model : "",
    lastTurnDurationMs: typeof state.lastTurnDurationMs === "number" ? state.lastTurnDurationMs : undefined,
    currentTurnStartedAt: typeof state.currentTurnStartedAt === "number" ? state.currentTurnStartedAt : undefined,
    liveToolLine: Array.isArray(state.liveTraceLines)
      ? selectWorkShellLiveToolTraceLines(state.liveTraceLines.filter((line) => typeof line === "string"), 1)[0]
      : undefined,
  };
}

/**
 * A completed tool entry is glyph-less multi-row text (`{verb} {arg}`, metric
 * rows, excerpt — see `formatWorkShellToolDetailEntry`); the renderer owns the
 * `● ` / `⎿` glyphs, as in the Ink shell.
 */
export function formatPiShellToolRows(text: string): readonly string[] {
  const [call = "", ...rest] = text.trimEnd().split("\n");
  const results = rest.filter((line) => line.trim().length > 0);
  const shown = results.slice(0, TOOL_RESULT_ROWS_MAX);
  const hidden = results.length - shown.length;
  return [
    `● ${call.trim()}`,
    ...shown.map((line, index) => `${index === 0 ? "  ⎿ " : "    "}${line}`),
    ...(hidden > 0 ? [`    … +${hidden} more lines`] : []),
  ];
}

export function formatPiShellStatus(state: PiShellState, now: number = Date.now()): string {
  if (state.isBusy) {
    const elapsed = state.currentTurnStartedAt === undefined
      ? ""
      : ` · ${(Math.max(0, now - state.currentTurnStartedAt) / 1000).toFixed(1)}s`;
    return `◆ ${state.liveToolLine ?? (state.busyStatus || "Working")}${elapsed}`;
  }
  const last = state.lastTurnDurationMs === undefined ? "" : ` · last ${(state.lastTurnDurationMs / 1000).toFixed(1)}s`;
  return `◇ Ready${last}`;
}

/**
 * One row, cut to the terminal width. The busy status carries a reasoning
 * preview with newlines; a newline inside a rendered row scrolls the terminal
 * and desyncs the differential renderer's screen (rows shift, the status row
 * shows twice), so whitespace runs fold to one space.
 */
export class PiShellStatusLine implements Component {
  private text = "";

  setText(text: string): void {
    this.text = text.replace(/[\r\n\t]+/g, " ");
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [truncateToWidth(` ${this.text}`, width)];
  }
}

function createEntryComponent(entry: PiShellEntry): Component {
  const text = entry.text.replace(STREAMING_CURSOR, "");
  switch (entry.role) {
    case "user":
      return new Text(bold(`› ${text}`), 1, 0);
    case "tool":
      return new Text(formatPiShellToolRows(text).map((row, index) => (index === 0 ? green(row) : dim(row))).join("\n"), 1, 0);
    case "system":
      return new Text(dim(`· ${text}`), 1, 0);
    case "assistant":
      return text.startsWith(REASONING_PREFIX)
        ? new Text(dim(italic(text.trimEnd())), 1, 0)
        : new Markdown(text, 1, 0, MARKDOWN_THEME);
  }
}

/**
 * Mirrors engine entries into transcript components. Entries only append or
 * change at the tail during a turn, so an unchanged prefix keeps its
 * components (and their rendered-line caches); anything else rebuilds.
 * Entries compare by value: the owner-remote engine parses a fresh state
 * object on every poll, so identity would rebuild the transcript each time.
 */
class TranscriptSync {
  private readonly rendered: PiShellEntry[] = [];
  private readonly components: Component[] = [];
  private streaming: Markdown | undefined;
  private streamingText = "";

  constructor(private readonly transcript: Container) {}

  apply(state: PiShellState): void {
    let keep = 0;
    while (
      keep < this.rendered.length
      && keep < state.entries.length
      && this.rendered[keep]?.role === state.entries[keep]?.role
      && this.rendered[keep]?.text === state.entries[keep]?.text
    ) keep += 1;
    if (keep < this.rendered.length) {
      for (const component of this.components.splice(keep)) this.transcript.removeChild(component);
      this.rendered.splice(keep);
    }
    this.detachStreaming();
    for (const entry of state.entries.slice(keep)) {
      const component = createEntryComponent(entry);
      this.rendered.push(entry);
      this.components.push(component);
      this.transcript.addChild(component);
    }
    const streamingText = state.streamingAssistantText;
    if (streamingText.length > 0) {
      if (!this.streaming) this.streaming = new Markdown("", 1, 0, MARKDOWN_THEME);
      if (streamingText !== this.streamingText) this.streaming.setText(`${streamingText}${STREAMING_CURSOR}`);
      this.streamingText = streamingText;
      this.transcript.addChild(this.streaming);
    } else {
      this.streaming = undefined;
      this.streamingText = "";
    }
  }

  private detachStreaming(): void {
    if (this.streaming) this.transcript.removeChild(this.streaming);
  }
}

export async function renderPiWorkShell(engine: PiShellEngine): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, undefined, undefined, { scrollToEndIndicator: () => " ↓ new output · End " });
  const transcript = new Container();
  const sync = new TranscriptSync(transcript);
  const status = new PiShellStatusLine();
  const editor = new Editor(tui, EDITOR_THEME, { paddingX: 1 });

  const scroll = new ScrollView(transcript, { follow: "end", primary: true, overscroll: "chain" });
  tui.setLayoutRoot(new VStack([
    {
      component: scroll,
      basis: 0,
      grow: 1,
      minSize: 1,
    },
    { component: editor, basis: "auto", shrink: 1, minSize: 1 },
    { component: status, basis: "auto", minSize: 1 },
  ]));

  let state = readPiShellState(engine.getState());
  const showStatus = () => {
    status.setText(dim([
      formatPiShellStatus(state),
      state.model,
      `PgUp/PgDn · wheel scroll · Ctrl+C ${state.isBusy ? "interrupt" : "quit"}`,
    ].join("  │  ")));
    tui.requestRender();
  };
  const show = (next: unknown) => {
    state = readPiShellState(next);
    sync.apply(state);
    showStatus();
  };
  // Owner state only changes on events; the elapsed time of a busy turn also moves between them.
  const tick = setInterval(() => {
    if (state.isBusy) showStatus();
  }, BUSY_TICK_MS);

  await new Promise<void>((resolve) => {
    const quit = () => {
      clearInterval(tick);
      unsubscribe();
      tui.stop();
      resolve();
    };
    editor.onSubmit = (text) => {
      const line = text.trim();
      if (line.length === 0) return;
      editor.addToHistory(line);
      void engine.handleSubmit(line).catch((error: unknown) => {
        status.setText(yellow(`✗ ${error instanceof Error ? error.message : String(error)}`));
        tui.requestRender();
      });
    };
    tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) {
        if (state.isBusy && engine.interruptTurn) engine.interruptTurn();
        else quit();
        return { consume: true };
      }
      // pi-tui's viewport has no End binding; with an empty draft End has nothing to
      // move in the editor, so it jumps back to the live end the indicator points at.
      if (matchesKey(data, "end") && editor.getText().length === 0) {
        scroll.scrollToEnd();
        tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+d") && editor.getText().length === 0) {
        quit();
        return { consume: true };
      }
      return undefined;
    });
    const unsubscribe = engine.subscribe(show);
    tui.setFocus(editor);
    tui.start();
    engine.updateTerminalColumns?.(terminal.columns);
    void engine.initialize?.();
    show(engine.getState());
  });
}
