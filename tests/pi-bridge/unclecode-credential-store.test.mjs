import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getUncleCodeCredentialModels,
  resolvePiModel,
  resolveProviderCredentialsPath,
  UncleCodeCredentialStore,
} from "@unclecode/pi-bridge";

const xaiCredential = {
  type: "oauth",
  access: "xai-access-1",
  refresh: "xai-refresh-1",
  expires: Date.now() + 3_600_000,
};

function tempCredentialsPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "unclecode-provider-credentials-"));
  return { dir, filePath: path.join(dir, "credentials", "providers.json") };
}

test("resolveProviderCredentialsPath defaults beside the OpenAI credentials and honors the override", () => {
  assert.equal(
    resolveProviderCredentialsPath({ HOME: "/home/tester" }),
    "/home/tester/.unclecode/credentials/providers.json",
  );
  assert.equal(
    resolveProviderCredentialsPath({ UNCLECODE_PROVIDER_CREDENTIALS_PATH: "/tmp/p.json" }),
    "/tmp/p.json",
  );
});

test("modify persists a mode-600 provider map; read, list, and delete round-trip", async () => {
  const { dir, filePath } = tempCredentialsPath();
  try {
    const store = new UncleCodeCredentialStore(filePath);
    assert.equal(await store.read("xai"), undefined);

    await store.modify("xai", async (current) => {
      assert.equal(current, undefined);
      return xaiCredential;
    });
    await store.modify("zai", async () => ({ type: "api_key", key: "zai-key" }));

    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")).xai, xaiCredential);
    assert.deepEqual(await store.read("xai"), xaiCredential);
    assert.deepEqual(
      (await store.list()).map((info) => `${info.providerId}:${info.type}`).sort(),
      ["xai:oauth", "zai:api_key"],
    );

    await store.delete("xai");
    assert.equal(await store.read("xai"), undefined);
    assert.equal((await store.read("zai"))?.type, "api_key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("modify leaves the entry unchanged when the updater returns undefined", async () => {
  const { dir, filePath } = tempCredentialsPath();
  try {
    const store = new UncleCodeCredentialStore(filePath);
    await store.modify("xai", async () => xaiCredential);
    const result = await store.modify("xai", async () => undefined);
    assert.deepEqual(result, xaiCredential);
    assert.deepEqual(await store.read("xai"), xaiCredential);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt credentials file fails loudly instead of reading as signed out", async () => {
  const { dir, filePath } = tempCredentialsPath();
  try {
    const store = new UncleCodeCredentialStore(filePath);
    await store.modify("xai", async () => xaiCredential);
    writeFileSync(filePath, "{not json");
    await assert.rejects(() => store.read("xai"), SyntaxError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store-backed models report xAI OAuth as configured and resolve the catalog model", async () => {
  const { dir, filePath } = tempCredentialsPath();
  const env = { HOME: dir, UNCLECODE_PROVIDER_CREDENTIALS_PATH: filePath };
  try {
    await new UncleCodeCredentialStore(filePath).modify("xai", async () => xaiCredential);
    const models = getUncleCodeCredentialModels(env);

    assert.equal(getUncleCodeCredentialModels(env), models);
    assert.equal((await models.checkAuth("xai"))?.type, "oauth");
    const auth = await models.getAuth("xai");
    assert.equal(auth?.auth.apiKey, "xai-access-1");

    const model = resolvePiModel("xai", "grok-4.3", models);
    assert.equal(model.provider, "xai");
    assert.equal(model.baseUrl, "https://api.x.ai/v1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
