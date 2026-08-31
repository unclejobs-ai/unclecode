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

// Task 9: the left group carries the workspace (path · branch + dirty counts)
// and the right group carries the cost of the next request (window budget ·
// session spend). Under pressure the path gives up its directories first,
// because "which branch, how dirty" is what the operator cannot reconstruct
// from anywhere else on screen.

const DIRTY = { branch: "main", staged: 90, unstaged: 2, untracked: 34 };
const CLEAN = { branch: "main", staged: 0, unstaged: 0, untracked: 0 };

function workspaceFooter(overrides = {}) {
  return formatWorkShellFooterLineFast({
    cwd: "/Users/dev/project/unclecode",
    home: "/Users/dev",
    model: "gpt-5.6-sol",
    reasoningLabel: "",
    mode: "work",
    authLabel: "Saved OAuth",
    contextIndicator: "▤ 31 ctx · ~69k",
    modelWindow: 272_000,
    gitFacts: DIRTY,
    cost: "$1.16",
    width: 78,
    ...overrides,
  });
}

test("footer states dirty counts beside the branch and session spend beside the budget", () => {
  const footer = workspaceFooter();

  assert.equal(
    footer,
    `~/project/unclecode  ·  main *90 +2 ?34${" ".repeat(23)}25%/272K · $1.16`,
  );
  assert.equal(footer.length, 78);
});

test("footer omits every zero dirty count and an unknown cost", () => {
  assert.equal(
    workspaceFooter({ gitFacts: CLEAN, cost: undefined }),
    `~/project/unclecode  ·  main${" ".repeat(42)}25%/272K`,
  );
});

test("footer keeps the dirty markers it does have in staged, unstaged, untracked order", () => {
  assert.match(
    workspaceFooter({ gitFacts: { ...CLEAN, unstaged: 2 } }),
    /·  main \+2 {2}/,
  );
  assert.match(
    workspaceFooter({ gitFacts: { ...CLEAN, untracked: 34 } }),
    /·  main \?34 {2}/,
  );
  assert.match(
    workspaceFooter({ gitFacts: { branch: "main", staged: 1, unstaged: 0, untracked: 3 } }),
    /·  main \*1 \?3 {2}/,
  );
});

test("footer shows dirty counts for a detached checkout with no branch name", () => {
  assert.match(
    workspaceFooter({ gitFacts: { staged: 0, unstaged: 5, untracked: 0 }, cost: undefined }),
    /^~\/project\/unclecode {2}· {2}\+5 /,
  );
});

test("footer treats a blank cost as no cost at all", () => {
  assert.doesNotMatch(workspaceFooter({ cost: "   " }), /\$/);
});

test("footer compacts the path to its basename before it drops the cost", () => {
  const footer = workspaceFooter({ width: 56 });

  assert.equal(
    footer,
    `unclecode  ·  main *90 +2 ?34${" ".repeat(11)}25%/272K · $1.16`,
  );
  assert.equal(footer.length, 56);
});

test("footer keeps all compact runtime facts when they fit at medium widths", () => {
  const footer = workspaceFooter({
    performance: "TTFT 6.6s · cache HIT",
    width: 78,
  });

  assert.match(footer, /TTFT 6\.6s · cache HIT · \$1\.16$/u);
  assert.match(footer, /25%\/272K/u);
  assert.equal(footer.length, 78);
});

test("footer drops the cost only after the path is already a basename, never the dirty markers", () => {
  const footer = workspaceFooter({ width: 44 });

  assert.equal(footer, `unclecode  ·  main *90 +2 ?34${" ".repeat(7)}25%/272K`);
  assert.doesNotMatch(footer, /\$/, "cost is the first optional fact to go");
  assert.match(footer, /\*90 \+2 \?34/, "dirty markers outlive the cost");
});

test("a missing budget still degrades from full path to a fitting basename", () => {
  assert.equal(
    workspaceFooter({
      contextIndicator: "▤ 31 ctx · tokens unknown",
      modelWindow: 272_000,
      cost: undefined,
      width: 30,
    }),
    "unclecode  ·  main *90 +2 ?34",
  );
});

test("a narrow footer drops path and branch before dirty markers or budget", () => {
  assert.equal(
    workspaceFooter({ width: 30 }),
    `main *90 +2 ?34${" ".repeat(7)}25%/272K`,
  );
  assert.equal(
    workspaceFooter({ width: 24 }),
    `*90 +2 ?34${" ".repeat(6)}25%/272K`,
  );
});

test("below 84 columns the footer still carries branch, dirty state and the window fraction", () => {
  const long = {
    cwd: "/Users/dev/project/unclecode-monorepo-workspace",
    home: "/Users/dev",
  };

  assert.equal(
    workspaceFooter({ ...long, width: 83 }),
    `~/project/unclecode-monorepo-workspace  ·  main *90 +2 ?34${" ".repeat(9)}25%/272K · $1.16`,
  );
  assert.equal(
    workspaceFooter({ ...long, width: 70 }),
    `unclecode-monorepo-workspace  ·  main *90 +2 ?34${" ".repeat(6)}25%/272K · $1.16`,
  );
});

test("footer branch falls back to the explicit prop when no git facts were read", () => {
  assert.equal(
    formatWorkShellFooterLineFast({
      cwd: "/Users/dev/project/unclecode",
      home: "/Users/dev",
      model: "gpt-5.6-sol",
      reasoningLabel: "",
      mode: "work",
      authLabel: "Saved OAuth",
      branch: "release",
    }),
    "~/project/unclecode  ·  release",
  );
});
