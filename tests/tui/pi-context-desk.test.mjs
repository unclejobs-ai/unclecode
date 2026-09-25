import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPiContextDeskAction,
  formatPiContextDeskLines,
  readPiContextDesk,
  resolvePiContextDeskAction,
} from "@unclecode/tui";

const packet = {
  id: "packet-1",
  version: 1,
  generatedAt: "2026-09-25T00:00:00.000Z",
  title: "Context",
  included: [
    { id: "guidance", category: "workspace-guidance", label: "Workspace guidance", reason: "AGENTS.md", preview: "AGENTS.md is active", tokenEstimate: 30 },
    { id: "stamp", category: "workspace", label: "Bootstrap context", reason: "loaded", preview: "Bootstrap context · today", tokenEstimate: 23 },
  ],
  excluded: [
    { id: "old", category: "memory", label: "Old memory", reason: "budget", preview: "held back", tokenEstimate: 9, includedInModel: false },
  ],
  warnings: [],
  preview: [],
  sourceCounts: {},
  tokenEstimate: 53,
  tokenEstimateState: "estimated",
};

function engineState(overrides = {}) {
  return {
    contextInspectorOpen: true,
    contextPacket: packet,
    contextInspectorPane: "sources",
    contextInspectorCollection: "all",
    contextInspectorCursor: 1,
    contextInspectorExpanded: null,
    contextSourceActionsEnabled: true,
    modelWindow: 200_000,
    ...overrides,
  };
}

test("the desk is read only while the engine has it open with a packet", () => {
  assert.equal(readPiContextDesk(engineState({ contextInspectorOpen: false })), undefined);
  assert.equal(readPiContextDesk(engineState({ contextPacket: undefined })), undefined);
  const desk = readPiContextDesk(engineState({ contextInspectorCollection: "not-a-collection", contextInspectorPane: "sideways" }));
  assert.equal(desk.collection, "all");
  assert.equal(desk.pane, "sources");
});

test("the desk lays out the budget, groups, the cursor row and its preview", () => {
  const lines = formatPiContextDeskLines(readPiContextDesk(engineState()), 100, 30).join("\n");
  assert.match(lines, /Sources · 2 sent · 1 held · ~53t \/ 200k/u);
  assert.match(lines, /› All sources 3/u);
  assert.match(lines, /› ● Bootstrap context · ~23t/u);
  assert.match(lines, /○ Old memory/u);
  assert.match(lines, /PREVIEW\s+Bootstrap context\n {2}Bootstrap context · today/u);
});

test("Space holds back a sent row and includes a held one; ↓ scrolls an expanded detail", () => {
  const calls = [];
  const engine = {
    forgetContextSourceAtCursor: () => calls.push("forget"),
    includeContextSourceAtCursor: () => calls.push("include"),
    moveContextInspectorCursor: (direction) => calls.push(`cursor ${direction}`),
    moveContextInspectorDetailOffset: (direction) => calls.push(`detail ${direction}`),
  };
  const sent = readPiContextDesk(engineState());
  const space = resolvePiContextDeskAction({ desk: sent, value: " ", key: {}, composerEmpty: true });
  assert.equal(applyPiContextDeskAction(engine, sent, space), true);

  const held = readPiContextDesk(engineState({ contextInspectorCursor: 2 }));
  applyPiContextDeskAction(engine, held, resolvePiContextDeskAction({ desk: held, value: " ", key: {}, composerEmpty: true }));

  const expanded = readPiContextDesk(engineState({ contextInspectorExpanded: "stamp" }));
  applyPiContextDeskAction(engine, expanded, resolvePiContextDeskAction({ desk: expanded, value: "", key: { downArrow: true }, composerEmpty: true }));
  assert.deepEqual(calls, ["forget", "include", "detail 1"]);
});

test("a pending draft owns every key, as in the Ink desk", () => {
  const desk = readPiContextDesk(engineState());
  const action = resolvePiContextDeskAction({ desk, value: "", key: { downArrow: true }, composerEmpty: false });
  assert.equal(applyPiContextDeskAction({}, desk, action), false);
});

test("advice on the selected source shows with a/r, and a/r settle that suggestion", () => {
  const suggestion = {
    id: "advice-1",
    packetReceiptId: "receipt-1",
    sourceId: "stamp",
    action: "hold-back",
    reasonCode: "stale",
    reasonText: "unchanged for 3 turns",
    estimatedTokenSaving: 23,
    status: "proposed",
    createdAt: "2026-09-25T00:00:00.000Z",
  };
  const desk = readPiContextDesk(engineState({ contextAdviceActionsEnabled: true, contextPolicySuggestions: [suggestion, { id: "bad" }] }));
  assert.match(formatPiContextDeskLines(desk, 120, 30).join("\n"), /Advice · hold-back · saves ~23t — unchanged for 3 turns {2}\(a accept · r reject\)/u);

  const calls = [];
  const engine = {
    acceptContextSuggestion: (id) => calls.push(`accept ${id}`),
    rejectContextSuggestion: (id) => calls.push(`reject ${id}`),
  };
  for (const value of ["a", "r"]) {
    applyPiContextDeskAction(engine, desk, resolvePiContextDeskAction({ desk, value, key: {}, composerEmpty: true }));
  }
  assert.deepEqual(calls, ["accept advice-1", "reject advice-1"]);

  const disabled = readPiContextDesk(engineState({ contextPolicySuggestions: [suggestion] }));
  const action = resolvePiContextDeskAction({ desk: disabled, value: "a", key: {}, composerEmpty: true });
  assert.equal(applyPiContextDeskAction(engine, disabled, action), false);
});
