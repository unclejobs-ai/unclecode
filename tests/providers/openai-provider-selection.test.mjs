import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeOpenAIProviderId,
  resolvePreferredOpenAIProvider,
} from "@unclecode/providers";

function buildJwtWithScopes(scopes, expSeconds = Math.floor(Date.now() / 1000) + 3600) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, scp: scopes })).toString("base64url");
  return `${header}.${payload}.sig`;
}

test("normalizeOpenAIProviderId keeps canonical ids and maps legacy openai to openai-api", () => {
  assert.equal(normalizeOpenAIProviderId("openai-api"), "openai-api");
  assert.equal(normalizeOpenAIProviderId("openai-codex"), "openai-codex");
  assert.equal(normalizeOpenAIProviderId("openai"), "openai-api");
  assert.equal(normalizeOpenAIProviderId("gemini"), null);
});

test("resolvePreferredOpenAIProvider prefers Codex OAuth over API key when reusable Codex auth exists", async () => {
  const codexToken = buildJwtWithScopes(["openid", "profile", "offline_access"]);

  const result = await resolvePreferredOpenAIProvider({
    env: {
      OPENAI_API_KEY: "sk-test-123",
    },
    readCodexAuthFile: async () =>
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: codexToken,
          refresh_token: "rt_123",
        },
      }),
    readApiAuthFile: async () => {
      throw new Error("api auth file should not be needed when env key exists");
    },
  });

  assert.equal(result.providerId, "openai-codex");
  assert.equal(result.authLabel, "oauth-file");
  assert.deepEqual(result.authIssueLines, []);
});

test("resolvePreferredOpenAIProvider falls back to OpenAI API when Codex auth is absent but API key exists", async () => {
  const result = await resolvePreferredOpenAIProvider({
    env: {
      OPENAI_API_KEY: "sk-test-123",
    },
    readCodexAuthFile: async () => {
      throw new Error("missing codex auth");
    },
    readApiAuthFile: async () => {
      throw new Error("missing api auth file");
    },
  });

  assert.equal(result.providerId, "openai-api");
  assert.equal(result.authLabel, "api-key-env");
  assert.deepEqual(result.authIssueLines, []);
});

test("resolvePreferredOpenAIProvider surfaces both missing-auth routes when neither Codex OAuth nor API key exists", async () => {
  const result = await resolvePreferredOpenAIProvider({
    env: {},
    readCodexAuthFile: async () => {
      throw new Error("missing codex auth");
    },
    readApiAuthFile: async () => {
      throw new Error("missing api auth file");
    },
  });

  assert.equal(result.providerId, null);
  assert.equal(result.authLabel, "none");
  assert.match(result.authIssueLines.join("\n"), /OpenAI Codex/i);
  assert.match(result.authIssueLines.join("\n"), /OpenAI API/i);
});
