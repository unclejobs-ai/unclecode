import assert from "node:assert/strict";
import test from "node:test";

import { redactSecrets } from "../../packages/providers/src/redaction.ts";

test("provider redaction delegates secret scrubbing to Rust", () => {
  const githubToken = `ghp_${"1".repeat(36)}`;
  const openaiKey = `sk-proj-${"a".repeat(30)}`;
  const input = [
    `token=${githubToken}`,
    `openai=${openaiKey}`,
    "private=-----BEGIN PRIVATE KEY-----\nabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz\n-----END PRIVATE KEY-----",
  ].join("\n");

  assert.equal(
    redactSecrets(input),
    ["token=[REDACTED]", "openai=[REDACTED]", "private=[REDACTED]"].join("\n"),
  );
});
