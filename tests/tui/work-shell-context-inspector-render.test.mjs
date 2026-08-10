import assert from "node:assert/strict";
import test from "node:test";

import React from "react";

import { WorkShellView } from "../../packages/tui/src/work-shell-view.tsx";
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
  assert.match(output, /↑↓ move · Enter details · Space hold back/);
  assert.match(output, /P pin · Esc close/);
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
