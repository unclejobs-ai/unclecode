import test from "node:test";
import assert from "node:assert/strict";

import { resolveOpenAIAuth } from "../shared/openaiAuth.js";

function buildJwtWithExp(expSeconds) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.sig`;
}

test("resolveOpenAIAuth prefers OPENAI_API_KEY when present", () => {
  const result = resolveOpenAIAuth({
    env: { OPENAI_API_KEY: "sk-test-123" },
    authJsonPath: "/does/not/matter",
    readAuthJson: () => {
      throw new Error("should not read auth.json when OPENAI_API_KEY is set");
    },
  });

  assert.equal(result.status, "ok");
  assert.equal(result.authType, "api-key");
  assert.equal(result.bearerToken, "sk-test-123");
});

test("resolveOpenAIAuth reports expired OPENAI_AUTH_TOKEN honestly", () => {
  const pastExp = Math.floor(Date.now() / 1000) - 3600;
  const result = resolveOpenAIAuth({
    env: { OPENAI_AUTH_TOKEN: buildJwtWithExp(pastExp) },
    authJsonPath: "/does/not/matter",
    readAuthJson: () => {
      throw new Error("should not read auth.json when OPENAI_AUTH_TOKEN is set");
    },
  });

  assert.equal(result.status, "expired");
  assert.equal(result.authType, "oauth");
  assert.equal(result.source, "env-openai-auth-token");
});

test("resolveOpenAIAuth ignores example OPENAI_API_KEY placeholders and reuses legacy auth schema", () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const result = resolveOpenAIAuth({
    env: { OPENAI_API_KEY: "your_openai_api_key_here" },
    authJsonPath: "/mock/.codex/auth.json",
    readAuthJson: () =>
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: buildJwtWithExp(futureExp),
          refresh_token: "rt_123",
        },
      }),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.authType, "oauth");
  assert.equal(result.source, "unclecode-auth-file");
});

test("resolveOpenAIAuth reuses legacy auth schema access token when valid", () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const result = resolveOpenAIAuth({
    env: {},
    authJsonPath: "/mock/.codex/auth.json",
    readAuthJson: () =>
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: buildJwtWithExp(futureExp),
          refresh_token: "rt_123",
          account_id: "acct_123",
        },
      }),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.authType, "oauth");
  assert.equal(result.source, "unclecode-auth-file");
  assert.match(result.bearerToken, /\./);
});

test("resolveOpenAIAuth reuses current UncleCode credential schema when valid", () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const result = resolveOpenAIAuth({
    env: {},
    authJsonPath: "/mock/.unclecode/credentials/openai.json",
    readAuthJson: () =>
      JSON.stringify({
        accessToken: buildJwtWithExp(futureExp),
        refreshToken: "rt_123",
        accountId: "acct_123",
      }),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.authType, "oauth");
  assert.equal(result.source, "unclecode-auth-file");
  assert.match(result.bearerToken, /\./);
});

test("resolveOpenAIAuth reports expired Codex auth.json tokens", () => {
  const pastExp = Math.floor(Date.now() / 1000) - 3600;
  const result = resolveOpenAIAuth({
    env: {},
    authJsonPath: "/mock/.codex/auth.json",
    readAuthJson: () =>
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: buildJwtWithExp(pastExp),
          refresh_token: "rt_123",
        },
      }),
  });

  assert.equal(result.status, "expired");
  assert.equal(result.authType, "oauth");
  assert.equal(result.authPath, "/mock/.codex/auth.json");
});

test("resolveOpenAIAuth reports missing auth when no key and no auth file exist", () => {
  const result = resolveOpenAIAuth({
    env: {},
    authJsonPath: "/mock/.codex/auth.json",
    readAuthJson: () => {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
  });

  assert.equal(result.status, "missing");
  assert.equal(result.authType, "none");
});
