import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "@unclecode/orchestrator";
import { UncleCodeCredentialStore } from "@unclecode/pi-bridge";
import { parseArgs } from "../../apps/unclecode-cli/src/work-runtime-args.ts";
import { resolveQualityReviewSelection } from "../../apps/unclecode-cli/src/work-runtime-bootstrap.ts";

function xaiEnv(extra = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "unclecode-xai-config-"));
  return {
    home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      LLM_PROVIDER: "xai",
      UNCLECODE_PROVIDER_CREDENTIALS_PATH: path.join(home, "providers.json"),
      ...extra,
    },
  };
}

test("loadConfig uses XAI_API_KEY from the environment when present", async () => {
  const { home, env } = xaiEnv({ XAI_API_KEY: "xai-env-key" });
  try {
    const config = await loadConfig({ cwd: home, env });
    assert.equal(config.provider, "xai");
    assert.equal(config.apiKey, "xai-env-key");
    assert.equal(config.model, "grok-4.3");
    assert.equal(config.authLabel, "env-key");
    assert.equal(config.reasoning.effort, "unsupported");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig defers to the stored xAI OAuth credential without copying the token", async () => {
  const { home, env } = xaiEnv({ XAI_MODEL: "grok-4.5" });
  try {
    await new UncleCodeCredentialStore(env.UNCLECODE_PROVIDER_CREDENTIALS_PATH).modify("xai", async () => ({
      type: "oauth",
      access: "xai-access",
      refresh: "xai-refresh",
      expires: Date.now() + 3_600_000,
    }));
    const config = await loadConfig({ cwd: home, env });
    assert.equal(config.apiKey, "");
    assert.equal(config.model, "grok-4.5");
    assert.equal(config.authLabel, "oauth-pi");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig tells a signed-out xAI user how to sign in", async () => {
  const { home, env } = xaiEnv();
  try {
    await assert.rejects(() => loadConfig({ cwd: home, env }), /unclecode auth login xai/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an xAI-only machine reviews on xAI instead of a missing provider", () => {
  assert.deepEqual(
    resolveQualityReviewSelection({ directProvider: "xai", directModel: "grok-4.3", env: {} }),
    { provider: "xai", model: "grok-4.3", distinct: false },
  );
});

test("work args keep --provider xai instead of silently falling back to openai", () => {
  const parsed = parseArgs(["--provider", "xai", "--model", "grok-4.3"]);
  assert.equal(parsed.provider, "xai");
  assert.equal(parsed.model, "grok-4.3");
});
