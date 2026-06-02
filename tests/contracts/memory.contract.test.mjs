import assert from "node:assert/strict";
import { test } from "node:test";

import { MEMORY_CATEGORIES, PEER_KINDS } from "@unclecode/contracts";

test("peer kinds match Honcho-style entity model", () => {
  assert.deepEqual(PEER_KINDS, ["user", "agent", "team", "run"]);
});

test("memory categories cover episodic/semantic/procedural/external_doc", () => {
  assert.deepEqual(MEMORY_CATEGORIES, [
    "episodic",
    "semantic",
    "procedural",
    "external_doc",
  ]);
});

test("Peer discriminated union accepts each kind", () => {
  const peers = [
    { kind: "user", id: "patreot0312@fronmpt.com" },
    { kind: "agent", persona: "coder" },
    { kind: "team", runId: "tr_xxx" },
    { kind: "run", runId: "tr_xxx" },
  ];
  for (const peer of peers) {
    assert.ok(PEER_KINDS.includes(peer.kind));
  }
});
