/**
 * The pi shell's transcript: engine entries as components (user line, Markdown
 * answer, `● call` / `⎿` tool rows, dim system and reasoning lines) plus the
 * streaming answer, kept in sync with the engine without rebuilding the prefix.
 */
import { type Component, type Container, Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";

export type PiShellEntry = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly text: string;
};

const STREAMING_CURSOR = "▌";
const REASONING_PREFIX = "✻ ";
const TOOL_RESULT_ROWS_MAX = 8;

const sgr = (open: number, close: number) => (text: string) => `\u001b[${open}m${text}\u001b[${close}m`;
export const bold = sgr(1, 22);
export const dim = sgr(2, 22);
export const italic = sgr(3, 23);
export const underline = sgr(4, 24);
export const strike = sgr(9, 29);
export const cyan = sgr(36, 39);
export const green = sgr(32, 39);
export const yellow = sgr(33, 39);

export const MARKDOWN_THEME: MarkdownTheme = {
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
export class TranscriptSync {
  private readonly rendered: PiShellEntry[] = [];
  private readonly components: Component[] = [];
  private streaming: Markdown | undefined;
  private streamingText = "";

  constructor(private readonly transcript: Container) {}

  apply(state: { readonly entries: readonly PiShellEntry[]; readonly streamingAssistantText: string }): void {
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
