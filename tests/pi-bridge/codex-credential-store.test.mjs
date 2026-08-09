import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import {
  CODEX_PI_PROVIDER_ID,
  CodexCredentialStore,
  createCodexOAuthModels,
  resolveCodexAuthPath,
  resolveCodexOAuthBridgeArgs,
  resolvePiModel,
} from "@unclecode/pi-bridge";

function jwtWithExpiry(expSeconds) {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds }), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}

function makeAuthFile(overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "unclecode-codex-auth-"));
  const authPath = path.join(dir, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: "2026-01-01T00:00:00.000Z",
      OPENAI_API_KEY: null,
      tokens: {
        access_token: jwtWithExpiry(1893456000),
        refresh_token: "refresh-token-1",
        id_token: "id-token-1",
        account_id: "account-1",
      },
      ...overrides,
    }),
  );
  return { dir, authPath };
}

test("resolveCodexAuthPath prefers the explicit credentials path override", () => {
  assert.equal(
    resolveCodexAuthPath({ UNCLECODE_OPENAI_CREDENTIALS_PATH: "/tmp/custom-auth.json" }),
    "/tmp/custom-auth.json",
  );
  assert.equal(resolveCodexAuthPath({ HOME: "/home/tester" }), "/home/tester/.codex/auth.json");
});

test("read maps Codex tokens onto a pi oauth credential with the JWT expiry", async () => {
  const { dir, authPath } = makeAuthFile();
  try {
    const store = new CodexCredentialStore(authPath);
    const credential = await store.read(CODEX_PI_PROVIDER_ID);

    assert.equal(credential.type, "oauth");
    assert.equal(credential.refresh, "refresh-token-1");
    assert.equal(credential.accountId, "account-1");
    assert.equal(credential.expires, 1893456000 * 1000);

    assert.equal(await store.read("openai"), undefined);
    assert.deepEqual(await store.list(), [{ providerId: CODEX_PI_PROVIDER_ID, type: "oauth" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("modify persists refreshed tokens while preserving unknown fields", async () => {
  const { dir, authPath } = makeAuthFile();
  try {
    const store = new CodexCredentialStore(authPath);
    const rotated = await store.modify(CODEX_PI_PROVIDER_ID, async (current) => {
      assert.equal(current.refresh, "refresh-token-1");
      return { ...current, access: jwtWithExpiry(1900000000), refresh: "refresh-token-2" };
    });

    assert.equal(rotated.refresh, "refresh-token-2");
    const persisted = JSON.parse(readFileSync(authPath, "utf8"));
    assert.equal(persisted.tokens.refresh_token, "refresh-token-2");
    assert.equal(persisted.tokens.id_token, "id-token-1");
    assert.equal(persisted.tokens.account_id, "account-1");
    assert.equal(persisted.auth_mode, "chatgpt");
    assert.notEqual(persisted.last_refresh, "2026-01-01T00:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("modify serializes concurrent Codex token rotations", async () => {
  const { dir, authPath } = makeAuthFile();
  try {
    const store = new CodexCredentialStore(authPath);
    const observedRefreshTokens = [];
    let active = 0;
    let maxActive = 0;
    await Promise.all([2, 3].map((suffix) => store.modify(CODEX_PI_PROVIDER_ID, async (current) => {
      assert.ok(current);
      observedRefreshTokens.push(current.refresh);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await sleep(25);
        return {
          ...current,
          access: jwtWithExpiry(1900000000 + suffix),
          refresh: `refresh-token-${suffix}`,
        };
      } finally {
        active -= 1;
      }
    })));

    assert.equal(maxActive, 1);
    assert.equal(new Set(observedRefreshTokens).size, 2);
    assert.ok(observedRefreshTokens.includes("refresh-token-1"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("modify refuses to steal a stale Codex credential lock", async () => {
  const { dir, authPath } = makeAuthFile();
  try {
    writeFileSync(`${authPath}.lock`, JSON.stringify({ pid: 2_147_483_647 }));
    const store = new CodexCredentialStore(authPath);
    await assert.rejects(
      () => store.modify(CODEX_PI_PROVIDER_ID, async (current) => current),
      /credential lock is stale/,
    );
    const persisted = JSON.parse(readFileSync(authPath, "utf8"));
    assert.equal(persisted.tokens.refresh_token, "refresh-token-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("modify leaves the file untouched for other providers", async () => {
  const { dir, authPath } = makeAuthFile();
  try {
    const before = readFileSync(authPath, "utf8");
    const store = new CodexCredentialStore(authPath);
    await store.modify("openai", async () => ({ type: "api_key", key: "sk-test" }));
    assert.equal(readFileSync(authPath, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delete refuses to clear Codex credentials", async () => {
  const { dir, authPath } = makeAuthFile();
  try {
    const store = new CodexCredentialStore(authPath);
    await assert.rejects(() => store.delete(CODEX_PI_PROVIDER_ID), /refresh-only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createCodexOAuthModels returns a registry only when tokens exist", () => {
  const { dir, authPath } = makeAuthFile();
  try {
    const models = createCodexOAuthModels(authPath);
    assert.ok(models);
    assert.ok(models.getModel(CODEX_PI_PROVIDER_ID, "gpt-5.6-sol"));

    const empty = makeAuthFile({ tokens: { access_token: "", refresh_token: "" } });
    try {
      assert.equal(createCodexOAuthModels(empty.authPath), undefined);
    } finally {
      rmSync(empty.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex OAuth selects the ChatGPT transport even after auth resolves a bearer token", () => {
  const { dir, authPath } = makeAuthFile();
  try {
    const args = resolveCodexOAuthBridgeArgs({
      provider: "openai",
      apiKey: "resolved-oauth-access-token",
      openAIRuntime: "codex",
      authPath,
    });

    assert.ok(args);
    const model = args.models.getModel(args.piProvider, "gpt-5.6-sol");
    assert.equal(model.api, "openai-codex-responses");
    assert.equal(model.baseUrl, "https://chatgpt.com/backend-api");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex OAuth ignores the standard OpenAI API base URL", () => {
  const { dir, authPath } = makeAuthFile();
  try {
    const args = resolveCodexOAuthBridgeArgs({
      provider: "openai",
      openAIRuntime: "codex",
      authPath,
    });
    assert.ok(args);

    const model = resolvePiModel(
      "openai",
      "gpt-5.6-sol",
      args.models,
      args.piProvider,
      "https://api.openai.com/v1",
    );
    assert.equal(model.baseUrl, "https://chatgpt.com/backend-api");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
