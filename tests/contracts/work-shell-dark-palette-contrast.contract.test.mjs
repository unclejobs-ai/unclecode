import assert from "node:assert/strict";
import test from "node:test";

// WCAG helpers (copied faithfully from tui-work-shell.contract.test.mjs).
// These are pure functions: parseHexColor -> [r,g,b], relativeLuminance does
// the sRGB linearization per WCAG 2.1, contrastRatio is (L1+0.05)/(L2+0.05).

function parseHexColor(hexColor) {
  const match = /^#([0-9a-f]{6})$/i.exec(hexColor);
  assert.ok(match, `${hexColor} should be a 6-digit hex color`);
  const value = match[1];
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function relativeLuminance(hexColor) {
  const [red, green, blue] = parseHexColor(hexColor).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(left, right) {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

// Pinned literal W_DARK values from packages/tui/src/work-shell-view.tsx
// (W_DARK is module-private / not exported, so the literals are pinned here).
const W_DARK = {
  text: "#e6edf3",
  textMuted: "#a6adc8",
  textDim: "#7f849c",
  borderSoft: "#21262d",
  borderDefault: "#45475a",
  user: "#92abdf",
  assistant: "#94e2d5",
  tool: "#9ece6a",
  toolAccent: "#73daca",
  success: "#a6e3a1",
  warning: "#f9e2af",
  error: "#f38ba8",
  spinner: "#fab387",
};

// Dark base background — OLED/true-black GitHub-dark surface.
const BG = "#0d1117";

test("W_DARK text tokens clear WCAG thresholds on dark base", () => {
  const text = contrastRatio(W_DARK.text, BG);
  assert.ok(
    text >= 4.5,
    `W_DARK.text ${W_DARK.text} on ${BG}: ${text.toFixed(3)}:1, expected >= 4.5:1`,
  );
  const textMuted = contrastRatio(W_DARK.textMuted, BG);
  assert.ok(
    textMuted >= 3.0,
    `W_DARK.textMuted ${W_DARK.textMuted} on ${BG}: ${textMuted.toFixed(3)}:1, expected >= 3.0:1`,
  );
  const textDim = contrastRatio(W_DARK.textDim, BG);
  assert.ok(
    textDim >= 3.0,
    `W_DARK.textDim ${W_DARK.textDim} on ${BG}: ${textDim.toFixed(3)}:1, expected >= 3.0:1`,
  );
});

test("W_DARK accent tokens are readable (>=3.0:1) on dark base", () => {
  const accents = {
    user: W_DARK.user,
    assistant: W_DARK.assistant,
    tool: W_DARK.tool,
    toolAccent: W_DARK.toolAccent,
    success: W_DARK.success,
    warning: W_DARK.warning,
    error: W_DARK.error,
    spinner: W_DARK.spinner,
  };
  for (const [role, hex] of Object.entries(accents)) {
    const ratio = contrastRatio(hex, BG);
    assert.ok(
      ratio >= 3.0,
      `W_DARK.${role} ${hex} on ${BG}: ${ratio.toFixed(3)}:1, expected >= 3.0:1`,
    );
  }
});

test("de-collapsed green triple is distinct (tool / toolAccent / success)", () => {
  assert.notEqual(
    W_DARK.tool,
    W_DARK.toolAccent,
    `tool (${W_DARK.tool}) must differ from toolAccent (${W_DARK.toolAccent})`,
  );
  assert.notEqual(
    W_DARK.tool,
    W_DARK.success,
    `tool (${W_DARK.tool}) must differ from success (${W_DARK.success})`,
  );
  assert.notEqual(
    W_DARK.toolAccent,
    W_DARK.success,
    `toolAccent (${W_DARK.toolAccent}) must differ from success (${W_DARK.success})`,
  );
});

test("W_DARK borderDefault has strictly higher contrast than borderSoft (readability-fix invariant)", () => {
  // borderDefault is a structural divider (~2.07:1) and is NOT held to the
  // >=3.0 text threshold; this invariant only asserts the relative improvement
  // introduced by the dark-palette readability fix.
  const soft = contrastRatio(W_DARK.borderSoft, BG);
  const def = contrastRatio(W_DARK.borderDefault, BG);
  assert.ok(
    def > soft,
    `borderDefault ${W_DARK.borderDefault} (${def.toFixed(3)}:1) must have strictly higher contrast than borderSoft ${W_DARK.borderSoft} (${soft.toFixed(3)}:1)`,
  );
});
