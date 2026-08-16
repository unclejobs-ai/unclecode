import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findOmpInstall,
  loadOmpAuthCatalog,
  parseOmpAuthCatalogPayload,
  resolveBunExecutable,
  resolveOmpAuthCatalogWorkerPath,
  resolveOmpSignInHandoff,
} from "@unclecode/providers";
import {
  buildOmpAuthCatalog,
  OmpAuthCatalogWorkerError,
  runOmpAuthCatalogWorkerMain,
} from "../../packages/providers/src/omp-auth-catalog-worker.ts";

/** Built from char codes so this source file stays free of raw control characters. */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/**
 * Builds a throwaway tree shaped like a real bun global install:
 *   <root>/bin/omp -> <root>/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js
 */
function createFakeOmpInstall() {
  // realpath: macOS hands out /var/folders/… symlinks, and the locator reports
  // the resolved package root, so the fixture has to compare against the same.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "unclecode-omp-install-")));
  const packageRoot = path.join(root, "node_modules", "@oh-my-pi", "pi-coding-agent");
  mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  mkdirSync(path.join(root, "bin"), { recursive: true });
  writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "0.0.0" }),
    "utf8",
  );
  const cliPath = path.join(packageRoot, "dist", "cli.js");
  writeFileSync(cliPath, "#!/usr/bin/env bun\n", "utf8");
  chmodSync(cliPath, 0o755);
  const binPath = path.join(root, "bin", "omp");
  symlinkSync(cliPath, binPath);
  return { root, binPath, cliPath, packageRoot, scopeRoot: path.dirname(packageRoot) };
}

function okPayload(providers) {
  return JSON.stringify({ ok: true, result: { dbPath: "/tmp/agent.db", providers } });
}

test("parseOmpAuthCatalogPayload maps OMP provider rows to display-safe catalog rows", () => {
  const result = parseOmpAuthCatalogPayload(okPayload([
    {
      id: "kimi-code",
      name: "Kimi Code",
      available: true,
      configured: true,
      origin: { kind: "oauth" },
    },
    {
      id: "zai-coding-plan",
      name: "Z.AI (GLM Coding Plan · Sign in)",
      available: true,
      storeCredentialsAs: "zai",
      configured: true,
      origin: { kind: "api_key" },
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      available: true,
      configured: true,
      origin: { kind: "env", envVar: "OPENROUTER_API_KEY" },
    },
    {
      id: "perplexity",
      name: "Perplexity",
      available: false,
      configured: false,
      origin: null,
    },
  ]));

  assert.equal(result.ok, true);
  assert.equal(result.dbPath, "/tmp/agent.db");
  assert.deepEqual(result.providers, [
    {
      id: "kimi-code",
      name: "Kimi Code",
      available: true,
      credentialKey: "kimi-code",
      signedIn: true,
      originKind: "oauth",
    },
    {
      id: "zai-coding-plan",
      name: "Z.AI (GLM Coding Plan · Sign in)",
      available: true,
      storeCredentialsAs: "zai",
      credentialKey: "zai",
      signedIn: true,
      originKind: "api_key",
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      available: true,
      credentialKey: "openrouter",
      signedIn: true,
      originKind: "env",
      originEnvVar: "OPENROUTER_API_KEY",
    },
    {
      id: "perplexity",
      name: "Perplexity",
      available: false,
      credentialKey: "perplexity",
      signedIn: false,
    },
  ]);
});

test("parseOmpAuthCatalogPayload keeps only whitelisted fields so credentials never reach the UI", () => {
  const result = parseOmpAuthCatalogPayload(okPayload([
    {
      id: "anthropic",
      name: "Anthropic (Claude Pro/Max)",
      available: true,
      configured: true,
      origin: { kind: "oauth", envVar: "ANTHROPIC_API_KEY" },
      access: "sk-ant-oat01-do-not-render",
      refresh: "sk-ant-ort01-do-not-render",
      apiKey: "sk-ant-api03-do-not-render",
      credential: { access: "leaky" },
    },
  ]));

  assert.equal(result.ok, true);
  const [row] = result.providers;
  assert.deepEqual(Object.keys(row).sort(), [
    "available",
    "credentialKey",
    "id",
    "name",
    "originKind",
    "signedIn",
  ]);
  assert.ok(!JSON.stringify(result).includes("do-not-render"));
  assert.ok(!JSON.stringify(result).includes("leaky"));
});

test("parseOmpAuthCatalogPayload drops rows without a usable id and unknown origin kinds", () => {
  const result = parseOmpAuthCatalogPayload(okPayload([
    { id: "", name: "Nameless", available: true, configured: false },
    { name: "No id at all", available: true, configured: false },
    { id: "wafer", name: "Wafer", available: true, configured: true, origin: { kind: "sorcery" } },
  ]));

  assert.equal(result.ok, true);
  assert.deepEqual(result.providers, [
    {
      id: "wafer",
      name: "Wafer",
      available: true,
      credentialKey: "wafer",
      signedIn: true,
    },
  ]);
});

test("parseOmpAuthCatalogPayload passes worker failure envelopes through with their code", () => {
  const result = parseOmpAuthCatalogPayload(JSON.stringify({
    ok: false,
    error: { code: "OMP_CATALOG_UNAVAILABLE", message: "agent.db is locked" },
  }));

  assert.deepEqual(result, {
    ok: false,
    error: { code: "OMP_CATALOG_UNAVAILABLE", message: "agent.db is locked" },
  });
});

test("parseOmpAuthCatalogPayload redacts token-shaped runs out of worker error messages", () => {
  const result = parseOmpAuthCatalogPayload(JSON.stringify({
    ok: false,
    error: {
      code: "OMP_CATALOG_UNAVAILABLE",
      message: "refresh rejected for sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA at /Users/me/.omp/agent",
    },
  }));

  assert.equal(result.ok, false);
  assert.ok(!result.error.message.includes("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
  assert.match(result.error.message, /…redacted…/);
  assert.match(result.error.message, /\/Users\/me\/\.omp\/agent/);
});

test("parseOmpAuthCatalogPayload reports OMP_PROTOCOL_ERROR for non-envelope output", () => {
  for (const raw of ["", "   ", "not json", JSON.stringify({ providers: [] })]) {
    const result = parseOmpAuthCatalogPayload(raw);
    assert.equal(result.ok, false, `expected a protocol error for ${JSON.stringify(raw)}`);
    assert.equal(result.error.code, "OMP_PROTOCOL_ERROR");
  }
});

test("parseOmpAuthCatalogPayload reads the envelope from the last stdout line", () => {
  const result = parseOmpAuthCatalogPayload(
    `bun: some unrelated warning\n${okPayload([
      { id: "kimi-code", name: "Kimi Code", available: true, configured: false },
    ])}\n`,
  );

  assert.equal(result.ok, true);
  assert.equal(result.providers.length, 1);
});

test("findOmpInstall resolves the package root through the executable symlink", () => {
  const fake = createFakeOmpInstall();
  try {
    const install = findOmpInstall({ UNCLECODE_OMP_BIN: fake.binPath });
    assert.deepEqual(install, {
      binPath: fake.binPath,
      packageRoot: fake.packageRoot,
      scopeRoot: fake.scopeRoot,
    });

    const viaPath = findOmpInstall({ PATH: path.join(fake.root, "bin") });
    assert.equal(viaPath?.packageRoot, fake.packageRoot);
  } finally {
    rmSync(fake.root, { recursive: true, force: true });
  }
});

test("findOmpInstall returns undefined instead of throwing when omp is absent", () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), "unclecode-omp-empty-"));
  try {
    assert.equal(findOmpInstall({ PATH: empty }), undefined);
    assert.equal(findOmpInstall({ UNCLECODE_OMP_BIN: path.join(empty, "nope") }), undefined);
    assert.equal(findOmpInstall({}), undefined);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("resolveBunExecutable honors the explicit override before PATH", () => {
  assert.equal(resolveBunExecutable({ UNCLECODE_OMP_BUN_BIN: "/opt/bun/bin/bun" }), "/opt/bun/bin/bun");
  assert.equal(resolveBunExecutable({ PATH: "" }), "bun");
});

test("resolveOmpAuthCatalogWorkerPath keeps the caller module's extension", () => {
  assert.equal(
    resolveOmpAuthCatalogWorkerPath("file:///w/packages/providers/src/omp-auth-catalog.ts"),
    path.join("/w/packages/providers/src", "omp-auth-catalog-worker.ts"),
  );
  assert.equal(
    resolveOmpAuthCatalogWorkerPath("file:///w/packages/providers/dist/omp-auth-catalog.js"),
    path.join("/w/packages/providers/dist", "omp-auth-catalog-worker.js"),
  );
});

test("loadOmpAuthCatalog reports OMP_UNAVAILABLE without spawning anything", async () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), "unclecode-omp-missing-"));
  let spawned = false;
  try {
    const result = await loadOmpAuthCatalog({
      env: { PATH: empty },
      run: async () => {
        spawned = true;
        return "";
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "OMP_UNAVAILABLE");
    assert.match(result.error.message, /omp/i);
    assert.equal(spawned, false);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("loadOmpAuthCatalog hands the Bun runner the resolved install roots, worker path, and OMP environment", async () => {
  const fake = createFakeOmpInstall();
  const seen = [];
  // OMP resolves its agent dir and its auth broker from these at module load in
  // the Bun child, so the picker only reads the executor's auth context when
  // the injected environment reaches the child instead of the ambient one.
  const env = {
    UNCLECODE_OMP_BIN: fake.binPath,
    UNCLECODE_OMP_BUN_BIN: "/opt/bun/bin/bun",
    OMP_PROFILE: "work",
    PI_CODING_AGENT_DIR: "/tmp/omp-work/agent",
    OMP_AUTH_BROKER_URL: "https://broker.example/omp",
    OMP_AUTH_BROKER_TOKEN: "broker-token",
  };
  try {
    const result = await loadOmpAuthCatalog({
      env,
      run: async (input) => {
        seen.push(input);
        return okPayload([{ id: "kimi-code", name: "Kimi Code", available: true, configured: true, origin: { kind: "oauth" } }]);
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.providers[0].id, "kimi-code");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].bunPath, "/opt/bun/bin/bun");
    assert.equal(seen[0].scopeRoot, fake.scopeRoot);
    assert.equal(seen[0].packageRoot, fake.packageRoot);
    assert.match(seen[0].workerPath, /omp-auth-catalog-worker\.(ts|js)$/);
    assert.equal(seen[0].env, env);
    assert.equal(seen[0].env.OMP_PROFILE, "work");
    assert.equal(seen[0].env.PI_CODING_AGENT_DIR, "/tmp/omp-work/agent");
    assert.equal(seen[0].env.OMP_AUTH_BROKER_URL, "https://broker.example/omp");
    assert.equal(seen[0].env.OMP_AUTH_BROKER_TOKEN, "broker-token");
  } finally {
    rmSync(fake.root, { recursive: true, force: true });
  }
});

test("loadOmpAuthCatalog turns a Bun spawn failure into OMP_CATALOG_UNAVAILABLE", async () => {
  const fake = createFakeOmpInstall();
  try {
    const result = await loadOmpAuthCatalog({
      env: { UNCLECODE_OMP_BIN: fake.binPath },
      run: async () => {
        throw new Error("spawn bun ENOENT");
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "OMP_CATALOG_UNAVAILABLE");
    assert.match(result.error.message, /spawn bun ENOENT/);
  } finally {
    rmSync(fake.root, { recursive: true, force: true });
  }
});

test("resolveOmpSignInHandoff returns the exact OMP-owned login command", () => {
  const fake = createFakeOmpInstall();
  try {
    const handoff = resolveOmpSignInHandoff("kimi-code", { env: { UNCLECODE_OMP_BIN: fake.binPath } });

    assert.equal(handoff.ok, true);
    assert.equal(handoff.binPath, fake.binPath);
    assert.deepEqual(handoff.argv, ["auth-broker", "login", "kimi-code"]);
    assert.equal(handoff.command, "omp auth-broker login kimi-code");
  } finally {
    rmSync(fake.root, { recursive: true, force: true });
  }
});

test("resolveOmpSignInHandoff refuses unknown providers and a missing OMP install", () => {
  const fake = createFakeOmpInstall();
  const empty = mkdtempSync(path.join(os.tmpdir(), "unclecode-omp-nologin-"));
  try {
    const noInstall = resolveOmpSignInHandoff("kimi-code", { env: { PATH: empty } });
    assert.equal(noInstall.ok, false);
    assert.equal(noInstall.error.code, "OMP_UNAVAILABLE");

    const badId = resolveOmpSignInHandoff("kimi code; rm -rf /", { env: { UNCLECODE_OMP_BIN: fake.binPath } });
    assert.equal(badId.ok, false);
    assert.equal(badId.error.code, "OMP_SIGN_IN_UNAVAILABLE");
  } finally {
    rmSync(fake.root, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test("parseOmpAuthCatalogPayload strips terminal control sequences out of every display field", () => {
  const result = parseOmpAuthCatalogPayload(JSON.stringify({
    ok: true,
    result: {
      dbPath: `/tmp/${ESC}[2Jagent.db`,
      providers: [
        {
          id: "kimi-code",
          name: `${ESC}[31mKimi${ESC}[0m Code\r\nSIGNED IN AS root${BEL}`,
          available: true,
          configured: true,
          origin: { kind: "oauth" },
        },
        {
          id: "openrouter",
          name: `${ESC}]0;pwned${BEL}OpenRouter`,
          available: true,
          configured: true,
          origin: { kind: "env", envVar: "OPENROUTER_API_KEY" },
        },
      ],
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.dbPath, "/tmp/agent.db");
  assert.equal(result.providers[0].name, "Kimi Code SIGNED IN AS root");
  assert.equal(result.providers[1].name, "OpenRouter");
  assert.equal(result.providers[1].originEnvVar, "OPENROUTER_API_KEY");
  for (const value of [result.dbPath, ...result.providers.flatMap((row) => [row.id, row.name])]) {
    assert.ok(!CONTROL_CHARS.test(value), `control characters survived in ${JSON.stringify(value)}`);
  }
});

test("parseOmpAuthCatalogPayload strips terminal control sequences out of worker error text", () => {
  const result = parseOmpAuthCatalogPayload(JSON.stringify({
    ok: false,
    error: {
      code: "OMP_CATALOG_UNAVAILABLE",
      message: `${ESC}[2Jauth broker refused\nrun: omp auth-broker login kimi-code${BEL}`,
    },
  }));

  assert.equal(result.ok, false);
  assert.equal(result.error.message, "auth broker refused run: omp auth-broker login kimi-code");
  assert.ok(!CONTROL_CHARS.test(result.error.message));
});

test("parseOmpAuthCatalogPayload bounds display lengths instead of letting a row scroll the picker", () => {
  const longName = "Kimi Code ".repeat(30).trim();
  const longSlug = Array.from({ length: 20 }, () => "kimi").join("-");
  const longEnvVar = Array.from({ length: 20 }, () => "KIMI").join("_");
  const result = parseOmpAuthCatalogPayload(okPayload([
    { id: "kimi-code", name: longName, available: true, configured: false },
    { id: longSlug, name: "Too long an id", available: true, configured: false },
    {
      id: "openrouter",
      name: "OpenRouter",
      available: true,
      configured: true,
      origin: { kind: "env", envVar: longEnvVar },
    },
  ]));

  assert.equal(result.ok, true);
  assert.deepEqual(result.providers.map((row) => row.id), ["kimi-code", "openrouter"]);
  assert.equal(result.providers[0].name.length, 120);
  assert.ok(result.providers[0].name.startsWith("Kimi Code Kimi Code"));
  assert.ok(result.providers[0].name.endsWith("…"));
  // The leg is still true even when the variable name is not renderable.
  assert.equal(result.providers[1].originKind, "env");
  assert.equal(result.providers[1].originEnvVar, undefined);
});

test("parseOmpAuthCatalogPayload requires provider ids and credential aliases to be slugs", () => {
  const rejected = ["Kimi Code", "KIMI", "../../etc/passwd", "kimi--code", "-kimi", "kimi_", "kimi/code"];
  for (const id of rejected) {
    const result = parseOmpAuthCatalogPayload(okPayload([
      { id, name: "Rejected", available: true, configured: true },
    ]));
    assert.equal(result.ok, true);
    assert.deepEqual(result.providers, [], `expected ${JSON.stringify(id)} to be dropped`);
  }

  const accepted = ["kimi-code", "zai-coding-plan", "xiaomi-token-plan-sgp", "gpt.4o", "a1"];
  for (const id of accepted) {
    const result = parseOmpAuthCatalogPayload(okPayload([
      { id, name: "Accepted", available: true, configured: true },
    ]));
    assert.equal(result.providers.length, 1, `expected ${JSON.stringify(id)} to survive`);
    assert.equal(result.providers[0].credentialKey, id);
  }

  // A bad alias must not silently become the credential key OMP looks under.
  const badAlias = parseOmpAuthCatalogPayload(okPayload([
    { id: "zai-coding-plan", name: "Z.AI", available: true, storeCredentialsAs: "ZAI KEY", configured: true },
  ]));
  assert.equal(badAlias.providers[0].storeCredentialsAs, undefined);
  assert.equal(badAlias.providers[0].credentialKey, "zai-coding-plan");
});

test("parseOmpAuthCatalogPayload requires originEnvVar to be an environment identifier", () => {
  for (const envVar of ["OPENROUTER-API-KEY", "1_KEY", "OPENROUTER API KEY", "sk-ant-oat01", "$OPENROUTER"]) {
    const result = parseOmpAuthCatalogPayload(okPayload([
      { id: "openrouter", name: "OpenRouter", available: true, configured: true, origin: { kind: "env", envVar } },
    ]));
    assert.equal(result.providers[0].originKind, "env");
    assert.equal(
      result.providers[0].originEnvVar,
      undefined,
      `expected ${JSON.stringify(envVar)} to be rejected as an env var name`,
    );
  }

  const good = parseOmpAuthCatalogPayload(okPayload([
    { id: "openrouter", name: "OpenRouter", available: true, configured: true, origin: { kind: "env", envVar: "_OPENROUTER_API_KEY2" } },
  ]));
  assert.equal(good.providers[0].originEnvVar, "_OPENROUTER_API_KEY2");
});

test("parseOmpAuthCatalogPayload keeps credential-shaped values out of every whitelisted field", () => {
  const lowerSecret = `sk-ant-oat01-${"a".repeat(28)}`;
  const upperSecret = `sk-ant-oat01-${"A".repeat(28)}`;
  const result = parseOmpAuthCatalogPayload(JSON.stringify({
    ok: true,
    result: {
      dbPath: `/tmp/${upperSecret}/agent.db`,
      providers: [
        // A token pasted into the id is not a login target: the row goes.
        { id: lowerSecret, name: "Leaky id", available: true, configured: true },
        {
          id: "zai-coding-plan",
          name: `Z.AI ${upperSecret}`,
          available: true,
          storeCredentialsAs: lowerSecret,
          configured: true,
          origin: { kind: "env", envVar: "A".repeat(28) },
        },
      ],
    },
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.providers.map((row) => row.id), ["zai-coding-plan"]);
  assert.equal(result.providers[0].storeCredentialsAs, undefined);
  assert.equal(result.providers[0].credentialKey, "zai-coding-plan");
  assert.equal(result.providers[0].originEnvVar, undefined);
  assert.equal(result.providers[0].name, "Z.AI …redacted…");
  assert.match(result.dbPath, /^\/tmp\/…redacted…\/agent\.db$/);

  const rendered = JSON.stringify(result);
  assert.ok(!rendered.includes("a".repeat(24)));
  assert.ok(!rendered.includes("A".repeat(24)));
});

test("parseOmpAuthCatalogPayload preserves ordinary Unicode provider names", () => {
  const result = parseOmpAuthCatalogPayload(okPayload([
    { id: "zai-coding-plan", name: "Z.AI (GLM Coding Plan · Sign in)", available: true, configured: true },
    { id: "zhipu-coding-plan", name: "智谱 · 编码套餐", available: true, configured: true },
    { id: "mistral", name: "Mistral — Le Chat", available: true, configured: false },
  ]));

  assert.deepEqual(result.providers.map((row) => row.name), [
    "Z.AI (GLM Coding Plan · Sign in)",
    "智谱 · 编码套餐",
    "Mistral — Le Chat",
  ]);
});

test("parseOmpAuthCatalogPayload rejects a result whose dbPath is nothing but control characters", () => {
  const result = parseOmpAuthCatalogPayload(JSON.stringify({
    ok: true,
    result: { dbPath: `${ESC}[2J${BEL}`, providers: [] },
  }));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "OMP_PROTOCOL_ERROR");
});

/**
 * Worker-level regressions. The catalog must read the auth storage OMP's own
 * SDK discovers — broker, config override, oauth, env, fallback — rather than a
 * hand-built store over `agent.db`, which sees only the last of those legs.
 */
function createDiscoveredStorageRuntime(origins, options = {}) {
  const calls = { discovered: 0, closed: 0, hasAuth: [], origin: [] };
  const runtime = {
    getAgentDbPath: () => options.dbPath ?? "/home/u/.omp/agent/agent.db",
    getOAuthProviders: () => options.providers ?? [],
    discoverAuthStorage: async () => {
      calls.discovered += 1;
      return {
        hasAuth(provider) {
          calls.hasAuth.push(provider);
          if (options.failOn === provider) throw new Error(`agent.db is locked for ${provider}`);
          return origins[provider] !== undefined;
        },
        getCredentialOrigin(provider) {
          calls.origin.push(provider);
          return origins[provider];
        },
        close() {
          calls.closed += 1;
        },
      };
    },
  };
  return { calls, runtime };
}

test("buildOmpAuthCatalog joins OMP's provider list against the storage OMP discovers for itself", async () => {
  const { calls, runtime } = createDiscoveredStorageRuntime(
    {
      // Credentials the picker can only see through discovery: the auth broker
      // snapshot surfaces as oauth, a config override as config, and the
      // cross-provider env resolver as fallback.
      anthropic: { kind: "oauth" },
      zai: { kind: "config" },
      openrouter: { kind: "env", envVar: "OPENROUTER_API_KEY" },
      xai: { kind: "fallback" },
    },
    {
      providers: [
        { id: "anthropic", name: "Anthropic (Claude Pro/Max)" },
        { id: "zai-coding-plan", name: "Z.AI", storeCredentialsAs: "zai" },
        { id: "openrouter", name: "OpenRouter" },
        { id: "xai", name: "xAI" },
        { id: "perplexity", name: "Perplexity", available: false },
      ],
    },
  );

  const envelope = await buildOmpAuthCatalog(runtime);

  assert.equal(calls.discovered, 1);
  assert.equal(calls.closed, 1);
  // The alias, not the provider id, is what OMP stores credentials under.
  assert.deepEqual(calls.hasAuth, ["anthropic", "zai", "openrouter", "xai", "perplexity"]);
  assert.deepEqual(calls.origin, calls.hasAuth);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.result.dbPath, "/home/u/.omp/agent/agent.db");
  assert.deepEqual(envelope.result.providers, [
    { id: "anthropic", name: "Anthropic (Claude Pro/Max)", available: true, configured: true, origin: { kind: "oauth" } },
    {
      id: "zai-coding-plan",
      name: "Z.AI",
      available: true,
      storeCredentialsAs: "zai",
      configured: true,
      origin: { kind: "config" },
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      available: true,
      configured: true,
      origin: { kind: "env", envVar: "OPENROUTER_API_KEY" },
    },
    { id: "xai", name: "xAI", available: true, configured: true, origin: { kind: "fallback" } },
    { id: "perplexity", name: "Perplexity", available: false, configured: false },
  ]);
});

test("runOmpAuthCatalogWorkerMain closes discovered storage and reports a read failure in band", async () => {
  const { calls, runtime } = createDiscoveredStorageRuntime(
    { anthropic: { kind: "oauth" } },
    { providers: [{ id: "anthropic", name: "Anthropic" }], failOn: "anthropic" },
  );

  const envelope = JSON.parse(await runOmpAuthCatalogWorkerMain({ loadRuntime: async () => runtime }));

  assert.equal(calls.closed, 1);
  assert.deepEqual(envelope, {
    ok: false,
    error: { code: "OMP_CATALOG_UNAVAILABLE", message: "agent.db is locked for anthropic" },
  });
});

test("runOmpAuthCatalogWorkerMain keeps the failure code when OMP itself cannot be loaded", async () => {
  const missingRoots = JSON.parse(await runOmpAuthCatalogWorkerMain({}));
  assert.deepEqual(missingRoots, {
    ok: false,
    error: { code: "OMP_UNAVAILABLE", message: "no @oh-my-pi scope root and package root were supplied" },
  });

  const loadFailure = JSON.parse(await runOmpAuthCatalogWorkerMain({
    loadRuntime: async () => {
      throw new OmpAuthCatalogWorkerError("OMP_UNAVAILABLE", 'Failed to load OMP module "src/sdk.ts": not found');
    },
  }));
  assert.equal(loadFailure.ok, false);
  assert.equal(loadFailure.error.code, "OMP_UNAVAILABLE");
  assert.match(loadFailure.error.message, /src\/sdk\.ts/);
});

test("a worker envelope from discovered storage parses into display-safe picker rows", async () => {
  const { runtime } = createDiscoveredStorageRuntime(
    { zai: { kind: "config" }, openrouter: { kind: "env", envVar: "OPENROUTER_API_KEY" } },
    {
      providers: [
        { id: "zai-coding-plan", name: "Z.AI (GLM Coding Plan · Sign in)", storeCredentialsAs: "zai" },
        { id: "openrouter", name: "OpenRouter" },
        { id: "perplexity", name: "Perplexity", available: false },
      ],
    },
  );

  const result = parseOmpAuthCatalogPayload(await runOmpAuthCatalogWorkerMain({ loadRuntime: async () => runtime }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.providers, [
    {
      id: "zai-coding-plan",
      name: "Z.AI (GLM Coding Plan · Sign in)",
      available: true,
      storeCredentialsAs: "zai",
      credentialKey: "zai",
      signedIn: true,
      originKind: "config",
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      available: true,
      credentialKey: "openrouter",
      signedIn: true,
      originKind: "env",
      originEnvVar: "OPENROUTER_API_KEY",
    },
    {
      id: "perplexity",
      name: "Perplexity",
      available: false,
      credentialKey: "perplexity",
      signedIn: false,
    },
  ]);
});
