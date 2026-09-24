import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "@unclecode/orchestrator";
import { UncleCodeCredentialStore } from "@unclecode/pi-bridge";

function anthropicEnv(extra = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "unclecode-anthropic-config-"));
  return {
    home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      LLM_PROVIDER: "anthropic",
      UNCLECODE_PROVIDER_CREDENTIALS_PATH: path.join(home, "providers.json"),
      ...extra,
    },
  };
}

async function storeOAuth(env, providerId) {
  await new UncleCodeCredentialStore(env.UNCLECODE_PROVIDER_CREDENTIALS_PATH).modify(providerId, async () => ({
    type: "oauth",
    access: `${providerId}-access`,
    refresh: `${providerId}-refresh`,
    expires: Date.now() + 3_600_000,
  }));
}

test("an Anthropic API key in the environment keeps the native env-key route", async () => {
  const { home, env } = anthropicEnv({ ANTHROPIC_API_KEY: "sk-ant-env" });
  try {
    const config = await loadConfig({ cwd: home, env });
    assert.equal(config.apiKey, "sk-ant-env");
    assert.equal(config.authLabel, "env-key");
    assert.equal(config.credentialStore, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a signed-in Anthropic subscription wins over an environment key, as in pi", async () => {
  // An explicit `unclecode auth login` is newer intent than a key left in .env.
  const { home, env } = anthropicEnv({ ANTHROPIC_API_KEY: "sk-ant-stale" });
  try {
    await storeOAuth(env, "anthropic");
    const config = await loadConfig({ cwd: home, env });
    assert.equal(config.apiKey, "");
    assert.equal(config.credentialStore, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a stored Anthropic subscription login resolves inside pi-ai, not as a copied key", async () => {
  const { home, env } = anthropicEnv({ ANTHROPIC_MODEL: "claude-sonnet-5" });
  try {
    await storeOAuth(env, "anthropic");
    const config = await loadConfig({ cwd: home, env });
    assert.equal(config.provider, "anthropic");
    assert.equal(config.apiKey, "");
    assert.equal(config.model, "claude-sonnet-5");
    assert.equal(config.authLabel, "oauth-pi");
    assert.equal(config.credentialStore, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a signed-out Anthropic user is offered both sign-in routes", async () => {
  const { home, env } = anthropicEnv();
  try {
    await assert.rejects(
      () => loadConfig({ cwd: home, env }),
      /ANTHROPIC_API_KEY[\s\S]*unclecode auth login anthropic/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
