import assert from "node:assert/strict";
import test from "node:test";

import { HeaderChrome, SessionList } from "../../packages/tui/src/dashboard-components.tsx";

/**
 * Recursively flatten a React element tree into its string representation.
 * Elements with children are walked structurally (covers Ink Text/Box);
 * childless composite components (EmptyStateBlock, KeyPill) are invoked
 * directly when they are hook-free, otherwise skipped.
 */
function renderText(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderText).join("");
  if (typeof node === "object") {
    if (node.props?.children != null) {
      return renderText(node.props.children);
    }
    if (typeof node.type === "function") {
      try {
        return renderText(node.type(node.props));
      } catch {
        return "";
      }
    }
  }
  return "";
}

const EMPTY_DETAIL = "Start a Work session and saved conversations will appear here.";

test("empty session list shows the full detail sentence without truncation", () => {
  const element = SessionList({
    sessions: [],
    selectedIndex: 0,
    isActive: true,
    emptyState: "No saved sessions yet.",
    emptyStateDetail: EMPTY_DETAIL,
    emptyStateActionKey: "W",
    emptyStateActionLabel: "start work",
  });
  const text = renderText(element);
  assert.ok(text.includes(EMPTY_DETAIL), `full detail must be visible, got: "${text}"`);
  assert.ok(!text.includes("…"), "empty-state detail must not be ellipsis-truncated");
});

test("header collapses missing git info into one explicit no-git-repo label", () => {
  const element = HeaderChrome({
    branch: "no git repo",
    gitStatus: "no git repo",
    workspacePath: "/tmp/ux-review-empty",
  });
  const text = renderText(element);
  const occurrences = text.split("no git repo").length - 1;
  assert.equal(occurrences, 1, `expected a single no-git-repo label, got: "${text}"`);
  assert.ok(!text.includes("unknown"), "header must not fall back to unknown· unknown");
});

test("header keeps branch and status labels for a real repository", () => {
  const element = HeaderChrome({
    branch: "main",
    gitStatus: "clean",
    workspacePath: "/Users/example/project/unclecode",
  });
  const text = renderText(element);
  assert.ok(text.includes("main"));
  assert.ok(text.includes("clean"));
});
