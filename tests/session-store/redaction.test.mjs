import assert from "node:assert/strict";
import test from "node:test";

import { redactSecrets, stringifyWithRedaction } from "../../packages/session-store/src/redaction.ts";

test("session-store redaction delegates string scrubbing to Rust", () => {
  const githubToken = `ghp_${"1".repeat(36)}`;
  assert.equal(
    redactSecrets(`token ${githubToken}`),
    "token [REDACTED]",
  );
});

test("session-store stringifyWithRedaction redacts nested string values through Rust", () => {
  const payload = {
    sessionId: "plain-session",
    metadata: {
      credential: `sk-proj-${"a".repeat(30)}`,
    },
  };

  assert.equal(
    stringifyWithRedaction(payload),
    '{"sessionId":"plain-session","metadata":{"credential":"[REDACTED]"}}',
  );
});
