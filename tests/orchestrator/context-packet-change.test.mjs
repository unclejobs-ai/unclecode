import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContextPacketSourceRefs,
  buildMandatorySourceIds,
  classifyContextPacketChange,
} from "@unclecode/orchestrator";

const SOURCE_REF_KEYS = new Set([
  "sourceId",
  "category",
  "sha256",
  "trustTier",
  "salience",
  "includedInModel",
]);

function makePacket(overrides = {}) {
  return {
    id: "pkt_1",
    version: 1,
    generatedAt: "2026-07-13T00:00:00.000Z",
    title: "Packet",
    included: [],
    excluded: [],
    warnings: [],
    preview: ["secret preview line"],
    sourceCounts: { included: 0, excluded: 0, warnings: 0 },
    tokenEstimate: 0,
    tokenEstimateState: "unknown",
    ...overrides,
  };
}

test("packet change blocks when a protected source disappears", () => {
  const result = classifyContextPacketChange({
    before: [{ sourceId: "rules", category: "workspace-guidance", salience: 1, includedInModel: true }],
    after: [],
    protectedSourceIds: new Set(["rules"]),
  });
  assert.equal(result.kind, "meaning-change");
  assert.deepEqual(result.removedSourceIds, ["rules"]);
  assert.deepEqual(result.protectedSourceIds, ["rules"]);
});

test("mandatory guidance replacement is a safety refresh", () => {
  const result = classifyContextPacketChange({
    before: [{ sourceId: "rules", category: "workspace-guidance", sha256: "sha-old", salience: 0.95, includedInModel: true }],
    after: [{ sourceId: "rules", category: "workspace-guidance", sha256: "sha-new", salience: 0.95, includedInModel: true }],
    protectedSourceIds: new Set(),
    mandatorySourceIds: new Set(["rules"]),
  });
  assert.equal(result.kind, "safety-refresh");
});

test("unchanged metadata classifies as unchanged", () => {
  const refs = [
    { sourceId: "rules", category: "workspace-guidance", sha256: "sha-1", salience: 0.95, includedInModel: true },
    { sourceId: "memory", category: "memory", sha256: "sha-m", salience: 0.4, includedInModel: true },
  ];
  const result = classifyContextPacketChange({
    before: refs,
    after: refs.map((ref) => ({ ...ref })),
    protectedSourceIds: new Set(["rules"]),
    mandatorySourceIds: new Set(["rules"]),
  });
  assert.equal(result.kind, "unchanged");
  assert.deepEqual(result.removedSourceIds, []);
  assert.deepEqual(result.addedSourceIds, []);
  assert.deepEqual(result.protectedSourceIds, []);
});

test("unknown or nonmandatory source changes are meaning-change", () => {
  const result = classifyContextPacketChange({
    before: [{ sourceId: "trail", category: "loop-trail", sha256: "sha-old", salience: 0.2, includedInModel: true }],
    after: [{ sourceId: "trail", category: "loop-trail", sha256: "sha-new", salience: 0.2, includedInModel: true }],
    protectedSourceIds: new Set(),
    mandatorySourceIds: new Set(["rules"]),
  });
  assert.equal(result.kind, "meaning-change");
  assert.equal(result.reason, "The selected source set changed.");
});

test("mandatory same-id addition without removals is a safety refresh", () => {
  const result = classifyContextPacketChange({
    before: [],
    after: [{ sourceId: "rules", category: "workspace-guidance", sha256: "sha-new", salience: 1, includedInModel: true }],
    protectedSourceIds: new Set(),
    mandatorySourceIds: new Set(["rules"]),
  });
  assert.equal(result.kind, "safety-refresh");
});

test("policy id source id mismatch is treated conservatively as meaning-change", () => {
  const result = classifyContextPacketChange({
    before: [{ sourceId: "rules", category: "workspace-guidance", sha256: "sha-old", salience: 0.95, includedInModel: true }],
    after: [{ sourceId: "rules", category: "workspace-guidance", sha256: "sha-new", salience: 0.95, includedInModel: true }],
    protectedSourceIds: new Set(),
    // Policy entry id does not match the packet source id.
    mandatorySourceIds: new Set(["rules-policy"]),
  });
  assert.equal(result.kind, "meaning-change");
});

test("unmatched mandatory policy ids force meaning-change even when a matched mandatory sha refreshes", () => {
  const result = classifyContextPacketChange({
    before: [{ sourceId: "rules", category: "workspace-guidance", sha256: "sha-old", salience: 0.95, includedInModel: true }],
    after: [{ sourceId: "rules", category: "workspace-guidance", sha256: "sha-new", salience: 0.95, includedInModel: true }],
    protectedSourceIds: new Set(),
    mandatorySourceIds: new Set(["rules", "ghost-policy"]),
  });
  assert.equal(result.kind, "meaning-change");
});

test("diff arrays are deterministically sorted", () => {
  const result = classifyContextPacketChange({
    before: [
      { sourceId: "zeta", category: "memory", salience: 0.1, includedInModel: true },
      { sourceId: "alpha", category: "runtime", salience: 0.1, includedInModel: true },
    ],
    after: [
      { sourceId: "omega", category: "bridge", salience: 0.1, includedInModel: true },
      { sourceId: "beta", category: "system", salience: 0.1, includedInModel: true },
    ],
    protectedSourceIds: new Set(),
  });
  assert.equal(result.kind, "meaning-change");
  assert.deepEqual(result.removedSourceIds, ["alpha", "zeta"]);
  assert.deepEqual(result.addedSourceIds, ["beta", "omega"]);
});

test("sources not included in the model are ignored by classification", () => {
  const result = classifyContextPacketChange({
    before: [
      { sourceId: "held", category: "memory", sha256: "sha-old", salience: 0.1, includedInModel: false },
      { sourceId: "rules", category: "workspace-guidance", sha256: "sha-1", salience: 1, includedInModel: true },
    ],
    after: [
      { sourceId: "held", category: "memory", sha256: "sha-new", salience: 0.1, includedInModel: false },
      { sourceId: "rules", category: "workspace-guidance", sha256: "sha-1", salience: 1, includedInModel: true },
    ],
    protectedSourceIds: new Set(["held"]),
  });
  assert.equal(result.kind, "unchanged");
});

test("classification kinds stay closed", () => {
  const kinds = new Set(["unchanged", "safety-refresh", "meaning-change"]);
  const samples = [
    classifyContextPacketChange({
      before: [{ sourceId: "a", category: "system", salience: 1, includedInModel: true }],
      after: [{ sourceId: "a", category: "system", salience: 1, includedInModel: true }],
      protectedSourceIds: new Set(),
    }),
    classifyContextPacketChange({
      before: [{ sourceId: "rules", category: "workspace-guidance", sha256: "old", salience: 1, includedInModel: true }],
      after: [{ sourceId: "rules", category: "workspace-guidance", sha256: "new", salience: 1, includedInModel: true }],
      protectedSourceIds: new Set(),
      mandatorySourceIds: new Set(["rules"]),
    }),
    classifyContextPacketChange({
      before: [{ sourceId: "a", category: "system", salience: 1, includedInModel: true }],
      after: [],
      protectedSourceIds: new Set(),
    }),
  ];
  for (const sample of samples) {
    assert.equal(kinds.has(sample.kind), true);
  }
});

test("buildContextPacketSourceRefs preserves order and metadata only", () => {
  const packet = makePacket({
    included: [
      {
        id: "rules",
        category: "workspace-guidance",
        label: "Rules",
        reason: "must not leak",
        preview: "SECRET_PREVIEW",
        salience: 0.95,
        includedInModel: true,
        trustTier: "project",
        provenance: {
          kind: "guidance",
          sourceId: "rules",
          sha256: "sha-rules",
        },
      },
      {
        id: "memory",
        category: "memory",
        label: "Memory",
        reason: "also secret",
        preview: "more secrets",
      },
    ],
    excluded: [
      {
        id: "held",
        category: "loop-trail",
        label: "Held",
        reason: "held back",
        preview: "held secret",
        includedInModel: false,
        salience: 0.1,
      },
    ],
    sourceCounts: { included: 2, excluded: 1, warnings: 0 },
  });

  const refs = buildContextPacketSourceRefs(packet);
  assert.deepEqual(
    refs.map((ref) => ref.sourceId),
    ["rules", "memory", "held"],
  );
  assert.deepEqual(refs[0], {
    sourceId: "rules",
    category: "workspace-guidance",
    sha256: "sha-rules",
    trustTier: "project",
    salience: 0.95,
    includedInModel: true,
  });
  assert.deepEqual(refs[1], {
    sourceId: "memory",
    category: "memory",
    salience: 0.5,
    includedInModel: true,
  });
  assert.equal(refs[2].includedInModel, false);
  assert.equal(refs[2].salience, 0.1);

  for (const ref of refs) {
    for (const key of Object.keys(ref)) {
      assert.equal(SOURCE_REF_KEYS.has(key), true, `unexpected key ${key}`);
    }
    assert.equal(Object.hasOwn(ref, "preview"), false);
    assert.equal(Object.hasOwn(ref, "reason"), false);
    assert.equal(Object.hasOwn(ref, "content"), false);
    assert.equal(Object.hasOwn(ref, "label"), false);
  }

  const serialized = JSON.stringify(refs);
  assert.equal(serialized.includes("SECRET_PREVIEW"), false);
  assert.equal(serialized.includes("must not leak"), false);
  assert.equal(serialized.includes("also secret"), false);
  assert.equal(serialized.includes("held secret"), false);
});

test("buildMandatorySourceIds derives mandatory policy ids", () => {
  const packet = makePacket({
    included: [
      {
        id: "rules",
        category: "workspace-guidance",
        label: "Rules",
        reason: "mandatory",
        includedInModel: true,
      },
    ],
    manifest: {
      id: "man_1",
      profileId: "build",
      createdAt: "2026-07-13T00:00:00.000Z",
      packetId: "pkt_1",
      policy: [
        { id: "rules", label: "Rules", authority: "mandatory", digest: "d1" },
        { id: "ghost", label: "Ghost", authority: "mandatory", digest: "d2" },
        { id: "optional", label: "Optional", authority: "profile-eligible", digest: "d3" },
      ],
      includedSourceCount: 1,
      excludedSourceCount: 0,
      tokenEstimate: 0,
    },
  });

  const mandatory = buildMandatorySourceIds(packet);
  assert.deepEqual([...mandatory].sort(), ["ghost", "rules"]);
});
