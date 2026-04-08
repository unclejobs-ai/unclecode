import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearOpenAICredentials,
  clearOpenAICodexCredentials,
  readOpenAICredentials,
  readOpenAICodexCredentials,
  writeOpenAICredentials,
  writeOpenAICodexCredentials,
} from "@unclecode/providers";

test("credential store writes strict fallback file permissions and round-trips oauth credentials", async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "unclecode-creds-"));
  const credentialsPath = path.join(rootDir, "openai.json");

  await writeOpenAICredentials({
    credentialsPath,
    credentials: {
      authType: "oauth",
      accessToken: "at_123",
      refreshToken: "rt_123",
      expiresAt: null,
      organizationId: "org_123",
      projectId: "proj_456",
      accountId: "acct_789",
    },
  });

  const saved = JSON.parse(readFileSync(credentialsPath, "utf8"));
  const loaded = await readOpenAICredentials({ credentialsPath });

  assert.equal(saved.authType, "oauth");
  assert.equal(loaded?.refreshToken, "rt_123");
  assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);
});

test("credential store returns null for malformed fallback files", async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "unclecode-creds-bad-"));
  const credentialsPath = path.join(rootDir, "openai.json");

  await writeOpenAICredentials({
    credentialsPath,
    rawContents: "{broken",
  });

  const loaded = await readOpenAICredentials({ credentialsPath });

  assert.equal(loaded, null);
});

test("credential store uses keytar when available", async () => {
  const writes = [];
  const loadedValue = {
    authType: "oauth",
    accessToken: "at_123",
    refreshToken: "rt_123",
    expiresAt: null,
    organizationId: null,
    projectId: null,
    accountId: null,
  };

  await writeOpenAICredentials({
    credentialsPath: "/tmp/unused-openai.json",
    credentials: loadedValue,
    keytar: {
      setPassword: async (_service, _account, value) => {
        writes.push(value);
      },
      getPassword: async () => JSON.stringify(loadedValue),
    },
  });

  const loaded = await readOpenAICredentials({
    credentialsPath: "/tmp/unused-openai.json",
    keytar: {
      getPassword: async () => JSON.stringify(loadedValue),
    },
  });

  assert.equal(writes.length, 1);
  assert.equal(loaded?.refreshToken, "rt_123");
});

test("credential store falls back to file storage when keytar write fails", async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "unclecode-creds-fallback-"));
  const credentialsPath = path.join(rootDir, "openai.json");

  await writeOpenAICredentials({
    credentialsPath,
    credentials: {
      authType: "oauth",
      accessToken: "at_123",
      refreshToken: "rt_123",
      expiresAt: null,
      organizationId: null,
      projectId: null,
      accountId: null,
    },
    keytar: {
      setPassword: async () => {
        throw new Error("keytar unavailable");
      },
      getPassword: async () => null,
    },
  });

  const loaded = await readOpenAICredentials({ credentialsPath });

  assert.equal(loaded?.accessToken, "at_123");
});

test("credential store round-trips api-key credentials", async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "unclecode-creds-api-key-"));
  const credentialsPath = path.join(rootDir, "openai.json");

  await writeOpenAICredentials({
    credentialsPath,
    credentials: {
      authType: "api-key",
      apiKey: "sk-file-123",
      organizationId: "org_file",
      projectId: "proj_file",
    },
  });

  const loaded = await readOpenAICredentials({ credentialsPath });

  assert.equal(loaded?.authType, "api-key");
  assert.equal(loaded?.apiKey, "sk-file-123");
  assert.equal(loaded?.organizationId, "org_file");
  assert.equal(loaded?.projectId, "proj_file");
});

test("credential store can clear persisted credentials", async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "unclecode-creds-clear-"));
  const credentialsPath = path.join(rootDir, "openai.json");

  await writeOpenAICredentials({
    credentialsPath,
    credentials: {
      authType: "api-key",
      apiKey: "sk-file-123",
      organizationId: null,
      projectId: null,
    },
  });

  await clearOpenAICredentials({ credentialsPath });
  const loaded = await readOpenAICredentials({ credentialsPath });

  assert.equal(loaded, null);
});

test("codex credential store round-trips oauth credentials independently from the API key store", async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "unclecode-codex-creds-"));
  const credentialsPath = path.join(rootDir, "openai-codex.json");

  await writeOpenAICodexCredentials({
    credentialsPath,
    credentials: {
      authType: "oauth",
      accessToken: "at_codex_123",
      refreshToken: "rt_codex_123",
      expiresAt: null,
      organizationId: null,
      projectId: null,
      accountId: "acct_codex",
    },
  });

  const loaded = await readOpenAICodexCredentials({ credentialsPath });
  assert.equal(loaded?.authType, "oauth");
  assert.equal(loaded?.refreshToken, "rt_codex_123");

  await clearOpenAICodexCredentials({ credentialsPath });
  const cleared = await readOpenAICodexCredentials({ credentialsPath });
  assert.equal(cleared, null);
});
