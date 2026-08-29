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

test("runtime diagnostics close cookie, JWT, signing, quoted auth, and escaped-key gaps", () => {
  const cases = [
    {
      input: "Cookie: session_id=cookie-secret; theme=dark",
      expected: "Cookie: [REDACTED]",
      forbidden: ["cookie-secret"],
    },
    {
      input: "Set-Cookie: sid=set-cookie-secret; HttpOnly; SameSite=Strict",
      expected: "Set-Cookie: [REDACTED]",
      forbidden: ["set-cookie-secret"],
    },
    {
      input: "SESSION_COOKIE=session=cookie-env-secret;theme=dark",
      expected: "SESSION_COOKIE=[REDACTED]",
      forbidden: ["cookie-env-secret", "theme=dark"],
    },
    {
      input: 'Authorization: Bearer "quoted-bearer-secret"',
      expected: "Authorization: Bearer [REDACTED]",
      forbidden: ["quoted-bearer-secret"],
    },
    {
      input: "Proxy-Authorization=Basic 'quoted-basic-secret'",
      expected: "Proxy-Authorization=Basic [REDACTED]",
      forbidden: ["quoted-basic-secret"],
    },
    {
      input: "JWT=jwt-named-secret SESSION_TOKEN=session-token-secret SIGNING_KEY=signing-key-secret",
      expected: "JWT=[REDACTED] SESSION_TOKEN=[REDACTED] SIGNING_KEY=[REDACTED]",
      forbidden: ["jwt-named-secret", "session-token-secret", "signing-key-secret"],
    },
    {
      input: '{"\\u0074oken":"escaped-json-secret","message":"safe"}',
      expected: '{"\\u0074oken":"[REDACTED]","message":"safe"}',
      forbidden: ["escaped-json-secret"],
    },
    {
      input: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature123456",
      expected: "[REDACTED]",
      forbidden: ["eyJhbGci", "zZWNyZXQ"],
    },
  ];

  for (const fixture of cases) {
    const result = redactRuntimeDiagnostic(fixture.input);
    assert.equal(result, fixture.expected, fixture.input);
    for (const secret of fixture.forbidden) assert.doesNotMatch(result, new RegExp(secret));
  }
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
