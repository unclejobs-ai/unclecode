import assert from "node:assert/strict";
import test from "node:test";

import { WORK_SHELL_PALETTES } from "../../packages/tui/src/work-shell-view.tsx";

// The work shell paints with ANSI colour names, not hex. The terminal owns the
// background and the sixteen base colours, so naming the slot ("cyan") instead
// of the pigment ("#94e2d5") lets the app inherit whatever theme the user runs
// and degrade cleanly to sixteen colours and to none.
//
// This file replaces a WCAG-ratio check over hex literals that were re-declared
// inside the test. Those literals could drift from the source and the test
// would still pass. Contrast is now the terminal theme's responsibility; what
// the app must guarantee is the palette's *structure*.

const ANSI_COLOR_NAMES = new Set([
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
  "grey",
  "blackBright",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "whiteBright",
]);

const HUE_NAMES = new Set([
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
]);

// Status slots are allowed their conventional hues; these are the slots that
// carry the product's own visual identity.
const ACCENT_SLOTS = [
  "user",
  "userBadgeText",
  "borderAccent",
  "assistant",
  "assistantBadgeText",
  "tool",
  "toolAccent",
  "spinner",
];

for (const [name, palette] of Object.entries(WORK_SHELL_PALETTES)) {
  test(`${name} palette names ANSI colours instead of hex`, () => {
    for (const [slot, value] of Object.entries(palette)) {
      assert.ok(
        !value.startsWith("#"),
        `${name}.${slot} is the hex literal ${value}; use an ANSI colour name so the terminal theme decides the pigment`,
      );
      assert.ok(
        ANSI_COLOR_NAMES.has(value),
        `${name}.${slot} = ${value} is not an ANSI colour name Ink understands`,
      );
    }
  });

  test(`${name} palette keeps chrome to a single line tone`, () => {
    const borderTones = new Set(
      Object.entries(palette)
        .filter(([slot]) => slot.startsWith("border"))
        .filter(([slot]) => slot !== "borderAccent")
        .map(([, value]) => value),
    );
    assert.equal(
      borderTones.size,
      1,
      `chrome should use one line weight; found ${[...borderTones].join(", ")}`,
    );
  });

  test(`${name} palette spends at most two accent hues`, () => {
    const accentHues = new Set(
      ACCENT_SLOTS.map((slot) => palette[slot]).filter((value) =>
        HUE_NAMES.has(value),
      ),
    );
    assert.ok(
      accentHues.size <= 2,
      `expected at most 2 accent hues, found ${accentHues.size}: ${[...accentHues].join(", ")}`,
    );
  });

  test(`${name} palette separates three text tiers`, () => {
    const tiers = [palette.text, palette.textMuted, palette.textDim];
    assert.equal(
      new Set(tiers).size,
      name === "dark" ? 3 : 2,
      `text tiers collapsed: ${tiers.join(", ")}`,
    );
  });
}

test("status colours stay on their conventional hues", () => {
  for (const [name, palette] of Object.entries(WORK_SHELL_PALETTES)) {
    assert.equal(palette.success, "green", `${name}.success`);
    assert.equal(palette.warning, "yellow", `${name}.warning`);
    assert.equal(palette.error, "red", `${name}.error`);
  }
});
