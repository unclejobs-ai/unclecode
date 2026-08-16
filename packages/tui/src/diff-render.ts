import { getDisplayWidth, truncateForDisplayWidth } from "./text-width.js";

/**
 * Unified diff → terminal rows.
 *
 * A patch printed as plain text makes the reader count `+` and `-` by hand. A
 * line-number gutter and a marker column let the eye find the changed lines
 * without reading them, and an elision marker keeps a large patch to a
 * readable height instead of flooding the transcript.
 *
 * Pure and string-only so the layout is testable without mounting Ink; the
 * component layer only decides colour.
 */

export type DiffRowKind = "added" | "removed" | "context" | "elision" | "header";

export type DiffRow = {
  readonly kind: DiffRowKind;
  /** Line number in the post-image; absent for removals and elisions. */
  readonly lineNumber?: number;
  readonly text: string;
};

export type DiffSummary = {
  readonly added: number;
  readonly removed: number;
};

type Hunk = {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly string[];
};

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;
const FILE_HEADER_RE = /^(?:diff --git |index |---\s|\+\+\+\s|new file mode|deleted file mode|similarity index|rename )/;

/**
 * Parse a unified diff. Returns null when the text is not one, so callers can
 * fall back to plain code-block rendering rather than mangle it.
 */
export function parseUnifiedDiff(text: string): readonly Hunk[] | null {
  const lines = text.split("\n");
  const hunks: Hunk[] = [];
  let current: { oldStart: number; newStart: number; lines: string[] } | undefined;

  for (const line of lines) {
    const header = HUNK_HEADER_RE.exec(line);
    if (header) {
      if (current) hunks.push(current);
      current = {
        oldStart: Number.parseInt(header[1] ?? "1", 10),
        newStart: Number.parseInt(header[2] ?? "1", 10),
        lines: [],
      };
      continue;
    }
    if (!current) {
      // Preamble before the first hunk is file metadata; anything else means
      // this is not a diff.
      if (line.trim() === "" || FILE_HEADER_RE.test(line)) continue;
      return null;
    }
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    current.lines.push(line);
  }
  if (current) hunks.push(current);
  return hunks.length > 0 ? hunks : null;
}

export function summarizeDiff(hunks: readonly Hunk[]): DiffSummary {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }
  return { added, removed };
}

export function formatDiffSummary(summary: DiffSummary): string {
  const parts = [
    `Added ${summary.added} ${summary.added === 1 ? "line" : "lines"}`,
    `removed ${summary.removed} ${summary.removed === 1 ? "line" : "lines"}`,
  ];
  return parts.join(", ");
}

/**
 * Flatten hunks into display rows, capping context around each change.
 *
 * `contextLines` is how many unchanged lines to keep either side of a change;
 * anything further is replaced by a single elision row. Without the cap a
 * whole-file patch would push the rest of the conversation off screen.
 */
export function buildDiffRows(
  hunks: readonly Hunk[],
  options: { readonly contextLines?: number; readonly maxRows?: number } = {},
): readonly DiffRow[] {
  const contextLines = options.contextLines ?? 3;
  const maxRows = options.maxRows ?? 60;
  const rows: DiffRow[] = [];

  hunks.forEach((hunk, hunkIndex) => {
    if (hunkIndex > 0) rows.push({ kind: "elision", text: "..." });

    // Number every line first so the gutter is correct before any trimming.
    let newLine = hunk.newStart;
    const numbered = hunk.lines.map((line) => {
      if (line.startsWith("-")) {
        return { kind: "removed" as const, text: line.slice(1), lineNumber: undefined };
      }
      const lineNumber = newLine;
      newLine += 1;
      return line.startsWith("+")
        ? { kind: "added" as const, text: line.slice(1), lineNumber }
        : { kind: "context" as const, text: line.startsWith(" ") ? line.slice(1) : line, lineNumber };
    });

    const changed = numbered
      .map((row, index) => (row.kind === "context" ? -1 : index))
      .filter((index) => index >= 0);
    if (changed.length === 0) return;

    const keep = new Set<number>();
    for (const index of changed) {
      for (let offset = -contextLines; offset <= contextLines; offset += 1) {
        const candidate = index + offset;
        if (candidate >= 0 && candidate < numbered.length) keep.add(candidate);
      }
    }

    let elided = false;
    numbered.forEach((row, index) => {
      if (!keep.has(index)) {
        if (!elided) {
          rows.push({ kind: "elision", text: "..." });
          elided = true;
        }
        return;
      }
      elided = false;
      rows.push(
        row.lineNumber === undefined
          ? { kind: row.kind, text: row.text }
          : { kind: row.kind, lineNumber: row.lineNumber, text: row.text },
      );
    });
  });

  if (rows.length <= maxRows) return rows;
  const head = rows.slice(0, maxRows - 1);
  const hiddenCount = rows.length - head.length;
  return [...head, { kind: "elision", text: `... +${hiddenCount} more lines` }];
}

const MARKERS: Readonly<Record<DiffRowKind, string>> = {
  added: "+",
  removed: "-",
  context: " ",
  elision: " ",
  header: " ",
};

/**
 * Render one row as `  12 + text`, with the gutter width shared across rows so
 * the marker column forms a straight edge.
 */
export function formatDiffRow(
  row: DiffRow,
  input: { readonly gutterWidth: number; readonly width: number },
): string {
  const gutter = row.lineNumber === undefined
    ? " ".repeat(input.gutterWidth)
    : String(row.lineNumber).padStart(input.gutterWidth, " ");
  if (row.kind === "elision") {
    return truncateForDisplayWidth(`${" ".repeat(input.gutterWidth)}   ${row.text}`, input.width);
  }
  const prefix = `${gutter} ${MARKERS[row.kind]} `;
  return truncateForDisplayWidth(`${prefix}${row.text}`, input.width);
}

export function resolveDiffGutterWidth(rows: readonly DiffRow[]): number {
  const widest = rows.reduce(
    (max, row) => (row.lineNumber === undefined ? max : Math.max(max, getDisplayWidth(String(row.lineNumber)))),
    1,
  );
  return widest;
}
