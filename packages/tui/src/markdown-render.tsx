import { Box, Text } from "ink";
import React from "react";

import {
  buildDiffRows,
  formatDiffRow,
  formatDiffSummary,
  parseUnifiedDiff,
  resolveDiffGutterWidth,
  summarizeDiff,
} from "./diff-render.js";
import { renderMermaidBlock } from "./mermaid-render.js";
import { getDisplayWidth, wrapDisplayTextFast } from "./text-width.js";

/**
 * Lightweight terminal markdown renderer — no external deps.
 *
 * Supports the subset that matters for AI assistant replies in a terminal:
 * headings, bold, inline code, fenced code blocks, bullet/ordered lists,
 * blockquotes, and pipe tables. Inline italics use *asterisks* only so
 * SNAKE_CASE identifiers render literally in assistant replies.
 * with color + bold styling so structure is visible at a glance.
 *
 * Deliberately NOT a full CommonMark parser — it's a fast line-oriented
 * scanner tuned for chat output. Edge cases fall through to plain text.
 */

export type MarkdownTheme = {
  readonly diffAdded?: string;
  readonly diffRemoved?: string;
  readonly heading: string;
  readonly headingL2: string;
  readonly headingL3: string;
  readonly bold: string;
  readonly inlineCode: string;
  readonly inlineCodeBg: string;
  readonly codeBlock: string;
  readonly bullet: string;
  readonly quote: string;
  readonly tableHeader: string;
  readonly tableBorder: string;
  readonly link: string;
  readonly text: string;
  readonly textMuted: string;
};

type InlineToken =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "bold"; readonly value: string }
  | { readonly kind: "code"; readonly value: string }
  | { readonly kind: "italic"; readonly value: string };

// ── Inline parsing: **bold**, `code`, _italic_ ───────────────────────

function parseInline(text: string): readonly InlineToken[] {
  const tokens: InlineToken[] = [];
  let rest = text;
  while (rest.length > 0) {
    // `code` — greedy first char to next backtick pair
    const codeMatch = /^`([^`]+)`/.exec(rest);
    if (codeMatch && codeMatch[1] !== undefined) {
      tokens.push({ kind: "code", value: codeMatch[1] });
      rest = rest.slice(codeMatch[0].length);
      continue;
    }
    // **bold**
    const boldMatch = /^\*\*([^*]+)\*\*/.exec(rest);
    if (boldMatch && boldMatch[1] !== undefined) {
      tokens.push({ kind: "bold", value: boldMatch[1] });
      rest = rest.slice(boldMatch[0].length);
      continue;
    }
    // __bold__
    const boldMatch2 = /^__([^_]+)__/.exec(rest);
    if (boldMatch2 && boldMatch2[1] !== undefined) {
      tokens.push({ kind: "bold", value: boldMatch2[1] });
      rest = rest.slice(boldMatch2[0].length);
      continue;
    }
    // *italic* — underscore italics disabled so SNAKE_CASE QA markers stay intact
    const asteriskItalicMatch = /^\*([^*\n]+)\*(?!\*)/.exec(rest);
    if (asteriskItalicMatch && asteriskItalicMatch[1] !== undefined) {
      tokens.push({ kind: "italic", value: asteriskItalicMatch[1] });
      rest = rest.slice(asteriskItalicMatch[0].length);
      continue;
    }
    // Plain text — consume up to the next markdown delimiter (` or *)
    const nextDelim = rest.search(/[`*]/);
    if (nextDelim <= 0) {
      tokens.push({ kind: "text", value: nextDelim === 0 ? rest[0] ?? "" : rest });
      rest = nextDelim === 0 ? rest.slice(1) : "";
      continue;
    }
    tokens.push({ kind: "text", value: rest.slice(0, nextDelim) });
    rest = rest.slice(nextDelim);
  }
  return tokens;
}

function renderInline(tokens: readonly InlineToken[], theme: MarkdownTheme): React.ReactNode {
  return tokens.map((token, i) => {
    switch (token.kind) {
      case "bold":
        return <Text key={`b-${i}`} bold color={theme.bold}>{token.value}</Text>;
      case "code":
        return (
          <Text key={`c-${i}`} backgroundColor={theme.inlineCodeBg} color={theme.inlineCode}>
            {token.value}
          </Text>
        );
      case "italic":
        return <Text key={`i-${i}`} italic color={theme.textMuted}>{token.value}</Text>;
      default:
        return <Text key={`t-${i}`} color={theme.text}>{token.value}</Text>;
    }
  });
}

// ── Block-level rendering ────────────────────────────────────────────

type LineKind =
  | { readonly kind: "blank" }
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "code-fence"; readonly lang: string }
  | { readonly kind: "code-line"; readonly text: string }
  | { readonly kind: "bullet"; readonly text: string; readonly ordered: boolean; readonly marker: string }
  | { readonly kind: "quote"; readonly text: string }
  | { readonly kind: "table-separator" }
  | { readonly kind: "table-row"; readonly cells: readonly string[] }
  | { readonly kind: "paragraph"; readonly text: string };

function classifyLine(line: string, inFence: boolean): { readonly line: LineKind; readonly fenceState: boolean } {
  const trimmed = line.trim();

  // Code fence. Checked before anything else so a closing fence is still
  // recognised while inside a block.
  const fenceMatch = /^(`{3,}|~{3,})(\s*\w+)?/.exec(trimmed);
  if (fenceMatch) {
    if (inFence) {
      return { line: { kind: "code-fence", lang: "" }, fenceState: false };
    }
    const lang = fenceMatch[2]?.trim() ?? "";
    return { line: { kind: "code-fence", lang }, fenceState: true };
  }

  // Inside a fence every line is code — including empty ones. The blank check
  // used to run first, so blank lines were pulled out of code blocks entirely:
  // paragraph breaks inside a snippet vanished, and in a diff the missing
  // context line shifted every following line number, making the gutter lie.
  if (inFence) {
    return { line: { kind: "code-line", text: line }, fenceState: true };
  }

  if (trimmed === "") return { line: { kind: "blank" }, fenceState: false };

  // Heading
  const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
  if (headingMatch && headingMatch[1] && headingMatch[2]) {
    return { line: { kind: "heading", level: headingMatch[1].length, text: headingMatch[2] }, fenceState: false };
  }

  // Bullet list (- or *)
  const bulletMatch = /^([-*])\s+(.+)$/.exec(trimmed);
  if (bulletMatch && bulletMatch[2]) {
    return { line: { kind: "bullet", text: bulletMatch[2], ordered: false, marker: "•" }, fenceState: false };
  }
  // Ordered list (1. )
  const orderedMatch = /^(\d+)\.\s+(.+)$/.exec(trimmed);
  if (orderedMatch && orderedMatch[2] && orderedMatch[1]) {
    return { line: { kind: "bullet", text: orderedMatch[2], ordered: true, marker: `${orderedMatch[1]}.` }, fenceState: false };
  }

  // Blockquote
  const quoteMatch = /^>\s*(.*)$/.exec(trimmed);
  if (quoteMatch) {
    return { line: { kind: "quote", text: quoteMatch[1] ?? "" }, fenceState: false };
  }

  // Table separator (|---|---|)
  if (/^\|?[\s-:|]+\|[\s-:|]*$/.test(trimmed) && trimmed.includes("-")) {
    return { line: { kind: "table-separator" }, fenceState: false };
  }
  // Table row (| cell | cell |)
  if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
    const cells = trimmed.slice(1, -1).split("|").map((c) => c.trim());
    return { line: { kind: "table-row", cells }, fenceState: false };
  }

  return { line: { kind: "paragraph", text: line }, fenceState: false };
}

// Compute column widths that fit within `width`.
// Borders/padding cost: for N columns the box is sum(w_i+2) + (N-1) + 2 = sum(w_i) + 3N + 1.
// Strategy: start from natural widths; if total overflows, shrink widest columns
// (wrapping their cells) until it fits. Each column keeps a floor of 4 chars so
// text is never crushed to nothing.
function computeColumnWidths(
  rows: readonly { readonly cells: readonly string[] }[],
  colCount: number,
  width: number,
): readonly number[] {
  const natural: number[] = [];
  for (let c = 0; c < colCount; c += 1) {
    const allCells = rows.map((r) => getDisplayWidth(r.cells[c] ?? ""));
    natural.push(Math.max(4, ...allCells));
  }
  const overhead = 3 * colCount + 1; // borders + padding
  const budget = Math.max(colCount * 6 + overhead, width) - overhead;
  const total = natural.reduce((a, b) => a + b, 0);
  if (total <= budget) return natural;

  // Iteratively shave from the widest column until we fit.
  const widths = natural.slice();
  const floor = 4;
  let guard = budget * colCount + 16;
  while (widths.reduce((a, b) => a + b, 0) > budget && guard > 0) {
    guard -= 1;
    let maxIdx = 0;
    for (let i = 1; i < widths.length; i += 1) {
      if (widths[i]! > widths[maxIdx]!) maxIdx = i;
    }
    if (widths[maxIdx]! <= floor) break;
    widths[maxIdx] = widths[maxIdx]! - 1;
  }
  return widths;
}

function renderTable(
  rows: readonly { readonly cells: readonly string[] }[],
  theme: MarkdownTheme,
  width: number,
): React.ReactNode {
  if (rows.length === 0) return null;
  const colCount = Math.max(...rows.map((r) => r.cells.length));
  const colWidths = computeColumnWidths(rows, colCount, width);

  const separator = `┌${colWidths.map((w) => "─".repeat(w + 2)).join("┬")}┐`;
  const midSep = `├${colWidths.map((w) => "─".repeat(w + 2)).join("┼")}┤`;
  const bottom = `└${colWidths.map((w) => "─".repeat(w + 2)).join("┴")}┘`;

  // Strip markdown delimiters from a cell so wrapping measures display width
  // accurately and tokens stay intact (e.g. `@google/genai` → @google/genai).
  // We re-add styling in renderCellContent via parseInline.
  function stripCellDelimiters(text: string): string {
    return text
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1");
  }

  // Wrap a cell into multiple display lines if it exceeds its column width.
  const wrapCell = (text: string, w: number): readonly string[] => {
    const stripped = stripCellDelimiters(text);
    const cellWidth = getDisplayWidth(stripped);
    if (cellWidth <= w) return [stripped];
    const wrapped = wrapDisplayTextFast(stripped, w);
    return wrapped.length > 0 ? wrapped : [""];
  };

  // Render a cell's visual line. Delimiters are already stripped during
  // wrapping, so we render the plain text in the table's text color. Code
  // values (formerly backtick-wrapped) get the inlineCode color to keep
  // the visual association with code without the background-bleed problem.
  function renderCellContent(text: string, isHeader: boolean): React.ReactNode {
    if (isHeader) {
      return <Text color={theme.tableHeader} bold>{text}</Text>;
    }
    return <Text color={theme.text}>{text}</Text>;
  }

  // A logical row may produce multiple visual lines when cells wrap.
  const renderVisualLine = (
    cells: readonly string[],
    isHeader: boolean,
    rowIndex: number,
    visualLineIndex: number,
  ): React.ReactNode => {
    return (
      <Text key={`tr-${rowIndex}-${visualLineIndex}`}>
        <Text color={theme.tableBorder}>│ </Text>
        {colWidths.map((w, i) => {
          const cellText = cells[i] ?? "";
          const wrapped = wrapCell(cellText, w);
          const visualText = wrapped[visualLineIndex] ?? "";
          const padLen = Math.max(0, w - getDisplayWidth(visualText));
          return (
            <React.Fragment key={`tc-${i}`}>
              {i > 0 ? <Text color={theme.tableBorder}> │ </Text> : null}
              {renderCellContent(visualText, isHeader)}
              {padLen > 0 ? <Text color={theme.text}>{" ".repeat(padLen)}</Text> : null}
            </React.Fragment>
          );
        })}
        <Text color={theme.tableBorder}> │</Text>
      </Text>
    );
  };

  const renderLogicalRow = (
    cells: readonly string[],
    isHeader: boolean,
    rowIndex: number,
  ): React.ReactNode => {
    // Determine how many visual lines this row needs.
    const lineCounts = colWidths.map((w, i) => {
      const cellText = cells[i] ?? "";
      return wrapCell(cellText, w).length;
    });
    const lineCount = Math.max(1, ...lineCounts);
    return Array.from({ length: lineCount }, (_, vi) =>
      renderVisualLine(cells, isHeader, rowIndex, vi),
    );
  };

  const headerRow = rows[0];
  if (!headerRow) return null;

  return (
    <Box flexDirection="column">
      <Text color={theme.tableBorder}>{separator}</Text>
      {renderLogicalRow(headerRow.cells, true, 0)}
      <Text color={theme.tableBorder}>{midSep}</Text>
      {rows.slice(1).map((r, i) => (
        <React.Fragment key={`trow-${i}`}>{renderLogicalRow(r.cells, false, i + 1)}</React.Fragment>
      ))}
      <Text color={theme.tableBorder}>{bottom}</Text>
    </Box>
  );
}

// Box-drawing, block, and arrow glyphs — the diagram's structure as opposed to
// its labels. Drawn in the border tone so node text stays the loudest thing.
const DIAGRAM_GLYPH_RE = /[─-╿▀-▟▲▶▼◀]/;

/**
 * Paint a diagram line so structure recedes and labels read first: border
 * glyphs take the muted border tone, everything else the normal text tone.
 */
function renderDiagramLine(line: string, theme: MarkdownTheme, key: string): React.ReactNode {
  const runs: { readonly text: string; readonly isGlyph: boolean }[] = [];
  for (const char of line) {
    const isGlyph = DIAGRAM_GLYPH_RE.test(char);
    const last = runs[runs.length - 1];
    if (last && last.isGlyph === isGlyph) {
      runs[runs.length - 1] = { text: last.text + char, isGlyph };
      continue;
    }
    runs.push({ text: char, isGlyph });
  }
  return (
    <Text key={key}>
      {runs.map((run, i) => (
        <Text key={`${key}-r${i}`} color={run.isGlyph ? theme.tableBorder : theme.text}>
          {run.text}
        </Text>
      ))}
    </Text>
  );
}

/**
 * Streaming cursor the work shell trims before handing text to the renderer.
 * Kept here (duplicated glyph) because markdown-render must not import from
 * the view; the rule it drives is the same one the view's Rust text caches
 * use: text that is still growing is transient, so parsing results for it
 * are never worth caching — each delta would evict a settled entry.
 */
const STREAMING_CURSOR_GLYPH = "▌";

const MARKDOWN_RENDER_CACHE_MAX_ENTRIES = 64;
const markdownRenderCache = new Map<string, React.ReactNode>();
let markdownRenderParseCount = 0;

function buildMarkdownRenderCacheKey(
  text: string,
  width: number,
  theme: MarkdownTheme,
): string {
  return JSON.stringify({ text, width, theme });
}

/**
 * Cache exclusion rule (mirrors the view's shouldSkipRustTextCacheStore):
 * never cache text that is still streaming. `isStreamingText` is supplied by
 * the view, which knows the entry's streaming state; the raw-glyph check
 * keeps the rule true for callers that pass untrimmed streaming text.
 */
function shouldSkipMarkdownRenderCache(input: {
  readonly text: string;
  readonly isStreamingText?: boolean;
}): boolean {
  return input.isStreamingText === true || input.text.endsWith(STREAMING_CURSOR_GLYPH);
}

/** @internal test seam — parse counter for cache-hit assertions. */
export function getMarkdownRenderParseCountForTest(): number {
  return markdownRenderParseCount;
}

/** @internal test seam — isolates cache state between tests. */
export function resetMarkdownRenderCacheForTest(): void {
  markdownRenderCache.clear();
  markdownRenderParseCount = 0;
}

export function renderMarkdown(
  input: {
    readonly text: string;
    readonly width: number;
    readonly theme: MarkdownTheme;
    /** True while the entry's text is still growing: cache lookups and stores are skipped. */
    readonly isStreamingText?: boolean;
  },
): React.ReactNode {
  const { text, width, theme } = input;
  const skipCache = shouldSkipMarkdownRenderCache(input);
  const cacheKey = skipCache
    ? undefined
    : buildMarkdownRenderCacheKey(text, width, theme);
  if (cacheKey !== undefined) {
    const cached = markdownRenderCache.get(cacheKey);
    if (cached !== undefined) {
      // LRU touch: re-insert so the newest reads survive eviction.
      markdownRenderCache.delete(cacheKey);
      markdownRenderCache.set(cacheKey, cached);
      return cached;
    }
  }
  markdownRenderParseCount += 1;
  const lines = text.split("\n");
  const nodes: React.ReactNode[] = [];
  let inFence = false;
  let currentLang = "";
  let codeLines: string[] = [];
  let tableRows: { readonly cells: readonly string[] }[] = [];

  const flushCode = (keyPrefix: string) => {
    if (codeLines.length === 0) return;

    // A patch is a change, not source. Give it a line-number gutter and a
    // marker column so changed lines are findable without reading them.
    if (currentLang.toLowerCase() === "diff" || currentLang.toLowerCase() === "patch") {
      const hunks = parseUnifiedDiff(codeLines.join("\n"));
      if (hunks) {
        const rows = buildDiffRows(hunks);
        const gutterWidth = resolveDiffGutterWidth(rows);
        const summary = formatDiffSummary(summarizeDiff(hunks));
        nodes.push(
          <Box key={`diff-${keyPrefix}`} flexDirection="column">
            <Text color={theme.textMuted}>{`⎿ ${summary}`}</Text>
            {rows.map((row, i) => (
              <Text
                key={`diff-${keyPrefix}-${i}`}
                color={
                  row.kind === "added"
                    ? (theme.diffAdded ?? theme.text)
                    : row.kind === "removed"
                      ? (theme.diffRemoved ?? theme.textMuted)
                      : theme.textMuted
                }
              >
                {formatDiffRow(row, { gutterWidth, width })}
              </Text>
            ))}
          </Box>,
        );
        codeLines = [];
        currentLang = "";
        return;
      }
    }

    // A mermaid fence is a picture, not source. Draw it when we can parse it;
    // unsupported diagram types fall through to normal code-block rendering.
    if (currentLang.toLowerCase() === "mermaid") {
      const diagram = renderMermaidBlock(codeLines.join("\n"), width);
      if (diagram) {
        nodes.push(
          <Box key={`mermaid-${keyPrefix}`} flexDirection="column" marginTop={0} marginBottom={0}>
            {diagram.map((line, i) =>
              renderDiagramLine(line, theme, `mermaid-${keyPrefix}-${i}`),
            )}
          </Box>,
        );
        codeLines = [];
        currentLang = "";
        return;
      }
    }

    nodes.push(
      <Box key={`code-${keyPrefix}`} flexDirection="column" marginTop={0} marginBottom={0}>
        {currentLang.length > 0 ? (
          <Text>
            <Text color={theme.inlineCode}>{`⌅ ${currentLang}`}</Text>
          </Text>
        ) : null}
        {codeLines.map((cl, i) => (
          <Text key={`cl-${keyPrefix}-${i}`}>
            <Text color={theme.tableBorder}>{"│ "}</Text>
            <Text color={theme.codeBlock}>{cl}</Text>
          </Text>
        ))}
      </Box>,
    );
    codeLines = [];
    currentLang = "";
  };

  const flushTable = (keyPrefix: string) => {
    if (tableRows.length === 0) return;
    nodes.push(
      <Box key={`table-${keyPrefix}`} marginTop={0} marginBottom={0}>
        {renderTable(tableRows, theme, width)}
      </Box>,
    );
    tableRows = [];
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (line === undefined) continue;
    const { line: classified, fenceState } = classifyLine(line, inFence);

    // Handle fence transitions
    if (classified.kind === "code-fence") {
      if (inFence) {
        flushCode(`end-${idx}`);
        inFence = false;
      } else {
        flushTable(`pre-fence-${idx}`);
        currentLang = classified.lang;
        inFence = true;
      }
      continue;
    }
    inFence = fenceState;

    if (classified.kind === "code-line") {
      codeLines.push(classified.text);
      continue;
    }

    // Not in a code block — flush any pending code
    if (!inFence && codeLines.length > 0) {
      flushCode(`mid-${idx}`);
    }

    switch (classified.kind) {
      case "blank": {
        flushTable(`blank-${idx}`);
        nodes.push(<Text key={`blank-${idx}`}> </Text>);
        break;
      }
      case "heading": {
        flushTable(`heading-${idx}`);
        const color = classified.level === 1 ? theme.heading
          : classified.level === 2 ? theme.headingL2
          : theme.headingL3;
        // H1=strong block marker, H2=section, H3=sub-section (smaller weight)
        const prefix = classified.level === 1 ? "■ " : classified.level === 2 ? "▸ " : "– ";
        const isStrong = classified.level <= 2;
        nodes.push(
          <Text key={`h-${idx}`} bold={isStrong} color={color}>
            {prefix}{classified.text}
          </Text>,
        );
        break;
      }
      case "bullet": {
        flushTable(`bullet-${idx}`);
        const markerLabel = classified.ordered ? `${classified.marker}` : classified.marker;
        const indent = classified.ordered ? "  " : "  ";
        nodes.push(
          <Text key={`li-${idx}`}>
            <Text color={theme.bullet}>{`${indent}${markerLabel} `}</Text>
            {renderInline(parseInline(classified.text), theme)}
          </Text>,
        );
        break;
      }
      case "quote": {
        flushTable(`quote-${idx}`);
        nodes.push(
          <Text key={`q-${idx}`}>
            <Text color={theme.quote}>{"▎ "}</Text>
            {renderInline(parseInline(classified.text), theme)}
          </Text>,
        );
        break;
      }
      case "table-row": {
        tableRows.push({ cells: classified.cells });
        break;
      }
      case "table-separator": {
        // Part of the table; separator line is consumed by renderTable.
        break;
      }
      case "paragraph": {
        flushTable(`para-${idx}`);
        const wrapped = wrapDisplayTextFast(classified.text, Math.max(20, width));
        nodes.push(
          <Box key={`p-${idx}`} flexDirection="column">
            {wrapped.map((wl, i) => (
              <Text key={`pl-${idx}-${i}`}>
                {renderInline(parseInline(wl), theme)}
              </Text>
            ))}
          </Box>,
        );
        break;
      }
      default:
        break;
    }
  }

  flushCode("final");
  flushTable("final");

  const rendered = <Box flexDirection="column">{nodes}</Box>;
  if (cacheKey !== undefined) {
    if (markdownRenderCache.size >= MARKDOWN_RENDER_CACHE_MAX_ENTRIES) {
      const oldestKey = markdownRenderCache.keys().next().value;
      if (oldestKey !== undefined) {
        markdownRenderCache.delete(oldestKey);
      }
    }
    markdownRenderCache.set(cacheKey, rendered);
  }
  return rendered;
}

/** @internal test seam — preserves snake_case identifiers in inline markdown. */
export function parseInlineForTest(text: string): readonly InlineToken[] {
  return parseInline(text);
}
