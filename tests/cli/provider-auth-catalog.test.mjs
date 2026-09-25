import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { UncleCodeCredentialStore } from "@unclecode/pi-bridge";
import { createProviderAuthCatalog } from "../../apps/unclecode-cli/src/provider-auth.ts";

test("the /auth catalog lists OAuth providers with UncleCode's own sign-in state", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "unclecode-auth-catalog-"));
  const filePath = path.join(dir, "providers.json");
  const env = { HOME: dir, PATH: process.env.PATH, UNCLECODE_PROVIDER_CREDENTIALS_PATH: filePath };
  try {
    await new UncleCodeCredentialStore(filePath).modify("xai", async () => ({
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: Date.now() + 3_600_000,
    }));
    const result = await createProviderAuthCatalog(env).list();
    assert.equal(result.ok, true);
    assert.equal(result.dbPath, filePath);
    const byId = new Map(result.providers.map((row) => [row.id, row]));
    for (const id of ["xai", "anthropic", "openai-codex", "github-copilot"]) {
      assert.ok(byId.has(id), `${id} is offered`);
    }
    assert.ok(result.providers.every((row) => row.available));
    assert.deepEqual(
      { signedIn: byId.get("xai").signedIn, originKind: byId.get("xai").originKind },
      { signedIn: true, originKind: "oauth" },
    );
    assert.equal(byId.get("anthropic").signedIn, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signing in from /auth hands off to `unclecode auth login <provider>`", async () => {
  const handoff = await createProviderAuthCatalog({ HOME: tmpdir(), PATH: process.env.PATH }).signIn("xai");
  assert.deepEqual(handoff, {
    ok: true,
    binPath: "unclecode",
    argv: ["auth", "login", "xai"],
    command: "unclecode auth login xai",
  });
});
