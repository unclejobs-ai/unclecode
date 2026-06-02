import assert from "node:assert/strict";
import { test } from "node:test";

import { SSOT_CATEGORIES } from "@unclecode/contracts";

test("SSOT contract enumerates the canonical categories", () => {
  assert.deepEqual(SSOT_CATEGORIES, [
    "code",
    "checkpoint",
    "worker_message",
    "context_packet",
    "review",
    "credential",
    "policy_decision",
    "workspace_guidance",
    "session_metadata",
    "mmbridge_session",
    "memory_observation",
    "external_doc",
  ]);
});

test("VersionedRef shape is round-trip JSON safe", () => {
  const ref = {
    category: "code",
    key: "src/auth.ts",
    versionHash: "a3f9c2",
    retrievedAt: 1714234567890,
  };
  const roundTripped = JSON.parse(JSON.stringify(ref));
  assert.deepEqual(roundTripped, ref);
});

test("CitedClaim allows zero or many citations", () => {
  const noCite = { claim: "build passes", citations: [] };
  const oneCite = {
    claim: "tests fail",
    citations: [
      {
        category: "checkpoint",
        key: "5",
        versionHash: "deadbeef",
        retrievedAt: 0,
        snippet: "exit code 1",
      },
    ],
  };
  assert.equal(noCite.citations.length, 0);
  assert.equal(oneCite.citations.length, 1);
});
