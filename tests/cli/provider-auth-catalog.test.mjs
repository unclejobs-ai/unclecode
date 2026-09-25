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

function fakeModels(loginImpl) {
  const provider = { id: "fake", name: "Fake", auth: { oauth: { name: "Fake (subscription)" } } };
  return {
    getProviders: () => [provider],
    getProvider: (id) => (id === "fake" ? provider : undefined),
    checkAuth: async () => undefined,
    login: (_id, _type, interaction) => loginImpl(interaction),
  };
}

test("signing in from /auth runs the login inside the TUI with safe default answers", async () => {
  const progress = [];
  const opened = [];
  const answers = {};
  const catalog = createProviderAuthCatalog({ HOME: tmpdir(), PATH: process.env.PATH }, {
    models: fakeModels(async (interaction) => {
      answers.text = await interaction.prompt({ type: "text", message: "Enterprise domain (blank for github.com)" });
      answers.select = await interaction.prompt({ type: "select", message: "Method", options: [{ id: "browser", label: "Browser" }, { id: "device", label: "Device" }] });
      interaction.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.test/device" });
      return { type: "oauth", access: "a", refresh: "r", expires: 1 };
    }),
    openUrl: (url) => opened.push(url),
  });
  const result = await catalog.signIn("fake", (text) => progress.push(text));
  assert.deepEqual(result, { ok: true, signedIn: true, name: "Fake (subscription)" });
  assert.deepEqual(answers, { text: "", select: "browser" });
  assert.deepEqual(opened, ["https://example.test/device"]);
  assert.match(progress.at(-1), /ABCD-1234/);
  assert.match(progress.at(-1), /https:\/\/example\.test\/device/);
});

test("a manual-code prompt waits for the browser callback instead of reading the TUI's stdin", async () => {
  const catalog = createProviderAuthCatalog({ HOME: tmpdir(), PATH: process.env.PATH }, {
    models: fakeModels(async (interaction) => {
      const superseded = new AbortController();
      const pending = interaction.prompt({ type: "manual_code", message: "Paste code", signal: superseded.signal });
      superseded.abort();
      await assert.rejects(pending);
      return { type: "oauth", access: "a", refresh: "r", expires: 1 };
    }),
    openUrl: () => {},
  });
  assert.equal((await catalog.signIn("fake", () => {})).ok, true);
});

test("a failed in-TUI sign-in says why and offers the terminal route", async () => {
  const catalog = createProviderAuthCatalog({ HOME: tmpdir(), PATH: process.env.PATH }, {
    models: fakeModels(async () => { throw new Error("xAI device code expired"); }),
    openUrl: () => {},
  });
  assert.deepEqual(await catalog.signIn("fake", () => {}), {
    ok: false,
    error: { code: "SIGN_IN_UNAVAILABLE", message: "xAI device code expired · or run: unclecode auth login fake" },
  });
});
