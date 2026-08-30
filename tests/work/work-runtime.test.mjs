import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseArgs,
  resolveRuntimeProvider,
} from "../../apps/unclecode-cli/src/work-runtime-args.ts";
import {
  deriveAuthIssueLines,
  loadResumedWorkSession,
} from "../../apps/unclecode-cli/src/work-runtime-session.ts";
import { loadWorkCliBootstrap } from "../../apps/unclecode-cli/src/work-runtime-bootstrap.ts";
import { loadWorkShellDashboardProps } from "../../apps/unclecode-cli/src/work-runtime.ts";
import { createManagedDashboardInput } from "../../apps/unclecode-cli/src/work-runtime-dashboard.ts";
import { createAgentOpsStore } from "@unclecode/agentops-db";
import { persistWorkShellSessionSnapshot } from "@unclecode/orchestrator";
import { createManagedWorkShellDashboardProps } from "../../packages/tui/src/index.tsx";
import {
  formatContextPacketPromptPrefix,
  listScopedMemoryEntries,
  writeScopedMemory,
} from "../../packages/context-broker/src/index.ts";
import { buildWorkGraphContextItems } from "../../apps/unclecode-cli/src/work-runtime-context-items.ts";

test("parseArgs extracts cwd/provider/model/reasoning/session/help/tools/prompt from work argv", () => {
  assert.deepEqual(
    parseArgs([
      "--cwd",
      "/tmp/project-a",
      "--provider",
      "openai",
      "--model",
      "gpt-5.6-luna",
      "--reasoning",
      "max",
      "--session-id",
      "work-123",
      "--tools",
      "fix",
      "auth",
    ]),
    {
      cwd: "/tmp/project-a",
      provider: "openai",
      model: "gpt-5.6-luna",
      reasoning: "max",
      sessionId: "work-123",
      prompt: "fix auth",
      showHelp: false,
      showTools: true,
    },
  );
});

test("resolveRuntimeProvider rejects unsupported providers honestly", () => {
  assert.equal(resolveRuntimeProvider("openai"), "openai");
  assert.equal(resolveRuntimeProvider("deepseek"), "deepseek");
  assert.throws(() => resolveRuntimeProvider("bogus"), /Unsupported runtime provider: bogus/);
});

test("parseArgs accepts deepseek as a first-class work runtime", () => {
  assert.deepEqual(
    parseArgs([
      "--provider",
      "deepseek",
      "--model",
      "deepseek-reasoner",
      "review",
      "this",
    ]),
    {
      cwd: process.cwd(),
      provider: "deepseek",
      model: "deepseek-reasoner",
      prompt: "review this",
      showHelp: false,
      showTools: false,
    },
  );
});

test("deriveAuthIssueLines maps saved oauth states into actionable operator guidance", () => {
  assert.deepEqual(
    deriveAuthIssueLines({ authStatus: { expiresAt: "insufficient-scope" } }),
    ["Auth issue: saved OAuth lacks model.request scope. Use /auth key, OPENAI_API_KEY, or browser OAuth with OPENAI_OAUTH_CLIENT_ID."],
  );
  assert.deepEqual(
    deriveAuthIssueLines({ authStatus: { expiresAt: "refresh-required" } }),
    ["Auth issue: saved OAuth needs refresh. Use /auth login or /auth logout before asking the model to work."],
  );
  assert.deepEqual(
    deriveAuthIssueLines({ authIssueMessage: "manual override" }),
    ["manual override"],
  );
  assert.deepEqual(
    deriveAuthIssueLines({
      authStatus: {
        authType: "oauth",
        runtime: "codex",
        expiresAt: null,
        apiReady: false,
      },
    }),
    ["Auth issue: saved Codex OAuth is not API-ready for OpenAI API tool calling. Use /auth key, OPENAI_API_KEY, or browser OAuth with OPENAI_OAUTH_CLIENT_ID."],
  );
});

function buildScopedOutJwt() {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: futureExp, scp: ["openid", "profile", "offline_access"] })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function preserveRustToolchainEnv(originalEnv) {
  const home = originalEnv.HOME;
  return {
    ...(originalEnv.CARGO_HOME
      ? { CARGO_HOME: originalEnv.CARGO_HOME }
      : home
        ? { CARGO_HOME: path.join(home, ".cargo") }
        : {}),
    ...(originalEnv.RUSTUP_HOME
      ? { RUSTUP_HOME: originalEnv.RUSTUP_HOME }
      : home
        ? { RUSTUP_HOME: path.join(home, ".rustup") }
        : {}),
  };
}

test("loadResumedWorkSession reports missing session ids honestly", async () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-runtime-session-"));
  const fakeHome = path.join(workspaceRoot, "home");

  try {
    await assert.rejects(
      () => loadResumedWorkSession({
        cwd: workspaceRoot,
        sessionId: "work-missing",
        env: { HOME: fakeHome },
      }),
      /Session not found: work-missing/,
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("Rust CLI persist-json to resume-json preserves transcript ids and accepts legacy missing ids", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-runtime-entry-id-"));
  const fakeHome = path.join(workspaceRoot, "home");
  const env = {
    ...originalEnv,
    HOME: fakeHome,
    UNCLECODE_SESSION_STORE_ROOT: path.join(workspaceRoot, "session-store"),
    ...preserveRustToolchainEnv(originalEnv),
  };

  try {
    await persistWorkShellSessionSnapshot({
      cwd: workspaceRoot,
      env,
      sessionId: "work-entry-id-roundtrip",
      model: "gpt-5.6-sol",
      mode: "analyze",
      state: "idle",
      summary: "Chat: transcript identity roundtrip",
      entries: [
        { id: "entry-user-stable", role: "user", text: "첫 질문" },
        { id: "entry-assistant-stable", role: "assistant", text: "첫 답변" },
        { role: "user", text: "legacy entry without an id" },
      ],
    });

    const resumed = await loadResumedWorkSession({
      cwd: workspaceRoot,
      sessionId: "work-entry-id-roundtrip",
      env,
    });
    assert.deepEqual(resumed.initialEntries, [
      { id: "entry-user-stable", role: "user", text: "첫 질문" },
      { id: "entry-assistant-stable", role: "assistant", text: "첫 답변" },
      { role: "user", text: "legacy entry without an id" },
    ]);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadWorkCliBootstrap returns prompt plus shell bootstrap state without starting the repl", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-runtime-bootstrap-"));
  const fakeHome = path.join(workspaceRoot, "home");

  try {
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, "AGENTS.md"),
      "# Guidance\nUse workspace guidance sentinel text in the provider system prompt.\n",
      "utf8",
    );
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const accessPayload = Buffer.from(JSON.stringify({ exp: futureExp, scp: ["openid", "profile", "offline_access", "api.connectors.read"] })).toString("base64url");
    const idPayload = Buffer.from(JSON.stringify({ aud: ["client-derived-789"] })).toString("base64url");
    writeFileSync(
      path.join(fakeHome, ".codex", "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: `${header}.${accessPayload}.sig`,
          id_token: `header.${idPayload}.sig`,
        },
      }),
      "utf8",
    );
    const omoSessionDir = path.join(workspaceRoot, ".omo", "ulw-loop", "active-context");
    mkdirSync(path.join(omoSessionDir, "evidence"), { recursive: true });
    writeFileSync(
      path.join(omoSessionDir, "goals.json"),
      JSON.stringify({
        activeGoalId: "G001-context",
        goals: [
          {
            id: "G001-context",
            title: "Ship context packet MVP",
            status: "in_progress",
            successCriteria: [
              {
                id: "C001",
                scenario: "context view uses sanitized OMO state",
                status: "pending",
              },
            ],
          },
        ],
      }),
      "utf8",
    );
    writeFileSync(path.join(omoSessionDir, "ledger.jsonl"), "RAW_LEDGER_SENTINEL_DO_NOT_SHOW\n", "utf8");
    writeFileSync(path.join(omoSessionDir, "evidence", "C001.txt"), "RAW_EVIDENCE_SENTINEL_DO_NOT_SHOW\n", "utf8");

    process.env = {
      ...originalEnv,
      LLM_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.4",
      HOME: fakeHome,
      ...preserveRustToolchainEnv(originalEnv),
      UNCLECODE_SESSION_STORE_ROOT: path.join(workspaceRoot, ".state"),
      OPENAI_OAUTH_CLIENT_ID: "",
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_AUTH_TOKEN;

    const result = await loadWorkCliBootstrap({
      argv: ["--cwd", workspaceRoot, "summarize", "repo"],
    });

    assert.equal(result.prompt, "summarize repo");
    assert.equal(result.options.cwd, workspaceRoot);
    assert.equal(result.options.browserOAuthAvailable, false);
    assert.equal(typeof result.agent.runTurn, "function");
    assert.equal(typeof result.options.resolveContextPacket, "function");
    assert.equal(typeof result.options.generateContextSuggestions, "function");
    assert.equal(typeof result.options.resolveContextSuggestion, "function");
    assert.equal(typeof result.options.invalidateContextSuggestions, "function");
    assert.equal(typeof result.options.refreshCondensedHistory, "function");

    const packet = await result.options.resolveContextPacket({
      cwd: workspaceRoot,
      sessionId: "work-test",
      contextSummaryLines: result.options.contextSummaryLines,
      bridgeLines: ["bridge ready"],
      memoryLines: ["memory ready"],
      traceLines: ["trace ready"],
      workGraph: {
        id: "goal-runtime-1",
        goal: "Ship safe context lifecycle",
        approval: "approved",
        nodes: [{
          id: "task-1",
          title: "Wire lifecycle state",
          prompt: "RAW_EXECUTOR_PROMPT_MUST_STAY_LOCAL",
          status: "running",
          dependsOn: [],
          fileOwnership: ["private/path.ts"],
          acceptanceCriteria: ["Packet exposes safe status"],
          evidenceRefs: [],
        }],
      },
    });

    assert.match(packet.id, /^crp-/, "bootstrap context packets are backed by the CRP selector");

    const providerPromptItem = packet.included.find(
      (item) =>
        item.category === "provider-system-prompt" &&
        item.reason === "workspace guidance active",
    );
    const workspaceGuidanceItem = packet.included.find(
      (item) => item.category === "workspace-guidance" && item.label === "Workspace guidance",
    );

    assert.ok(providerPromptItem, "packet includes system guidance metadata");
    assert.ok(workspaceGuidanceItem, "packet includes workspace guidance summary with safe label");
    assert.notEqual(providerPromptItem.id, workspaceGuidanceItem.id);
    assert.ok(
      packet.manifest?.policy.some(
        (source) => source.authority === "mandatory" && source.id === workspaceGuidanceItem.id,
      ),
      "workspace guidance packet and mandatory policy share one canonical source ID",
    );
    assert.equal(
      packet.included.some((item) => item.category === "workspace" && /AGENTS\.md/.test(item.label)),
      false,
      "AGENTS.md guidance summary rows are not collapsed into generic workspace rows",
    );
    assert.doesNotMatch(
      JSON.stringify(providerPromptItem),
      /Use workspace guidance sentinel text/,
      "system guidance metadata does not inline the guidance body",
    );
    assert.doesNotMatch(
      JSON.stringify(packet),
      /Use workspace guidance sentinel text/,
      "context packet does not inline workspace guidance body text",
    );
    // label must not expose the bare filename, but filename must be preserved in preview
    assert.doesNotMatch(
      workspaceGuidanceItem.label,
      /AGENTS\.md/,
      "workspace guidance label must not expose the raw guidance filename",
    );
    assert.match(
      workspaceGuidanceItem.preview ?? "",
      /AGENTS\.md/,
      "workspace guidance filename is preserved in preview, not the headline label",
    );
    assert.ok(packet.included.some((item) => item.category === "loop-trail" && /G001-context/.test(item.label)));
    assert.ok(
      packet.included.some((item) =>
        item.category === "loop-trail" && /running · Wire lifecycle state/.test(item.label)
      ),
      "packet includes the allowlisted autonomous task status",
    );
    assert.doesNotMatch(JSON.stringify(packet), /RAW_EXECUTOR_PROMPT_MUST_STAY_LOCAL/);
    assert.doesNotMatch(JSON.stringify(packet), /private\/path\.ts/);
    // OMO excluded label must not expose an absolute path; path is preserved in preview
    const loopTrailLedgerItem = packet.excluded.find((item) => item.category === "loop-trail" && /ledger\.jsonl/.test(item.preview ?? ""));
    assert.ok(loopTrailLedgerItem, "loop trail excluded item preserves ledger path in preview");
    assert.doesNotMatch(
      loopTrailLedgerItem.label,
      /\//,
      "OMO excluded item label must not contain an absolute path (no forward-slash)",
    );
    assert.doesNotMatch(JSON.stringify(packet), /RAW_LEDGER_SENTINEL_DO_NOT_SHOW/);
    assert.doesNotMatch(JSON.stringify(packet), /RAW_EVIDENCE_SENTINEL_DO_NOT_SHOW/);
    const preview = result.options.previewContextPacket({
      sessionId: "work-test",
      packet,
      profile: "build",
    });
    const submitted = result.options.submitContextPacketReceipt({
      receiptId: preview.id,
      sessionId: "work-test",
      turnId: "turn-work-test-1",
    });
    const suggestions = await result.options.generateContextSuggestions({
      receipt: submitted,
      packet,
    });
    const mandatorySuggestion = suggestions.find(
      (suggestion) => suggestion.reasonCode === "mandatory-guidance",
    );
    assert.ok(mandatorySuggestion, "submitted packet produces mandatory keep advice");
    assert.equal(mandatorySuggestion.packetReceiptId, submitted.id);
    assert.doesNotMatch(JSON.stringify(suggestions), /Use workspace guidance sentinel text/);
    assert.equal(
      result.options.resolveContextSuggestion(mandatorySuggestion.id, "accepted").status,
      "accepted",
    );
    assert.equal(result.options.invalidateContextSuggestions(submitted.id), suggestions.length - 1);
    await result.options.refreshCondensedHistory();
    const refreshedPacket = await result.options.resolveContextPacket({
      cwd: workspaceRoot,
      sessionId: "work-test",
      contextSummaryLines: [],
      bridgeLines: [],
      memoryLines: [],
      traceLines: Array.from(
        { length: 10 },
        (_, index) => `Optimizer lifecycle trace ${index + 1}.`,
      ),
    });
    assert.ok(
      [...refreshedPacket.included, ...refreshedPacket.excluded].some(
        (item) => item.category === "condensed-history",
      ),
      "forced refresh rebuilds the condensed-history provider before packet selection",
    );
  } finally {
    process.env = originalEnv;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadWorkCliBootstrap forwards optional LSP bridge into guardian checks", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-runtime-lsp-guardian-"));
  const fakeHome = path.join(workspaceRoot, "home");
  const lspCalls = [];

  try {
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(path.join(workspaceRoot, "runtime.ts"), "const ok = true;\n", "utf8");

    process.env = {
      ...originalEnv,
      LLM_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.4",
      HOME: fakeHome,
      ...preserveRustToolchainEnv(originalEnv),
      UNCLECODE_SESSION_STORE_ROOT: path.join(workspaceRoot, ".state"),
      OPENAI_API_KEY: "sk-test-123",
      OPENAI_OAUTH_CLIENT_ID: "",
    };
    delete process.env.OPENAI_AUTH_TOKEN;

    const result = await loadWorkCliBootstrap({
      argv: ["--cwd", workspaceRoot],
      lspBridge: {
        async checkAfterEdit(input) {
          lspCalls.push(input);
          return { status: "pass", summary: "runtime clean" };
        },
      },
    });

    const summary = await result.agent.loadExecutableGuardianSummary({
      prompt: "check runtime",
      mode: "default",
      tasks: [],
      results: [],
      changedFiles: ["runtime.ts"],
    });

    assert.equal(lspCalls.length, 1);
    assert.equal(lspCalls[0]?.path, "runtime.ts");
    assert.match(summary ?? "", /lsp:runtime\.ts PASS · runtime clean/);
  } finally {
    process.env = originalEnv;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadWorkCliBootstrap reports default LSP bridge unavailability honestly", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-runtime-lsp-default-"));
  const fakeHome = path.join(workspaceRoot, "home");

  try {
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(path.join(workspaceRoot, "runtime.ts"), "const ok = true;\n", "utf8");

    process.env = {
      ...originalEnv,
      LLM_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.4",
      HOME: fakeHome,
      ...preserveRustToolchainEnv(originalEnv),
      UNCLECODE_SESSION_STORE_ROOT: path.join(workspaceRoot, ".state"),
      OPENAI_API_KEY: "sk-test-123",
      OPENAI_OAUTH_CLIENT_ID: "",
    };
    delete process.env.OPENAI_AUTH_TOKEN;

    const result = await loadWorkCliBootstrap({
      argv: ["--cwd", workspaceRoot],
    });
    const summary = await result.agent.loadExecutableGuardianSummary({
      prompt: "check runtime",
      mode: "default",
      tasks: [],
      results: [],
      changedFiles: ["runtime.ts"],
    });

    assert.match(summary ?? "", /lsp:runtime\.ts UNAVAILABLE · no LSP clients registered/);
  } finally {
    process.env = originalEnv;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadWorkCliBootstrap represents configured provider prompt as metadata without raw prompt preview", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-runtime-prompt-metadata-"));
  const fakeHome = path.join(workspaceRoot, "home");

  try {
    mkdirSync(path.join(workspaceRoot, ".unclecode"), { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, ".unclecode", "config.json"),
      JSON.stringify({
        prompt: {
          sections: {
            "project-secret": {
              title: "Project Secret",
              body: "SECRET_PROMPT_SENTINEL_DO_NOT_SHOW",
            },
          },
        },
      }),
      "utf8",
    );

    process.env = {
      ...originalEnv,
      LLM_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.4",
      HOME: fakeHome,
      ...preserveRustToolchainEnv(originalEnv),
      UNCLECODE_SESSION_STORE_ROOT: path.join(workspaceRoot, ".state"),
      OPENAI_API_KEY: "sk-test-123",
      OPENAI_OAUTH_CLIENT_ID: "",
    };
    delete process.env.OPENAI_AUTH_TOKEN;

    const result = await loadWorkCliBootstrap({
      argv: ["--cwd", workspaceRoot],
    });

    const metadata = result.options.contextPacketSourceMetadata ?? [];
    assert.ok(
      metadata.some(
        (item) =>
          item.category === "provider-system-prompt" &&
          item.reason === "prompt guidance active",
      ),
      "bootstrap exposes configured prompt metadata before first submit",
    );
    assert.doesNotMatch(JSON.stringify(metadata), /SECRET_PROMPT_SENTINEL_DO_NOT_SHOW/);
    const localDetail = await result.options.resolveContextSourceDetail?.(
      "provider-system-prompt-configured",
    );
    assert.match(localDetail ?? "", /SECRET_PROMPT_SENTINEL_DO_NOT_SHOW/);

    const packet = await result.options.resolveContextPacket?.({
      cwd: workspaceRoot,
      sessionId: "work-test-prompt-metadata",
      contextSummaryLines: result.options.contextSummaryLines,
      bridgeLines: [],
      memoryLines: [],
      traceLines: [],
    });

    assert.ok(packet);
    assert.ok(
      packet.included.some(
        (item) =>
          item.category === "provider-system-prompt" &&
          item.reason === "prompt guidance active",
      ),
      "packet includes system guidance metadata",
    );
    const configuredItem = packet.included.find(
      (item) => item.id === "provider-system-prompt-configured",
    );
    assert.ok(configuredItem);
    assert.ok(
      packet.manifest?.policy.some(
        (source) => source.authority === "mandatory" && source.id === configuredItem.id,
      ),
      "configured prompt packet and mandatory policy share one canonical source ID",
    );
    assert.doesNotMatch(JSON.stringify(packet), /SECRET_PROMPT_SENTINEL_DO_NOT_SHOW/);
    assert.doesNotMatch(packet.preview.join("\n"), /SECRET_PROMPT_SENTINEL_DO_NOT_SHOW/);
  } finally {
    process.env = originalEnv;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadWorkCliBootstrap groups large OMO excluded artifact lists", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-runtime-omo-bounded-"));
  const fakeHome = path.join(workspaceRoot, "home");
  const omoSessionDir = path.join(workspaceRoot, ".omo", "ulw-loop", "large-session");

  try {
    mkdirSync(path.join(omoSessionDir, "evidence"), { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(
      path.join(omoSessionDir, "goals.json"),
      JSON.stringify({ activeGoalId: null, goals: [] }),
      "utf8",
    );
    writeFileSync(path.join(omoSessionDir, "ledger.jsonl"), "RAW_LEDGER_SENTINEL_DO_NOT_SHOW\n", "utf8");
    for (let index = 0; index < 64; index += 1) {
      writeFileSync(
        path.join(omoSessionDir, "evidence", `C${String(index).padStart(3, "0")}.txt`),
        `RAW_EVIDENCE_SENTINEL_${String(index)}_DO_NOT_SHOW\n`,
        "utf8",
      );
    }

    process.env = {
      ...originalEnv,
      LLM_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.4",
      HOME: fakeHome,
      ...preserveRustToolchainEnv(originalEnv),
      UNCLECODE_SESSION_STORE_ROOT: path.join(workspaceRoot, ".state"),
      OPENAI_API_KEY: "sk-test-123",
      OPENAI_OAUTH_CLIENT_ID: "",
    };
    delete process.env.OPENAI_AUTH_TOKEN;

    const result = await loadWorkCliBootstrap({
      argv: ["--cwd", workspaceRoot],
    });
    const packet = await result.options.resolveContextPacket?.({
      cwd: workspaceRoot,
      sessionId: "work-test-omo-bounded",
      contextSummaryLines: result.options.contextSummaryLines,
      bridgeLines: [],
      memoryLines: [],
      traceLines: [],
    });

    assert.ok(packet);
    const loopTrailExcluded = packet.excluded.filter((item) => item.category === "loop-trail");
    assert.ok(
      loopTrailExcluded.length <= 8,
      `expected bounded loop trail excluded list, got ${String(loopTrailExcluded.length)} items`,
    );
    assert.equal(
      packet.sourceCounts.excluded,
      65,
      "context still reports the full raw artifact count withheld from model-ready context",
    );
    assert.ok(
      loopTrailExcluded.some((item) => /64 loop trail evidence transcripts/.test(item.label)),
      "packet summarizes excluded loop trail evidence counts instead of listing every path",
    );
    assert.match(
      formatContextPacketPromptPrefix(packet),
      /Excluded raw artifacts:\n- 65 raw artifacts withheld from model-ready context; inspect \/context for local-only details\./,
    );
    assert.doesNotMatch(JSON.stringify(packet), /RAW_EVIDENCE_SENTINEL_/);
  } finally {
    process.env = originalEnv;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadWorkCliBootstrap defers full dashboard home hydration until refresh", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-runtime-lazy-home-"));
  const fakeHome = path.join(workspaceRoot, "home");
  const sessionStoreRoot = path.join(workspaceRoot, ".state");

  try {
    await persistWorkShellSessionSnapshot({
      cwd: workspaceRoot,
      env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
      sessionId: "work-lazy-home",
      model: "gpt-5.4",
      mode: "default",
      state: "idle",
      summary: "Chat: cached history",
    });

    process.env = {
      ...originalEnv,
      LLM_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.4",
      HOME: fakeHome,
      ...preserveRustToolchainEnv(originalEnv),
      UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
      OPENAI_API_KEY: "sk-test-123",
      OPENAI_OAUTH_CLIENT_ID: "",
    };
    delete process.env.OPENAI_AUTH_TOKEN;

    const result = await loadWorkCliBootstrap({
      argv: ["--cwd", workspaceRoot],
    });

    assert.equal(result.options.homeState.sessionCount, 0);
    assert.deepEqual(result.options.homeState.sessions, []);
    assert.equal(typeof result.options.refreshHomeState, "function");

    const refreshed = await result.options.refreshHomeState?.();
    assert.equal(refreshed?.sessionCount, 1);
    assert.equal(refreshed?.sessions[0]?.sessionId, "work-lazy-home");
  } finally {
    process.env = originalEnv;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadWorkShellDashboardProps keeps browser oauth unavailable when only reusable codex auth exists", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-runtime-"));
  const fakeHome = path.join(workspaceRoot, "home");

  try {
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const accessPayload = Buffer.from(JSON.stringify({ exp: futureExp, scp: ["openid", "profile", "offline_access", "api.connectors.read"] })).toString("base64url");
    const idPayload = Buffer.from(JSON.stringify({ aud: ["client-derived-789"] })).toString("base64url");
    writeFileSync(
      path.join(fakeHome, ".codex", "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: `${header}.${accessPayload}.sig`,
          id_token: `header.${idPayload}.sig`,
        },
      }),
      "utf8",
    );

    process.env = {
      ...originalEnv,
      LLM_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.4",
      HOME: fakeHome,
      ...preserveRustToolchainEnv(originalEnv),
      UNCLECODE_SESSION_STORE_ROOT: path.join(workspaceRoot, ".state"),
      OPENAI_OAUTH_CLIENT_ID: "",
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_AUTH_TOKEN;

    const props = await loadWorkShellDashboardProps(["--cwd", workspaceRoot]);
    const element = props.renderWorkPane({ openSessions() {}, syncHomeState() {} });
    const pane = element.props.buildPane({ onExit() {} });

    assert.equal(props.authLabel, "oauth-file-api-blocked");
    assert.equal(pane.browserOAuthAvailable, false);
  } finally {
    process.env = originalEnv;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadWorkShellDashboardProps still opens the shell when saved oauth lacks model.request scope", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-runtime-"));
  const credentialsPath = path.join(workspaceRoot, "openai.json");

  try {
    mkdirSync(path.join(workspaceRoot, ".unclecode"), { recursive: true });
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        authType: "oauth",
        accessToken: buildScopedOutJwt(),
        refreshToken: "rt_123",
      }),
      "utf8",
    );

    process.env = {
      ...originalEnv,
      LLM_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.4",
      UNCLECODE_OPENAI_CREDENTIALS_PATH: credentialsPath,
      UNCLECODE_SESSION_STORE_ROOT: path.join(workspaceRoot, ".state"),
      HOME: originalEnv.HOME ?? workspaceRoot,
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_AUTH_TOKEN;

    const props = await loadWorkShellDashboardProps(["--cwd", workspaceRoot]);

    assert.equal(props.workspaceRoot, workspaceRoot);
    assert.equal(props.authLabel, "oauth-file-api-blocked");
    assert.ok(props.contextLines.some((line) => /model\.request scope/i.test(line)));
    assert.equal(typeof props.renderWorkPane, "function");
  } finally {
    process.env = originalEnv;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("loadWorkCliBootstrap reuses resumed reasoning overrides unless the CLI overrides them", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-runtime-resume-reasoning-"));
  const sessionStoreRoot = path.join(workspaceRoot, ".state");

  try {
    await persistWorkShellSessionSnapshot({
      cwd: workspaceRoot,
      env: { ...process.env, UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot },
      sessionId: "work-session-77",
      model: "gpt-5.6-sol",
      mode: "analyze",
      state: "idle",
      summary: "Chat: inspect repo",
      reasoningEffort: "max",
      entries: [
        { role: "user", text: "inspect repo" },
        { role: "assistant", text: "repo inspected" },
      ],
    });

    process.env = {
      ...originalEnv,
      LLM_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.6-sol",
      HOME: originalEnv.HOME ?? workspaceRoot,
      UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
      OPENAI_API_KEY: "sk-test-123",
    };
    delete process.env.OPENAI_AUTH_TOKEN;

    const resumed = await loadWorkCliBootstrap({
      argv: ["--cwd", workspaceRoot, "--session-id", "work-session-77"],
    });
    assert.equal(resumed.options.reasoning.effort, "max");
    assert.equal(resumed.options.reasoning.source, "override");
    assert.deepEqual(resumed.options.initialEntries, [
      { role: "user", text: "inspect repo" },
      { role: "assistant", text: "repo inspected" },
    ]);
    assert.equal(resumed.options.initialSessionSummary, "Chat: inspect repo");

    const overridden = await loadWorkCliBootstrap({
      argv: ["--cwd", workspaceRoot, "--session-id", "work-session-77", "--reasoning", "none"],
    });
    assert.equal(overridden.options.reasoning.effort, "none");
    assert.equal(overridden.options.reasoning.source, "override");
  } finally {
    process.env = originalEnv;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("resuming invalidates previews and excludes memory with unsubmitted lineage", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-runtime-resume-lineage-"));
  const fakeHome = path.join(workspaceRoot, "home");
  const sessionStoreRoot = path.join(workspaceRoot, ".state");
  const sessionId = "work-session-lineage";
  const projectId = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  const env = {
    ...process.env,
    LLM_PROVIDER: "openai",
    OPENAI_MODEL: "gpt-5.6-sol",
    HOME: fakeHome,
    UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
    OPENAI_API_KEY: "sk-test-123",
  };

  try {
    mkdirSync(fakeHome, { recursive: true });
    const store = createAgentOpsStore({
      home: path.join(fakeHome, ".unclecode", "agentops"),
    });
    store.addProject({
      id: projectId,
      name: "resume-lineage",
      repoPath: workspaceRoot,
    });
    store.recordContextPacketPreview({
      id: "receipt-submitted",
      projectId,
      sessionId,
      packetId: "packet-submitted",
      profile: "build",
      tokenEstimate: 100,
      tokenEstimateState: "estimated",
      sourceCount: 0,
      sourceRefs: [],
    });
    store.submitContextPacketReceipt({
      receiptId: "receipt-submitted",
      projectId,
      sessionId,
      turnId: "turn-submitted",
    });
    store.recordContextPacketPreview({
      id: "receipt-preview",
      projectId,
      sessionId,
      packetId: "packet-preview",
      profile: "build",
      tokenEstimate: 100,
      tokenEstimateState: "estimated",
      sourceCount: 0,
      sourceRefs: [],
    });
    const memory = await writeScopedMemory({
      scope: "session",
      cwd: workspaceRoot,
      env,
      sessionId,
      summary: "orphan-memory must never be injected",
    });
    store.recordMemoryLineage({
      memoryId: memory.memoryId,
      sourceId: "assistant-summary",
      originTurnId: "turn-preview",
      originPacketReceiptId: "receipt-preview",
      state: "active",
      confidence: 0.9,
    });
    store.addProject({
      id: "other-project",
      name: "other-project",
      repoPath: path.join(workspaceRoot, "other"),
    });
    store.recordContextPacketPreview({
      id: "receipt-other-preview",
      projectId: "other-project",
      sessionId: "other-session",
      packetId: "packet-other-preview",
      profile: "build",
      tokenEstimateState: "unknown",
      sourceCount: 0,
      sourceRefs: [],
    });
    store.recordMemoryLineage({
      memoryId: "memory:session:2026-07-13T00:00:00.000Z:other",
      sourceId: "assistant-summary",
      originTurnId: "turn-other-preview",
      originPacketReceiptId: "receipt-other-preview",
      state: "active",
      confidence: 0.9,
    });
    store.close();

    await persistWorkShellSessionSnapshot({
      cwd: workspaceRoot,
      env,
      sessionId,
      model: "gpt-5.6-sol",
      mode: "analyze",
      state: "idle",
      summary: "Chat: lifecycle",
      lastSubmittedContextReceiptId: "receipt-submitted",
    });

    process.env = env;
    delete process.env.OPENAI_AUTH_TOKEN;
    const resumedSession = await loadResumedWorkSession({
      cwd: workspaceRoot,
      sessionId,
      env,
    });
    assert.equal(
      resumedSession.lastSubmittedContextReceiptId,
      "receipt-submitted",
      "only the submitted receipt identity is resumable",
    );

    const resumed = await loadWorkCliBootstrap({
      argv: ["--cwd", workspaceRoot, "--session-id", sessionId],
      env,
      userHomeDir: fakeHome,
    });
    assert.equal(
      resumed.options.initialLastSubmittedContextReceiptId,
      "receipt-submitted",
    );
    const reopened = createAgentOpsStore({
      home: path.join(fakeHome, ".unclecode", "agentops"),
    });
    assert.equal(
      reopened.getContextPacketReceipt(projectId, "receipt-preview")?.state,
      "invalidated",
    );
    assert.equal(
      reopened.getMemoryLineage(
        "memory:session:2026-07-13T00:00:00.000Z:other",
      )?.state,
      "active",
      "resuming one project must not mutate another project's lineage",
    );
    reopened.close();
    assert.equal(resumed.options.memoryLineage?.isActive(memory.memoryId), false);
    assert.deepEqual(
      await listScopedMemoryEntries({
        scope: "session",
        cwd: workspaceRoot,
        env,
        sessionId,
        lineage: resumed.options.memoryLineage,
      }),
      [],
    );
    assert.ok(
      resumed.options.contextSummaryLines.some((line) =>
        /memory lineage.*1/i.test(line)
      ),
    );
  } finally {
    process.env = originalEnv;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("resuming fails closed when lifecycle integrity cannot be reconciled", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-runtime-resume-integrity-"));
  const fakeHome = path.join(workspaceRoot, "home");
  const sessionStoreRoot = path.join(workspaceRoot, ".state");
  const env = {
    ...process.env,
    LLM_PROVIDER: "openai",
    OPENAI_MODEL: "gpt-5.6-sol",
    HOME: fakeHome,
    UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
    OPENAI_API_KEY: "sk-test-123",
  };

  try {
    await persistWorkShellSessionSnapshot({
      cwd: workspaceRoot,
      env,
      sessionId: "resume-integrity-failure",
      model: "gpt-5.6-sol",
      mode: "analyze",
      state: "idle",
      summary: "Chat: integrity",
    });
    mkdirSync(path.join(fakeHome, ".unclecode"), { recursive: true });
    writeFileSync(path.join(fakeHome, ".unclecode", "agentops"), "not a directory");
    process.env = env;

    await assert.rejects(
      () => loadWorkCliBootstrap({
        argv: [
          "--cwd",
          workspaceRoot,
          "--session-id",
          "resume-integrity-failure",
        ],
        env,
        userHomeDir: fakeHome,
      }),
      /Unable to resume safely: context integrity validation failed/,
    );
  } finally {
    process.env = originalEnv;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("goal context projection prioritizes active tasks and excludes private executor fields", () => {
  const items = buildWorkGraphContextItems({
    id: "goal-context",
    goal: "Ship context",
    approval: "approved",
    nodes: Array.from({ length: 6 }, (_, index) => ({
      id: `task-${index + 1}`,
      title: `Task ${index + 1}`,
      prompt: `PRIVATE_PROMPT_${index + 1}`,
      status: index === 5 ? "running" : "completed",
      dependsOn: [],
      fileOwnership: [`private-${index + 1}.ts`],
      evidenceRefs: [],
    })),
  });

  assert.match(items[1]?.label ?? "", /running · Task 6/);
  assert.equal(items.some((item) => /Task 5/.test(item.label)), false);
  assert.doesNotMatch(JSON.stringify(items), /PRIVATE_PROMPT|private-\d+\.ts/);
});

test("goal context projection carries title, goal, constraints, acceptance criteria and evidence per task", () => {
  const items = buildWorkGraphContextItems({
    id: "graph-runbook",
    goal: "Ship the context desk",
    constraints: ["no new dependencies", "keyboard semantics unchanged"],
    approval: "approved",
    nodes: [
      {
        id: "node-desk",
        title: "Wire the desk",
        prompt: "PRIVATE_PROMPT wire the Context Desk to the runbook lane",
        status: "requires_action",
        dependsOn: ["node-contract"],
        fileOwnership: ["packages/tui/src/work-shell-view.tsx"],
        acceptanceCriteria: ["Runbook lane renders", "Keyboard focus survives", "No new deps"],
        evidenceRefs: ["evidence/desk-render.txt", "evidence/desk-keys.txt", "evidence/desk-deps.txt"],
      },
    ],
  });

  const node = items[1];
  assert.equal(node?.id, "goal-loop-graph-runbook-node-desk");
  assert.equal(
    node?.preview,
    "Aim: Wire the desk"
      + " · Done when: Runbook lane renders; Keyboard focus survives (+1 more)"
      + " · Evidence: evidence/desk-render.txt; evidence/desk-keys.txt (+1 more)",
  );
  assert.deepEqual(node?.metadata, {
    kind: "work-node",
    graphId: "graph-runbook",
    nodeId: "node-desk",
    title: "Wire the desk",
    goal: "Ship the context desk",
    constraints: ["no new dependencies", "keyboard semantics unchanged"],
    status: "requires_action",
    acceptanceCriteria: ["Runbook lane renders", "Keyboard focus survives", "No new deps"],
    evidenceRefs: ["evidence/desk-render.txt", "evidence/desk-keys.txt", "evidence/desk-deps.txt"],
  });
  assert.doesNotMatch(JSON.stringify(node), /PRIVATE_PROMPT|work-shell-view\.tsx/);
});

test("goal context projection states missing acceptance criteria and evidence in words", () => {
  const items = buildWorkGraphContextItems({
    id: "graph-bare",
    approval: "pending",
    nodes: [
      {
        id: "node-bare",
        title: "Unscoped task",
        prompt: "PRIVATE_PROMPT investigate the regression",
        status: "ready",
        dependsOn: [],
        fileOwnership: [],
        evidenceRefs: ["   "],
      },
    ],
  });

  assert.equal(
    items[1]?.preview,
    "Aim: Unscoped task"
      + " · Done when: no acceptance criteria recorded yet"
      + " · Evidence: nothing captured yet",
  );
  assert.equal(items[1]?.metadata?.title, "Unscoped task");
  assert.deepEqual(items[1]?.metadata?.constraints, []);
  assert.equal("goal" in (items[1]?.metadata ?? {}), false);
  assert.deepEqual(items[1]?.metadata?.acceptanceCriteria, []);
  assert.deepEqual(items[1]?.metadata?.evidenceRefs, ["   "]);
});

test("managed dashboard preserves the resumed submitted receipt identity", () => {
  const ompAuthCatalog = {
    list: async () => ({ ok: true, providers: [] }),
    signIn: async () => ({ ok: true, command: "omp auth-broker login kimi-code" }),
  };
  const managed = createManagedDashboardInput({
    agent: {},
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "build",
      authLabel: "api-key-env",
      reasoning: {
        effort: "high",
        source: "mode-default",
        support: {
          status: "supported",
          defaultEffort: "medium",
          supportedEfforts: ["low", "medium", "high"],
        },
      },
      cwd: "/repo",
      modelWindow: 128_000,
      contextSummaryLines: [],
      homeState: {},
      initialLastSubmittedContextReceiptId: "receipt-resumed-submitted",
      ompAuthCatalog,
    },
  }, {
    resolveWorkShellInlineCommand: async () => ({ lines: [], failed: false }),
  });

  assert.equal(
    managed.paneRuntime.initialLastSubmittedContextReceiptId,
    "receipt-resumed-submitted",
  );

  const dashboard = createManagedWorkShellDashboardProps(managed);
  const embeddedPane = dashboard.renderWorkPane({
    openSessions() {},
    syncHomeState() {},
  });
  const pane = embeddedPane.props.buildPane({ onExit() {} });
  assert.equal(pane.ompAuthCatalog, ompAuthCatalog);
});

test("managed dashboard publishes one attachment callback per runtime engine", () => {
  const attached = [];
  const managed = createManagedDashboardInput({
    agent: {},
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "build",
      authLabel: "api-key-env",
      reasoning: {
        effort: "high",
        source: "mode-default",
        support: {
          status: "supported",
          defaultEffort: "medium",
          supportedEfforts: ["low", "medium", "high"],
        },
      },
      cwd: "/repo",
      modelWindow: 128_000,
      contextSummaryLines: [],
      homeState: {},
      onWorkShellEngineReady(engine) {
        attached.push(engine);
      },
    },
  }, {
    resolveWorkShellInlineCommand: async () => ({ lines: [], failed: false }),
  });
  const sharedEngine = {
    getState() { return { model: "gpt-5.4" }; },
  };
  const dashboard = createManagedWorkShellDashboardProps({
    ...managed,
    paneEngine: sharedEngine,
  });

  dashboard.renderWorkPane({ openSessions() {}, syncHomeState() {} })
    .props.buildPane({ onExit() {} });
  dashboard.renderWorkPane({ openSessions() {}, syncHomeState() {} })
    .props.buildPane({ onExit() {} });

  assert.deepEqual(attached, [sharedEngine]);
});

test("managed dashboard retries an engine attachment callback that throws", () => {
  let attempts = 0;
  const managed = createManagedDashboardInput({
    agent: {},
    options: {
      provider: "openai",
      model: "gpt-5.4",
      mode: "build",
      authLabel: "api-key-env",
      reasoning: {
        effort: "high",
        source: "mode-default",
        support: {
          status: "supported",
          defaultEffort: "medium",
          supportedEfforts: ["low", "medium", "high"],
        },
      },
      cwd: "/repo",
      modelWindow: 128_000,
      contextSummaryLines: [],
      homeState: {},
      onWorkShellEngineReady() {
        attempts += 1;
        if (attempts === 1) throw new Error("attach failed");
      },
    },
  }, {
    resolveWorkShellInlineCommand: async () => ({ lines: [], failed: false }),
  });
  const sharedEngine = {
    getState() { return { model: "gpt-5.4" }; },
  };
  const dashboard = createManagedWorkShellDashboardProps({
    ...managed,
    paneEngine: sharedEngine,
  });
  const build = () => dashboard.renderWorkPane({ openSessions() {}, syncHomeState() {} })
    .props.buildPane({ onExit() {} });

  assert.throws(build, /attach failed/);
  assert.doesNotThrow(build);
  assert.doesNotThrow(build);
  assert.equal(attempts, 2);
});
