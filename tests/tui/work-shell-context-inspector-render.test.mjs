import assert from "node:assert/strict";
import test from "node:test";

import React from "react";

import {
  formatWorkShellAgentConsoleActivityLines,
  WorkShellView,
} from "../../packages/tui/src/work-shell-view.tsx";
import { buildContextInspectorRows } from "../../packages/tui/src/work-shell-context-inspector-model.ts";
import { renderContextInspectorGroupedViewport } from "../../packages/tui/src/work-shell-context-inspector-sources.tsx";
import { formatContextInspectorPacketProofLines } from "../../packages/tui/src/work-shell-context-inspector-header.tsx";
import {
  formatContextTurnReceiptLine,
  renderContextTurnReceipt,
} from "../../packages/tui/src/work-shell-context-receipt.tsx";
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

function receipt(overrides = {}) {
  return {
    id: "receipt-preview",
    projectId: "project-1",
    sessionId: "session-1",
    packetId: "crp-b203",
    state: "previewed",
    profile: "build",
    tokenEstimate: 18_100,
    tokenEstimateState: "estimated",
    sourceCount: 14,
    sourceRefs: [
      {
        sourceId: "rules",
        category: "workspace-guidance",
        sha256: "sha-rules",
        trustTier: "trusted",
        salience: 1,
        includedInModel: true,
      },
      {
        sourceId: "memory-1",
        category: "memory",
        salience: 0.8,
        includedInModel: true,
      },
      {
        sourceId: "memory-2",
        category: "memory",
        salience: 0.7,
        includedInModel: true,
      },
    ],
    createdAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

test("Context Desk renders preview and meaning-change proof", async () => {
  const packetChange = {
    kind: "meaning-change",
    removedSourceIds: ["rules"],
    addedSourceIds: [],
    protectedSourceIds: ["rules"],
    reason: "A pinned or explicitly included source disappeared.",
  };
  const output = formatContextInspectorPacketProofLines({
    packet: packet({ id: "crp-b203" }),
    previewReceipt: receipt({ packetId: "crp-a91f" }),
    packetChange,
    modelWindow: 128_000,
    width: 100,
  }).join("\n");
  const rendered = await renderView({
    contextPacket: packet({ id: "crp-b203" }),
    contextPreviewReceipt: receipt({ packetId: "crp-a91f" }),
    contextPacketChange: packetChange,
    contextSubmittedReceipt: receipt({
      id: "receipt-submitted",
      packetId: "crp-a91f",
      state: "submitted",
      turnId: "turn-session-1-6",
    }),
    terminalColumns: 52,
  });

  for (const proof of [output, rendered]) {
    assert.match(proof, /PACKET CHANGED/);
    assert.match(proof, /crp-a91f -> crp-b203/);
    assert.match(proof, /review required/i);
  }
  assert.equal(rendered.match(/PACKET CHANGED|NEXT REQUEST|SUBMITTED/g)?.length, 1);
  const narrowProof = formatContextInspectorPacketProofLines({
    packet: packet({ id: "crp-b203" }),
    previewReceipt: receipt({ packetId: "crp-a91f" }),
    packetChange,
    modelWindow: 128_000,
    width: 48,
  }).join("\n");
  assert.match(narrowProof, /review required/i);
});

test("Context Desk preview renders honest unknown token state", async () => {
  const previewReceipt = receipt({
    packetId: "crp-unknown",
    tokenEstimate: undefined,
    tokenEstimateState: "unknown",
  });
  const packetView = packet({ id: "crp-unknown", tokenEstimate: 0, tokenEstimateState: "unknown" });
  const output = formatContextInspectorPacketProofLines({
    packet: packetView,
    previewReceipt,
    modelWindow: 128_000,
    width: 100,
  }).join("\n");
  const rendered = await renderView({
    contextPacket: packetView,
    contextPreviewReceipt: previewReceipt,
    modelWindow: 128_000,
  });

  for (const proof of [output, rendered]) {
    assert.match(proof, /NEXT REQUEST crp-unknown previewed unknown \/ 128k/);
    assert.doesNotMatch(proof, /~0/);
  }
});

test("turn receipt exposes submitted packet aggregates without source content", () => {
  const submitted = receipt({
    state: "submitted",
    turnId: "turn-session-1-7",
  });
  const output = formatContextTurnReceiptLine(submitted);

  assert.equal(output, "ctx crp-b203 · 14 sources · ~18.1k · 2 memories");
  assert.doesNotMatch(output, /preview|reason|content/);
});

test("WorkShellView renders submitted proof outside the conversation transcript", async () => {
  const output = await renderView({
    activePanel: { title: "Status", lines: ["Ready"] },
    contextPacket: packet({ id: "crp-b203" }),
    entries: [{ role: "assistant", text: "Completed." }],
    contextSubmittedReceipt: receipt({
      state: "submitted",
      turnId: "turn-session-1-7",
    }),
  });

  assert.match(output, /ctx crp-b203 · 14 sources · ~18.1k · 2 memories/);
  assert.match(output, /SUBMITTED crp-b203 turn-session-1-7/);
  assert.equal(output.match(/ctx crp-b203/g)?.length, 1);
  assert.doesNotMatch(output, /System · state[\s\S]*ctx crp-b203/);
});

test("expanded turn receipt proves metadata without leaking content and respects narrow widths", async () => {
  const contentSentinel = "SECRET SOURCE CONTENT MUST NOT RENDER";
  const expandedReceipt = receipt({
    id: "receipt-with-an-intentionally-long-identifier",
    packetId: "crp-with-an-intentionally-long-packet-identifier",
    sourceRefs: receipt().sourceRefs.map((source, index) => (
      index === 0 ? { ...source, preview: contentSentinel } : source
    )),
  });
  let fullOutput = "";

  for (const width of [100, 32, 8]) {
    const node = renderContextTurnReceipt({
      receipt: expandedReceipt,
      width,
      expanded: true,
    });
    const { instance, getOutput } = renderDebugFrame(
      React.createElement(React.Fragment, null, node),
      { columns: width, rows: 20 },
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const output = getOutput();
      for (const line of output.split("\n")) {
        assert.ok(line.length <= width, `receipt line exceeded width ${width}: ${line}`);
      }
      if (width === 100) {
        fullOutput = output;
      }
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  }

  assert.match(fullOutput, /ctx crp-with-an-intentionally-long-packet-identifier · 14 sources · ~18.1k · 2 memories/);
  assert.match(fullOutput, /receipt receipt-with-an-intentionally-long-identifier · previewed · estimated/);
  assert.match(fullOutput, /rules · workspace-guidance · sha · trusted · sent/);
  assert.match(fullOutput, /memory-1 · memory · sha missing · trust unknown · sent/);
  assert.doesNotMatch(fullOutput, new RegExp(contentSentinel));
});

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

test("WorkShellView renders actionable optimizer advice without source content", async () => {
  const contextPacket = packet();
  const output = await renderView({
    contextPacket,
    contextInspectorCursor: 0,
    contextSourceActionsEnabled: true,
    contextAdviceActionsEnabled: true,
    contextPolicySuggestions: [
      {
        id: "suggestion-hold-workspace",
        packetReceiptId: "receipt-submitted",
        sourceId: "workspace-1",
        action: "hold-back",
        reasonCode: "low-trust-token-hotspot",
        reasonText: "This source exceeds the strict low-trust token threshold.",
        estimatedTokenSaving: 42,
        status: "proposed",
        createdAt: "2026-07-13T00:00:01.000Z",
      },
      {
        id: "suggestion-refresh-memory",
        packetReceiptId: "receipt-submitted",
        sourceId: "bridge-1",
        action: "refresh",
        reasonCode: "expired-source",
        reasonText: "Source metadata expired and must be refreshed.",
        status: "accepted",
        createdAt: "2026-07-13T00:00:01.000Z",
        resolvedAt: "2026-07-13T00:00:02.000Z",
      },
      {
        id: "suggestion-keep-loop",
        packetReceiptId: "receipt-submitted",
        sourceId: "loop-1",
        action: "keep",
        reasonCode: "mandatory-guidance",
        reasonText: "The source was retained after review.",
        status: "rejected",
        createdAt: "2026-07-13T00:00:01.000Z",
        resolvedAt: "2026-07-13T00:00:02.000Z",
      },
      {
        id: "suggestion-summarize-bridge",
        packetReceiptId: "receipt-submitted",
        sourceId: "bridge-1",
        action: "summarize",
        reasonCode: "stale-condensed-history",
        reasonText: "Condensed history is stale.",
        status: "proposed",
        createdAt: "2026-07-13T00:00:03.000Z",
      },
    ],
  });

  assert.match(output, /Context optimizer/);
  assert.match(output, /Hold back · AGENTS\.md · Save ~42t/);
  assert.match(output, /strict low-trust token threshold/);
  assert.match(output, /\[A\] accept · \[R\] reject/);
  assert.match(output, /Refresh · recent Q&A · accepted/);
  assert.match(output, /Keep · session loop trail · rejected/);
  assert.match(output, /Summarize · recent Q&A · Savings unknown/);
  assert.doesNotMatch(output, /Workspace instructions stay active/);
});

test("WorkShellView renders optimizer failure as a bounded non-fatal state", async () => {
  const output = await renderView({
    contextPacket: packet(),
    contextInspectorCursor: 0,
    contextPolicySuggestions: [],
    contextAdviceUnavailable: "Context optimizer unavailable; reply kept.",
  });

  assert.match(output, /Context optimizer/);
  assert.match(output, /Context optimizer unavailable; reply kept\./);
  assert.doesNotMatch(output, /\[A\] accept/);
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
