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
import { persistWorkShellSessionSnapshot } from "@unclecode/orchestrator";

test("parseArgs extracts cwd/provider/model/reasoning/session/help/tools/prompt from work argv", () => {
  assert.deepEqual(
    parseArgs([
      "--cwd",
      "/tmp/project-a",
      "--provider",
      "openai",
      "--model",
      "gpt-5.4",
      "--reasoning",
      "high",
      "--session-id",
      "work-123",
      "--tools",
      "fix",
      "auth",
    ]),
    {
      cwd: "/tmp/project-a",
      provider: "openai",
      model: "gpt-5.4",
      reasoning: "high",
      sessionId: "work-123",
      prompt: "fix auth",
      showHelp: false,
      showTools: true,
    },
  );
});

test("resolveRuntimeProvider rejects unsupported providers honestly", () => {
  assert.equal(resolveRuntimeProvider("openai"), "openai");
  assert.throws(() => resolveRuntimeProvider("bogus"), /Unsupported runtime provider: bogus/);
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
});

function buildScopedOutJwt() {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: futureExp, scp: ["openid", "profile", "offline_access"] })).toString("base64url");
  return `${header}.${payload}.sig`;
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

test("loadWorkCliBootstrap returns prompt plus shell bootstrap state without starting the repl", async () => {
  const originalEnv = { ...process.env };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-work-runtime-bootstrap-"));
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
                scenario: "packet inspector uses sanitized OMO state",
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

    const packet = await result.options.resolveContextPacket({
      cwd: workspaceRoot,
      sessionId: "work-test",
      contextSummaryLines: ["Loaded guidance: AGENTS.md"],
      bridgeLines: ["bridge ready"],
      memoryLines: ["memory ready"],
      traceLines: ["trace ready"],
    });

    assert.ok(packet.included.some((item) => item.category === "omo" && /G001-context/.test(item.label)));
    assert.ok(packet.excluded.some((item) => item.category === "omo" && /ledger\.jsonl/.test(item.label)));
    assert.doesNotMatch(JSON.stringify(packet), /RAW_LEDGER_SENTINEL_DO_NOT_SHOW/);
    assert.doesNotMatch(JSON.stringify(packet), /RAW_EVIDENCE_SENTINEL_DO_NOT_SHOW/);
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
      UNCLECODE_SESSION_STORE_ROOT: path.join(workspaceRoot, ".state"),
      OPENAI_OAUTH_CLIENT_ID: "",
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_AUTH_TOKEN;

    const props = await loadWorkShellDashboardProps(["--cwd", workspaceRoot]);
    const element = props.renderWorkPane({ openSessions() {}, syncHomeState() {} });
    const pane = element.props.buildPane({ onExit() {} });

    assert.equal(props.authLabel, "oauth-file");
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
    assert.equal(props.authLabel, "oauth-file");
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
      model: "gpt-5.4",
      mode: "analyze",
      state: "idle",
      summary: "Chat: inspect repo",
      reasoningEffort: "low",
      entries: [
        { role: "user", text: "inspect repo" },
        { role: "assistant", text: "repo inspected" },
      ],
    });

    process.env = {
      ...originalEnv,
      LLM_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.4",
      HOME: originalEnv.HOME ?? workspaceRoot,
      UNCLECODE_SESSION_STORE_ROOT: sessionStoreRoot,
      OPENAI_API_KEY: "sk-test-123",
    };
    delete process.env.OPENAI_AUTH_TOKEN;

    const resumed = await loadWorkCliBootstrap({
      argv: ["--cwd", workspaceRoot, "--session-id", "work-session-77"],
    });
    assert.equal(resumed.options.reasoning.effort, "low");
    assert.equal(resumed.options.reasoning.source, "override");
    assert.deepEqual(resumed.options.initialEntries, [
      { role: "user", text: "inspect repo" },
      { role: "assistant", text: "repo inspected" },
    ]);
    assert.equal(resumed.options.initialSessionSummary, "Chat: inspect repo");

    const overridden = await loadWorkCliBootstrap({
      argv: ["--cwd", workspaceRoot, "--session-id", "work-session-77", "--reasoning", "high"],
    });
    assert.equal(overridden.options.reasoning.effort, "high");
    assert.equal(overridden.options.reasoning.source, "override");
  } finally {
    process.env = originalEnv;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
