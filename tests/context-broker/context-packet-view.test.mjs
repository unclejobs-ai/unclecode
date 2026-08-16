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
    assert.ok(lines.includes('Next answer · <unclecode_context_packet id="packet-test-1" version="1">'));
    assert.ok(lines.includes("Controls · Esc close · /context refresh"));
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

  it("keeps packet preview lines identical to the provider-bound prompt prefix", () => {
    const packet = createContextPacketView({
      id: "packet-preview-parity",
      generatedAt: "2026-07-08T00:00:00.000Z",
      included: [
        {
          id: "runtime-summary",
          category: "runtime",
          label: "terminal output",
          reason: "latest shell output",
          preview: "tests passed",
        },
      ],
      excluded: [],
      warnings: [],
      preview: ["Stale human summary that must not masquerade as model preview."],
    });

    const prefixLines = formatContextPacketPromptPrefix(packet).split("\n");

    assert.deepEqual(packet.preview, prefixLines);
    assert.equal(
      buildContextPacketPreviewLines(packet)
        .some((line) => line.includes("Stale human summary")),
      false,
    );
  });

  it("includes the provider-bound prompt prefix in the compact work-shell preview", () => {
    const packet = createContextPacketView({
      id: "packet-work-shell-prefix",
      generatedAt: "2026-07-08T00:00:00.000Z",
      included: [
        {
          id: "workspace-guidance",
          category: "workspace",
          label: "AGENTS.md",
          reason: "repo instructions loaded",
          preview: "Use small diffs.",
        },
      ],
      excluded: [],
      warnings: [],
      preview: ["decorative preview must not be used"],
    });

    const lines = buildWorkShellCompactContextPacketPreviewLines(packet);
    const prefixStart = lines.indexOf("Provider prompt prefix");

    assert.notEqual(prefixStart, -1);
    assert.deepEqual(lines.slice(prefixStart + 1), formatContextPacketPromptPrefix(packet).split("\n"));
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

    assert.equal(formatContextPacketIndicator(packet), "▤ 2 ctx · 1 held");
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
    assert.equal(formatContextPacketIndicator(packet), "▤ 1 ctx · 64 held");
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
      "Sources · 16 included · 12 held back · 7 warnings · token estimate unknown",
      "UncleCode · included summaries go to the model; raw audit artifacts stay local.",
      "Included in next answer",
    ]);
    assert.equal(lines.filter((line) => line.startsWith("+ bridge ·")).length, 1);
    assert.equal(lines.filter((line) => line.startsWith("- omo ·")).length, 1);
    assert.ok(lines.includes("Warnings · 7 · warning.1: warning 1 · 6 more"));
    assert.ok(lines.includes('Next answer · <unclecode_context_packet id="packet-bounded" version="1">'));
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
    assert.ok(lines.includes("Held back locally"));
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
    assert.ok(getDisplayWidth(summary) <= 110);
    assert.match(summary, /…$/);
  });

  it("appends a pinned segment to the footer indicator when included sources are pinned", () => {
    const packet = createContextPacketView({
      id: "packet-pinned",
      generatedAt: "2026-06-04T00:00:00.000Z",
      included: [
        { id: "workspace", category: "workspace", label: "AGENTS.md", reason: "loaded", salience: 1.0 },
        { id: "omo", category: "omo", label: "G001", reason: "active goal", salience: 1.0 },
      ],
      excluded: [],
      warnings: [],
      preview: [],
    });

    const result = formatContextPacketIndicator(packet);
    assert.ok(/📌.*2 pinned/.test(result), `expected pinned segment in "${result}"`);
  });

  it("omits the pinned segment when no included source is pinned", () => {
    const packet = createContextPacketView({
      id: "packet-unpinned",
      generatedAt: "2026-06-04T00:00:00.000Z",
      included: [
        { id: "workspace", category: "workspace", label: "AGENTS.md", reason: "loaded", salience: 0.5 },
        { id: "omo", category: "omo", label: "G001", reason: "active goal", salience: 0.5 },
      ],
      excluded: [],
      warnings: [],
      preview: [],
    });

    const result = formatContextPacketIndicator(packet);
    assert.equal(result.includes("pinned"), false);
  });

  it("drops internal source fields at the public packet boundary", () => {
    const internalItem = {
      id: "condensed-history",
      category: "condensed-history",
      label: "Condensed history",
      reason: "bounded summary",
      preview: "Public summary",
      content: "raw provider payload",
      badges: [
        {
          label: "condensed",
          tone: "info",
          secretToken: "badge-secret",
          path: "/var/internal/badge.json",
        },
      ],
      provenance: {
        kind: "condensed-history",
        sourceId: "history-1",
        scope: "workspace",
        secretToken: "provenance-secret",
        store: "sqlite:///var/internal/provenance.db",
      },
      freshness: {
        state: "fresh",
        updatedAt: "2026-07-13T00:00:00.000Z",
        projectId: "internal-project",
        secretToken: "freshness-secret",
      },
      rank: {
        score: 0.42,
        factors: [
          {
            label: "recency",
            value: "high",
            secretToken: "factor-secret",
            path: "/var/internal/factor.json",
          },
        ],
        store: "redis://internal-rank",
        projectId: "internal-project",
      },
      metadata: {
        kind: "condensed-history",
        sourceEventIds: ["trace-internal"],
        summary: "internal summary",
        recomputeReason: "token pressure",
        compactedEventCount: 1,
        recentEventCount: 2,
        compression: {
          method: "recent-window",
          inputTokensEstimate: 10,
          outputTokensEstimate: 4,
          secretToken: "compression-secret",
          path: "/var/internal/compression.json",
        },
        sourceEventPreviews: ["raw event"],
      },
      arbitraryInternalField: "must not escape",
    };

    const internalWarning = {
      code: "omo.multiple-active",
      message: "Multiple active OMO sessions detected.",
      severity: "warning",
      secretToken: "warning-secret",
      store: "sqlite:///var/internal/warnings.db",
      projectId: "internal-project",
    };
    const policySource = {
      id: "policy-source",
      label: "Public policy source",
      authority: "mandatory",
      digest: "sha256:policy-public-boundary",
      secretToken: "policy-secret",
      path: "/var/internal/policy.json",
      store: "sqlite:///var/internal/policy.db",
      projectId: "internal-project",
    };
    const manifest = {
      id: "manifest-public-boundary",
      profileId: "build",
      createdAt: "2026-07-13T00:00:00.000Z",
      packetId: "packet-public-boundary",
      policy: [policySource],
      includedSourceCount: 1,
      excludedSourceCount: 0,
      tokenEstimate: 30,
      secretToken: "manifest-secret",
      path: "/var/internal/manifest.json",
      store: "sqlite:///var/internal/manifest.db",
      projectId: "internal-project",
    };
    const included = [internalItem];
    const excluded = [];
    const warnings = [internalWarning];
    const preview = ["caller-owned preview"];

    const packet = createContextPacketView({
      id: "packet-public-boundary",
      generatedAt: "2026-07-13T00:00:00.000Z",
      included,
      excluded,
      warnings,
      preview,
      manifest,
    });
    assert.notStrictEqual(packet.included, included);
    assert.notStrictEqual(packet.included[0], internalItem);
    assert.notStrictEqual(packet.warnings, warnings);
    assert.notStrictEqual(packet.warnings[0], internalWarning);
    assert.notStrictEqual(packet.preview, preview);
    const projectedManifest = packet.manifest;
    assert.ok(projectedManifest, "the valid prompt manifest must survive the public projection");
    assert.notStrictEqual(projectedManifest, manifest);
    assert.notStrictEqual(projectedManifest.policy, manifest.policy);
    assert.notStrictEqual(projectedManifest.policy[0], policySource);

    for (const [boundaryPath, record] of [
      ["manifest", projectedManifest],
      ["manifest.policy[0]", projectedManifest.policy[0]],
    ]) {
      for (const leaked of ["secretToken", "path", "store", "projectId"]) {
        assert.equal(
          Object.hasOwn(record, leaked),
          false,
          `${boundaryPath} leaked internal field "${leaked}" through the public packet boundary`,
        );
      }
    }
    assert.deepEqual(projectedManifest, {
      id: "manifest-public-boundary",
      profileId: "build",
      createdAt: "2026-07-13T00:00:00.000Z",
      packetId: "packet-public-boundary",
      policy: [{
        id: "policy-source",
        label: "Public policy source",
        authority: "mandatory",
        digest: "sha256:policy-public-boundary",
      }],
      includedSourceCount: 1,
      excludedSourceCount: 0,
      tokenEstimate: 30,
    });

    const projected = packet.included[0];
    const nestedPublicRecords = [
      ["included[0].badges[0]", projected.badges?.[0]],
      ["included[0].provenance", projected.provenance],
      ["included[0].freshness", projected.freshness],
      ["included[0].rank", projected.rank],
      ["included[0].rank.factors[0]", projected.rank?.factors?.[0]],
      ["included[0].metadata.compression", projected.metadata?.compression],
      ["warnings[0]", packet.warnings[0]],
    ];
    for (const [path, record] of nestedPublicRecords) {
      assert.ok(record, `${path} must survive the public projection`);
      for (const leaked of ["secretToken", "path", "store", "projectId"]) {
        assert.equal(
          Object.hasOwn(record, leaked),
          false,
          `${path} leaked internal field "${leaked}" through the public packet boundary`,
        );
      }
    }

    assert.deepEqual(projected, {
      id: "condensed-history",
      category: "condensed-history",
      group: "conversation",
      label: "Condensed history",
      reason: "bounded summary",
      preview: "Public summary",
      badges: [{ label: "condensed", tone: "info" }],
      provenance: {
        kind: "condensed-history",
        sourceId: "history-1",
        scope: "workspace",
      },
      freshness: {
        state: "fresh",
        updatedAt: "2026-07-13T00:00:00.000Z",
      },
      rank: {
        score: 0.42,
        factors: [{ label: "recency", value: "high" }],
      },
      metadata: {
        kind: "condensed-history",
        sourceEventIds: ["trace-internal"],
        summary: "internal summary",
        recomputeReason: "token pressure",
        compactedEventCount: 1,
        recentEventCount: 2,
        compression: {
          method: "recent-window",
          inputTokensEstimate: 10,
          outputTokensEstimate: 4,
        },
      },
    });

    assert.deepEqual(packet.warnings, [
      {
        code: "omo.multiple-active",
        message: "Multiple active OMO sessions detected.",
        severity: "warning",
      },
    ]);
    manifest.id = "caller-mutated-manifest";
    manifest.packetId = "caller-mutated-packet";
    manifest.policy.push({
      id: "caller-added-policy",
      label: "Caller-added policy",
      authority: "profile-eligible",
      digest: "sha256:caller-added-policy",
    });
    policySource.label = "caller-mutated-policy";
    internalItem.badges[0].label = "caller-mutated-badge";
    internalWarning.message = "caller-mutated-warning";

    assert.equal(projectedManifest.id, "manifest-public-boundary");
    assert.equal(projectedManifest.packetId, "packet-public-boundary");
    assert.equal(projectedManifest.policy.length, 1);
    assert.equal(projectedManifest.policy[0].label, "Public policy source");
    assert.equal(packet.included[0].badges[0].label, "condensed");
    assert.equal(packet.warnings[0].message, "Multiple active OMO sessions detected.");
  });
});
