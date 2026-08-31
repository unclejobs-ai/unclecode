import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveOpenAIAuth } from "@unclecode/providers";

function buildJwtWithExp(expSeconds) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.sig`;
}

test("package resolveOpenAIAuth accepts legacy token schema", async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const result = await resolveOpenAIAuth({
    env: {},
    readFallbackFile: async () =>
      JSON.stringify({
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

test("package resolveOpenAIAuth accepts current credential schema", async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const result = await resolveOpenAIAuth({
    env: {},
    readFallbackFile: async () =>
      JSON.stringify({
        accessToken: buildJwtWithExp(futureExp),
        refreshToken: "rt_123",
      }),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.authType, "oauth");
  assert.equal(result.source, "unclecode-auth-file");
});

test("package resolveOpenAIAuth accepts stored api-key credential schema", async () => {
  const result = await resolveOpenAIAuth({
    env: {},
    readFallbackFile: async () =>
      JSON.stringify({
        authType: "api-key",
        apiKey: "sk-file-123",
        organizationId: "org_file",
        projectId: "proj_file",
      }),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.authType, "api-key");
  assert.equal(result.source, "unclecode-auth-file");
  assert.equal(result.organizationId, "org_file");
  assert.equal(result.projectId, "proj_file");
});

test("package resolveOpenAIAuth uses Rust resolver for default credential-file path", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "unclecode-rust-auth-"));
  const credentialsPath = path.join(root, "openai.json");
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  writeFileSync(
    credentialsPath,
    `${JSON.stringify({
      authType: "oauth",
      accessToken: buildJwtWithExp(futureExp),
      refreshToken: "rt_123",
      organizationId: "org_rust",
      projectId: "proj_rust",
      runtime: "api",
    })}\n`,
    "utf8",
  );

  const result = await resolveOpenAIAuth({
    env: {
      UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
    },
  });

  assert.equal(result.status, "ok");
  assert.equal(result.authType, "oauth");
  assert.equal(result.source, "unclecode-auth-file");
  assert.equal(result.organizationId, "org_rust");
  assert.equal(result.projectId, "proj_rust");
  assert.equal(result.runtime, "api");
});

test("package resolveOpenAIAuth uses Rust resolver for a single fallback credential path", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "unclecode-rust-auth-fallback-"));
  const credentialsPath = path.join(root, "openai.json");
  writeFileSync(
    credentialsPath,
    `${JSON.stringify({
      authType: "api-key",
      apiKey: "sk-rust-fallback",
      organizationId: "org_single",
      projectId: "proj_single",
    })}\n`,
    "utf8",
  );

  const result = await resolveOpenAIAuth({
    env: {},
    fallbackAuthPath: credentialsPath,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.authType, "api-key");
  assert.equal(result.source, "unclecode-api-key-file");
  assert.equal(result.bearerToken, "sk-rust-fallback");
  assert.equal(result.organizationId, "org_single");
  assert.equal(result.projectId, "proj_single");
});

test("package resolveOpenAIAuth keeps an explicit empty env isolated from host credentials", async (t) => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-host-must-not-leak";
  t.after(() => {
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }
  });

  const result = await resolveOpenAIAuth({
    env: {},
    fallbackAuthPath: "/definitely/missing",
  });

  assert.deepEqual(result, {
    status: "missing",
    authType: "none",
    source: "none",
    reason: "auth-file-missing",
  });
});

test("package resolveOpenAIAuth reports expired env oauth token honestly", async () => {
  const pastExp = Math.floor(Date.now() / 1000) - 3600;
  const result = await resolveOpenAIAuth({
    env: {
      OPENAI_AUTH_TOKEN: buildJwtWithExp(pastExp),
    },
  });

  assert.equal(result.status, "expired");
  assert.equal(result.authType, "oauth");
  assert.equal(result.source, "env-openai-auth-token");
});

test("package resolveOpenAIAuth reports refresh-needed oauth file honestly", async () => {
  const pastExp = Math.floor(Date.now() / 1000) - 3600;
  const result = await resolveOpenAIAuth({
    env: {},
    readFallbackFile: async () =>
      JSON.stringify({
        accessToken: buildJwtWithExp(pastExp),
        refreshToken: "rt_123",
      }),
  });

  assert.equal(result.status, "missing");
  assert.equal(result.authType, "oauth");
  assert.equal(result.source, "unclecode-auth-file");
  assert.equal(result.reason, "auth-refresh-required");
});

test("package resolveOpenAIAuth reuses ~/.codex/auth.json when UncleCode credentials are absent", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "unclecode-codex-auth-"));
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  mkdirSync(path.join(root, ".codex"), { recursive: true });
  writeFileSync(
    path.join(root, ".codex", "auth.json"),
    `${JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: buildJwtWithExp(futureExp),
        refresh_token: "rt_123",
      },
    })}\n`,
    "utf8",
  );

  const result = await resolveOpenAIAuth({
    env: {
      HOME: root,
    },
    fallbackAuthPaths: [
      path.join(root, ".unclecode", "credentials", "openai.json"),
      path.join(root, ".codex", "auth.json"),
    ],
  });

  assert.equal(result.status, "ok");
  assert.equal(result.authType, "oauth");
  assert.equal(result.source, "codex-auth-file");
});

test("package resolveOpenAIAuth prefers a valid later Codex auth over an expired earlier UncleCode file", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "unclecode-codex-auth-"));
  const pastExp = Math.floor(Date.now() / 1000) - 3600;
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  mkdirSync(path.join(root, ".unclecode", "credentials"), { recursive: true });
  mkdirSync(path.join(root, ".codex"), { recursive: true });
  writeFileSync(
    path.join(root, ".unclecode", "credentials", "openai.json"),
    `${JSON.stringify({
      accessToken: buildJwtWithExp(pastExp),
      refreshToken: "rt_old",
    })}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(root, ".codex", "auth.json"),
    `${JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: buildJwtWithExp(futureExp),
        refresh_token: "rt_new",
      },
    })}\n`,
    "utf8",
  );

  const result = await resolveOpenAIAuth({
    env: { HOME: root },
    fallbackAuthPaths: [
      path.join(root, ".unclecode", "credentials", "openai.json"),
      path.join(root, ".codex", "auth.json"),
    ],
  });

  assert.equal(result.status, "ok");
  assert.equal(result.authType, "oauth");
  assert.equal(result.source, "codex-auth-file");
});

test("package resolveOpenAIAuth accepts codex oauth tokens without model.request scope", async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: futureExp, scp: ["openid", "profile", "offline_access"] })).toString("base64url");
  const token = `${header}.${payload}.sig`;

  const result = await resolveOpenAIAuth({
    env: {},
    fallbackAuthPaths: ["/tmp/.codex/auth.json"],
    readFallbackFile: async () => JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: token,
        refresh_token: "rt_123",
      },
    }),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.authType, "oauth");
  assert.equal(result.source, "codex-auth-file");
  assert.equal(result.runtime, "codex");
});

test("package resolveOpenAIAuth accepts stored codex runtime oauth without model.request scope", async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: futureExp, scp: ["openid", "profile", "offline_access"] })).toString("base64url");
  const token = `${header}.${payload}.sig`;

  const result = await resolveOpenAIAuth({
    env: {},
    readFallbackFile: async () => JSON.stringify({
      authType: "oauth",
      accessToken: token,
      refreshToken: "rt_123",
      runtime: "codex",
    }),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.authType, "oauth");
  assert.equal(result.source, "unclecode-auth-file");
  assert.equal(result.runtime, "codex");
});
