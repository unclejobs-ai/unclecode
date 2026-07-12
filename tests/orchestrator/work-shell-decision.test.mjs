import assert from "node:assert/strict";
import test from "node:test";

import {
  formatWorkShellDecisionLines,
  resolveWorkShellDecisionReply,
} from "@unclecode/orchestrator";

const request = {
  id: "decision-1",
  title: "Execution choice",
  questions: [{
    id: "strategy",
    question: "Which strategy?",
    options: [
      { label: "Safe", description: "Inspect before editing." },
      { label: "Fast", description: "Execute the focused plan." },
    ],
    recommended: 0,
  }],
};

test("decision reply parser accepts option numbers and labels", () => {
  assert.deepEqual(resolveWorkShellDecisionReply({ request, value: "2" }), {
    kind: "answered",
    result: {
      status: "answered",
      answers: [{ id: "strategy", selectedOptions: ["Fast"] }],
    },
  });
  assert.deepEqual(resolveWorkShellDecisionReply({ request, value: "safe" }), {
    kind: "answered",
    result: {
      status: "answered",
      answers: [{ id: "strategy", selectedOptions: ["Safe"] }],
    },
  });
});

test("decision reply parser keeps cancellation and invalid choices explicit", () => {
  assert.deepEqual(resolveWorkShellDecisionReply({ request, value: "/cancel" }), { kind: "cancelled" });
  assert.deepEqual(resolveWorkShellDecisionReply({ request, value: "3" }), {
    kind: "invalid",
    message: "Choose one option for strategy.",
  });
});

test("decision reply parser handles multi-question replies and multi-select options", () => {
  const multiRequest = {
    id: "decision-2",
    questions: [
      {
        id: "scope",
        question: "Which areas?",
        options: [{ label: "Docs" }, { label: "Tests" }],
        multi: true,
      },
      {
        id: "mode",
        question: "Which mode?",
        options: [{ label: "Review" }, { label: "Execute" }],
      },
    ],
  };

  assert.deepEqual(
    resolveWorkShellDecisionReply({ request: multiRequest, value: "scope: 1,2; mode: Execute" }),
    {
      kind: "answered",
      result: {
        status: "answered",
        answers: [
          { id: "scope", selectedOptions: ["Docs", "Tests"] },
          { id: "mode", selectedOptions: ["Execute"] },
        ],
      },
    },
  );
  assert.match(formatWorkShellDecisionLines(request).join("\n"), /1\. Safe.*recommended.*Reply with an option number/s);
  assert.match(
    formatWorkShellDecisionLines(multiRequest).join("\n"),
    /Question · scope: Which areas\?.*Question · mode: Which mode\?.*Reply question-id: option-number/s,
  );
});
