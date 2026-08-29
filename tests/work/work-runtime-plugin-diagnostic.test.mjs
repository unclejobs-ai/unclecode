import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadWorkCliBootstrap } from "../../apps/unclecode-cli/src/work-runtime-bootstrap.ts";
import { createManagedDashboardInput } from "../../apps/unclecode-cli/src/work-runtime-dashboard.ts";
import { loadResumedWorkSession } from "../../apps/unclecode-cli/src/work-runtime-session.ts";
import { createWorkShellPaneRuntime } from "@unclecode/orchestrator";
import { recordWorkspaceTrust } from "@unclecode/plugin-host";

function preserveRustToolchainEnv(originalEnv) {
  const home = originalEnv.HOME;
  return {
    ...(originalEnv.CARGO_HOME
      ? { CARGO_HOME: originalEnv.CARGO_HOME }
      : home ? { CARGO_HOME: path.join(home, ".cargo") } : {}),
    ...(originalEnv.RUSTUP_HOME
      ? { RUSTUP_HOME: originalEnv.RUSTUP_HOME }
      : home ? { RUSTUP_HOME: path.join(home, ".rustup") } : {}),
  };
}

async function runProductionDiagnosticFixture({ sessionId, prompts, uiLocale }) {
  const originalEnv = { ...process.env };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "unclecode-plugin-diag-bootstrap-"));
  const fakeHome = path.join(workspaceRoot, "home");
  let bootstrap;
  try {
    mkdirSync(path.join(workspaceRoot, ".unclecode", "plugins"), { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, ".unclecode", "plugins", "workspace-stop-adapter.mjs"),
      [
        "export default () => ({",
        "  runClassified() {",
        "    const error = new Error('Stop hook failed: zod/v3');",
        "    error.exitStatus = 2;",
        "    throw error;",
        "  },",
        "});",
      ].join("\n"),
      "utf8",
    );
    recordWorkspaceTrust(workspaceRoot, fakeHome);
    const env = {
      ...originalEnv,
      HOME: fakeHome,
      LLM_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.4",
      OPENAI_API_KEY: "sk-test-no-network",
      OPENAI_OAUTH_CLIENT_ID: "",
      UNCLECODE_SESSION_STORE_ROOT: path.join(workspaceRoot, ".state"),
      LC_ALL: uiLocale === "ko" ? "ko_KR.UTF-8" : "en_US.UTF-8",
      ...preserveRustToolchainEnv(originalEnv),
    };
    process.env = env;

    bootstrap = await loadWorkCliBootstrap({
      argv: ["--cwd", workspaceRoot],
      env,
      userHomeDir: fakeHome,
    });
    const managed = createManagedDashboardInput(bootstrap, {
      userHomeDir: fakeHome,
      resolveWorkShellInlineCommand: async () => ({ lines: [], failed: false }),
    });
    const runtime = createWorkShellPaneRuntime({
      ...managed.paneRuntime,
      sessionId,
      onExit() {},
    });
    await runtime.engine.initialize();

    for (const prompt of prompts) {
      await runtime.engine.handleSubmit(prompt);
    }
    const diagnosticEntries = runtime.engine.getState().entries.filter((entry) =>
      entry.text.includes("Stop hook failed: zod/v3")
      && entry.text.includes("workspace-stop-adapter")
      && entry.text.includes("runClassified"));
    const liveDiagnostics = runtime.engine.getState().agentConsole.pluginDiagnostics ?? [];

    runtime.engine.dispose();
    const resumed = await loadResumedWorkSession({ cwd: workspaceRoot, sessionId, env });
    const resumedDiagnostics = resumed.initialAgentConsole?.pluginDiagnostics ?? [];
    return { diagnosticEntries, liveDiagnostics, resumedDiagnostics };
  } finally {
    process.env = originalEnv;
    await bootstrap?.dispose?.();
    rmSync(workspaceRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
}

function assertDurableDiagnosticPayload({ diagnosticEntries, liveDiagnostics, resumedDiagnostics }) {
  assert.equal(diagnosticEntries.length, 2, "one source-labelled TUI diagnostic is retained for each actual run");
  assert.ok(diagnosticEntries.every((entry) => entry.role === "system"));
  assert.ok(diagnosticEntries.every((entry) => !entry.text.includes("Quality Engine")));
  assert.equal(liveDiagnostics.length, 2, "typed diagnostics reach the live console projection");
  assert.equal(resumedDiagnostics.length, 2, "bounded diagnostics survive the existing session snapshot");
  assert.ok(resumedDiagnostics.every((diagnostic) => diagnostic.source === "workspace"));
  assert.ok(resumedDiagnostics.every((diagnostic) => diagnostic.pluginName === "workspace-stop-adapter"));
  assert.ok(resumedDiagnostics.every((diagnostic) => diagnostic.hookName === "runClassified"));
  assert.ok(resumedDiagnostics.every((diagnostic) => diagnostic.errorMessage === "Stop hook failed: zod/v3"));
  assert.ok(resumedDiagnostics.every((diagnostic) => diagnostic.dedupeKey.startsWith("sha256:")));
  for (const [index, entry] of diagnosticEntries.entries()) {
    assert.ok(entry.text.includes("workspace-stop-adapter"), "plugin payload stays byte-for-byte");
    assert.ok(entry.text.includes("runClassified"), "hook payload stays byte-for-byte");
    assert.ok(entry.text.includes("Stop hook failed: zod/v3"), "error payload stays byte-for-byte");
    assert.ok(entry.text.includes(resumedDiagnostics[index].dedupeKey), "persisted hash payload matches the TUI diagnostic");
  }
}

test("production bootstrap keeps English external plugin diagnostic labels in an English session", async () => {
  const fixture = await runProductionDiagnosticFixture({
    sessionId: "plugin-diagnostic-en-session",
    uiLocale: "en",
    prompts: ["Fix one typo", "Fix another typo"],
  });
  assertDurableDiagnosticPayload(fixture);
  assert.ok(fixture.diagnosticEntries.every((entry) =>
    /External plugin · source workspace · trust workspace-trusted · plugin workspace-stop-adapter · hook runClassified · status error · exit 2 · error Error: Stop hook failed: zod\/v3 · dedupe sha256:/.test(entry.text)));
});

test("production bootstrap localizes only system-owned external plugin labels for a Korean session", async () => {
  const fixture = await runProductionDiagnosticFixture({
    sessionId: "plugin-diagnostic-ko-session",
    uiLocale: "ko",
    prompts: ["첫 번째 오타를 수정해 주세요", "두 번째 오타를 수정해 주세요"],
  });
  assertDurableDiagnosticPayload(fixture);
  assert.ok(fixture.diagnosticEntries.every((entry) =>
    /외부 플러그인 · 출처 workspace · 신뢰 workspace-trusted · 플러그인 workspace-stop-adapter · 훅 runClassified · 상태 오류 · 종료 2 · 오류 Error: Stop hook failed: zod\/v3 · 중복 키 sha256:/.test(entry.text)));
  assert.ok(fixture.diagnosticEntries.every((entry) =>
    !/External plugin ·| · source | · trust | · plugin | · hook | · status | · exit | · error | · dedupe /.test(entry.text)));
});
