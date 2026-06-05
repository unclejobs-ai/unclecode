import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildContextPacketPreviewLines,
  createContextPacketView,
  formatContextPacketIndicator,
  formatContextPacketPromptPrefix,
} from "../../packages/context-broker/src/context-packet-view.ts";

describe("context packet view", () => {
  it("builds a deterministic next-call packet preview with source counts", () => {
    const packet = createContextPacketView({
      id: "packet-test-1",
      generatedAt: "2026-06-04T00:00:00.000Z",
      title: "Next model-call packet",
      included: [
        {
          id: "workspace-guidance",
          category: "workspace",
          label: "AGENTS.md",
          reason: "repo instructions loaded",
          preview: "Prefer small reversible diffs.",
          tokenEstimate: 12,
        },
        {
          id: "omo-active-goal",
          category: "omo",
          label: "G001 context MVP",
          reason: "active ULW goal",
          preview: "Implement packet inspector.",
          tokenEstimate: 18,
        },
      ],
      excluded: [
        {
          id: "omo-raw-ledger",
          category: "omo",
          label: ".omo/ulw-loop/session/ledger.jsonl",
          reason: "raw audit ledger is excluded from provider context",
        },
      ],
      warnings: [
        {
          code: "omo.multiple-active",
          message: "Multiple active OMO sessions detected.",
          severity: "warning",
        },
      ],
      preview: [
        "Packet packet-test-1 will prefix the next provider call.",
        "Included summaries are safe; raw ledgers are excluded.",
      ],
    });

    assert.equal(packet.id, "packet-test-1");
    assert.equal(packet.version, 1);
    assert.deepEqual(packet.sourceCounts, {
      included: 2,
      excluded: 1,
      warnings: 1,
    });
    assert.equal(packet.tokenEstimate, 30);
    assert.equal(packet.included[0].category, "workspace");
    assert.equal(packet.included[1].category, "omo");
    assert.equal(packet.excluded[0].reason, "raw audit ledger is excluded from provider context");

    const lines = buildContextPacketPreviewLines(packet);
    assert.deepEqual(lines.slice(0, 6), [
      "Packet packet-test-1 · Next model-call packet",
      "Sources · 2 included · 1 excluded · 1 warning · ~30 tokens",
      "Provider · next model call receives included summaries; raw audit artifacts stay out.",
      "Included by source",
      "+ workspace · 1 · AGENTS.md (repo instructions loaded) - Prefer small reversible diffs.",
      "+ omo · 1 · G001 context MVP (active ULW goal) - Implement packet inspector.",
    ]);
    assert.ok(lines.includes("Excluded raw artifacts"));
    assert.ok(lines.includes("- omo · 1 · .omo/ulw-loop/session/ledger.jsonl (raw audit ledger is excluded from provider context)"));
    assert.ok(lines.includes("Warnings · 1 · omo.multiple-active: Multiple active OMO sessions detected."));
    assert.ok(lines.includes("Preview · Packet packet-test-1 will prefix the next provider call."));
    assert.ok(lines.includes("Controls · Esc close · /context refresh · Ctrl+O context center"));
  });

  it("formats the provider-bound prompt prefix from the same packet id", () => {
    const packet = createContextPacketView({
      id: "packet-provider-bound",
      generatedAt: "2026-06-04T00:00:00.000Z",
      included: [
        {
          id: "workspace-guidance",
          category: "workspace",
          label: "AGENTS.md",
          reason: "repo instructions loaded",
          preview: "Prefer <small> reversible diffs & packet summaries.",
        },
      ],
      excluded: [
        {
          id: "omo-raw-evidence",
          category: "omo",
          label: ".omo/ulw-loop/session/evidence/C001.txt",
          reason: "raw evidence transcripts are excluded",
        },
      ],
      warnings: [
        {
          code: "omo.multiple-active",
          message: "Multiple active OMO sessions detected: local-session-a.",
          severity: "warning",
        },
      ],
      preview: ["provider prefix preview"],
    });

    const prefix = formatContextPacketPromptPrefix(packet);
    assert.match(prefix, /<unclecode_context_packet id="packet-provider-bound" version="1">/);
    assert.match(
      prefix,
      /Included:\n- workspace: AGENTS\.md \(repo instructions loaded\) - Prefer &lt;small&gt; reversible diffs &amp; packet summaries\./,
    );
    assert.match(prefix, /Excluded raw artifacts:\n- 1 raw artifact withheld from provider context; inspect \/context for local-only details\./);
    assert.doesNotMatch(prefix, /\.omo\/ulw-loop\/session\/evidence\/C001\.txt/);
    assert.match(prefix, /Warnings:\n- 1 packet warning withheld from provider context; inspect \/context for local-only details\./);
    assert.doesNotMatch(prefix, /local-session-a/);
    assert.match(prefix, /<\/unclecode_context_packet>$/);
  });

  it("formats a compact footer indicator for folded context state", () => {
    const packet = createContextPacketView({
      id: "packet-indicator",
      generatedAt: "2026-06-04T00:00:00.000Z",
      included: [
        { id: "workspace", category: "workspace", label: "AGENTS.md", reason: "loaded" },
        { id: "omo", category: "omo", label: "G001", reason: "active goal" },
      ],
      excluded: [
        { id: "raw", category: "omo", label: "ledger.jsonl", reason: "raw ledger excluded" },
      ],
      warnings: [],
      preview: [],
    });

    assert.equal(formatContextPacketIndicator(packet), "packet 2 in · 1 out");
  });

  it("bounds inspector preview lines so /context does not flood the TUI", () => {
    const packet = createContextPacketView({
      id: "packet-bounded",
      generatedAt: "2026-06-04T00:00:00.000Z",
      included: Array.from({ length: 16 }, (_, index) => ({
        id: `included-${index + 1}`,
        category: "bridge",
        label: `bridge ${index + 1}`,
        reason: "project context bridge",
      })),
      excluded: Array.from({ length: 12 }, (_, index) => ({
        id: `excluded-${index + 1}`,
        category: "omo",
        label: `.omo/evidence/${index + 1}.txt`,
        reason: "raw OMO evidence transcript is excluded from provider context",
      })),
      warnings: Array.from({ length: 7 }, (_, index) => ({
        code: `warning.${index + 1}`,
        message: `warning ${index + 1}`,
        severity: "warning",
      })),
      preview: ["provider prefix preview"],
    });

    const lines = buildContextPacketPreviewLines(packet);

    assert.deepEqual(lines.slice(0, 4), [
      "Packet packet-bounded · Next model-call packet",
      "Sources · 16 included · 12 excluded · 7 warnings",
      "Provider · next model call receives included summaries; raw audit artifacts stay out.",
      "Included by source",
    ]);
    assert.equal(lines.filter((line) => line.startsWith("+ bridge ·")).length, 1);
    assert.equal(lines.filter((line) => line.startsWith("- omo ·")).length, 1);
    assert.ok(lines.includes("Warnings · 7 · warning.1: warning 1 · 6 more"));
    assert.ok(lines.includes("Preview · provider prefix preview"));
    assert.equal(lines.length <= 12, true);
  });
});
