import assert from "node:assert/strict";
import test from "node:test";

import React from "react";

import { WorkShellView } from "../../packages/tui/src/work-shell-view.tsx";
import { renderDebugFrame } from "./work-shell-render-harness.mjs";

process.env.UNCLECODE_TERMINAL_BACKGROUND = "light";

function baseProps(overrides = {}) {
  return {
    provider: "openai",
    model: "gpt-5.4",
    reasoningLabel: "medium",
    reasoningSupported: true,
    mode: "Default",
    authLabel: "Saved OAuth",
    entries: [],
    isBusy: false,
    activePanel: { title: "Context expanded", lines: ["fallback line"] },
    composer: React.createElement("span", null, ""),
    inputValue: "",
    slashSuggestionCount: 0,
    terminalColumns: 100,
    cwd: "/Users/parkeungje/project/unclecode",
    ...overrides,
  };
}

async function renderView(overrides) {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, baseProps(overrides)),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  const output = getOutput();
  instance.unmount();
  instance.cleanup();
  return output;
}

function packet(overrides = {}) {
  return {
    id: "packet-test",
    version: 1,
    generatedAt: "2026-07-07T00:00:00.000Z",
    title: "Next answer context",
    included: [
      {
        id: "workspace-1",
        category: "workspace",
        label: "AGENTS.md",
        reason: "workspace guidance",
        preview: "Workspace instructions stay active.",
        tokenEstimate: 42,
        salience: 1,
        includedInModel: true,
      },
      {
        id: "bridge-1",
        category: "bridge",
        label: "recent Q&A",
        reason: "session bridge",
        preview: "반갑다. 컨텍스트 인스펙터에서 선택한 행은 펼쳐져야 한다.",
        tokenEstimate: 24,
        salience: 0.7,
        includedInModel: true,
      },
    ],
    excluded: [
      {
        id: "loop-1",
        category: "loop-trail",
        label: ".omo/ulw-loop/session/ledger.jsonl",
        reason: "raw trail stays local",
        preview: ".omo/ulw-loop/session/ledger.jsonl contains raw evidence",
        sourceCount: 3,
        includedInModel: false,
      },
    ],
    warnings: [],
    preview: ["UncleCode will carry selected summaries into the next answer."],
    sourceCounts: { included: 2, excluded: 3, warnings: 0 },
    tokenEstimate: 66,
    tokenEstimateState: "estimated",
    ...overrides,
  };
}

test("WorkShellView renders /context as an interactive source inspector", async () => {
  const output = await renderView({
    contextSourceActionsEnabled: true,
    contextInspectorCursor: 1,
    contextInspectorExpanded: "bridge-1",
    contextActionReceipt: {
      id: "context-action-1",
      action: "hold-back",
      sourceId: "loop-1",
      sourceLabel: "session loop trail",
      message: "hold-back session loop trail · model on -> model off",
      canUndo: true,
      beforePacketId: "packet-before",
      afterPacketId: "packet-test",
    },
    contextPacket: packet(),
  });

  assert.match(output, /UncleCode Context Desk/);
  assert.match(output, /Keys.*e collapse.*Esc close/s);
  assert.match(output, /Actions.*Enter pin.*f hold back.*i include/s);
  assert.match(output, /Proof.*packet-before -> packet-test.*undo ready.*hold-back session loop trail/s);
  assert.match(output, /Workbench.*overview \/ budget/s);
  assert.doesNotMatch(output, /rules \/ preview \/ history/);
  assert.match(output, /Recommendation.*keep current packet.*review included rows/s);
  assert.match(output, /Budget lane.*AGENTS\.md.*~42t/s);
  assert.match(output, /> .*bridge.*Enter pin.*recent Q&A/s);
  assert.match(output, /반갑다\. 컨텍스트 인스펙터에서 선택한 행은 펼쳐져야 한다\./);
  assert.match(output, /include.*session loop trail/s);
  assert.doesNotMatch(output, /\.omo\/ulw-loop/);
});

test("WorkShellView hides source mutation keys when no provider prompt mutator is wired", async () => {
  const output = await renderView({
    contextInspectorCursor: 0,
    contextPacket: packet({
      included: [{
        id: "workspace-1",
        category: "workspace",
        label: "AGENTS.md",
        reason: "workspace guidance",
        preview: "Read-only context preview.",
        tokenEstimate: 42,
        includedInModel: true,
      }],
      excluded: [],
      warnings: [{
        code: "runtime-token-estimate-unknown",
        severity: "warning",
        message: "Runtime source lacks a precise token estimate; review before answering.",
      }],
      preview: [],
      sourceCounts: { included: 1, excluded: 0, warnings: 1 },
      tokenEstimate: 42,
    }),
  });

  assert.match(output, /source actions unavailable/);
  assert.match(output, /Warnings · 1/);
  assert.match(output, /warning · runtime-token-estimate-unknown/);
  assert.match(output, /· Runtime source lacks a precise token estimate; review before answering\./);
  assert.doesNotMatch(output, /Enter pin/);
  assert.doesNotMatch(output, /i include/);
});

test("WorkShellView keeps model picker overlay visible when a context packet exists", async () => {
  const output = await renderView({
    model: "gpt-5.5",
    reasoningLabel: "low",
    activePanel: {
      title: "Model picker",
      lines: [
        "Current model",
        "Model · gpt-5.5",
        "Thinking choices · low / medium / high / default",
        "Controls",
        "Type filter · /model <name> [low|medium|high|default] · Esc close",
      ],
    },
    contextPacket: packet({ included: [packet().included[0]], excluded: [], sourceCounts: { included: 1, excluded: 0, warnings: 0 }, tokenEstimate: 42 }),
    slashSuggestionCount: 1,
  });

  assert.match(output, /Model picker/);
  assert.match(output, /Thinking choices · low \/ medium \/ high \/ default/);
  assert.doesNotMatch(output, /UncleCode Context Desk/);
});

test("WorkShellView windows long /context source lists around the cursor", async () => {
  const included = Array.from({ length: 30 }, (_, index) => ({
    id: `workspace-${index}`,
    category: "workspace",
    label: `workspace source ${index}`,
    reason: "workspace context",
    preview: `workspace preview ${index}`,
    tokenEstimate: 5,
    includedInModel: true,
  }));
  const output = await renderView({
    contextInspectorCursor: 14,
    contextPacket: packet({
      included,
      excluded: [],
      warnings: [],
      preview: [],
      sourceCounts: { included: included.length, excluded: 0, warnings: 0 },
      tokenEstimate: 120,
    }),
  });

  assert.match(output, /… \d+ more above/);
  assert.match(output, /… \d+ more below/);
  assert.match(output, /> .*workspace source 14/s);
  assert.match(output, /Budget lane.*workspace source 0/s);
  assert.doesNotMatch(output, /↓ Included in next answer[\s\S]*workspace source 0/);
});
