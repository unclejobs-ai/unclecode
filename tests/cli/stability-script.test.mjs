import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, "../..");

test("package exposes one command for the UncleCode stabilization gate", () => {
  const pkg = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
  const stability = pkg.scripts?.["qa:stability"];

  assert.equal(stability, "npm run qa:health");
});

test("package exposes one command for operational health and stabilization checks", () => {
  const pkg = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
  const health = pkg.scripts?.["qa:health"];

  assert.equal(health, "node scripts/unclecode-health-qa.mjs");
});

test("QA scripts keep build noise low while preserving native build checks", () => {
  const pkg = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));

  for (const scriptName of ["qa:runtime", "qa:live", "qa:live:record"]) {
    const command = pkg.scripts?.[scriptName] ?? "";
    assert.match(command, /cargo build --quiet -p unclecode/);
  }
});

test("node test scripts suppress expected sqlite experimental warning noise", () => {
  const pkg = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
  const testScripts = Object.entries(pkg.scripts ?? {}).filter(([name, command]) =>
    name.startsWith("test:") && command.startsWith("node --")
  );

  assert.ok(testScripts.length > 0, "expected node-backed test scripts");
  for (const [name, command] of testScripts) {
    if (name === "test:integration" || name === "test:integration:performance") {
      continue;
    }
    assert.match(command, /--disable-warning=ExperimentalWarning/, `${name} should suppress sqlite warning noise`);
  }
});

test("compact health runner preserves the full operational gate", () => {
  const runner = readFileSync(path.join(workspaceRoot, "scripts", "unclecode-health-qa.mjs"), "utf8");
  const healthRunner = readFileSync(path.join(workspaceRoot, "scripts", "health-qa", "runner.mjs"), "utf8");
  const summary = readFileSync(path.join(workspaceRoot, "scripts", "health-qa", "summary.mjs"), "utf8");

  for (const requiredCommand of [
    "bin/unclecode.cjs\", \"--version",
    "run\", \"node:check",
    "bin/unclecode.cjs\", \"doctor",
    "bin/unclecode.cjs\", \"doctor\", \"--json",
    "bin/unclecode.cjs\", \"mcp\", \"list",
    "bin/unclecode.cjs\", \"research\", \"status\", \"--json",
    "run\", \"check",
    "run\", \"lint",
    "run\", \"test:work",
    "run\", \"test:cli",
    "run\", \"test:tui",
    "run\", \"qa:runtime",
    "run\", \"qa:live:record",
    "diff\", \"--check",
  ]) {
    assert.match(runner, new RegExp(escapeRegExp(requiredCommand)));
  }
  assert.match(runner, /summarizeRuntimeQa/);
  assert.match(runner, /acceptRuntimeQa/);
  assert.match(runner, /summarizeLiveQa/);
  assert.match(runner, /acceptLiveQa/);
  assert.match(runner, /summarizeDoctorJson/);
  assert.match(runner, /hasDoctorJsonAuthContract/);
  assert.match(runner, /hasRuntimeReportContract/);
  assert.match(runner, /hasLiveProviderReportContract/);
  assert.match(runner, /isNativeAbiFailure/);
  assert.match(runner, /npm", \["rebuild", "better-sqlite3"\]/);
  assert.match(runner, /summarizeRuntimeReport/);
  assert.match(runner, /summarizeLiveReport/);
  assert.match(runner, /recoveryHintForFailure/);
  assert.match(runner, /live blocked recorded/);
  assert.match(runner, /runCommand/);
  assert.match(runner, /result\.timedOut !== true/);
  assert.match(runner, /timed out after/);
  assert.match(healthRunner, /DEFAULT_CHECK_TIMEOUT_MS/);
  assert.match(healthRunner, /startedAtMs/);
  assert.match(healthRunner, /SIGTERM/);
  assert.match(healthRunner, /SIGKILL/);
  assert.match(healthRunner, /startTimeoutWatchdog/);
  assert.match(healthRunner, /didTimeOut \? normalizeTimedOutCode\(code, signal\)/);
  assert.match(healthRunner, /terminateProcessTree\(child, "SIGKILL", knownDescendantPids\)/);
  assert.match(summary, /isFreshReport/);
  assert.match(summary, /stale runtime report ignored/);
  assert.match(summary, /stale live report ignored/);
  assert.match(summary, /better_sqlite3/);
  assert.match(summary, /NODE_MODULE_VERSION/);
  assert.match(summary, /ERR_DLOPEN_FAILED/);
  assert.match(summary, /isNativeAbiFailure/);
  assert.match(summary, /liveRecovery=refresh credentials/);
  assert.match(summary, /markerMatched/);
  assert.match(summary, /npm rebuild better-sqlite3 && npm run qa:health --silent/);
});

test("runtime QA stays split into inspectable modules", () => {
  const runtimeQaScript = path.join(workspaceRoot, "scripts", "unclecode-runtime-qa.mjs");
  const healthQaScript = path.join(workspaceRoot, "scripts", "unclecode-health-qa.mjs");
  const healthSummaryModule = path.join(workspaceRoot, "scripts", "health-qa", "summary.mjs");
  const healthRunnerModule = path.join(workspaceRoot, "scripts", "health-qa", "runner.mjs");
  const moduleDirectory = path.join(workspaceRoot, "scripts", "runtime-qa");
  const moduleFiles = readdirSync(moduleDirectory)
    .filter((fileName) => fileName.endsWith(".mjs"))
    .sort();

  assert.deepEqual(moduleFiles, [
    "cli-helpers.mjs",
    "constants.mjs",
    "fake-anthropic-server.mjs",
    "fake-gemini-server.mjs",
    "fake-openai-server.mjs",
    "provider-smokes.mjs",
    "report-evidence.mjs",
    "tmux-helpers.mjs",
    "tty-smoke.mjs",
    "tui-basic-smokes.mjs",
    "tui-context-contrast-smoke.mjs",
    "tui-korean-smoke.mjs",
    "tui-real-use-smoke.mjs",
    "tui-slash-latency-smoke.mjs",
    "tui-suite-smokes.mjs",
  ]);
  assertPureLocAtMost(healthQaScript, 220);
  assertPureLocAtMost(healthSummaryModule, 220);
  assertPureLocAtMost(healthRunnerModule, 120);
  assertPureLocAtMost(runtimeQaScript, 150);
  for (const moduleFile of moduleFiles) {
    assertPureLocAtMost(path.join(moduleDirectory, moduleFile), 220);
  }
});

test("slash latency smoke keeps strict budgets but retries transient tmux capture spikes", async () => {
  const smokeModuleUrl = pathToFileURL(
    path.join(workspaceRoot, "scripts", "runtime-qa", "tui-slash-latency-smoke.mjs"),
  ).href;
  const { SLASH_LATENCY_BUDGETS_MS, retryBudgetedMeasurement } = await import(smokeModuleUrl);

  assert.deepEqual(SLASH_LATENCY_BUDGETS_MS, {
    firstSlash: 300,
    warmSlash: 200,
    filter: 150,
    modelPicker: 200,
  });

  const attempts = [];
  const clears = [];
  const recovered = await retryBudgetedMeasurement({
    label: "demo paint",
    budgetMs: 200,
    clear: async () => {
      clears.push(clears.length);
    },
    measure: async () => {
      attempts.push(attempts.length);
      return attempts.length === 1 ? 450 : 120;
    },
  });

  assert.equal(recovered, 120);
  assert.equal(clears.length, 2);
  assert.equal(attempts.length, 2);

  const firstAttemptClears = [];
  const firstAttempt = await retryBudgetedMeasurement({
    label: "first slash paint",
    budgetMs: 200,
    resetBeforeFirst: false,
    clear: async () => {
      firstAttemptClears.push(firstAttemptClears.length);
    },
    measure: async () => 120,
  });

  assert.equal(firstAttempt, 120);
  assert.equal(firstAttemptClears.length, 0);

  await assert.rejects(
    () =>
      retryBudgetedMeasurement({
        label: "slow paint",
        budgetMs: 100,
        clear: async () => {},
        measure: async () => 180,
      }),
    /slow paint took 180ms, 180ms; budget 100ms/,
  );
});

test("runtime QA prints compact output by default and keeps full JSON explicit", () => {
  const pkg = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
  const runner = readFileSync(path.join(workspaceRoot, "scripts", "unclecode-runtime-qa.mjs"), "utf8");

  assert.doesNotMatch(pkg.scripts?.["qa:runtime"] ?? "", /--json/);
  assert.match(runner, /formatCompactReport/);
  assert.match(runner, /buildRuntimeEvidence/);
  assert.match(runner, /buildRuntimeEvidence\(\{[\s\S]*fullTuiSmoke/);
  assert.match(runner, /UncleCode runtime QA/);
  assert.match(runner, /toolFinalGate/);
  assert.match(runner, /--json prints full report/);
  assert.match(runner, /Usage: node scripts\/unclecode-runtime-qa\.mjs \[--json\]/);
});

test("live provider QA prints compact output by default and keeps full JSON explicit", () => {
  const pkg = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
  const runner = readFileSync(path.join(workspaceRoot, "scripts", "unclecode-live-provider-qa.mjs"), "utf8");
  const lib = readFileSync(path.join(workspaceRoot, "scripts", "unclecode-live-provider-qa-lib.mjs"), "utf8");

  assert.doesNotMatch(pkg.scripts?.["qa:live"] ?? "", /--json/);
  assert.doesNotMatch(pkg.scripts?.["qa:live:record"] ?? "", /--json/);
  assert.match(runner, /formatLiveProviderCompactReport/);
  assert.match(lib, /UncleCode live provider QA/);
  assert.match(lib, /markerMatched/);
  assert.match(lib, /--json prints full report/);
  assert.match(runner, /Usage: node scripts\/unclecode-live-provider-qa\.mjs \[--allow-blocked\] \[--json\]/);
  assert.match(runner, /"auth", "status", "--json"/);
});

test("normalization runbook documents machine-readable auth and tool-call evidence", () => {
  const runbook = readFileSync(
    path.join(workspaceRoot, "docs", "runbooks", "unclecode-normalization-runbook.md"),
    "utf8",
  );

  for (const requiredText of [
    "doctor --json",
    "auth status --json",
    "doctorAuth.auth.apiReady",
    "doctorAuth.auth.recovery.reason",
    "doctorAuth.auth.recovery.commands",
    "doctorAuth.auth.recovery.verify",
    "Skipped live provider call: auth-preflight-blocked",
    "auth.apiReady",
    "auth.source",
    "auth.runtime",
    "auth.recovery.reason",
    "recovery.reason",
    "recovery.commands",
    "recovery.verify",
    "toolCallSmoke.markerMatched: true",
    "toolCallSmoke.runId",
    "evidence.providerToolCalls",
    "evidence.tui",
    "evidence.tui.lightTerminalContrast=true",
    "evidence.tui.idleStable=true",
    "evidence.tui.latencyOk=true",
    "evidence.context",
    "protocolPaired=true",
    "finalAnswerGatedByToolResult=true",
    "functionResponseIdMatched=true",
    "functionResponseNameMatched=true",
    "the function name must remain `run_shell`",
    "geminiTool=true",
    "openaiTool=true",
    "anthropicTool=true",
    "toolFinalGate=true",
    "lightContrast=true",
    "duplicateBusy=false",
    "queueDrain=true",
    "resize=true",
    "idleStable=true",
    "latencyOk=true",
    "qa:stability delegates to qa:health",
    "`qa:health` must be bounded",
    "DEFAULT_CHECK_TIMEOUT_MS",
    "SIGTERM",
    "SIGKILL",
    "openai-oauth-codex-runtime-not-api-ready",
    "unclecode auth login --api-key-stdin",
    "Checked against GitHub on 2026-06-28 KST",
    "Hermes memory providers",
    "Hermes multi-agent architecture issue #344",
    "Hermes package restructure issue #14182",
    "Hermes Honcho cold-start issue #34070",
    "Hermes Honcho peer-fragmentation issue #42980",
    "agent-memory-mcp",
    "mcp_agent_mail",
    "https://github.com/NousResearch/hermes-agent/issues/344",
    "https://github.com/NousResearch/hermes-agent/issues/14182",
    "https://github.com/NousResearch/hermes-agent/issues/34070",
    "https://github.com/NousResearch/hermes-agent/issues/42980",
  ]) {
    assert.match(runbook, new RegExp(escapeRegExp(requiredText)));
  }
});

function assertPureLocAtMost(filePath, limit) {
  assert.equal(statSync(filePath).isFile(), true, `${filePath} should exist`);
  const pureLines = readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("//") && !trimmed.startsWith("#");
    });
  assert.ok(
    pureLines.length <= limit,
    `${path.relative(workspaceRoot, filePath)} has ${pureLines.length} pure LOC; limit is ${limit}`,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
