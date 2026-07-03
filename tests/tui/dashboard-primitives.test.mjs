import assert from "node:assert/strict";
import test from "node:test";

import { RoundedPanel, SectionDivider } from "../../packages/tui/src/dashboard-primitives.tsx";
import { getDisplayWidth } from "../../packages/tui/src/text-width.ts";

/**
 * Recursively flatten a React element tree into its string representation.
 * Works for components that use no hooks (pure structural/presentational).
 */
function renderText(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderText).join("");
  if (typeof node === "object" && node.props != null) {
    return renderText(node.props.children);
  }
  return "";
}

// ─── RoundedPanel ────────────────────────────────────────────────────────────
//
// RoundedPanel top border: ╭─{titleContent}─×rightPad╮
//
// The pre-existing "+1 column" off-by-one (the leading ─ before titleContent
// adds a column not compensated by rightPad) is constant and out of scope.
// We isolate only the CJK-specific error by comparing CJK-title top width
// against empty-title top width — they must be equal after the fix.

test("RoundedPanel: CJK title produces same top-border display width as empty title (Korean)", () => {
  const W = 40;

  const emptyEl = RoundedPanel({ title: "", width: W, children: null });
  const emptyChildren = emptyEl.props.children;
  const emptyTop = renderText(emptyChildren[0]);

  const cjkEl = RoundedPanel({ title: "워크스페이스", width: W, children: null });
  const cjkChildren = cjkEl.props.children;
  const cjkTop = renderText(cjkChildren[0]);

  assert.equal(getDisplayWidth(emptyTop), W, `empty top border should match panel width ${W}`);
  assert.equal(getDisplayWidth(cjkTop), W, `CJK top border should match panel width ${W}`);
  assert.equal(
    getDisplayWidth(cjkTop),
    getDisplayWidth(emptyTop),
    `CJK top border display width (${getDisplayWidth(cjkTop)}) should equal empty top border display width (${getDisplayWidth(emptyTop)}). Got:\n  empty: "${emptyTop}"\n  CJK:   "${cjkTop}"`,
  );
});

test("RoundedPanel: ASCII title produces same top-border display width as empty title (sanity check)", () => {
  const W = 40;

  const emptyEl = RoundedPanel({ title: "", width: W, children: null });
  const emptyTop = renderText(emptyEl.props.children[0]);

  const asciiEl = RoundedPanel({ title: "Status", width: W, children: null });
  const asciiTop = renderText(asciiEl.props.children[0]);

  assert.equal(
    getDisplayWidth(asciiTop),
    getDisplayWidth(emptyTop),
    `ASCII top border display width (${getDisplayWidth(asciiTop)}) should equal empty top border display width (${getDisplayWidth(emptyTop)})`,
  );
});

// ─── SectionDivider ──────────────────────────────────────────────────────────
//
// SectionDivider: ─×leftLen {label} ─×rightLen
// Total display width must equal w exactly.

test("SectionDivider: CJK label renders total display width equal to configured width (Korean)", () => {
  const W = 72;
  const el = SectionDivider({ label: "워크스페이스", width: W });
  const line = renderText(el);
  const dw = getDisplayWidth(line);
  assert.equal(
    dw,
    W,
    `SectionDivider with Korean label should have total display width ${W}, got ${dw}. Rendered: "${line}"`,
  );
});

test("SectionDivider: ASCII label renders total display width equal to configured width (sanity check)", () => {
  const W = 72;
  const el = SectionDivider({ label: "Sessions", width: W });
  const line = renderText(el);
  const dw = getDisplayWidth(line);
  assert.equal(
    dw,
    W,
    `SectionDivider with ASCII label should have total display width ${W}, got ${dw}`,
  );
});

test("SectionDivider: empty label renders total display width equal to configured width", () => {
  const W = 72;
  const el = SectionDivider({ label: "", width: W });
  const line = renderText(el);
  const dw = getDisplayWidth(line);
  assert.equal(dw, W, `SectionDivider with empty label should have total display width ${W}, got ${dw}`);
});
