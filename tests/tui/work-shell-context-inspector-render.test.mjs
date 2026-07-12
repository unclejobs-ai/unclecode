import assert from "node:assert/strict";
import test from "node:test";

import React from "react";

import {
  formatWorkShellAgentConsoleActivityLines,
  WorkShellView,
} from "../../packages/tui/src/work-shell-view.tsx";
import { buildContextInspectorRows } from "../../packages/tui/src/work-shell-context-inspector-model.ts";
import { renderContextInspectorGroupedViewport } from "../../packages/tui/src/work-shell-context-inspector-sources.tsx";
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
    cwd: "/tmp/unclecode-test-workspace",
    ...overrides,
  };
}

async function renderView(overrides, frameOptions = {}) {
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, baseProps(overrides)),
    frameOptions,
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
    manifest: {
      id: "packet-test:review",
      profileId: "review",
      createdAt: "2026-07-07T00:00:00.000Z",
      packetId: "packet-test",
      policy: [{ id: "workspace-guidance", label: "AGENTS.md", authority: "mandatory", digest: "digest" }],
      includedSourceCount: 2,
      excludedSourceCount: 3,
      tokenEstimate: 66,
    },
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
  assert.match(output, /Sources · 2 included · 3 held back/);
  assert.match(output, /Summary ·/);
  assert.match(output, /반갑다\. 컨텍스트 인스펙터에서 선택한 행은 펼쳐져야 한다\./);
  assert.match(output, /Detail · recent Q&A/);
  assert.match(output, /↑↓ scroll · Enter back · Space send\/hold · P pin · Esc close/);
  assert.doesNotMatch(output, /Project instructions/);
  assert.doesNotMatch(output, /Tool activity/);
  assert.doesNotMatch(output, /session loop trail/);
  assert.doesNotMatch(output, /\.omo\/ulw-loop/);
  assert.doesNotMatch(output, /\bbridge\b/);
  assert.doesNotMatch(output, /(?<!session )loop trail/);
  assert.doesNotMatch(output, /^\s*Groups\s*$/m);
  assert.doesNotMatch(output, /Keys ·/);
  assert.doesNotMatch(output, /Actions ·/);
  assert.doesNotMatch(output, /Prompt ·/);
  assert.doesNotMatch(output, /Workbench/);
  assert.doesNotMatch(output, /Budget lane/);
  assert.doesNotMatch(output, /Preflight/);
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

  assert.match(output, /Warnings · 1/);
  assert.match(output, /warning · runtime-token-estimate-unknown/);
  assert.match(output, /· Runtime source lacks a precise token estimate; review before answering\./);
  assert.match(output, /↑↓ move · Enter details · Space send\/hold · P pin · Esc close/);
  assert.match(output, /> AGENTS\.md · sent · ~42t/);
  assert.doesNotMatch(output, /Keys ·/);
  assert.doesNotMatch(output, /Actions ·/);
  assert.doesNotMatch(output, /source actions unavailable/);
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
    terminalRows: 40,
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
  assert.match(output, /> workspace source 14 · sent · ~5t/);
  assert.doesNotMatch(output, /workspace preview 14/);
  assert.doesNotMatch(output, /Budget lane/);
  assert.doesNotMatch(output, /↓ Included in next answer[\s\S]*workspace source 0/);
});

test("WorkShellView renders a compact 52x40 inspector for 40+ grouped sources", async () => {
  const categories = [
    "workspace-guidance",
    "bridge",
    "memory",
    "attachment",
    "runtime",
    "loop-trail",
    "mystery-provider",
  ];
  const included = Array.from({ length: 36 }, (_, index) => ({
    id: `src-included-${index}`,
    category: categories[index % categories.length],
    label: `source ${index}`,
    reason: "fixture source",
    preview: `preview body for source ${index} should stay off collapsed siblings`,
    tokenEstimate: 8,
    includedInModel: true,
    salience: index === 22 ? 0.9 : 0.5,
  }));
  const excluded = Array.from({ length: 8 }, (_, index) => ({
    id: `src-held-${index}`,
    category: categories[(index + 3) % categories.length],
    label: `held source ${index}`,
    reason: "held fixture",
    preview: `held preview ${index}`,
    tokenEstimate: 4,
    includedInModel: false,
  }));
  const contextPacket = packet({
    included,
    excluded,
    warnings: [],
    preview: [],
    sourceCounts: { included: included.length, excluded: excluded.length, warnings: 0 },
    tokenEstimate: 320,
    manifest: undefined,
  });
  const selectedIndex = buildContextInspectorRows(contextPacket).findIndex((row) => row.item.id === "src-included-22");
  assert.ok(selectedIndex >= 0, "expected src-included-22 in grouped rows");
  const output = await renderView(
    {
      terminalColumns: 52,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextInspectorCursor: selectedIndex,
      contextPacket,
    },
    { columns: 52, rows: 40 },
  );

  assert.match(output, /UncleCode Context Desk/);
  assert.match(output, /Sources · 36 included · 8 held back/);
  assert.match(output, /Current conversation/);
  assert.match(output, /Saved memory/);
  assert.match(output, new RegExp(`Focus · #${selectedIndex + 1}/44`));
  assert.match(output, /> source 22 · sent · ~8t/);
  assert.match(output, /… \d+ more (above|below)/);
  assert.match(output, /↑↓ move · Enter details · Space send\/hold/);
  assert.match(output, /P pin · Esc close/);
  assert.ok(output.split("\n").length <= 40, "52x40 context inspector must fit the terminal height");
  const expandedOutput = await renderView(
    {
      terminalColumns: 52,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextInspectorCursor: selectedIndex,
      contextInspectorExpanded: "src-included-22",
      contextPacket,
      contextInspectorDetailContent: [
        "# Configured prompt",
        "Rule one stays local.",
        "Rule two is inspectable.",
        "Rule three is not sent by the detail view.",
        "Rule four remains visible.",
        "Rule five proves Enter opens a real detail reader.",
      ].join("\n"),
      contextInspectorDetailOffset: 0,
    },
    { columns: 52, rows: 40 },
  );
  assert.match(expandedOutput, /preview body for source 22/);
  assert.match(expandedOutput, /Rule five proves Enter opens a real/);
  assert.match(expandedOutput, /detail reader\./);
  assert.match(expandedOutput, /↑↓ scroll · Enter back/);
  assert.doesNotMatch(expandedOutput, /source 21/);
  assert.ok(
    expandedOutput.split("\n").length <= 40,
    "expanded 52x40 context detail must fit the terminal height",
  );
  const middleScrolledOutput = await renderView(
    {
      terminalColumns: 52,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextInspectorCursor: selectedIndex,
      contextInspectorExpanded: "src-included-22",
      contextPacket,
      contextInspectorDetailContent: Array.from(
        { length: 60 },
        (_, index) => `Local detail line ${index + 1}`,
      ).join("\n"),
      contextInspectorDetailOffset: 8,
    },
    { columns: 52, rows: 40 },
  );
  assert.match(middleScrolledOutput, /… 8 lines above/);
  assert.match(middleScrolledOutput, /lines below/);
  assert.ok(
    middleScrolledOutput.split("\n").length <= 40,
    "middle-scrolled context detail must reserve rows for both overflow markers",
  );
  // Group headers live only in the scrolled viewport; offscreen groups are not duplicated in a summary block.
  assert.doesNotMatch(output, /^\s*Groups\s*$/m);
  assert.doesNotMatch(output, /preview body for source 22/);
  assert.doesNotMatch(output, /preview body for source 21/);
  assert.doesNotMatch(output, /\bbridge\b/);
  assert.doesNotMatch(output, /(?<!session )loop trail/);
  assert.doesNotMatch(output, /\bruntime\b/);
  assert.doesNotMatch(output, /mystery-provider/);
  assert.doesNotMatch(output, /Workbench/);
  assert.doesNotMatch(output, /Budget lane/);
  assert.doesNotMatch(output, /Preflight/);
  assert.doesNotMatch(output, /↓ Included in next answer/);
  assert.doesNotMatch(output, /Held back locally/);
});

test("detail viewport reserves rows for both overflow markers", async () => {
  const contextPacket = packet();
  const rows = buildContextInspectorRows(contextPacket);
  const detail = renderContextInspectorGroupedViewport({
    rows,
    maxRows: 10,
    cursorIndex: 0,
    expandedId: rows[0]?.item.id,
    detailContent: Array.from({ length: 30 }, (_, index) => `Detail line ${index + 1}`).join("\n"),
    detailOffset: 5,
    width: 80,
    palette: {
      assistant: "cyan",
      text: "white",
      textDim: "gray",
      borderDefault: "gray",
    },
    actionsEnabled: true,
  });
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(React.Fragment, null, detail),
    { columns: 100, rows: 100 },
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const output = getOutput();
    assert.match(output, /… 5 lines above/);
    assert.match(output, /lines below/);
    assert.ok(
      output.split("\n").length <= 10,
      `detail viewport rendered ${output.split("\n").length} rows for a 10-row budget`,
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test("WorkShellView formats only compact agent console tool evidence", () => {
  assert.deepEqual(
    formatWorkShellAgentConsoleActivityLines({
      profileId: "build",
      activity: [{
        id: "tool-1",
        toolCallId: "call-1",
        toolName: "read_file",
        kind: "read",
        intent: "Read session state",
        target: "session.json",
        status: "completed",
        summary: "completed · 12ms",
        startedAt: 1,
        output: "raw output must not render",
      }],
    }),
    ["Tool · Read session state · session.json · completed · 12ms"],
  );
});

test("WorkShellView renders a bounded goal task lifecycle without executor prompts", () => {
  const lines = formatWorkShellAgentConsoleActivityLines({
    profileId: "build",
    workGraph: {
      id: "goal-1",
      goal: "Ship authentication",
      approval: "approved",
      nodes: Array.from({ length: 6 }, (_, index) => ({
        id: `task-${index + 1}`,
        title: `Task ${index + 1}`,
        prompt: `private executor prompt ${index + 1}`,
        status: index === 0 ? "completed" : index === 1 ? "running" : "ready",
        dependsOn: index === 0 ? [] : [`task-${index}`],
        fileOwnership: [],
        acceptanceCriteria: ["observable proof"],
        evidenceRefs: [],
      })),
    },
    activity: [],
  });

  assert.deepEqual(lines, [
    "Goal · Ship authentication",
    "● Task 2 · after task-1",
    "✓ Task 1",
    "○ Task 3 · after task-2",
    "○ Task 4 · after task-3",
    "… 2 more tasks",
  ]);
  assert.doesNotMatch(lines.join("\n"), /private executor prompt/);
});
