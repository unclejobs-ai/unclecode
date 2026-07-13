import assert from "node:assert/strict";
import test from "node:test";

import { evaluateContextPolicy } from "../../packages/orchestrator/src/context-policy-evaluator.ts";

const CREATED_AT = "2026-07-13T00:00:00.000Z";

function sourceRef(sourceId, overrides = {}) {
  return {
    sourceId,
    category: "runtime",
    salience: 0.5,
    includedInModel: true,
    ...overrides,
  };
}

function item(id, overrides = {}) {
  return {
    id,
    category: "runtime",
    label: `Source ${id}`,
    reason: "Selected for the packet.",
    includedInModel: true,
    ...overrides,
  };
}

function receipt(sourceRefs, overrides = {}) {
  return {
    id: "receipt-1",
    projectId: "project-1",
    sessionId: "session-1",
    turnId: "turn-1",
    packetId: "packet-1",
    state: "submitted",
    profile: "build",
    tokenEstimate: 1_000,
    tokenEstimateState: "exact",
    sourceCount: sourceRefs.length,
    sourceRefs,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function packet(items, mandatorySourceIds = []) {
  return {
    id: "packet-1",
    version: 1,
    generatedAt: CREATED_AT,
    title: "Context",
    included: items,
    excluded: [],
    warnings: [],
    preview: [],
    sourceCounts: { included: items.length, excluded: 0, warnings: 0 },
    tokenEstimate: items.reduce((sum, entry) => sum + (entry.tokenEstimate ?? 0), 0),
    tokenEstimateState: "exact",
    manifest: {
      id: "manifest-1",
      profileId: "build",
      createdAt: CREATED_AT,
      packetId: "packet-1",
      policy: mandatorySourceIds.map((id) => ({
        id,
        label: id,
        authority: "mandatory",
        digest: `sha-${id}`,
      })),
      includedSourceCount: items.length,
      excludedSourceCount: 0,
      tokenEstimate: 1_000,
    },
  };
}

const cases = [
  {
    name: "configured prompt mandatory guidance",
    refs: [sourceRef("provider-system-prompt-configured", { category: "provider-system-prompt" })],
    items: [item("provider-system-prompt-configured", {
      category: "provider-system-prompt",
      freshness: { state: "expired" },
    })],
    mandatory: ["provider-system-prompt-configured"],
    expected: ["mandatory-guidance", "keep"],
  },
  {
    name: "workspace mandatory guidance",
    refs: [sourceRef("guidance:workspace-sha", { category: "workspace-guidance" })],
    items: [item("guidance:workspace-sha", { category: "workspace-guidance" })],
    mandatory: ["guidance:workspace-sha"],
    expected: ["mandatory-guidance", "keep"],
  },
  {
    name: "expired source",
    refs: [sourceRef("expired")],
    items: [item("expired", { freshness: { state: "expired" } })],
    expected: ["expired-source", "refresh"],
  },
  {
    name: "stale condensed history",
    refs: [sourceRef("history", { category: "condensed-history" })],
    items: [item("history", {
      category: "condensed-history",
      freshness: { state: "stale" },
      tokenEstimate: 600,
    })],
    expected: ["stale-condensed-history", "summarize"],
  },
  {
    name: "duplicate SHA",
    refs: [
      sourceRef("first", { sha256: "same-sha" }),
      sourceRef("duplicate", { sha256: "same-sha" }),
    ],
    items: [item("first"), item("duplicate", { tokenEstimate: 450 })],
    expected: ["duplicate-fingerprint", "hold-back"],
  },
  {
    name: "low-trust token hotspot",
    refs: [sourceRef("external", { trustTier: "external" })],
    items: [item("external", { trustTier: "external", tokenEstimate: 201 })],
    expected: ["low-trust-token-hotspot", "hold-back"],
  },
];

for (const fixture of cases) {
  test(`optimizer classifies ${fixture.name}`, () => {
    const [result] = evaluateContextPolicy({
      receipt: receipt(fixture.refs),
      packet: packet(fixture.items, fixture.mandatory),
    });
    assert.ok(result);
    assert.equal(result.reasonCode, fixture.expected[0]);
    assert.equal(result.action, fixture.expected[1]);
  });
}

test("optimizer uses strict hotspot threshold and ignores held sources", () => {
  const refs = [
    sourceRef("boundary", { trustTier: "runtime" }),
    sourceRef("held", { trustTier: "external", includedInModel: false }),
  ];
  const suggestions = evaluateContextPolicy({
    receipt: receipt(refs),
    packet: packet([
      item("boundary", { trustTier: "runtime", tokenEstimate: 200 }),
      item("held", { trustTier: "external", tokenEstimate: 900, includedInModel: false }),
    ]),
  });
  assert.deepEqual(suggestions, []);
});

for (const [trustTier, expectedCount] of [
  ["builtin", 0],
  ["project", 0],
  ["user", 0],
  ["external", 1],
  ["runtime", 1],
]) {
  test(`optimizer classifies ${trustTier} trust tier explicitly`, () => {
    const suggestions = evaluateContextPolicy({
      receipt: receipt([sourceRef(`tier-${trustTier}`, { trustTier })]),
      packet: packet([item(`tier-${trustTier}`, { trustTier, tokenEstimate: 201 })]),
    });
    assert.equal(suggestions.length, expectedCount);
  });
}

test("optimizer compares the 20% threshold exactly across safe integers", () => {
  const packetTokens = 9_007_199_254_740_989;
  const sourceTokens = 1_801_439_850_948_198;
  const [suggestion] = evaluateContextPolicy({
    receipt: receipt(
      [sourceRef("large-hotspot", { trustTier: "external" })],
      { tokenEstimate: packetTokens },
    ),
    packet: packet([
      item("large-hotspot", { trustTier: "external", tokenEstimate: sourceTokens }),
    ]),
  });
  assert.equal(suggestion?.reasonCode, "low-trust-token-hotspot");
});
test("optimizer skips low-trust hotspot advice when packet tokens are unknown", () => {
  const unknownBudget = evaluateContextPolicy({
    receipt: receipt(
      [sourceRef("unknown-budget", { trustTier: "external" })],
      { tokenEstimate: undefined, tokenEstimateState: "unknown" },
    ),
    packet: packet([item("unknown-budget", { trustTier: "external", tokenEstimate: 900 })]),
  });
  assert.deepEqual(unknownBudget, []);
});

test("optimizer applies mandatory, expiry, stale, duplicate, then hotspot precedence", () => {
  const refs = [
    sourceRef("base", { sha256: "shared-sha" }),
    sourceRef("mandatory", { category: "workspace-guidance", sha256: "shared-sha" }),
    sourceRef("expired", { sha256: "shared-sha" }),
    sourceRef("stale", { category: "condensed-history", sha256: "shared-sha" }),
    sourceRef("duplicate", { sha256: "shared-sha" }),
  ];
  const suggestions = evaluateContextPolicy({
    receipt: receipt(refs),
    packet: packet([
      item("base"),
      item("mandatory", {
        category: "workspace-guidance",
        freshness: { state: "expired" },
      }),
      item("expired", { freshness: { state: "expired" } }),
      item("stale", {
        category: "condensed-history",
        freshness: { state: "stale" },
      }),
      item("duplicate"),
    ], ["mandatory"]),
  });
  const bySource = new Map(suggestions.map((suggestion) => [suggestion.sourceId, suggestion.reasonCode]));
  assert.equal(bySource.get("mandatory"), "mandatory-guidance");
  assert.equal(bySource.get("expired"), "expired-source");
  assert.equal(bySource.get("stale"), "stale-condensed-history");
  assert.equal(bySource.get("duplicate"), "duplicate-fingerprint");
});

test("optimizer ordering and IDs are deterministic without leaking item content", () => {
  const contentSentinel = "SECRET PACKET CONTENT MUST NOT LEAK";
  const refs = [
    sourceRef("duplicate-base", { sha256: "duplicate-sha" }),
    sourceRef("hold-unknown-z", { sha256: "duplicate-sha" }),
    sourceRef("hold-unknown-a", { sha256: "duplicate-sha" }),
    sourceRef("keep", { category: "workspace-guidance" }),
    sourceRef("summarize", { category: "condensed-history" }),
    sourceRef("refresh"),
    sourceRef("hold-known-small", { trustTier: "external" }),
    sourceRef("hold-known", { trustTier: "external" }),
  ];
  const items = [
    item("duplicate-base"),
    item("hold-unknown-z"),
    item("hold-unknown-a"),
    item("keep", { category: "workspace-guidance" }),
    item("summarize", {
      category: "condensed-history",
      freshness: { state: "stale" },
      tokenEstimate: 300,
    }),
    item("refresh", { freshness: { state: "expired" } }),
    item("hold-known-small", { trustTier: "external", tokenEstimate: 300 }),
    item("hold-known", {
      trustTier: "external",
      tokenEstimate: 700,
      label: contentSentinel,
      reason: contentSentinel,
      preview: contentSentinel,
    }),
  ];
  const input = {
    receipt: receipt(refs, { id: "receipt-sort" }),
    packet: packet(items, ["keep"]),
  };

  const first = evaluateContextPolicy(input);
  const second = evaluateContextPolicy(input);
  assert.deepEqual(second, first);
  assert.deepEqual(
    first.map(({ sourceId, action }) => [sourceId, action]),
    [
      ["refresh", "refresh"],
      ["summarize", "summarize"],
      ["hold-known", "hold-back"],
      ["hold-known-small", "hold-back"],
      ["hold-unknown-a", "hold-back"],
      ["hold-unknown-z", "hold-back"],
      ["keep", "keep"],
    ],
  );
  assert.equal(first[2]?.estimatedTokenSaving, 700);
  assert.equal(first[3]?.estimatedTokenSaving, 300);
  assert.equal(first[4]?.estimatedTokenSaving, undefined);
  assert.match(first[2]?.id ?? "", /^suggestion-[0-9a-f]{24}$/);
  assert.notEqual(first[2]?.id, first[3]?.id);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(contentSentinel));
});

test("optimizer rejects non-submitted and mismatched receipts", () => {
  assert.throws(
    () => evaluateContextPolicy({
      receipt: receipt([], { state: "previewed", turnId: undefined }),
      packet: packet([]),
    }),
    /submitted receipt/i,
  );
  assert.throws(
    () => evaluateContextPolicy({
      receipt: receipt([], { packetId: "packet-other" }),
      packet: packet([]),
    }),
    /does not match evaluator packet/i,
  );
});
