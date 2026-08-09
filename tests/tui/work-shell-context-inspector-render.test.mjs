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
import { renderDebugFrame, waitForSettledFrame } from "./work-shell-render-harness.mjs";

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
  await waitForSettledFrame(getOutput);
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
    sourceCount: 3,
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

test("context staging keeps every next-request source ahead of held-back sources", () => {
  const rows = buildContextInspectorRows(packet({
    included: [{
      id: "sent-runtime",
      category: "runtime",
      label: "active runtime trace",
      reason: "active evidence",
      includedInModel: true,
    }],
    excluded: [{
      id: "held-workspace",
      category: "workspace",
      label: "old workspace guide",
      reason: "held evidence",
      includedInModel: false,
    }],
    sourceCounts: { included: 1, excluded: 1, warnings: 0 },
  }));

  assert.deepEqual(rows.map((row) => row.item.id), ["sent-runtime", "held-workspace"]);
});

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

  assert.match(output, /Context changed · review before sending/);
  assert.match(output, /1 source dropped · 0 added/);
  assert.match(output, /A pinned or explicitly included source disappeared\./);
  assert.match(rendered, /Context changed · review before sending/);
  assert.match(rendered, /1 source dropped · 0 added/);
  for (const proof of [output, rendered]) {
    assert.doesNotMatch(proof, /crp-a91f|crp-b203|receipt-preview|receipt-submitted|turn-session/);
  }
  assert.equal(
    rendered.match(/Context changed ·|Next request ·|Last request ·/g)?.length,
    1,
  );
  const narrowProof = formatContextInspectorPacketProofLines({
    packet: packet({ id: "crp-b203" }),
    previewReceipt: receipt({ packetId: "crp-a91f" }),
    packetChange,
    modelWindow: 128_000,
    width: 48,
  }).join("\n");
  assert.match(narrowProof, /Context changed · review before sending/);
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
    assert.match(proof, /Next request · ready to send · unknown \/ 128k/);
    assert.doesNotMatch(proof, /~0/);
    assert.doesNotMatch(proof, /crp-unknown/);
  }
});

test("turn receipt exposes an auditable context proof without internal ids", () => {
  const submitted = receipt({
    state: "submitted",
    turnId: "turn-session-1-7",
  });
  const output = formatContextTurnReceiptLine(submitted);

  assert.equal(output, "▤ Context proof · 3 sent · 0 held · ~18.1k tok");
  assert.doesNotMatch(output, /crp-b203|turn-session|preview|reason|content/);
});

test("turn receipt derives every source count from its auditable source refs", () => {
  const output = formatContextTurnReceiptLine(receipt({
    state: "submitted",
    turnId: "turn-session-1-8",
    sourceCount: 14,
  }));

  assert.equal(output, "▤ Context proof · 3 sent · 0 held · ~18.1k tok");
});

test("WorkShellView renders categorized context proof outside the conversation transcript", async () => {
  const output = await renderView({
    activePanel: { title: "Status", lines: ["Ready"] },
    contextPacket: packet({ id: "crp-b203" }),
    entries: [{ role: "assistant", text: "Completed." }],
    contextSubmittedReceipt: receipt({
      state: "submitted",
      turnId: "turn-session-1-7",
    }),
  });

  assert.match(output, /▤ Context proof · 3 sent · 0 held · ~18.1k tok/);
  assert.match(output, /Guidance 1 · Memory 2/);
  assert.equal(output.match(/▤ Context proof/g)?.length, 1);
  assert.doesNotMatch(output, /SUBMITTED crp-b203|turn-session-1-7/);
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
      await waitForSettledFrame(getOutput);
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

  assert.match(fullOutput, /▤ Context proof · 3 sent · 0 held · ~18.1k tok/);
  assert.match(fullOutput, /Previewed · ~18\.1k estimated · 1\/3 verified/);
  assert.match(fullOutput, /Guidance · 1 sent · 1\/1 verified/);
  assert.match(fullOutput, /Memory · 2 sent · 0\/2 verified/);
  assert.doesNotMatch(fullOutput, new RegExp(contentSentinel));
  assert.doesNotMatch(
    fullOutput,
    /receipt-with-an-intentionally-long-identifier|crp-with-an-intentionally-long-packet-identifier/,
  );
  assert.doesNotMatch(fullOutput, /\brules\b|\bmemory-1\b|\bmemory-2\b|workspace-guidance/);
});

test("WorkShellView renders /context as a hybrid preflight workbench", async () => {
  const output = await renderView({
    contextSourceActionsEnabled: true,
    contextInspectorCursor: 1,
    contextActionReceipt: {
      id: "context-action-1",
      action: "hold-back",
      sourceId: "loop-1",
      sourceLabel: "session loop trail",
      message: "held back session loop trail",
      canUndo: true,
      succeeded: true,
      beforePacketId: "packet-before",
      afterPacketId: "packet-test",
    },
    contextPacket: packet({ id: "crp-b203" }),
    contextPreviewReceipt: receipt({ packetId: "crp-b203" }),
    contextSubmittedReceipt: receipt({
      id: "receipt-submitted",
      packetId: "crp-a91f",
      state: "submitted",
      turnId: "turn-session-1-6",
    }),
    contextPacketChange: {
      kind: "safety-refresh",
      removedSourceIds: [],
      addedSourceIds: ["bridge-1"],
      protectedSourceIds: [],
      reason: "A refreshed source changed safely.",
    },
    terminalColumns: 140,
  }, { columns: 140, rows: 40 });

  assert.match(output, /UncleCode Context Desk/);
  assert.match(output, /Preflight/);
  assert.match(output, /In next request · 2/);
  assert.match(output, /Held back · 3/);
  assert.match(output, /Preview · recent Q&A/);
  assert.match(output, /반갑다\./);
  assert.match(output, /Compare · next request vs last sent/);
  assert.match(output, /\+ recent Q&A/);
  assert.match(output, /Same size as the last request/);
  assert.match(output, /Proof · Held back · session loop trail · undo ready/);
  assert.match(output, /↑↓ move · Enter details · Space hold back · P pin · U undo · Esc close/);
  assert.doesNotMatch(output, /Summary ·/);
  assert.doesNotMatch(output, /Context optimizer/);
  assert.doesNotMatch(output, /\.omo\/ulw-loop/);
  assert.doesNotMatch(
    output,
    /crp-b203|crp-a91f|packet-before|packet-test|context-action-1|turn-session-1-6|loop-1/,
  );
});

test("Context Desk reports a failed undo as unchanged, not as applied proof", async () => {
  const output = await renderView({
    contextSourceActionsEnabled: true,
    contextActionReceipt: {
      id: "context-action-failed",
      action: "undo",
      sourceId: "workspace-1",
      sourceLabel: "AGENTS.md",
      message: "Could not undo hold-back on AGENTS.md. Nothing changed, and the undo is still waiting.",
      succeeded: false,
      canUndo: true,
    },
    contextPacket: packet(),
  });

  assert.match(output, /Proof · Not changed · Could not undo hold-back on AGENTS\.md/);
  assert.match(output, /undo still ready/);
  assert.doesNotMatch(output, /Proof · Undid/);
});

test("WorkShellView keeps staging and preview adjacent at the 80-column breakpoint", async () => {
  const output = await renderView(
    {
      terminalColumns: 80,
      terminalRows: 40,
      contextInspectorCursor: 1,
      contextPacket: packet(),
    },
    { columns: 80, rows: 40 },
  );
  const lines = output.split("\n");
  const stagingLine = lines.findIndex((line) => line.includes("In next request"));
  const previewLine = lines.findIndex((line) => line.includes("Preview · recent Q&A"));

  assert.ok(stagingLine >= 0);
  assert.ok(previewLine >= 0);
  assert.ok(Math.abs(stagingLine - previewLine) <= 1);
  assert.match(output, /반갑다\./);
  assert.ok(lines.length <= 40);
});

test("WorkShellView shows readable warnings and read-only controls without a source mutator", async () => {
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

  assert.match(output, /1 warnings/);
  assert.match(output, /Warning · Runtime source lacks a precise token estimate; review before answering\./);
  assert.match(output, /↑↓ move · Enter details · Esc close/);
  assert.match(output, /> AGENTS\.md · ~42t/);
  assert.doesNotMatch(output, /runtime-token-estimate-unknown/);
  assert.doesNotMatch(output, /Space hold back|Space include/);
  assert.doesNotMatch(output, /P pin/);
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
  assert.match(output, /> workspace source 14 · ~5t/);
  assert.match(output, /workspace preview 14/);
  assert.doesNotMatch(output, /Budget lane/);
  assert.doesNotMatch(output, /> workspace source 0/);
});

test("WorkShellView renders actionable optimizer advice beside an independent preview", async () => {
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
        estimatedTokenSaving: 3_200,
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
  assert.match(output, /Hold back · AGENTS\.md · Save ~3\.2k/);
  assert.match(output, /This source exceeds the strict low-trust token/);
  assert.match(output, /threshold\./);
  assert.match(output, /\[A\] accept · \[R\] reject/);
  assert.match(output, /Refresh · recent Q&A · accepted/);
  assert.match(output, /Keep · session loop trail · rejected/);
  assert.match(output, /Summarize · recent Q&A · Savings unknown/);
  // Advice no longer displaces the selected preview: both blocks are on screen.
  assert.match(output, /Preview · AGENTS\.md/);
  assert.match(output, /Workspace instructions stay active/);
});

test("Context Desk names advice for an absent source in human terms", async () => {
  const output = await renderView({
    contextPacket: packet(),
    contextInspectorCursor: 0,
    contextAdviceActionsEnabled: true,
    terminalColumns: 140,
    contextPolicySuggestions: [{
      id: "suggestion-orphaned-history",
      packetReceiptId: "receipt-submitted",
      sourceId: "condensed-history-stale-42",
      action: "summarize",
      reasonCode: "stale-condensed-history",
      reasonText: "Summarize the stale exchange.",
      estimatedTokenSaving: 900,
      status: "proposed",
      createdAt: "2026-07-13T00:00:03.000Z",
    }],
  }, { columns: 140, rows: 40 });

  assert.match(output, /Summarize · recent conversation/);
  assert.doesNotMatch(output, /condensed-history-stale-42/);
});
test("WorkShellView reserves source rows when optimizer advice fills a compact terminal", async () => {
  const output = await renderView(
    {
      terminalColumns: 52,
      terminalRows: 40,
      contextPacket: packet(),
      contextInspectorCursor: 0,
      contextSourceActionsEnabled: true,
      contextAdviceActionsEnabled: true,
      contextPolicySuggestions: Array.from({ length: 6 }, (_, index) => ({
        id: `suggestion-${index}`,
        packetReceiptId: "receipt-submitted",
        sourceId: index < 3 ? "workspace-1" : "bridge-1",
        action: index === 0 ? "hold-back" : "refresh",
        reasonCode: index === 0 ? "low-trust-token-hotspot" : "expired-source",
        reasonText: index === 0 ? "Hold back oversized guidance." : "Refresh stale metadata.",
        estimatedTokenSaving: 3_200 - index,
        status: "proposed",
        createdAt: "2026-07-13T00:00:01.000Z",
      })),
    },
    { columns: 52, rows: 40 },
  );

  assert.match(output, /> AGENTS\.md · \[pin\] · ~42t/);
  assert.match(output, /\[A\] accept · \[R\] reject/);
  assert.equal(output.match(/\[A\] accept · \[R\] reject/g)?.length, 1);
  assert.match(output, /… 5 more suggestions/);
  assert.match(output, /Preview · AGENTS\.md/);
  assert.match(output, /Workspace instructions stay active/);
  assert.ok(output.split("\n").length <= 40, "advice and source evidence must fit a 52x40 terminal");
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
  assert.match(output, /In next request · 36/);
  assert.match(output, /Current conversation/);
  assert.match(output, /> source 22 · ~8t/);
  assert.match(output, /… \d+ more (above|below)/);
  assert.match(output, /↑↓ move · Enter details · Space hold back/);
  assert.match(output, /P pin · Esc close/);
  // The selected preview survives the narrowest supported frame.
  assert.match(output, /Preview · source 22/);
  assert.match(output, /preview body for source 22/);
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
  assert.match(expandedOutput, /Rule four remains visible/);
  assert.match(expandedOutput, /… 2 lines below/);
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
  assert.doesNotMatch(output, /preview body for source 23/);
  assert.doesNotMatch(output, /preview body for source 21/);
  assert.doesNotMatch(output, /\bbridge\b/);
  assert.doesNotMatch(output, /(?<!session )loop trail/);
  assert.doesNotMatch(output, /\bruntime\b/);
  assert.doesNotMatch(output, /mystery-provider/);
  assert.doesNotMatch(output, /Workbench/);
  assert.doesNotMatch(output, /Budget lane/);
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
    await waitForSettledFrame(getOutput);
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

function workNodeSource(overrides = {}) {
  return {
    id: "goal-loop-graph-7-node-3",
    category: "loop-trail",
    label: "Context Desk runbook",
    reason: "active work item",
    preview: "Aim: Ship the Context Desk",
    tokenEstimate: 30,
    includedInModel: true,
    metadata: {
      kind: "work-node",
      graphId: "graph-7",
      nodeId: "node-3",
      title: "Wire the runbook block into the packet view",
      goal: "Ship the Context Desk",
      constraints: ["Do not edit engine files"],
      status: "requires_action",
      acceptanceCriteria: [
        "Runbook renders before the source list",
        "Human copy carries no internal ids",
        "Evidence counts stay honest",
      ],
      evidenceRefs: ["evidence-ref-1"],
    },
    ...overrides,
  };
}

test("Context Desk renders a work node as a first-class runbook block", async () => {
  const contextPacket = packet({
    included: [workNodeSource(), ...packet().included],
    sourceCounts: { included: 3, excluded: 3, warnings: 0 },
  });
  const workNodeCursor = buildContextInspectorRows(contextPacket).findIndex(
    (row) => row.item.metadata?.kind === "work-node",
  );
  const output = await renderView(
    { contextPacket, contextInspectorCursor: workNodeCursor, terminalColumns: 140, terminalRows: 40 },
    { columns: 140, rows: 40 },
  );
  const lines = output.split("\n");
  const runbookLine = lines.findIndex((line) => line.includes("Runbook · Ship the Context Desk"));
  const inventoryLine = lines.findIndex((line) => line.includes("In next request"));

  assert.ok(runbookLine >= 0, "expected a runbook block");
  assert.ok(inventoryLine >= 0, "expected the source inventory");
  assert.ok(runbookLine < inventoryLine, "runbook must precede the source inventory");
  assert.match(output, /Doing · Wire the runbook block into the packet view/);
  assert.match(output, /Next · Needs your input/);
  assert.match(output, /Must hold · Do not edit engine files/);
  assert.match(output, /Accepted when · Runbook renders before the source\s+list/);
  assert.match(output, /· Human copy carries no internal ids/);
  assert.match(output, /· … 1 more check/);
  assert.match(output, /Evidence · 1 of 3 collected/);
  // The work node explains itself instead of hiding behind a generic activity label.
  assert.doesNotMatch(output, /graph-7|node-3|goal-loop|evidence-ref-1/);
});

test("Context Desk keeps the runbook block bounded at 52x40", async () => {
  const contextPacket = packet({
    included: [workNodeSource(), ...packet().included],
    sourceCounts: { included: 3, excluded: 3, warnings: 0 },
  });
  const workNodeCursor = buildContextInspectorRows(contextPacket).findIndex(
    (row) => row.item.metadata?.kind === "work-node",
  );
  const output = await renderView(
    {
      contextPacket,
      contextInspectorCursor: workNodeCursor,
      contextSourceActionsEnabled: true,
      terminalColumns: 52,
      terminalRows: 40,
    },
    { columns: 52, rows: 40 },
  );

  assert.match(output, /Runbook · Ship the Context Desk/);
  assert.match(output, /Doing · Wire the runbook block/);
  assert.match(output, /Next · Needs your input/);
  assert.match(output, /Evidence · 1 of 3 collected/);
  assert.match(output, /Preview · Context Desk runbook/);
  assert.doesNotMatch(output, /graph-7|node-3|goal-loop|evidence-ref-1/);
  assert.ok(
    output.split("\n").length <= 40,
    `the runbook block must stay inside a 52x40 frame, got ${output.split("\n").length} rows`,
  );
});

test("Context Desk falls back to the work node title when the graph has no goal", async () => {
  const { goal: _goal, ...metadataWithoutGoal } = workNodeSource().metadata;
  const contextPacket = packet({
    included: [
      workNodeSource({
        metadata: {
          ...metadataWithoutGoal,
          status: "completed",
          constraints: [],
          acceptanceCriteria: [],
          evidenceRefs: [],
        },
      }),
      ...packet().included,
    ],
    sourceCounts: { included: 3, excluded: 3, warnings: 0 },
  });
  const output = await renderView(
    { contextPacket, contextInspectorCursor: 0, terminalColumns: 140, terminalRows: 40 },
    { columns: 140, rows: 40 },
  );

  assert.match(output, /Runbook · Wire the runbook block into the packet view/);
  assert.match(output, /Status · Completed/);
  assert.match(output, /Evidence · none collected yet/);
  assert.doesNotMatch(output, /Doing ·/);
  assert.doesNotMatch(output, /Must hold ·/);
  assert.doesNotMatch(output, /Accepted when ·/);
});

test("Context Desk compares lifecycle receipts with human labels and token deltas", async () => {
  const output = await renderView(
    {
      contextPacket: packet({ id: "crp-b203" }),
      contextInspectorCursor: 1,
      contextPreviewReceipt: receipt({ packetId: "crp-b203", tokenEstimate: 20_600 }),
      contextSubmittedReceipt: receipt({
        id: "receipt-submitted",
        packetId: "crp-a91f",
        state: "submitted",
        turnId: "turn-session-1-6",
        tokenEstimate: 18_100,
      }),
      contextPacketChange: {
        kind: "safety-refresh",
        removedSourceIds: ["workspace-1"],
        addedSourceIds: ["bridge-1"],
        protectedSourceIds: [],
        reason: "A refreshed source changed safely.",
      },
      terminalColumns: 140,
      terminalRows: 40,
    },
    { columns: 140, rows: 40 },
  );

  assert.match(output, /Compare · next request vs last sent/);
  assert.match(output, /\+ recent Q&A/);
  assert.match(output, /- AGENTS\.md/);
  assert.match(output, /~2\.5k larger than the last request/);
  // Comparing the next packet does not drop the previously submitted receipt.
  assert.match(output, /Next request · ready to send/);
  assert.doesNotMatch(output, /crp-a91f|crp-b203|receipt-submitted|receipt-preview|turn-session/);
});

test("Context Desk advertises only the selected source's real capabilities", async () => {
  const contextPacket = packet({
    included: [{
      id: "pinned-guidance",
      category: "workspace",
      label: "AGENTS.md",
      reason: "workspace guidance",
      preview: "Workspace instructions stay active.",
      tokenEstimate: 42,
      salience: 1,
      includedInModel: true,
      actions: ["unpin", "hold-back", "preview"],
    }],
    excluded: [{
      id: "held-trail",
      category: "loop-trail",
      label: "session loop trail",
      reason: "raw trail stays local",
      preview: "Held evidence stays local.",
      tokenEstimate: 12,
      includedInModel: false,
      actions: ["include", "preview"],
    }],
    sourceCounts: { included: 1, excluded: 1, warnings: 0 },
  });
  const onPinned = await renderView({
    contextPacket,
    contextInspectorCursor: 0,
    contextSourceActionsEnabled: true,
  });
  const onHeld = await renderView({
    contextPacket,
    contextInspectorCursor: 1,
    contextSourceActionsEnabled: true,
  });

  assert.match(onPinned, /Space hold back · P unpin · Esc close/);
  assert.doesNotMatch(onPinned, /Space include/);
  assert.doesNotMatch(onPinned, /P pin ·/);

  assert.match(onHeld, /↑↓ move · Enter details · Space include · Esc close/);
  assert.doesNotMatch(onHeld, /Space hold back/);
  assert.doesNotMatch(onHeld, /P pin|P unpin/);
});

test("Context Desk keeps read-only sources from advertising any mutation control", async () => {
  const output = await renderView({
    contextPacket: packet({
      included: [{
        id: "system-frame",
        category: "system",
        label: "provider system prompt",
        reason: "provider requirement",
        preview: "System framing is fixed.",
        tokenEstimate: 90,
        includedInModel: true,
        actions: ["preview"],
      }],
      excluded: [],
      sourceCounts: { included: 1, excluded: 0, warnings: 0 },
    }),
    contextInspectorCursor: 0,
    contextSourceActionsEnabled: true,
  });

  assert.match(output, /↑↓ move · Enter details · Esc close/);
  assert.doesNotMatch(output, /Space hold back|Space include|P pin|P unpin/);
});

test("Context Desk surfaces the selected source's advice past the first four suggestions", async () => {
  const output = await renderView(
    {
      terminalColumns: 52,
      terminalRows: 40,
      contextPacket: packet(),
      contextInspectorCursor: 1,
      contextSourceActionsEnabled: true,
      contextAdviceActionsEnabled: true,
      contextPolicySuggestions: [
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `suggestion-workspace-${index}`,
          packetReceiptId: "receipt-submitted",
          sourceId: "workspace-1",
          action: "hold-back",
          reasonCode: "low-trust-token-hotspot",
          reasonText: "Hold back oversized guidance.",
          estimatedTokenSaving: 3_200,
          status: "proposed",
          createdAt: "2026-07-13T00:00:01.000Z",
        })),
        {
          id: "suggestion-bridge-late",
          packetReceiptId: "receipt-submitted",
          sourceId: "bridge-1",
          action: "summarize",
          reasonCode: "stale-condensed-history",
          reasonText: "Summarize the recent exchange.",
          estimatedTokenSaving: 900,
          status: "proposed",
          createdAt: "2026-07-13T00:00:06.000Z",
        },
      ],
    },
    { columns: 52, rows: 40 },
  );

  assert.match(output, /> Summarize · recent Q&A · Save ~900/);
  assert.match(output, /\[A\] accept · \[R\] reject/);
  assert.equal(output.match(/\[A\] accept · \[R\] reject/g)?.length, 1);
  assert.match(output, /… 5 more suggestions/);
  assert.ok(
    output.split("\n").length <= 40,
    "reaching a late suggestion must not grow the 52x40 frame",
  );
});

test("WorkShellView formats structured tool evidence without raw output", () => {
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
        summary: "completed · 12ms · 48 lines",
        startedAt: 1,
        output: "raw output must not render",
      }],
    }),
    ["  ● Read    Read session state · session.json    12ms · 48 lines"],
  );
});

test("WorkShellView drops the metric column instead of stacking a second row", () => {
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
        summary: "completed · 12ms · 48 lines",
        startedAt: 1,
      }],
    }, 52),
    ["  ● Read    Read session state · session.json"],
  );
});

test("WorkShellView keeps the live block to running work while calls are in flight", () => {
  const activity = [
    {
      id: "tool-running",
      toolCallId: "call-running",
      toolName: "read_file",
      kind: "read",
      intent: "Long-running inspection",
      status: "running",
      startedAt: 1,
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `tool-completed-${index + 1}`,
      toolCallId: `call-completed-${index + 1}`,
      toolName: "read_file",
      kind: "read",
      intent: `Completed inspection ${index + 1}`,
      status: "completed",
      summary: "completed · 1ms · 1 line",
      startedAt: index + 2,
      completedAt: index + 3,
    })),
  ];

  const lines = formatWorkShellAgentConsoleActivityLines({
    profileId: "build",
    activity,
  });

  // While anything is in flight this block is the live edge only. Finished
  // calls render inline in the transcript now, in the order they happened, so
  // repeating them above the conversation would show each one twice.
  assert.match(lines.join("\n"), /◐ Read {4}Long-running inspection {4}running/);
  assert.doesNotMatch(lines.join("\n"), /Completed inspection/);

  // With nothing running, the block fills with what just settled so an idle
  // screen still reports the last few calls — newest kept, oldest dropped.
  const settled = Array.from({ length: 6 }, (_, index) => ({
    id: `tool-settled-${index + 1}`,
    toolCallId: `call-settled-${index + 1}`,
    toolName: "read_file",
    kind: "read",
    intent: `Completed inspection ${index + 1}`,
    status: "completed",
    summary: "completed · 1ms · 1 line",
    startedAt: index + 1,
    completedAt: index + 2,
  }));
  const idle = formatWorkShellAgentConsoleActivityLines({ profileId: "build", activity: settled });

  assert.match(idle.join("\n"), /Completed inspection 6/);
  assert.doesNotMatch(idle.join("\n"), /Completed inspection 1\b/);
  assert.match(idle.join("\n"), /… \+2 earlier/);
});

test("WorkShellView renders tools before a bounded task lifecycle without executor prompts", () => {
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
    activity: [{
      id: "tool-1",
      toolCallId: "call-1",
      toolName: "search_text",
      kind: "search",
      intent: "Find auth callers",
      status: "running",
      startedAt: 1,
    }],
  });

  assert.deepEqual(lines, [
    "  ◐ Search  Find auth callers    running",
    "Ship authentication · 1/6",
    "  ◐ Task 2    after Task 1",
    "  ● Task 1",
    "  ○ Task 3    after Task 2",
    "  ○ Task 4    after Task 3",
    "  ○ Task 5    after Task 4",
    "  … +1 more",
  ]);
  assert.doesNotMatch(lines.join("\n"), /private executor prompt/);
});
