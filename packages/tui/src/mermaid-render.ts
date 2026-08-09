import { getDisplayWidth, truncateForDisplayWidth } from "./text-width.js";

/**
 * Mermaid flowchart → ASCII diagram, for terminals.
 *
 * Terminals cannot render mermaid graphically, and dumping the source as a
 * code block shows syntax instead of a picture. This module parses the
 * flowchart subset that assistant replies actually use and draws it on a
 * character canvas with box-drawing glyphs.
 *
 * Supported: `flowchart`/`graph` with LR|RL|TD|TB|BT direction, node shapes
 * [rect] (round) ((circle)) {decision}, edges --> --- -.-> ==> with optional
 * |edge labels|, and chained statements (A --> B --> C).
 *
 * Everything else (sequenceDiagram, classDiagram, pie, ...) returns null so
 * the caller falls back to plain code-block rendering. That is deliberate:
 * a wrong picture is worse than legible source.
 */

export type MermaidNodeShape = "rect" | "round" | "decision";

export type MermaidNode = {
  readonly id: string;
  readonly label: string;
  readonly shape: MermaidNodeShape;
};

export type MermaidEdge = {
  readonly from: string;
  readonly to: string;
  readonly label: string;
};

export type MermaidDiagram = {
  readonly direction: "LR" | "TD";
  readonly nodes: readonly MermaidNode[];
  readonly edges: readonly MermaidEdge[];
};

// ── Parsing ──────────────────────────────────────────────────────────

const HEADER_RE = /^\s*(?:flowchart|graph)\s+(LR|RL|TD|TB|BT)?\s*$/i;
const IGNORED_STATEMENT_RE = /^\s*(?:%%|classDef\b|class\b|style\b|linkStyle\b|click\b|subgraph\b|end\b|direction\b)/i;
const ARROW_RE = /^\s*(<?-{2,3}>?|-\.-+>?|={2,3}>?|--[ox])(?:\|([^|]*)\|)?\s*/;
const ID_RE = /^[A-Za-z0-9_.-]+/;

const SHAPE_DELIMITERS: readonly {
  readonly open: string;
  readonly close: string;
  readonly shape: MermaidNodeShape;
}[] = [
  { open: "((", close: "))", shape: "round" },
  { open: "([", close: "])", shape: "round" },
  { open: "[[", close: "]]", shape: "rect" },
  { open: "{{", close: "}}", shape: "decision" },
  { open: "[", close: "]", shape: "rect" },
  { open: "(", close: ")", shape: "round" },
  { open: "{", close: "}", shape: "decision" },
];

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** Mermaid labels use <br/> for line breaks; terminals want a space. */
function normalizeLabel(value: string): string {
  return stripQuotes(value).replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim();
}

type NodeRef = { readonly id: string; readonly rest: string };

/**
 * Read one `id[label]` reference from the head of `text`. Returns null when
 * the head is not a node reference, which ends statement parsing.
 */
function readNodeRef(
  text: string,
  collect: (node: MermaidNode) => void,
): NodeRef | null {
  const head = text.replace(/^\s+/, "");
  const idMatch = ID_RE.exec(head);
  if (!idMatch) return null;
  const id = idMatch[0];
  const afterId = head.slice(id.length);

  for (const delimiter of SHAPE_DELIMITERS) {
    if (!afterId.startsWith(delimiter.open)) continue;
    const closeIndex = afterId.indexOf(delimiter.close, delimiter.open.length);
    if (closeIndex < 0) continue;
    const raw = afterId.slice(delimiter.open.length, closeIndex);
    collect({ id, label: normalizeLabel(raw) || id, shape: delimiter.shape });
    return { id, rest: afterId.slice(closeIndex + delimiter.close.length) };
  }

  collect({ id, label: id, shape: "rect" });
  return { id, rest: afterId };
}

/**
 * Parse a mermaid source block. Returns null when the source is not a
 * flowchart we can draw, or when it declares no edges to lay out.
 */
export function parseMermaid(source: string): MermaidDiagram | null {
  const lines = source.split("\n");
  let direction: "LR" | "TD" | null = null;
  const nodeOrder: string[] = [];
  const nodesById = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];

  const collect = (node: MermaidNode): void => {
    const existing = nodesById.get(node.id);
    if (!existing) {
      nodeOrder.push(node.id);
      nodesById.set(node.id, node);
      return;
    }
    // A later richer declaration (id[Label]) upgrades a bare `id` mention.
    if (existing.label === existing.id && node.label !== node.id) {
      nodesById.set(node.id, node);
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (direction === null) {
      const header = HEADER_RE.exec(trimmed);
      if (header) {
        const raw = (header[1] ?? "TD").toUpperCase();
        direction = raw === "LR" || raw === "RL" ? "LR" : "TD";
        continue;
      }
      // A flowchart must open with its header; anything else is another
      // diagram type we do not draw.
      return null;
    }

    if (IGNORED_STATEMENT_RE.test(trimmed)) continue;

    let cursor = trimmed;
    let previous = readNodeRef(cursor, collect);
    if (!previous) continue;
    cursor = previous.rest;

    while (cursor.trim().length > 0) {
      const arrow = ARROW_RE.exec(cursor);
      if (!arrow) break;
      cursor = cursor.slice(arrow[0].length);
      const next = readNodeRef(cursor, collect);
      if (!next) break;
      edges.push({
        from: previous.id,
        to: next.id,
        label: normalizeLabel(arrow[2] ?? ""),
      });
      previous = next;
      cursor = next.rest;
    }
  }

  if (direction === null || edges.length === 0) return null;
  const nodes = nodeOrder
    .map((id) => nodesById.get(id))
    .filter((node): node is MermaidNode => node !== undefined);
  if (nodes.length === 0) return null;
  return { direction, nodes, edges };
}

// ── Canvas ───────────────────────────────────────────────────────────

const DIR_UP = 1;
const DIR_RIGHT = 2;
const DIR_DOWN = 4;
const DIR_LEFT = 8;

const MASK_GLYPHS: Readonly<Record<number, string>> = {
  [DIR_UP]: "│",
  [DIR_DOWN]: "│",
  [DIR_UP | DIR_DOWN]: "│",
  [DIR_LEFT]: "─",
  [DIR_RIGHT]: "─",
  [DIR_LEFT | DIR_RIGHT]: "─",
  [DIR_DOWN | DIR_RIGHT]: "┌",
  [DIR_DOWN | DIR_LEFT]: "┐",
  [DIR_UP | DIR_RIGHT]: "└",
  [DIR_UP | DIR_LEFT]: "┘",
  [DIR_UP | DIR_DOWN | DIR_RIGHT]: "├",
  [DIR_UP | DIR_DOWN | DIR_LEFT]: "┤",
  [DIR_DOWN | DIR_LEFT | DIR_RIGHT]: "┬",
  [DIR_UP | DIR_LEFT | DIR_RIGHT]: "┴",
  [DIR_UP | DIR_DOWN | DIR_LEFT | DIR_RIGHT]: "┼",
};

const GLYPH_MASKS = new Map<string, number>(
  Object.entries(MASK_GLYPHS)
    .map(([mask, glyph]): readonly [string, number] => [glyph, Number(mask)])
    // Later entries win, so seed only the canonical single-mask glyphs.
    .filter(([glyph]) => glyph !== "│" && glyph !== "─")
    .concat([["│", DIR_UP | DIR_DOWN], ["─", DIR_LEFT | DIR_RIGHT]]),
);

/**
 * Trailing cell of a double-width character. One array index equals one
 * display column, so a CJK glyph claims its own cell plus this filler; the
 * filler renders as nothing when the row is joined. Without it, box borders
 * drift right of their top/bottom rules on Korean labels.
 */
const WIDE_CHAR_FILLER = "\u0000";

/**
 * A fixed-size character grid indexed by display column. Line segments merge
 * into junction glyphs when they cross, so routed edges read as one connected
 * diagram rather than overwriting each other. Box cells are protected: routed
 * edges never carve through a node.
 */
class Canvas {
  private readonly cells: string[][];
  private readonly locked: boolean[][];

  constructor(readonly width: number, readonly height: number) {
    this.cells = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => " "),
    );
    this.locked = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => false),
    );
  }

  private inBounds(row: number, col: number): boolean {
    return row >= 0 && row < this.height && col >= 0 && col < this.width;
  }

  set(row: number, col: number, char: string): void {
    if (!this.inBounds(row, col)) return;
    const line = this.cells[row];
    if (!line) return;
    line[col] = char;
  }

  /** Write text starting at a display column, honouring double-width glyphs. */
  write(row: number, col: number, text: string, lock = false): void {
    let offset = 0;
    for (const char of text) {
      const charWidth = Math.max(1, getDisplayWidth(char));
      this.set(row, col + offset, char);
      for (let filler = 1; filler < charWidth; filler += 1) {
        this.set(row, col + offset + filler, WIDE_CHAR_FILLER);
      }
      if (lock) {
        for (let cell = 0; cell < charWidth; cell += 1) {
          const lockRow = this.locked[row];
          if (lockRow && this.inBounds(row, col + offset + cell)) {
            lockRow[col + offset + cell] = true;
          }
        }
      }
      offset += charWidth;
    }
  }

  /** Draw a line segment, merging with any segment already in the cell. */
  merge(row: number, col: number, mask: number): void {
    if (!this.inBounds(row, col)) return;
    if (this.locked[row]?.[col] === true) return;
    const line = this.cells[row];
    if (!line) return;
    const existing = line[col] ?? " ";
    const existingMask = existing === " " ? 0 : GLYPH_MASKS.get(existing);
    if (existingMask === undefined) return;
    const glyph = MASK_GLYPHS[mask | existingMask];
    if (glyph !== undefined) {
      line[col] = glyph;
    }
  }

  toLines(): readonly string[] {
    return this.cells.map((line) =>
      line
        .map((cell) => (cell === WIDE_CHAR_FILLER ? "" : cell))
        .join("")
        .replace(/\s+$/, ""),
    );
  }
}

// ── Layout ───────────────────────────────────────────────────────────

const BOX_BORDERS: Readonly<Record<MermaidNodeShape, readonly string[]>> = {
  // topLeft, horizontal, topRight, vertical, bottomLeft, bottomRight
  rect: ["┌", "─", "┐", "│", "└", "┘"],
  round: ["╭", "─", "╮", "│", "╰", "╯"],
  decision: ["╔", "═", "╗", "║", "╚", "╝"],
};

const BOX_HEIGHT = 3;
const LABEL_PADDING = 2; // one space either side of the label
const MAX_LABEL_WIDTH = 28;

type Placed = {
  readonly node: MermaidNode;
  readonly label: string;
  readonly rank: number;
  readonly row: number;
  readonly col: number;
  readonly width: number;
};

/**
 * Assign each node a rank: one past its deepest predecessor. Cycles are
 * broken by capping the relaxation passes, which keeps a self-referential
 * graph from spinning.
 */
function assignRanks(diagram: MermaidDiagram): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const node of diagram.nodes) ranks.set(node.id, 0);
  for (let pass = 0; pass < diagram.nodes.length; pass += 1) {
    let changed = false;
    for (const edge of diagram.edges) {
      if (edge.from === edge.to) continue;
      const fromRank = ranks.get(edge.from) ?? 0;
      const toRank = ranks.get(edge.to) ?? 0;
      if (toRank < fromRank + 1) {
        ranks.set(edge.to, fromRank + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return ranks;
}

function groupByRank(
  diagram: MermaidDiagram,
  ranks: Map<string, number>,
): readonly (readonly MermaidNode[])[] {
  const maxRank = Math.max(0, ...diagram.nodes.map((n) => ranks.get(n.id) ?? 0));
  const layers: MermaidNode[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const node of diagram.nodes) {
    const layer = layers[ranks.get(node.id) ?? 0];
    if (layer) layer.push(node);
  }
  return layers;
}

function boxLabel(node: MermaidNode): string {
  return truncateForDisplayWidth(node.label, MAX_LABEL_WIDTH);
}

function boxWidth(label: string): number {
  return getDisplayWidth(label) + LABEL_PADDING + 2;
}

function drawBox(canvas: Canvas, placed: Placed): void {
  const borders = BOX_BORDERS[placed.node.shape];
  const [topLeft, horizontal, topRight, vertical, bottomLeft, bottomRight] = [
    borders[0] ?? "┌",
    borders[1] ?? "─",
    borders[2] ?? "┐",
    borders[3] ?? "│",
    borders[4] ?? "└",
    borders[5] ?? "┘",
  ];
  const inner = placed.width - 2;
  canvas.write(placed.row, placed.col, `${topLeft}${horizontal.repeat(inner)}${topRight}`);
  const labelWidth = getDisplayWidth(placed.label);
  const leftPad = Math.max(1, Math.floor((inner - labelWidth) / 2));
  const rightPad = Math.max(0, inner - labelWidth - leftPad);
  canvas.write(
    placed.row + 1,
    placed.col,
    `${vertical}${" ".repeat(leftPad)}${placed.label}${" ".repeat(rightPad)}${vertical}`,
  );
  canvas.write(
    placed.row + 2,
    placed.col,
    `${bottomLeft}${horizontal.repeat(inner)}${bottomRight}`,
  );
}

/** Fill strictly between two columns; the caller owns the turn glyphs at each end. */
function drawHorizontalRun(canvas: Canvas, row: number, fromCol: number, toCol: number): void {
  const lo = Math.min(fromCol, toCol) + 1;
  const hi = Math.max(fromCol, toCol) - 1;
  for (let col = lo; col <= hi; col += 1) {
    canvas.merge(row, col, DIR_LEFT | DIR_RIGHT);
  }
}

/** Fill strictly between two rows; the caller owns the turn glyphs at each end. */
function drawVerticalRun(canvas: Canvas, col: number, fromRow: number, toRow: number): void {
  const lo = Math.min(fromRow, toRow) + 1;
  const hi = Math.max(fromRow, toRow) - 1;
  for (let row = lo; row <= hi; row += 1) {
    canvas.merge(row, col, DIR_UP | DIR_DOWN);
  }
}

function layoutTopDown(diagram: MermaidDiagram, maxWidth: number): readonly string[] | null {
  const ranks = assignRanks(diagram);
  const layers = groupByRank(diagram, ranks);
  const hasEdgeLabel = diagram.edges.some((edge) => edge.label.length > 0);
  const bandHeight = hasEdgeLabel ? 3 : 2;
  const gap = 3;

  const layerWidths = layers.map((layer) =>
    layer.reduce((total, node) => total + boxWidth(boxLabel(node)), 0) +
    gap * Math.max(0, layer.length - 1),
  );
  const canvasWidth = Math.max(1, ...layerWidths);
  if (canvasWidth > maxWidth) return null;

  const placedById = new Map<string, Placed>();
  layers.forEach((layer, rank) => {
    let col = Math.floor((canvasWidth - (layerWidths[rank] ?? 0)) / 2);
    const row = rank * (BOX_HEIGHT + bandHeight);
    for (const node of layer) {
      const label = boxLabel(node);
      const width = boxWidth(label);
      placedById.set(node.id, { node, label, rank, row, col, width });
      col += width + gap;
    }
  });

  const canvasHeight = layers.length * BOX_HEIGHT + Math.max(0, layers.length - 1) * bandHeight;
  const canvas = new Canvas(canvasWidth, canvasHeight);
  for (const placed of placedById.values()) drawBox(canvas, placed);

  for (const edge of diagram.edges) {
    const from = placedById.get(edge.from);
    const to = placedById.get(edge.to);
    if (!from || !to || from === to) continue;
    const fromCol = from.col + Math.floor(from.width / 2);
    const toCol = to.col + Math.floor(to.width / 2);
    const startRow = from.row + BOX_HEIGHT;
    const arrowRow = to.row - 1;
    if (arrowRow < startRow) continue;

    // Descend from the source, turn on the routing row, drop into the target.
    const turnRow = arrowRow - 1 >= startRow ? arrowRow - 1 : startRow;
    for (let row = startRow; row < turnRow; row += 1) {
      canvas.merge(row, fromCol, DIR_UP | DIR_DOWN);
    }
    if (fromCol === toCol) {
      canvas.merge(turnRow, fromCol, DIR_UP | DIR_DOWN);
    } else {
      canvas.merge(turnRow, fromCol, DIR_UP | (toCol > fromCol ? DIR_RIGHT : DIR_LEFT));
      drawHorizontalRun(canvas, turnRow, fromCol, toCol);
      canvas.merge(turnRow, toCol, DIR_DOWN | (toCol > fromCol ? DIR_LEFT : DIR_RIGHT));
    }
    for (let row = turnRow + 1; row < arrowRow; row += 1) {
      canvas.merge(row, toCol, DIR_UP | DIR_DOWN);
    }
    canvas.set(arrowRow, toCol, "▼");

    if (edge.label.length > 0) {
      const labelRow = startRow;
      const labelCol = Math.min(fromCol, toCol) + 2;
      const room = canvasWidth - labelCol;
      if (room > 2) {
        canvas.write(labelRow, labelCol, truncateForDisplayWidth(edge.label, room));
      }
    }
  }

  return canvas.toLines();
}

function layoutLeftRight(diagram: MermaidDiagram, maxWidth: number): readonly string[] | null {
  const ranks = assignRanks(diagram);
  const layers = groupByRank(diagram, ranks);
  const rowGap = 1;

  // Each gap between columns is 5 wide for ──▶, widened only where a labelled
  // edge starts so one long label cannot inflate the whole diagram.
  const gapCount = Math.max(0, layers.length - 1);
  const bandWidths = Array.from({ length: gapCount }, () => 5);
  for (const edge of diagram.edges) {
    if (edge.label.length === 0) continue;
    const rank = ranks.get(edge.from) ?? 0;
    if (rank >= gapCount) continue;
    bandWidths[rank] = Math.max(bandWidths[rank] ?? 5, getDisplayWidth(edge.label) + 6);
  }

  const columnWidths = layers.map((layer) =>
    Math.max(1, ...layer.map((node) => boxWidth(boxLabel(node)))),
  );
  const canvasWidth =
    columnWidths.reduce((total, width) => total + width, 0) +
    bandWidths.reduce((total, width) => total + width, 0);
  if (canvasWidth > maxWidth) return null;

  const columnStarts: number[] = [];
  let cursor = 0;
  columnWidths.forEach((width, rank) => {
    columnStarts.push(cursor);
    cursor += width + (bandWidths[rank] ?? 0);
  });

  const placedById = new Map<string, Placed>();
  let canvasHeight = 0;
  layers.forEach((layer, rank) => {
    let row = 0;
    const width = columnWidths[rank] ?? 1;
    const col = columnStarts[rank] ?? 0;
    for (const node of layer) {
      placedById.set(node.id, { node, label: boxLabel(node), rank, row, col, width });
      row += BOX_HEIGHT + rowGap;
    }
    canvasHeight = Math.max(canvasHeight, row - rowGap);
  });

  const canvas = new Canvas(canvasWidth, Math.max(1, canvasHeight));
  for (const placed of placedById.values()) drawBox(canvas, placed);

  for (const edge of diagram.edges) {
    const from = placedById.get(edge.from);
    const to = placedById.get(edge.to);
    if (!from || !to || from === to) continue;
    const fromRow = from.row + 1;
    const toRow = to.row + 1;
    const startCol = from.col + from.width;
    const arrowCol = to.col - 1;
    if (arrowCol < startCol) continue;

    if (fromRow === toRow) {
      for (let col = startCol; col < arrowCol; col += 1) {
        canvas.merge(fromRow, col, DIR_LEFT | DIR_RIGHT);
      }
    } else {
      // Run out of the source, turn once, then run into the target's row.
      const turnCol = Math.max(startCol, arrowCol - 1);
      for (let col = startCol; col < turnCol; col += 1) {
        canvas.merge(fromRow, col, DIR_LEFT | DIR_RIGHT);
      }
      canvas.merge(fromRow, turnCol, DIR_LEFT | (toRow > fromRow ? DIR_DOWN : DIR_UP));
      drawVerticalRun(canvas, turnCol, fromRow, toRow);
      canvas.merge(toRow, turnCol, DIR_RIGHT | (toRow > fromRow ? DIR_UP : DIR_DOWN));
      for (let col = turnCol + 1; col < arrowCol; col += 1) {
        canvas.merge(toRow, col, DIR_LEFT | DIR_RIGHT);
      }
    }
    canvas.set(toRow, arrowCol, "▶");

    if (edge.label.length > 0 && arrowCol - startCol > 2) {
      canvas.write(fromRow, startCol + 1, ` ${edge.label} `);
    }
  }

  return canvas.toLines();
}

/**
 * Indented adjacency fallback for graphs too wide to draw as boxes. Still a
 * picture of the structure, just one that always fits.
 */
function layoutOutline(diagram: MermaidDiagram, maxWidth: number): readonly string[] {
  const ranks = assignRanks(diagram);
  const labelById = new Map(diagram.nodes.map((node) => [node.id, boxLabel(node)]));
  const roots = diagram.nodes.filter((node) => (ranks.get(node.id) ?? 0) === 0);
  const outgoing = new Map<string, MermaidEdge[]>();
  for (const edge of diagram.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }

  const lines: string[] = [];
  const visit = (id: string, depth: number, seen: ReadonlySet<string>): void => {
    const indent = "  ".repeat(depth);
    const label = labelById.get(id) ?? id;
    const prefix = depth === 0 ? "● " : "└─▶ ";
    lines.push(truncateForDisplayWidth(`${indent}${prefix}${label}`, maxWidth));
    if (seen.has(id)) return;
    const nextSeen = new Set(seen).add(id);
    for (const edge of outgoing.get(id) ?? []) {
      if (edge.label.length > 0) {
        lines.push(truncateForDisplayWidth(`${indent}    (${edge.label})`, maxWidth));
      }
      visit(edge.to, depth + 1, nextSeen);
    }
  };

  for (const root of roots) visit(root.id, 0, new Set());
  return lines;
}

/**
 * Render a parsed diagram to terminal lines that fit inside `width`.
 * Falls back from boxes to an indented outline when the graph is too wide.
 */
export function renderMermaidLines(
  diagram: MermaidDiagram,
  width: number,
): readonly string[] {
  const available = Math.max(20, width);
  const drawn = diagram.direction === "LR"
    ? layoutLeftRight(diagram, available)
    : layoutTopDown(diagram, available);
  if (drawn && drawn.length > 0) return drawn;

  // A wide top-down graph often fits left-to-right, and vice versa.
  const transposed = diagram.direction === "LR"
    ? layoutTopDown(diagram, available)
    : layoutLeftRight(diagram, available);
  if (transposed && transposed.length > 0) return transposed;

  return layoutOutline(diagram, available);
}

/**
 * Parse and render in one step. Returns null when the source is not a
 * flowchart, so callers can fall back to code-block rendering.
 */
export function renderMermaidBlock(
  source: string,
  width: number,
): readonly string[] | null {
  const diagram = parseMermaid(source);
  if (!diagram) return null;
  return renderMermaidLines(diagram, width);
}
