import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildContextPacketPreviewLines,
  buildWorkShellCompactContextPacketPreviewLines,
  createContextPacketView,
  formatContextPacketIndicator,
  formatContextPacketPromptPrefix,
} from "../../packages/context-broker/src/context-packet-view.ts";
import { getDisplayWidth } from "../../packages/context-broker/src/display-width.ts";

describe("context packet view", () => {
  it("builds a human next-answer context preview with source counts", () => {
    const packet = createContextPacketView({
      id: "packet-test-1",
      generatedAt: "2026-06-04T00:00:00.000Z",
      title: "Next answer context",
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
          preview: "Implement context view.",
          tokenEstimate: 18,
        },
      ],
      excluded: [
        {
          id: "omo-raw-ledger",
          category: "omo",
          label: ".omo/ulw-loop/session/ledger.jsonl",
          reason: "raw audit ledger stays local",
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
        "Context will be carried into the next answer.",
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
    assert.equal(packet.excluded[0].reason, "raw audit ledger stays local");

    const lines = buildContextPacketPreviewLines(packet);
    assert.deepEqual(lines.slice(0, 6), [
      "Context · Next answer context",
      "Sources · 2 included · 1 held back · 1 warning · ~30 tokens",
      "UncleCode · included summaries go to the model; raw audit artifacts stay local.",
      "Included in next answer",
      "+ workspace · 1 · AGENTS.md (repo instructions loaded) - Prefer small reversible diffs.",
      "+ omo · 1 · G001 context MVP (active ULW goal) - Implement context view.",
    ]);
    assert.ok(lines.includes("Held back locally"));
    assert.ok(lines.includes("- omo · 1 · .omo/ulw-loop/session/ledger.jsonl (raw audit ledger stays local)"));
    assert.ok(lines.includes("Warnings · 1 · omo.multiple-active: Multiple active OMO sessions detected."));
    assert.ok(lines.includes("Next answer · Context will be carried into the next answer."));
    assert.ok(lines.includes("Controls · Esc close · /context refresh · Ctrl+O context"));
    assert.equal(lines.some((line) => /\bPacket\b|provider packet|Next model-call packet/.test(line)), false);
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
    assert.match(prefix, /Excluded raw artifacts:\n- 1 raw artifact withheld from model-ready context; inspect \/context for local-only details\./);
    assert.doesNotMatch(prefix, /\.omo\/ulw-loop\/session\/evidence\/C001\.txt/);
    assert.match(prefix, /Warnings:\n- 1 context issue withheld from model-ready context; inspect \/context for local-only details\./);
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

    assert.equal(formatContextPacketIndicator(packet), "context 2 ready · 1 held back");
  });

  it("keeps compact packet rows but counts grouped raw artifacts accurately", () => {
    const packet = createContextPacketView({
      id: "packet-grouped-excluded",
      generatedAt: "2026-06-04T00:00:00.000Z",
      included: [
        { id: "workspace", category: "workspace", label: "AGENTS.md", reason: "loaded" },
      ],
      excluded: [
        {
          id: "omo-evidence-summary",
          category: "omo",
          label: "64 raw OMO evidence transcripts",
          reason: "raw OMO evidence transcripts stay local",
          sourceCount: 64,
        },
      ],
      warnings: [],
      preview: [],
    });

    assert.equal(packet.excluded.length, 1);
    assert.equal(packet.sourceCounts.excluded, 64);
    assert.equal(formatContextPacketIndicator(packet), "context 1 ready · 64 held back");
    assert.match(
      formatContextPacketPromptPrefix(packet),
      /Excluded raw artifacts:\n- 64 raw artifacts withheld from model-ready context; inspect \/context for local-only details\./,
    );
    assert.ok(
      buildContextPacketPreviewLines(packet).includes(
        "- omo · 64 · 64 raw OMO evidence transcripts (raw OMO evidence transcripts stay local)",
      ),
    );
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
        reason: "raw OMO evidence transcript stays local",
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
      "Context · Next answer context",
      "Sources · 16 included · 12 held back · 7 warnings",
      "UncleCode · included summaries go to the model; raw audit artifacts stay local.",
      "Included in next answer",
    ]);
    assert.equal(lines.filter((line) => line.startsWith("+ bridge ·")).length, 1);
    assert.equal(lines.filter((line) => line.startsWith("- omo ·")).length, 1);
    assert.ok(lines.includes("Warnings · 7 · warning.1: warning 1 · 6 more"));
    assert.ok(lines.includes("Next answer · provider prefix preview"));
    assert.equal(lines.length <= 12, true);
  });

  it("builds the compact work-shell overlay preview from the shared formatter", () => {
    const packet = createContextPacketView({
      id: "packet-work-shell",
      generatedAt: "2026-06-04T00:00:00.000Z",
      included: [
        {
          id: "workspace-guidance",
          category: "workspace",
          label: "AGENTS.md",
          reason: "repo instructions loaded",
          preview: "Prefer small reversible diffs.",
        },
      ],
      excluded: [],
      warnings: [],
      preview: ["Context will be carried into the next answer."],
    });

    const lines = buildWorkShellCompactContextPacketPreviewLines(packet);
    assert.ok(lines[0]?.startsWith("Sources ·"));
    assert.ok(lines.includes("Included in next answer"));
    assert.ok(lines.some((line) => line.startsWith("  workspace ·")));
    assert.equal(lines.some((line) => line.includes("Controls ·")), false);
  });

  it("truncates Korean summaries by display width instead of code units", () => {
    const longPreview = "가나다라마바사아자차카타파하".repeat(4);
    const packet = createContextPacketView({
      id: "packet-hangul-truncate",
      generatedAt: "2026-06-04T00:00:00.000Z",
      included: [
        {
          id: "omo-summary",
          category: "omo",
          label: "G001 context MVP",
          reason: "active ULW goal",
          preview: longPreview,
        },
      ],
      excluded: [],
      warnings: [],
      preview: [],
    });

    const summaryLine = buildWorkShellCompactContextPacketPreviewLines(packet)
      .find((line) => line.includes("omo ·"));
    assert.ok(summaryLine);
    const summary = summaryLine.split(" · ").slice(2).join(" · ");
    assert.ok(getDisplayWidth(summary) <= 64);
    assert.match(summary, /…$/);
  });
});
