import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { Text } from "ink";

import {
  WorkShellView,
  resolveWorkShellComposerAdditionalRows,
} from "../../packages/tui/src/work-shell-view.tsx";
import {
  buildContextDeskCollectionRows,
  buildContextInspectorRows,
  computeContextOverlayViewportMaxRows,
} from "../../packages/tui/src/work-shell-context-inspector-model.ts";
import { renderContextInspectorGroupedViewport } from "../../packages/tui/src/work-shell-context-inspector-sources.tsx";
import { formatContextInspectorPacketProofLines } from "../../packages/tui/src/work-shell-context-inspector-header.tsx";
import {
  formatContextTurnReceiptLine,
  renderContextTurnReceipt,
} from "../../packages/tui/src/work-shell-context-receipt.tsx";
import { renderDebugFrame, waitForSettledFrame } from "./work-shell-render-harness.mjs";

process.env.UNCLECODE_TERMINAL_BACKGROUND = "light";

import { getDisplayWidth } from "../../packages/tui/src/text-width.ts";
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

  assert.match(output, /Review before sending · context changed/);
  assert.match(rendered, /Review before sending · context changed/);
  for (const proof of [output, rendered]) {
    assert.doesNotMatch(proof, /crp-a91f|crp-b203|receipt-preview|receipt-submitted|turn-session/);
  }
  assert.equal(
    rendered.match(/Review before sending ·|Next request ·|Last request ·/g)?.length,
    1,
  );
  const narrowProof = formatContextInspectorPacketProofLines({
    packet: packet({ id: "crp-b203" }),
    previewReceipt: receipt({ packetId: "crp-a91f" }),
    packetChange,
    modelWindow: 128_000,
    width: 48,
  }).join("\n");
  assert.match(narrowProof, /Review before sending · context changed/);
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

  assert.equal(output, "▤ 3 sent · ~18.1k tok");
  assert.doesNotMatch(output, /crp-b203|turn-session|preview|reason|content/);
});

test("turn receipt derives every source count from its auditable source refs", () => {
  const output = formatContextTurnReceiptLine(receipt({
    state: "submitted",
    turnId: "turn-session-1-8",
    sourceCount: 14,
  }));

  assert.equal(output, "▤ 3 sent · ~18.1k tok");
});

test("WorkShellView keeps context proof to one quiet row outside the transcript", async () => {
  const output = await renderView({
    activePanel: { title: "Status", lines: ["Ready"] },
    contextPacket: packet({ id: "crp-b203" }),
    entries: [{ role: "assistant", text: "Completed." }],
    contextSubmittedReceipt: receipt({
      state: "submitted",
      turnId: "turn-session-1-7",
    }),
  });

  assert.match(output, /▤ 3 sent · ~18\.1k tok/);
  assert.doesNotMatch(output, /Guidance 1 · Memory 2/);
  assert.equal(output.match(/▤/g)?.length, 1);
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

  assert.match(fullOutput, /▤ 3 sent · ~18\.1k tok/);
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

  assert.match(output, /Context Desk/);
  assert.match(output, /2 sent · 3 held/);
  assert.match(output, /Selected · recent Q&A/);
  assert.match(output, /반갑다\./);
  assert.match(output, /Since last send/);
  assert.match(output, /\+ recent Q&A/);
  assert.match(output, /Proof · Held back · session loop trail · undo ready/);
  assert.match(output, /↑↓ move · Enter details · Space hold back · P pin · U undo · Esc close/);
  assert.doesNotMatch(output, /Preflight|Compare|Preview ·/);
  assert.doesNotMatch(output, /Project instructions|Current conversation|Tool activity/);
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
  const selectedLine = lines.findIndex((line) => line.includes("Selected · recent Q&A"));
  const sourceLine = lines.findIndex((line) => line.includes("› ● recent Q&A"));

  assert.ok(selectedLine >= 0);
  assert.ok(sourceLine >= 0);
  assert.ok(Math.abs(selectedLine - sourceLine) <= 1);
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

  assert.match(output, /1 warning/);
  assert.match(output, /Review · Runtime source lacks a precise token estimate; review before answering\./);
  assert.match(output, /↑↓ move · Enter details · Esc close/);
  assert.match(output, /› ● AGENTS\.md · ~42t/);
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
  assert.match(output, /› ● workspace source 14 · ~5t/);
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

  assert.match(output, /Suggestions · 4/);
  assert.match(output, /Hold back · AGENTS\.md · save ~3\.2k/);
  assert.match(output, /Why · This source exceeds the strict low-/);
  assert.match(output, /A accept · R reject/);
  assert.match(output, /Refresh · recent Q&A · accepted/);
  assert.match(output, /… 2 more/);
  assert.doesNotMatch(output, /Keep · session loop trail|Summarize · recent Q&A/);
  // Advice no longer displaces the selected preview: both blocks are on screen.
  assert.match(output, /Selected · AGENTS\.md/);
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

  assert.match(output, /› ● AGENTS\.md · pinned · ~42t/);
  assert.match(output, /A accept · R reject/);
  assert.equal(output.match(/A accept · R reject/g)?.length, 1);
  assert.match(output, /… 5 more/);
  assert.match(output, /Selected · AGENTS\.md/);
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

  assert.match(output, /Context Desk · next answer/);
  assert.match(output, /Sources · 36 sent · 8 held/);
  assert.match(output, /› ● source 22 · ~8t/);
  assert.match(output, /… \d+ more (above|below)/);
  // At 52 columns the one-row footer keeps navigation and pane discovery;
  // optional mutations yield first, and exit copy may truncate at the edge.
  assert.match(output, /↑↓ move · Enter details · ←→ pane/);
  // The selected preview survives the narrowest supported frame.
  assert.match(output, /Selected · source 22/);
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

test("source viewport keeps the selected middle row inside a one-row budget", async () => {
  const sourceTemplate = packet().included[0];
  const contextPacket = packet({
    included: Array.from({ length: 5 }, (_, index) => ({
      ...sourceTemplate,
      id: `viewport-source-${index}`,
      label: `viewport source ${index}`,
      reason: `viewport reason ${index}`,
      preview: `viewport preview ${index}`,
      salience: index === 2 ? 1 : 0.5,
    })),
    excluded: [],
    sourceCounts: { included: 5, excluded: 0, warnings: 0 },
  });
  const rows = buildContextInspectorRows(contextPacket);
  const cursorIndex = rows.findIndex((row) => row.item.id === "viewport-source-2");
  assert.equal(cursorIndex, 2, "the fixture must keep the selected source in the middle");
  const viewport = renderContextInspectorGroupedViewport({
    rows,
    maxRows: 1,
    cursorIndex,
    marginTop: 0,
    width: 80,
    palette: {
      assistant: "cyan",
      text: "white",
      textDim: "gray",
      borderDefault: "gray",
    },
    actionsEnabled: false,
  });
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(React.Fragment, null, viewport),
    { columns: 80, rows: 10 },
  );

  try {
    await waitForSettledFrame(getOutput);
    const output = getOutput();
    const lines = output.replace(ANSI_PATTERN, "").split("\n");
    assert.match(output, /› ● viewport source 2/);
    assert.doesNotMatch(output, /… \d+ more (above|below)/);
    assert.ok(
      lines.length <= 1,
      `one-row source viewport rendered ${lines.length} physical rows`,
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
  const inventoryLine = lines.findIndex((line) => line.includes("Context Desk runbook · ~30t"));

  assert.ok(runbookLine >= 0, "expected a runbook block");
  assert.ok(inventoryLine >= 0, "expected the source inventory");
  assert.match(output, /Doing · Wire the runbook block into the pack/);
  assert.match(output, /Next · Needs your input/);
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
  assert.match(output, /Selected · Context Desk runbook/);
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

  assert.match(output, /Runbook · Wire the runbook block into the packe/);
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

  assert.match(output, /Since last send · \+ recent Q&A/);
  assert.match(output, /− AGENTS\.md/);
  assert.match(output, /~2\.5k larger/);
  // Comparing the next packet does not drop the previously submitted receipt.
  assert.match(output, /Next request · ready to send/);
  assert.doesNotMatch(output, /crp-a91f|crp-b203|receipt-submitted|receipt-preview|turn-session/);
});

test("Korean Context Desk localizes runbook, compare, and action receipt chrome only", async () => {
  const contextPacket = packet({
    id: "crp-b203",
    included: [workNodeSource(), ...packet().included],
    sourceCounts: { included: 3, excluded: 3, warnings: 0 },
  });
  const output = await renderView(
    {
      uiLocale: "ko",
      contextPacket,
      contextInspectorCursor: 0,
      contextPreviewReceipt: receipt({ packetId: "crp-b203", tokenEstimate: 20_600 }),
      contextSubmittedReceipt: receipt({
        id: "receipt-submitted-ko",
        packetId: "crp-a91f",
        state: "submitted",
        turnId: "turn-ko",
        tokenEstimate: 18_100,
      }),
      contextPacketChange: {
        kind: "safety-refresh",
        removedSourceIds: ["workspace-1"],
        addedSourceIds: ["bridge-1"],
        protectedSourceIds: [],
        reason: "RAW_CHANGE_REASON",
      },
      contextActionReceipt: {
        id: "action-ko",
        action: "include",
        sourceId: "workspace-1",
        sourceLabel: "AGENTS.md EXACT",
        message: "RAW_ACTION_MESSAGE",
        succeeded: true,
        canUndo: true,
        before: { includedInModel: false, tokenEstimate: 42 },
        after: { includedInModel: true, tokenEstimate: 42 },
      },
      terminalColumns: 160,
      terminalRows: 50,
    },
    { columns: 160, rows: 50 },
  );

  assert.match(output, /실행 지침 · Ship the Context Desk/);
  assert.match(output, /진행 중 · Wire the runbook block into the packet view/);
  assert.match(output, /다음 · 입력이 필요함/);
  assert.match(output, /증거 · 3개 중 1개 수집됨/);
  assert.match(output, /최근 전송 이후 · \+ recent Q&A/);
  assert.match(output, /~2\.5k 증가/);
  assert.match(output, /증명 · 포함됨 · AGENTS\.md EXACT · ~42t 전송됨 · 실행 취소 가능/);
  assert.match(output, /Context Desk runbook|Ship the Context Desk|AGENTS\.md EXACT/,
    "artifact and work-node payload stays unchanged");
  assert.doesNotMatch(output, /Runbook ·|Doing ·|Next · Needs your input|Evidence ·|Since last send|larger|now sent|undo ready/);
  assert.doesNotMatch(output, /RAW_CHANGE_REASON|RAW_ACTION_MESSAGE|receipt-submitted-ko|turn-ko|action-ko/);

  const detail = await renderView({
    uiLocale: "ko",
    contextPacket,
    contextInspectorCursor: 0,
    contextInspectorExpanded: "goal-loop-graph-7-node-3",
    terminalColumns: 100,
    terminalRows: 50,
  }, { columns: 100, rows: 50 });
  assert.match(detail, /목표 · Ship the Context Desk/);
  assert.match(detail, /상태 · 입력 필요/);
  assert.match(detail, /유지 조건 · Do not edit engine files/);
  assert.match(detail, /승인 조건 · Runbook renders before the source list/);
  assert.match(detail, /증거 · 3개 중 1개 수집됨/);
  assert.doesNotMatch(detail, /Goal ·|Status · requires action|Must hold ·|Accepted when ·|Evidence · 1 of 3 collected/);
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

  assert.match(output, /› Summarize · recent Q&A · save ~900/);
  assert.match(output, /A accept · R reject/);
  assert.equal(output.match(/A accept · R reject/g)?.length, 1);
  assert.match(output, /… 5 more/);
  assert.ok(
    output.split("\n").length <= 40,
    "reaching a late suggestion must not grow the 52x40 frame",
  );
});


// biome-ignore lint/suspicious/noControlCharactersInRegex: measuring painted columns requires stripping SGR sequences.
const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

/** A packet that populates every Context Desk group plus both delivery lanes. */
function deskPacket() {
  return packet({
    included: [
      {
        id: "guidance-1",
        category: "workspace-guidance",
        label: "AGENTS.md",
        reason: "workspace guidance",
        preview: "Workspace instructions stay active.",
        tokenEstimate: 42,
        includedInModel: true,
      },
      {
        id: "conversation-1",
        category: "condensed-history",
        label: "recent Q&A",
        reason: "current conversation",
        preview: "recent exchange preview body",
        tokenEstimate: 24,
        includedInModel: true,
      },
      {
        id: "memory-1",
        category: "memory",
        label: "saved decision log",
        reason: "saved memory",
        preview: "decision log preview body stays inspectable",
        tokenEstimate: 30,
        includedInModel: true,
      },
      {
        id: "attachment-1",
        category: "attachment",
        label: "design brief.pdf",
        reason: "attached file",
        preview: "design brief preview body",
        tokenEstimate: 18,
        includedInModel: true,
      },
      {
        id: "tools-1",
        category: "runtime",
        label: "runtime trace",
        reason: "tool activity",
        preview: "runtime trace preview body",
        tokenEstimate: 12,
        includedInModel: true,
      },
      {
        id: "other-1",
        category: "mystery-provider",
        label: "unmapped source",
        reason: "unclassified provider",
        preview: "unmapped preview body",
        tokenEstimate: 6,
        includedInModel: true,
      },
    ],
    excluded: [
      {
        id: "memory-held-1",
        category: "memory",
        label: "older memory note",
        reason: "held back locally",
        preview: "older memory preview body",
        tokenEstimate: 9,
        includedInModel: false,
      },
      {
        id: "tools-held-1",
        category: "loop-trail",
        label: "session loop trail",
        reason: "raw trail stays local",
        preview: "session loop preview body",
        tokenEstimate: 7,
        includedInModel: false,
      },
    ],
    warnings: [],
    preview: [],
    sourceCounts: { included: 6, excluded: 2, warnings: 0 },
    tokenEstimate: 148,
    manifest: undefined,
  });
}

function deskCursorFor(sourceId, contextPacket) {
  const index = buildContextInspectorRows(contextPacket).findIndex((row) => row.item.id === sourceId);
  assert.ok(index >= 0, `expected ${sourceId} in grouped rows`);
  return index;
}

test("Context Desk renders Groups, Sources and Preview as three panes at a wide terminal", async () => {
  const contextPacket = deskPacket();
  const output = await renderView(
    {
      terminalColumns: 120,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextPacket,
      contextInspectorPane: "sources",
      contextInspectorCollection: "all",
      contextInspectorCursor: deskCursorFor("memory-1", contextPacket),
    },
    { columns: 120, rows: 40 },
  );

  // All three panes are named on the same frame.
  assert.match(output, /GROUPS/);
  assert.match(output, /SOURCES/);
  assert.match(output, /PREVIEW/);

  // The left pane is a collection list: everything, then per-group counts.
  assert.match(output, /All sources[^\n]*\b8\b/);
  assert.match(output, /Guidance[^\n]*\b1\b/);
  assert.match(output, /Conversation[^\n]*\b1\b/);
  assert.match(output, /Memory[^\n]*\b2\b/);
  assert.match(output, /Tools[^\n]*\b2\b/);
  assert.match(output, /Attachments[^\n]*\b1\b/);
  assert.match(output, /Other[^\n]*\b1\b/);

  // Collections are listed in descriptor order, so muscle memory survives.
  const groupLines = output.replace(ANSI_PATTERN, "").split("\n");
  const rowIndex = (label) => groupLines.findIndex((line) => new RegExp(`\\b${label}\\b`).test(line));
  const orderedRows = ["All sources", "Guidance", "Conversation", "Memory", "Tools", "Attachments", "Other"]
    .map((label) => rowIndex(label));
  for (const [position, index] of orderedRows.entries()) {
    assert.ok(index >= 0, `expected a collection row for position ${position}`);
    if (position > 0) {
      assert.ok(
        index > orderedRows[position - 1],
        `collection rows must follow descriptor order, got ${JSON.stringify(orderedRows)}`,
      );
    }
  }

  // Delivery lanes are their own collections, not a group.
  assert.match(output, /DELIVERY/);
  assert.match(output, /Sent[^\n]*\b6\b/);
  assert.match(output, /Held[^\n]*\b2\b/);

  // The selected source keeps both its row and its preview on screen.
  assert.match(output, /› ● saved decision log/);
  assert.match(output, /Selected · saved decision log/);
  assert.match(output, /decision log preview body stays inspectable/);

  // Pane switching is discoverable, and the sources pane keeps its own hints.
  assert.match(output, /←→ pane/);
  assert.match(output, /↑↓ move · Enter details/);
});

test("Context Desk moves the cursor and filter with the active pane without losing preview context", async () => {
  const contextPacket = deskPacket();
  const memoryCursor = deskCursorFor("memory-1", contextPacket);

  const onGroups = await renderView(
    {
      terminalColumns: 120,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextPacket,
      contextInspectorPane: "groups",
      contextInspectorCollection: "all",
      contextInspectorCursor: memoryCursor,
    },
    { columns: 120, rows: 40 },
  );
  // Focus on Groups moves the cursor onto the collection list…
  assert.match(onGroups, /› All sources/);
  assert.match(onGroups, /↑↓ collection/);
  // …and the preview pane still explains the selected source.
  assert.match(onGroups, /Selected · saved decision log/);
  assert.match(onGroups, /decision log preview body stays inspectable/);

  const onMemoryCollection = await renderView(
    {
      terminalColumns: 120,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextPacket,
      contextInspectorPane: "sources",
      contextInspectorCollection: "memory",
      contextInspectorCursor: 0,
    },
    { columns: 120, rows: 40 },
  );
  // A group collection filters the middle pane down to that group's sources.
  assert.match(onMemoryCollection, /saved decision log/);
  assert.match(onMemoryCollection, /older memory note/);
  assert.doesNotMatch(onMemoryCollection, /AGENTS\.md/);
  assert.doesNotMatch(onMemoryCollection, /design brief\.pdf/);
  assert.doesNotMatch(onMemoryCollection, /runtime trace/);
  // The cursor lands inside the filtered list and the preview follows it.
  assert.match(onMemoryCollection, /› ● saved decision log/);
  assert.match(onMemoryCollection, /Selected · saved decision log/);
  assert.match(onMemoryCollection, /↑↓ move · Enter details/);

  const onHeld = await renderView(
    {
      terminalColumns: 120,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextPacket,
      contextInspectorPane: "sources",
      contextInspectorCollection: "held",
      contextInspectorCursor: 0,
    },
    { columns: 120, rows: 40 },
  );
  // The held lane shows only held-back sources, and still previews one of them.
  assert.match(onHeld, /older memory note/);
  assert.match(onHeld, /session loop trail/);
  assert.doesNotMatch(onHeld, /saved decision log/);
  assert.doesNotMatch(onHeld, /AGENTS\.md/);
  assert.match(onHeld, /Selected · (older memory note|session loop trail)/);

  const onPreview = await renderView(
    {
      terminalColumns: 120,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextPacket,
      contextInspectorPane: "preview",
      contextInspectorCollection: "all",
      contextInspectorCursor: memoryCursor,
    },
    { columns: 120, rows: 40 },
  );
  // Focus on Preview scrolls the preview while the source list stays in frame
  // without competing for the pane cursor.
  assert.match(onPreview, /↑↓ scroll/);
  assert.match(onPreview, /Selected · saved decision log/);
  assert.match(onPreview, /decision log preview body stays inspectable/);
  assert.match(onPreview, /● saved decision log/);
  assert.doesNotMatch(onPreview, /› ● saved decision log/);
});

test("Context Desk keeps the focused pane navigable inside a 52x40 frame", async () => {
  const contextPacket = deskPacket();

  const assertBounded = (frame, label) => {
    const lines = frame.replace(ANSI_PATTERN, "").split("\n");
    for (const line of lines) {
      assert.ok(
        getDisplayWidth(line) <= 52,
        `${label} line measured ${getDisplayWidth(line)} cells in a 52-column terminal: ${line}`,
      );
    }
    assert.ok(lines.length <= 40, `${label} rendered ${lines.length} rows for a 40-row terminal`);
  };

  const onGroups = await renderView(
    {
      terminalColumns: 52,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextPacket,
      contextInspectorPane: "groups",
      contextInspectorCollection: "memory",
      contextInspectorCursor: 0,
    },
    { columns: 52, rows: 40 },
  );
  assertBounded(onGroups, "groups pane");
  // The narrow frame still says which collection is active and how to move in it.
  assert.match(onGroups, /› Memory/);
  assert.match(onGroups, /↑↓ collection/);
  assert.match(onGroups, /saved decision log/);
  assert.doesNotMatch(onGroups, /AGENTS\.md/);

  const onSources = await renderView(
    {
      terminalColumns: 52,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextPacket,
      contextInspectorPane: "sources",
      contextInspectorCollection: "memory",
      contextInspectorCursor: 0,
    },
    { columns: 52, rows: 40 },
  );
  assertBounded(onSources, "sources pane");
  // Switching panes at 52 columns keeps the source cursor and the preview usable.
  assert.match(onSources, /› ● saved decision log/);
  assert.match(onSources, /↑↓ move · Enter details/);
  assert.match(onSources, /Selected · saved decision log/);
  assert.match(onSources, /decision log preview body/);
});

/**
 * Physical frame rows with SGR sequences and the overlay's box edges removed,
 * so a row can be compared against the copy it is supposed to carry.
 */
function frameContentLines(frame) {
  return frame
    .replace(ANSI_PATTERN, "")
    .split("\n")
    .map((line) => line.replace(/^[\s│╭╰├]+/, "").replace(/[\s│╮╯┤]+$/, ""));
}

/**
 * True when `line` reads as a wrapped remainder of `text`. Ink breaks at word
 * boundaries — and mid-word when a word outruns the row — so a continuation
 * row carries only whole words or broken pieces of words from the row above,
 * while any genuine next element of the frame contributes a foreign token.
 */
function isWrappedRemainderOf(text, line) {
  const words = text.split(/\s+/).filter(Boolean);
  const tokens = line.replace(/…/g, "").split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }
  return tokens.every((token) =>
    words.some((word) => word.startsWith(token) || word.endsWith(token)),
  );
}

/** The desk line carrying `text` must own exactly one physical terminal row. */
function assertSingleRow(lines, { text, anchor, label }) {
  const index = lines.findIndex((line) => line.includes(anchor));
  assert.ok(index >= 0, `${label} never rendered; no row contains ${JSON.stringify(anchor)}`);
  const continuation = lines[index + 1] ?? "";
  assert.ok(
    !isWrappedRemainderOf(text, continuation),
    `${label} spilled onto a second physical row: ${JSON.stringify(continuation)}`,
  );
}

function assertBoundedFrame(frame, label) {
  const lines = frame.replace(ANSI_PATTERN, "").split("\n");
  for (const line of lines) {
    assert.ok(
      getDisplayWidth(line) <= 52,
      `${label} line measured ${getDisplayWidth(line)} cells in a 52-column terminal: ${line}`,
    );
  }
  assert.ok(lines.length <= 40, `${label} rendered ${lines.length} rows for a 40-row terminal`);
}

test("Context Desk spends one physical row on readiness and one on controls at 52x40", async () => {
  const contextPacket = deskPacket();
  const output = await renderView(
    {
      terminalColumns: 52,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextPacket,
      contextInspectorPane: "sources",
      contextInspectorCollection: "all",
      contextInspectorCursor: deskCursorFor("memory-1", contextPacket),
    },
    { columns: 52, rows: 40 },
  );

  assertBoundedFrame(output, "compact desk");
  const lines = frameContentLines(output);

  // The readiness headline is a single row: 52 columns budgets one row for it,
  // so it must be fitted to the painted width instead of wrapping a tail word
  // — or half a word — onto a row of its own.
  assertSingleRow(lines, {
    text: "Ready · Context packet looks ready for the next answer.",
    anchor: "Ready ·",
    label: "readiness overview",
  });

  // Same contract for the controls footer, which today is painted untruncated.
  assertSingleRow(lines, {
    text: "↑↓ move · Enter details · Space hold back · P pin · Esc close · ←→ pane",
    anchor: "↑↓ move · Enter details",
    label: "controls footer",
  });
});

test("compact collection line counts sources the way the Groups pane counts them", async () => {
  const base = deskPacket();
  // One held memory row stands for three real sources, exactly as the packet
  // fixtures elsewhere declare `sourceCount`.
  const contextPacket = {
    ...base,
    excluded: base.excluded.map((item) =>
      item.id === "memory-held-1" ? { ...item, sourceCount: 3 } : item),
    sourceCounts: { included: 6, excluded: 4, warnings: 0 },
  };

  const onGroups = await renderView(
    {
      terminalColumns: 52,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextPacket,
      contextInspectorPane: "groups",
      contextInspectorCollection: "memory",
      contextInspectorCursor: 0,
    },
    { columns: 52, rows: 40 },
  );
  assertBoundedFrame(onGroups, "groups pane");
  const groupsCount = frameContentLines(onGroups)
    .map((line) => /^[›●]?\s*Memory\s+(\d+)$/.exec(line))
    .find((match) => match !== null)?.[1];
  assert.ok(groupsCount !== undefined, "expected a Memory collection row with a count in the Groups pane");
  assert.equal(groupsCount, "4", "Groups pane must weight the held memory row by its source count");

  const onSources = await renderView(
    {
      terminalColumns: 52,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextPacket,
      contextInspectorPane: "sources",
      contextInspectorCollection: "memory",
      contextInspectorCursor: 0,
    },
    { columns: 52, rows: 40 },
  );
  assertBoundedFrame(onSources, "sources pane");
  // The compact frame hides the Groups pane, so its collection line is the only
  // count on screen. Reporting the filtered row count instead of the weighted
  // source count makes the same collection read as two sizes in one session.
  const collectionLine = frameContentLines(onSources).find((line) => line.startsWith("Collection ·"));
  assert.ok(collectionLine !== undefined, "expected a compact collection context line");
  assert.equal(
    collectionLine,
    `Collection · Memory · ${groupsCount} sources`,
    "compact collection line must report the Groups pane's source-weighted count",
  );
});

test("scrollable Preview keeps both overflow markers inside a 52x40 frame", async () => {
  const baseSource = packet().included[0];
  const contextPacket = packet({
    included: [{
      ...baseSource,
      id: "scrolling-preview",
      label: "Scroll target",
      reason: "scrolling preview",
      preview: Array.from({ length: 40 }, (_, index) => `preview segment ${index + 1}`).join(" "),
      tokenEstimate: 42,
    }],
    excluded: [],
    warnings: [],
    preview: [],
    sourceCounts: { included: 1, excluded: 0, warnings: 0 },
    tokenEstimate: 42,
  });
  const output = await renderView(
    {
      terminalColumns: 52,
      terminalRows: 40,
      contextPacket,
      contextInspectorPane: "preview",
      contextInspectorCursor: 0,
      contextInspectorDetailOffset: 2,
    },
    { columns: 52, rows: 40 },
  );

  assert.match(output, /… \d+ more above/);
  assert.match(output, /… \d+ more below/);
  assertBoundedFrame(output, "scrollable Preview");
});

test("long Runbook and Selected labels keep their prefixes inside a 52-column frame", async () => {
  const longGoal = `Ship the Context Desk ${"with a carefully bounded runbook ".repeat(8)}`;
  const longTitle = `Wire the runbook block ${"without losing its label ".repeat(8)}`;
  const longLabel = `Context Desk runbook ${"label ".repeat(20)}`;
  const node = workNodeSource({
    label: longLabel,
    preview: `Aim: ${longGoal}`,
    metadata: {
      ...workNodeSource().metadata,
      title: longTitle,
      goal: longGoal,
    },
  });
  const contextPacket = packet({
    included: [node, ...packet().included],
    sourceCounts: { included: 3, excluded: 3, warnings: 0 },
  });
  const workNodeCursor = buildContextInspectorRows(contextPacket).findIndex(
    (row) => row.item.metadata?.kind === "work-node",
  );
  const output = await renderView(
    {
      terminalColumns: 52,
      terminalRows: 40,
      contextPacket,
      contextInspectorCursor: workNodeCursor,
      contextSourceActionsEnabled: true,
    },
    { columns: 52, rows: 40 },
  );

  assertBoundedFrame(output, "long runbook and selected labels");
  const lines = frameContentLines(output);
  const runbookLine = lines.find((line) => line.includes("Runbook ·"));
  const selectedLine = lines.find((line) => line.includes("Selected ·"));
  assert.ok(runbookLine?.trimStart().startsWith("Runbook ·"), "Runbook prefix must survive label truncation");
  assert.ok(selectedLine?.trimStart().startsWith("Selected ·"), "Selected prefix must survive label truncation");
  assertSingleRow(lines, {
    text: `Runbook · ${longGoal}`,
    anchor: "Runbook ·",
    label: "long Runbook label",
  });
  assertSingleRow(lines, {
    text: `Selected · ${longLabel}`,
    anchor: "Selected ·",
    label: "long Selected label",
  });
});

test("constructor and toString group values sort after canonical groups", () => {
  const source = packet().included[0];
  const contextPacket = packet({
    included: [
      { ...source, id: "constructor-group", category: "mystery-provider", group: "constructor" },
      { ...source, id: "to-string-group", category: "mystery-provider", group: "toString" },
      { ...source, id: "canonical-guidance", category: "workspace", group: "guidance" },
      { ...source, id: "canonical-memory", category: "memory", group: "memory" },
    ],
    excluded: [],
    sourceCounts: { included: 4, excluded: 0, warnings: 0 },
  });

  const rows = buildContextInspectorRows(contextPacket);
  assert.deepEqual(
    rows.map((row) => row.item.id),
    ["canonical-guidance", "canonical-memory", "constructor-group", "to-string-group"],
  );
});

test("collection counts read each sourceCount once while preserving weighted totals", () => {
  let sourceCountReads = 0;
  const countedSource = (
    id,
    category,
    sourceCount,
    includedInModel,
  ) => ({
    id,
    category,
    label: id,
    reason: `${id} reason`,
    preview: `${id} preview`,
    tokenEstimate: 10,
    includedInModel,
    get sourceCount() {
      sourceCountReads += 1;
      return sourceCount;
    },
  });
  const contextPacket = packet({
    included: [
      countedSource("guidance-source", "workspace", 2, true),
      countedSource("memory-source", "memory", 3, true),
    ],
    excluded: [
      countedSource("held-memory-source", "memory", 4, false),
    ],
    sourceCounts: { included: 5, excluded: 4, warnings: 0 },
  });

  const rows = buildContextInspectorRows(contextPacket);
  const collections = buildContextDeskCollectionRows(rows);
  const counts = Object.fromEntries(collections.map((row) => [row.id, row.count]));

  assert.equal(sourceCountReads, 3, "each sourceCount getter must be read once");
  assert.deepEqual(counts, {
    all: 9,
    guidance: 2,
    conversation: 0,
    memory: 7,
    tools: 0,
    attachments: 0,
    other: 0,
    sent: 5,
    held: 4,
  });
});

test("unknown token budget line stays one physical row at 52 columns", async () => {
  const contextPacket = packet({
    tokenEstimate: undefined,
    tokenEstimateState: "unknown",
  });
  const output = await renderView(
    {
      terminalColumns: 52,
      terminalRows: 40,
      contextPacket,
      contextInspectorCursor: 0,
    },
    { columns: 52, rows: 40 },
  );

  assertBoundedFrame(output, "unknown token budget");
  assertSingleRow(frameContentLines(output), {
    text: "Sources · 2 sent · 3 held · unknown token estimate / 200k",
    anchor: "Sources ·",
    label: "unknown token budget line",
  });
});

test("tight and over budget states render Review copy with a sanitized largest source", async () => {
  const contextPacket = packet({
    included: [
      {
        ...packet().included[0],
        id: "largest-source",
        category: "loop-trail",
        label: ".omo/ulw-loop/session/ledger.jsonl",
        reason: "raw trail stays local",
        preview: "raw trail preview",
        tokenEstimate: 95,
      },
      {
        ...packet().included[1],
        id: "smaller-source",
        tokenEstimate: 5,
      },
    ],
    excluded: [],
    warnings: [],
    preview: [],
    sourceCounts: { included: 2, excluded: 0, warnings: 0 },
    tokenEstimate: 90,
    tokenEstimateState: "estimated",
    manifest: undefined,
  });

  for (const [modelWindow, budgetState] of [[100, "tight"], [80, "over"]]) {
    const output = await renderView(
      {
        terminalColumns: 140,
        terminalRows: 40,
        contextPacket,
        contextInspectorCursor: 0,
        modelWindow,
      },
      { columns: 140, rows: 40 },
    );
    assert.match(
      output,
      new RegExp(`Review · Budget is ${budgetState}\\. Largest source is Tool activity · session loop trail at ~95t\\.`),
    );
    assert.doesNotMatch(output, /\.omo\/ulw-loop\/session\/ledger\.jsonl/);
    assert.doesNotMatch(output, new RegExp(`Ready · Budget is ${budgetState}`));
  }

  const meaningChangeOutput = await renderView(
    {
      terminalColumns: 140,
      terminalRows: 40,
      contextPacket,
      contextInspectorCursor: 0,
      modelWindow: 100,
      contextPreviewReceipt: receipt({ state: "previewed" }),
      contextPacketChange: {
        kind: "meaning-change",
        removedSourceIds: ["largest-source"],
        addedSourceIds: [],
        protectedSourceIds: [],
        reason: "The selected context changed.",
      },
    },
    { columns: 140, rows: 40 },
  );
  assert.match(meaningChangeOutput, /Review ·/);
  assert.match(meaningChangeOutput, /Review before sending · context changed/);
  assert.doesNotMatch(meaningChangeOutput, /Ready ·/);
});

test("controls keep pane switching visible before optional mutations at 52 and 80 columns", async () => {
  const basePacket = deskPacket();
  const contextPacket = {
    ...basePacket,
    included: basePacket.included.map((item) =>
      item.id === "memory-1"
        ? { ...item, actions: ["pin", "hold-back", "preview"] }
        : item),
  };
  const cursor = deskCursorFor("memory-1", contextPacket);
  for (const columns of [52, 80]) {
    const output = await renderView(
      {
        terminalColumns: columns,
        terminalRows: 40,
        contextSourceActionsEnabled: true,
        contextPacket,
        contextInspectorPane: "sources",
        contextInspectorCollection: "all",
        contextInspectorCursor: cursor,
        contextActionReceipt: {
          id: `context-action-${columns}`,
          action: "hold-back",
          sourceId: "memory-1",
          sourceLabel: "saved decision log",
          message: "held back saved decision log",
          canUndo: true,
          succeeded: true,
          beforePacketId: "packet-before",
          afterPacketId: contextPacket.id,
        },
      },
      { columns, rows: 40 },
    );
    const lines = frameContentLines(output);
    const controls = lines.find((line) => line.includes("↑↓ move · Enter details"));
    assert.ok(controls !== undefined, `expected controls footer at ${columns} columns`);
    assert.match(controls, /←→ pane/);
    assert.ok(
      getDisplayWidth(controls) <= columns,
      `controls footer exceeded ${columns} columns: ${controls}`,
    );
    assertSingleRow(lines, {
      text: "↑↓ move · Enter details · Space hold back · P pin · U undo · Esc close · ←→ pane",
      anchor: "↑↓ move · Enter details",
      label: `${columns}-column controls footer`,
    });
  }
});

test("Context Desk distinguishes Sources focus from Preview focus on the selected source row", async () => {
  const contextPacket = deskPacket();
  const cursor = deskCursorFor("memory-1", contextPacket);
  const onSources = await renderView(
    {
      terminalColumns: 120,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextPacket,
      contextInspectorPane: "sources",
      contextInspectorCollection: "all",
      contextInspectorCursor: cursor,
    },
    { columns: 120, rows: 40 },
  );
  const onPreview = await renderView(
    {
      terminalColumns: 120,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextPacket,
      contextInspectorPane: "preview",
      contextInspectorCollection: "all",
      contextInspectorCursor: cursor,
    },
    { columns: 120, rows: 40 },
  );

  const sourceLine = frameContentLines(onSources)
    .find((line) => line.includes("● saved decision log"));
  assert.match(sourceLine ?? "", /› ● saved decision log/);
  const previewLine = frameContentLines(onPreview)
    .find((line) => line.includes("● saved decision log"));
  assert.match(previewLine ?? "", /● saved decision log/);
  assert.doesNotMatch(previewLine ?? "", /› ● saved decision log/);
});

test("narrow Groups delivery lanes keep Sent and Held glyphs without a DELIVERY heading", async () => {
  const output = await renderView(
    {
      terminalColumns: 52,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextPacket: deskPacket(),
      contextInspectorPane: "groups",
      contextInspectorCollection: "all",
      contextInspectorCursor: 0,
    },
    { columns: 52, rows: 40 },
  );
  const lines = frameContentLines(output);

  assert.doesNotMatch(output, /DELIVERY/);
  assert.ok(lines.some((line) => /^● Sent\b/.test(line)), "Sent lane must keep its filled glyph");
  assert.ok(lines.some((line) => /^○ Held\b/.test(line)), "Held lane must keep its open glyph");
});

test("compact Groups stays inside its bounded pane allocation with a wrapped composer", async () => {
  const terminalColumns = 52;
  const terminalRows = 40;
  const draft = Array.from(
    { length: 4 },
    (_, index) => `composer line ${index + 1} ${"keeps the active request visible ".repeat(2)}`,
  ).join("\n");
  const composerAdditionalRows = resolveWorkShellComposerAdditionalRows({
    inputValue: draft,
    terminalColumns,
  });
  const contextDeskTerminalRows = Math.max(1, terminalRows - composerAdditionalRows);
  const overlayViewportRows = computeContextOverlayViewportMaxRows({
    terminalRows: contextDeskTerminalRows,
    reservedRows: 0,
  });
  const workbenchRows = Math.max(1, overlayViewportRows - 1);
  const contentRows = Math.max(1, workbenchRows - 1);
  const groupsPaneAllocation = Math.max(2, contentRows - 1 - 2 - 1);
  assert.equal(
    groupsPaneAllocation,
    4,
    "the fixture must share the Composer's four-row viewport plus both possible overflow markers",
  );

  const output = await renderView(
    {
      terminalColumns,
      terminalRows,
      composer: React.createElement(Text, null, draft),
      inputValue: draft,
      contextSourceActionsEnabled: true,
      contextPacket: deskPacket(),
      contextInspectorPane: "groups",
      contextInspectorCollection: "all",
      contextInspectorCursor: 0,
    },
    { columns: terminalColumns, rows: terminalRows },
  );
  const lines = frameContentLines(output);
  const groupsStart = lines.findIndex((line) => line.trim() === "GROUPS");
  const sourceStart = lines.findIndex(
    (line, index) => index > groupsStart && line.includes("AGENTS.md"),
  );
  assert.ok(groupsStart >= 0, "expected the Groups pane heading");
  assert.ok(sourceStart > groupsStart, "expected the source pane after Groups");
  const groupPaneLines = lines
    .slice(groupsStart, sourceStart)
    .map((line) => line.trim())
    .filter((line) =>
      /^(?:GROUPS|(?:›\s+|[●○]\s+)?(?:All sources|Guidance|Conversation|Memory|Tools|Attachments|Other|Sent|Held)\s+\d+|… \d+ more collections)$/u
        .test(line),
    );

  assert.ok(
    groupPaneLines.length <= groupsPaneAllocation,
    `Groups painted ${groupPaneLines.length} rows for a ${groupsPaneAllocation}-row pane`,
  );
  assert.ok(
    output.replace(ANSI_PATTERN, "").split("\n").length <= terminalRows,
    `compact Groups frame exceeded ${terminalRows} terminal rows`,
  );
});

test("narrow Groups keeps the selected preview after reserving source rows", async () => {
  const terminalColumns = 52;
  const terminalRows = 44;
  const output = await renderView(
    {
      terminalColumns,
      terminalRows,
      contextSourceActionsEnabled: true,
      contextPacket: deskPacket(),
      contextInspectorPane: "groups",
      contextInspectorCollection: "memory",
      contextInspectorCursor: 0,
    },
    { columns: terminalColumns, rows: terminalRows },
  );

  assert.match(output, /Selected · saved decision log/);
  assert.match(output, /decision log preview body stays inspectable/);
  assert.ok(
    output.replace(ANSI_PATTERN, "").split("\n").length <= terminalRows,
    `narrow Groups frame exceeded ${terminalRows} terminal rows`,
  );
});

test("expanded detail keeps a long label after Detail on one bounded row", async () => {
  const longLabel = `expanded detail ${"label ".repeat(20)}`.trim();
  const source = packet().included[0];
  const contextPacket = packet({
    included: [{
      ...source,
      id: "long-detail-source",
      label: longLabel,
      preview: "Expanded detail preview body.",
    }],
    excluded: [],
    sourceCounts: { included: 1, excluded: 0, warnings: 0 },
  });
  const output = await renderView(
    {
      terminalColumns: 52,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextPacket,
      contextInspectorExpanded: "long-detail-source",
      contextInspectorCursor: 0,
      contextInspectorDetailContent: "One bounded detail body.",
    },
    { columns: 52, rows: 40 },
  );

  assertBoundedFrame(output, "expanded long detail");
  const lines = frameContentLines(output);
  const detailLine = lines.find((line) => line.includes("Detail ·"));
  assert.ok(
    detailLine?.trimStart().startsWith("Detail ·"),
    "expanded detail must preserve its Detail prefix",
  );
  assertSingleRow(lines, {
    text: `Detail · ${longLabel}`,
    anchor: "Detail ·",
    label: "expanded detail heading",
  });
});

test("80-column advice truncates its source label before the complete savings suffix", async () => {
  const longLabel = "oversized source label that must yield to the savings suffix";
  const source = packet().included[0];
  const contextPacket = packet({
    included: [{
      ...source,
      id: "long-advice-source",
      label: longLabel,
    }],
    sourceCounts: { included: 2, excluded: 3, warnings: 0 },
  });
  const output = await renderView(
    {
      terminalColumns: 80,
      terminalRows: 40,
      contextSourceActionsEnabled: true,
      contextAdviceActionsEnabled: true,
      contextPacket,
      contextInspectorCursor: 0,
      contextPolicySuggestions: [{
        id: "suggestion-long-label",
        packetReceiptId: "receipt-submitted",
        sourceId: "long-advice-source",
        action: "hold-back",
        reasonCode: "low-trust-token-hotspot",
        reasonText: "Hold back this oversized source.",
        estimatedTokenSaving: 3_200,
        status: "proposed",
        createdAt: "2026-07-13T00:00:01.000Z",
      }],
    },
    { columns: 80, rows: 40 },
  );
  const lines = frameContentLines(output);
  const adviceLine = lines.find((line) => line.includes("› Hold back ·"));
  assert.ok(adviceLine !== undefined, "expected the selected advice row");
  const adviceText = adviceLine.slice(adviceLine.indexOf("› Hold back ·"));
  assert.match(adviceText, /save ~3\.2k/);
  assert.ok(
    !adviceText.includes(longLabel),
    "the long source label must yield before the savings suffix",
  );
  assert.ok(
    getDisplayWidth(adviceText) <= 32,
    `advice row exceeded its preview pane width: ${adviceText}`,
  );
  assertSingleRow(lines, {
    text: `› Hold back · ${longLabel} · save ~3.2k`,
    anchor: "› Hold back ·",
    label: "80-column advice row",
  });
});
