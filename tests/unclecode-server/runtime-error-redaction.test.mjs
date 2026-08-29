import { test } from "node:test";
import assert from "node:assert/strict";

import {
  boundedRuntimeRpcError,
  redactRuntimeDiagnostic,
} from "../../apps/unclecode-server/src/runtime-error-redaction.ts";

test("runtime diagnostics redact structured, transport, and provider credentials", () => {
  const secrets = [
    "json-secret-value",
    "nested-api-key",
    "query-token-value",
    "basic-credential-value",
    "proxy-basic-value",
    "user-name",
    "user-password",
    "client-secret-value",
    "github_pat_abcdefghijklmnopqrstuvwxyz",
    "AKIAIOSFODNN7EXAMPLE",
  ];
  const input = [
    '{"credential":"json-secret-value","OPENAI_API_KEY":"nested-api-key","message":"safe"}',
    "https://user-name:user-password@example.test/path?access_token=query-token-value&mode=debug",
    "Authorization: Basic basic-credential-value",
    "Proxy-Authorization=Basic proxy-basic-value",
    "clientSecret='client-secret-value'",
    "github_pat_abcdefghijklmnopqrstuvwxyz AKIAIOSFODNN7EXAMPLE",
  ].join(" | ");

  const result = redactRuntimeDiagnostic(input);

  for (const secret of secrets) assert.doesNotMatch(result, new RegExp(secret));
  assert.match(result, /"credential":"\[REDACTED\]"/);
  assert.match(result, /OPENAI_API_KEY":"\[REDACTED\]"/);
  assert.match(result, /https:\/\/\[REDACTED\]@example\.test/);
  assert.match(result, /access_token=\[REDACTED\]&mode=debug/);
  assert.match(result, /Authorization: Basic \[REDACTED\]/);
  assert.match(result, /Proxy-Authorization=Basic \[REDACTED\]/);
  assert.match(result, /"message":"safe"/);
});

test("runtime diagnostics recognize encoded credential query names without redacting ordinary keys", () => {
  const result = redactRuntimeDiagnostic(
    "https://example.test/?api%5Fkey=encoded-secret&monkey=banana&keyboard=qwerty",
  );

  assert.equal(
    result,
    "https://example.test/?api%5Fkey=[REDACTED]&monkey=banana&keyboard=qwerty",
  );
});

test("runtime error conversion is bounded and survives hostile coercion", () => {
  const tail = "z".repeat(2_000);
  const result = boundedRuntimeRpcError(new Error(`DATABASE_CREDENTIAL=database-secret ${tail}`));
  assert.doesNotMatch(result, /database-secret/);
  assert.match(result, /DATABASE_CREDENTIAL=\[REDACTED\]/);
  assert.ok(result.length <= 512);

  assert.equal(boundedRuntimeRpcError({ toString() { throw new Error("token=do-not-leak"); } }), "Runtime operation failed.");
  assert.equal(redactRuntimeDiagnostic("token=secret-value", 1), "…");
});
