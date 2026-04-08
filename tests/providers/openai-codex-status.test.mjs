import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatOpenAICodexAuthStatus,
  resolveOpenAICodexAuthStatus,
} from "@unclecode/providers";

function buildJwtWithScopes(scopes, expSeconds = Math.floor(Date.now() / 1000) + 3600) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, scp: scopes })).toString("base64url");
  return `${header}.${payload}.sig`;
}

test("resolveOpenAICodexAuthStatus accepts reusable Codex OAuth without model.request scope", async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "unclecode-codex-status-"));
  const credentialsPath = path.join(rootDir, "openai-codex.json");

  try {
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        authType: "oauth",
        accessToken: buildJwtWithScopes(["openid", "profile", "offline_access"]),
        refreshToken: "rt_123",
        expiresAt: null,
        organizationId: null,
        projectId: null,
        accountId: "acct_123",
      }),
      "utf8",
    );

    const status = await resolveOpenAICodexAuthStatus({
      env: {
        UNCLECODE_OPENAI_CODEX_CREDENTIALS_PATH: credentialsPath,
      },
    });

    assert.equal(status.providerId, "openai-codex");
    assert.equal(status.activeSource, "oauth-file");
    assert.equal(status.authType, "oauth");
    assert.equal(status.expiresAt, null);
    assert.equal(status.isExpired, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("formatOpenAICodexAuthStatus redacts secrets from rendered output", () => {
  const rendered = formatOpenAICodexAuthStatus({
    providerId: "openai-codex",
    activeSource: "oauth-file",
    authType: "oauth",
    organizationId: null,
    projectId: null,
    expiresAt: null,
    isExpired: false,
  });

  assert.match(rendered, /openai-codex/);
  assert.match(rendered, /oauth-file/);
  assert.doesNotMatch(rendered, /at_codex_123/);
});
