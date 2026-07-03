import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { formatOpenAIAuthStatus, resolveOpenAIAuthStatus } from "@unclecode/providers";

test("resolveOpenAIAuthStatus exposes source, context, and expiry without secrets", async () => {
  const status = await resolveOpenAIAuthStatus({
    env: { OPENAI_API_KEY: "sk-test-123", OPENAI_ORG_ID: "org_123", OPENAI_PROJECT_ID: "proj_456" },
  });

  assert.equal(status.activeSource, "api-key-env");
  assert.equal(status.apiReady, true);
  assert.equal(status.organizationId, "org_123");
  assert.equal(status.projectId, "proj_456");
});

test("resolveOpenAIAuthStatus reports api-key-file and stored org/project context", async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "unclecode-status-apikey-file-"));
  const credentialsPath = path.join(rootDir, "openai.json");

  try {
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        authType: "api-key",
        apiKey: "sk-file-123",
        organizationId: "org_file",
        projectId: "proj_file",
      }),
      "utf8",
    );

    const status = await resolveOpenAIAuthStatus({
      env: {
        UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
      },
    });

    assert.equal(status.activeSource, "api-key-file");
    assert.equal(status.authType, "api-key");
    assert.equal(status.organizationId, "org_file");
    assert.equal(status.projectId, "proj_file");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("formatOpenAIAuthStatus redacts secrets from rendered output", () => {
  const rendered = formatOpenAIAuthStatus({
    providerId: "openai",
    activeSource: "api-key-env",
    authType: "api-key",
    runtime: null,
    organizationId: "org_123",
    projectId: "proj_456",
    expiresAt: null,
    isExpired: false,
    apiReady: true,
  });

  assert.match(rendered, /api-key-env/);
  assert.match(rendered, /org_123/);
  assert.doesNotMatch(rendered, /sk-test-123/);
});

test("formatOpenAIAuthStatus exposes runtime and API readiness", () => {
  const rendered = formatOpenAIAuthStatus({
    providerId: "openai",
    activeSource: "oauth-file",
    authType: "oauth",
    runtime: "codex",
    organizationId: null,
    projectId: null,
    expiresAt: null,
    isExpired: false,
    apiReady: false,
  });

  assert.match(rendered, /runtime: codex/);
  assert.match(rendered, /api ready: no/);
});

test("resolveOpenAIAuthStatus reports insufficient-scope oauth honestly", async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: futureExp, scp: ["openid", "profile", "offline_access"] })).toString("base64url");
  const token = `${header}.${payload}.sig`;
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "unclecode-status-scope-"));
  const credentialsPath = path.join(rootDir, "openai.json");

  try {
    writeFileSync(
      credentialsPath,
      JSON.stringify({ authType: "oauth", accessToken: token, refreshToken: "rt_123" }),
      "utf8",
    );

    const status = await resolveOpenAIAuthStatus({
      env: { UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath },
    });

    assert.equal(status.activeSource, "oauth-file");
    assert.equal(status.authType, "oauth");
    assert.equal(status.expiresAt, "insufficient-scope");
    assert.equal(status.isExpired, true);
    assert.equal(status.apiReady, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("resolveOpenAIAuthStatus accepts codex oauth files without model.request scope", async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: futureExp, scp: ["openid", "profile", "offline_access", "api.connectors.read"] })).toString("base64url");
  const token = `${header}.${payload}.sig`;
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "unclecode-status-codex-"));
  const codexDir = path.join(rootDir, ".codex");

  try {
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      path.join(codexDir, "auth.json"),
      JSON.stringify({ tokens: { access_token: token } }),
      "utf8",
    );

    const status = await resolveOpenAIAuthStatus({
      env: { HOME: rootDir },
    });

    assert.equal(status.activeSource, "oauth-file");
    assert.equal(status.authType, "oauth");
    assert.equal(status.runtime, "codex");
    assert.equal(status.expiresAt, null);
    assert.equal(status.isExpired, false);
    assert.equal(status.apiReady, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("resolveOpenAIAuthStatus accepts stored codex runtime oauth without model.request scope", async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: futureExp, scp: ["openid", "profile", "offline_access"] })).toString("base64url");
  const token = `${header}.${payload}.sig`;
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "unclecode-status-stored-codex-"));
  const credentialsPath = path.join(rootDir, "openai.json");

  try {
    writeFileSync(
      credentialsPath,
      JSON.stringify({ authType: "oauth", accessToken: token, refreshToken: "rt_123", runtime: "codex" }),
      "utf8",
    );

    const status = await resolveOpenAIAuthStatus({
      env: { UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath },
    });

    assert.equal(status.activeSource, "oauth-file");
    assert.equal(status.authType, "oauth");
    assert.equal(status.runtime, "codex");
    assert.equal(status.expiresAt, null);
    assert.equal(status.isExpired, false);
    assert.equal(status.apiReady, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
