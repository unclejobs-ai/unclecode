import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCredentialRecovery,
  classifyLiveProviderPreflight,
  classifyLiveProviderResult,
  parseOpenAIDoctorAuthSummary,
  parseOpenAIAuthStatusSummary,
} from "../../scripts/unclecode-live-provider-qa-lib.mjs";

const expectedText = "UNCLECODE_LIVE_QA_OK";

test("preflights blocked OpenAI auth before live text smoke", () => {
  const doctorAuth = {
    code: 0,
    timedOut: false,
    stdout: JSON.stringify({
      auth: {
        provider: "openai",
        source: "oauth-file",
        type: "oauth",
        runtime: "codex",
        expired: false,
        apiReady: false,
      },
    }),
    stderr: "",
  };

  assert.equal(classifyLiveProviderPreflight({ provider: "openai", authStatus: null, doctorAuth }), "blocked");
  assert.equal(classifyLiveProviderPreflight({ provider: "anthropic", authStatus: null, doctorAuth }), null);
});

test("classifies blocked OpenAI Codex OAuth and explains browser OAuth recovery", () => {
  const authStatus = {
    code: 0,
    timedOut: false,
    stdout: [
      "provider: openai",
      "source: oauth-file",
      "auth: oauth",
      "organization: none",
      "project: none",
      "runtime: codex",
      "expiresAt: none",
      "expired: no",
      "api ready: no",
    ].join("\n"),
    stderr: "",
  };
  const work = {
    code: 1,
    timedOut: false,
    stdout: "",
    stderr:
      "OpenAI OAuth lacks model.request scope for API calls. Use `unclecode auth login --api-key-stdin`, set OPENAI_API_KEY, or use browser OAuth with OPENAI_OAUTH_CLIENT_ID.",
  };

  const status = classifyLiveProviderResult(work, authStatus, expectedText);
  const summary = parseOpenAIAuthStatusSummary(authStatus.stdout);
  const recovery = buildCredentialRecovery({
    provider: "openai",
    status,
    authStatus,
    work,
  });

  assert.equal(status, "blocked");
  assert.deepEqual(summary, {
    provider: "openai",
    source: "oauth-file",
    auth: "oauth",
    runtime: "codex",
    expiresAt: "none",
    expired: "no",
    apiReady: false,
    recovery: null,
  });
  assert.equal(recovery?.reason, "openai-oauth-codex-runtime-not-api-ready");
  assert.equal(recovery?.apiReady, false);
  assert.match(recovery?.preferredFix ?? "", /browser OAuth/i);
  assert.ok(
    recovery?.commands.includes("OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser"),
  );
  assert.ok(recovery?.commands.includes("npm run qa:live"));
});

test("prefers structured doctor auth readiness for OpenAI recovery", () => {
  const doctorAuth = {
    code: 0,
    timedOut: false,
    stdout: JSON.stringify({
      auth: {
        provider: "openai",
        source: "oauth-file",
        type: "oauth",
        runtime: "codex",
        expiresAt: null,
        expired: false,
        apiReady: false,
      },
    }),
    stderr: "",
  };
  const authStatus = {
    code: 0,
    timedOut: false,
    stdout: "provider: openai\nsource: oauth-file\nauth: oauth\nruntime: api\napi ready: yes",
    stderr: "",
  };
  const work = { code: 1, timedOut: false, stdout: "", stderr: "provider blocked" };

  const summary = parseOpenAIDoctorAuthSummary(doctorAuth.stdout);
  const recovery = buildCredentialRecovery({
    provider: "openai",
    status: "blocked",
    authStatus,
    doctorAuth,
    work,
  });

  assert.deepEqual(summary, {
    provider: "openai",
    source: "oauth-file",
    auth: "oauth",
    runtime: "codex",
    expiresAt: null,
    expired: "no",
    apiReady: false,
    recovery: null,
  });
  assert.equal(recovery?.reason, "openai-oauth-codex-runtime-not-api-ready");
  assert.equal(recovery?.apiReady, false);
  assert.deepEqual(recovery?.authStatus, summary);
});

test("parses structured auth status json for OpenAI recovery", () => {
  const summary = parseOpenAIAuthStatusSummary(JSON.stringify({
    provider: "openai",
    source: "api-key-env",
    type: "api-key",
    organizationId: "org_json",
    projectId: "proj_json",
    runtime: null,
    expiresAt: null,
    expired: false,
    apiReady: true,
  }));

  assert.deepEqual(summary, {
    provider: "openai",
    source: "api-key-env",
    auth: "api-key",
    runtime: null,
    expiresAt: null,
    expired: "no",
    apiReady: true,
    recovery: null,
  });
});

test("preserves auth status json recovery metadata for blocked OpenAI QA", () => {
  const authStatus = {
    code: 0,
    timedOut: false,
    stdout: JSON.stringify({
      provider: "openai",
      source: "oauth-file",
      type: "oauth",
      runtime: "codex",
      expiresAt: null,
      expired: false,
      apiReady: false,
      recovery: {
        reason: "openai-oauth-codex-runtime-not-api-ready",
        preferredFix: "Use API-ready browser OAuth or an API key.",
        commands: [
          "OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser",
          "unclecode auth login --api-key-stdin",
          "npm run qa:live",
        ],
        verify: "npm run qa:live",
      },
    }),
    stderr: "",
  };
  const doctorAuth = {
    code: 0,
    timedOut: false,
    stdout: JSON.stringify({
      auth: {
        provider: "openai",
        source: "oauth-file",
        type: "oauth",
        runtime: "codex",
        expiresAt: null,
        expired: false,
        apiReady: false,
      },
    }),
    stderr: "",
  };
  const summary = parseOpenAIAuthStatusSummary(authStatus.stdout);
  const recovery = buildCredentialRecovery({
    provider: "openai",
    status: "blocked",
    authStatus,
    doctorAuth,
    work: { code: 1, timedOut: false, stdout: "", stderr: "provider blocked" },
  });

  assert.deepEqual(summary?.recovery, {
    reason: "openai-oauth-codex-runtime-not-api-ready",
    preferredFix: "Use API-ready browser OAuth or an API key.",
    commands: [
      "OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser",
      "unclecode auth login --api-key-stdin",
      "npm run qa:live",
    ],
    verify: "npm run qa:live",
  });
  assert.equal(recovery?.reason, "openai-oauth-codex-runtime-not-api-ready");
  assert.equal(recovery?.preferredFix, "Use API-ready browser OAuth or an API key.");
  assert.deepEqual(recovery?.commands, [
    "OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser",
    "unclecode auth login --api-key-stdin",
    "npm run qa:live",
  ]);
  assert.equal(recovery?.verify, "npm run qa:live");
  assert.deepEqual(recovery?.authStatus?.recovery, summary?.recovery);
});

test("preserves doctor json recovery metadata for blocked OpenAI QA", () => {
  const doctorAuth = {
    code: 0,
    timedOut: false,
    stdout: JSON.stringify({
      auth: {
        provider: "openai",
        source: "oauth-file",
        type: "oauth",
        runtime: "codex",
        expiresAt: null,
        expired: false,
        apiReady: false,
        recovery: {
          reason: "openai-oauth-codex-runtime-not-api-ready",
          preferredFix: "Use doctor-provided browser OAuth recovery.",
          commands: [
            "OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser",
            "npm run qa:live",
          ],
          verify: "npm run qa:live",
        },
      },
    }),
    stderr: "",
  };
  const authStatus = {
    code: 0,
    timedOut: false,
    stdout: "provider: openai\nsource: oauth-file\nauth: oauth\nruntime: codex\napi ready: no",
    stderr: "",
  };
  const summary = parseOpenAIDoctorAuthSummary(doctorAuth.stdout);
  const recovery = buildCredentialRecovery({
    provider: "openai",
    status: "blocked",
    authStatus,
    doctorAuth,
    work: { code: 1, timedOut: false, stdout: "", stderr: "provider blocked" },
  });

  assert.deepEqual(summary?.recovery, {
    reason: "openai-oauth-codex-runtime-not-api-ready",
    preferredFix: "Use doctor-provided browser OAuth recovery.",
    commands: [
      "OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser",
      "npm run qa:live",
    ],
    verify: "npm run qa:live",
  });
  assert.equal(recovery?.preferredFix, "Use doctor-provided browser OAuth recovery.");
  assert.deepEqual(recovery?.commands, [
    "OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser",
    "npm run qa:live",
  ]);
  assert.deepEqual(recovery?.authStatus?.recovery, summary?.recovery);
});

test("does not attach credential recovery to passing live provider QA", () => {
  const work = {
    code: 0,
    timedOut: false,
    stdout: `final: ${expectedText}`,
    stderr: "",
  };
  const status = classifyLiveProviderResult(work, null, expectedText);

  assert.equal(status, "pass");
  assert.equal(buildCredentialRecovery({ provider: "openai", status, authStatus: null, work }), null);
});

test("marks rejected OpenAI API-key credentials as operationally not API-ready", () => {
  const authStatus = {
    code: 0,
    timedOut: false,
    stdout: JSON.stringify({
      provider: "openai",
      source: "api-key-env",
      type: "api-key",
      runtime: null,
      expired: false,
      apiReady: true,
    }),
    stderr: "",
  };
  const rejectedWork = { code: 1, timedOut: false, stdout: "", stderr: "OpenAI rejected current auth (401/403)." };
  const recovery = buildCredentialRecovery({
    provider: "openai",
    status: "blocked",
    authStatus,
    work: rejectedWork,
  });

  assert.equal(recovery?.reason, "openai-auth-rejected");
  assert.equal(recovery?.authStatus?.apiReady, true);
  assert.equal(recovery?.apiReady, false);
});

test("does not pass live provider text smoke from prompt echo alone", () => {
  const work = {
    code: 0,
    timedOut: false,
    stdout: [
      "You message",
      `Respond with exactly ${expectedText}.`,
      "Ready.",
    ].join("\n"),
    stderr: "",
  };

  assert.equal(classifyLiveProviderResult(work, null, expectedText), "failed");
});
