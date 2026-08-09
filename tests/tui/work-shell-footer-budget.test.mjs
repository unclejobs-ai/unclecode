import assert from "node:assert/strict";
import test from "node:test";

import {
  formatWorkShellBudgetChip,
  formatWorkShellFooterLineFast,
} from "../../packages/tui/src/work-shell-footer-fast-paths.ts";

// The footer used to read `~/project/unclecode · ▤ 31 ctx · ~1k`: a source
// count only this app cares about, and a raw token figure with nothing to
// compare it against. Path · branch on the left and a budget percentage on the
// right is the shape every terminal agent converges on, because "which
// checkout" and "how full is the window" are what change the next action.

test("budget chip states the window fraction, not a bare token count", () => {
  assert.equal(formatWorkShellBudgetChip("▤ 31 ctx · ~42k", 272_000), "15%/272K");
  assert.equal(formatWorkShellBudgetChip("▤ 31 ctx · ~1k", 272_000), "0.4%/272K");
  assert.equal(formatWorkShellBudgetChip("▤ 2 ctx · ~500", 200_000), "0.3%/200K");
});

test("budget chip renders million-token windows compactly", () => {
  assert.equal(formatWorkShellBudgetChip("▤ 9 ctx · ~150k", 1_000_000), "15%/1M");
});

test("budget chip stays silent when either side is unknown", () => {
  assert.equal(formatWorkShellBudgetChip("▤ 31 ctx · tokens unknown", 272_000), undefined);
  assert.equal(formatWorkShellBudgetChip(undefined, 272_000), undefined);
  assert.equal(formatWorkShellBudgetChip("▤ 31 ctx · ~1k", undefined), undefined);
  assert.equal(formatWorkShellBudgetChip("▤ 31 ctx · ~1k", 0), undefined);
});

test("footer puts path and branch left, budget hard right", () => {
  const footer = formatWorkShellFooterLineFast({
    cwd: "/Users/dev/project/unclecode",
    home: "/Users/dev",
    model: "gpt-5.6-sol",
    reasoningLabel: "",
    mode: "work",
    authLabel: "Saved OAuth",
    contextIndicator: "▤ 31 ctx · ~42k",
    modelWindow: 272_000,
    branch: "main",
    width: 60,
  });

  assert.equal(footer.length, 60, `footer should fill the row: ${JSON.stringify(footer)}`);
  assert.match(footer, /^~\/project\/unclecode\s+·\s+main/);
  assert.match(footer, /15%\/272K$/);
});

test("footer falls back to the context chip when no budget can be computed", () => {
  const footer = formatWorkShellFooterLineFast({
    cwd: "/Users/dev/project/unclecode",
    home: "/Users/dev",
    model: "gpt-5.6-sol",
    reasoningLabel: "",
    mode: "work",
    authLabel: "Saved OAuth",
    contextIndicator: "▤ 31 ctx · tokens unknown",
    branch: "main",
  });

  assert.match(footer, /~\/project\/unclecode\s+·\s+main/);
  assert.match(footer, /31 ctx/);
});

test("footer without a branch still renders the path", () => {
  const footer = formatWorkShellFooterLineFast({
    cwd: "/Users/dev/project/unclecode",
    home: "/Users/dev",
    model: "gpt-5.6-sol",
    reasoningLabel: "",
    mode: "work",
    authLabel: "Saved OAuth",
  });

  assert.equal(footer, "~/project/unclecode");
});
