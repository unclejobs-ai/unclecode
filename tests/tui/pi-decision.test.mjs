import assert from "node:assert/strict";
import test from "node:test";

import { formatPiDecisionRows, piDecisionOptionCount, readPiShellDecision } from "@unclecode/tui";

const approval = {
  pendingDecision: {
    kind: "security-approval",
    id: "decision-1",
    questions: [{ id: "q1", question: "Run `rm -rf build`?", options: [{ label: "Allow once" }, { label: "Deny" }], recommended: 1 }],
  },
};

test("a pending approval is read from the agent console with numbered one-key answers", () => {
  const decision = readPiShellDecision(approval);
  assert.equal(decision?.id, "decision-1");
  assert.equal(piDecisionOptionCount(decision), 2);
  assert.deepEqual(formatPiDecisionRows(decision), [
    "Run `rm -rf build`?",
    "  1. Allow once",
    "  2. Deny  (recommended)",
    "",
    "1-9 choose · type an answer + Enter · Esc cancel",
  ]);
});

test("several questions have no one-key answer; malformed or absent decisions are none", () => {
  const decision = readPiShellDecision({
    pendingDecision: {
      id: "d2",
      questions: [
        { id: "a", question: "Scope?", options: [{ label: "repo" }] },
        { id: "b", question: "Depth?", options: [{ label: "deep" }] },
      ],
    },
  });
  assert.equal(piDecisionOptionCount(decision), 0);
  assert.equal(formatPiDecisionRows(decision).at(-1), "type an answer + Enter · Esc cancel");
  assert.equal(readPiShellDecision({ pendingDecision: { id: "d3", questions: [] } }), undefined);
  assert.equal(readPiShellDecision(undefined), undefined);
});
