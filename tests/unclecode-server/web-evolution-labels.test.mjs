import assert from "node:assert/strict";
import test from "node:test";

import { evolutionEvidenceLabel } from "../../apps/godness-web/src/evolution-labels.js";

test("only fresh PR-ready evolution evidence is labelled verified", () => {
  assert.equal(evolutionEvidenceLabel({ state: "pr-ready", stale: false }), "verified");
  assert.equal(evolutionEvidenceLabel({ state: "rejected", stale: false }), "unproven");
  assert.equal(evolutionEvidenceLabel({ state: "failed", stale: false }), "unproven");
  assert.equal(evolutionEvidenceLabel({ state: "cancelled", stale: false }), "unproven");
  assert.equal(evolutionEvidenceLabel({ state: "stale", stale: true }), "stale");
  assert.equal(evolutionEvidenceLabel({ state: "pr-ready", stale: true }), "stale");
});
