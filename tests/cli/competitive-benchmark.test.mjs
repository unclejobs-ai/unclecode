import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

import {
  buildBenchmarkSummary,
  buildBenchmarkEnvironment,
  buildWindowsTreeKillArgs,
  buildSystemProfile,
  benchmarkProcessResult,
  driveUncleCodeBenchmarkApprovals,
  evaluateBenchmarkChecks,
  formatBenchmarkFailureSummary,
  runCommand,
  sanitizeBenchmarkOutput,
  stopBenchmarkRuntimeOwner,
  validateBenchmarkSuite,
} from "../../scripts/competitive-benchmark.mjs";
import { buildProviderConformanceReport } from "../../scripts/provider-conformance.mjs";
import { createToolRuntime, resolveModeExecutionPolicyProfile } from "@unclecode/orchestrator";

test("competitive benchmark checks score observable workspace results", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-benchmark-checks-"));
  try {
    writeFileSync(path.join(root, "result.txt"), "LOCAL_RULE_OK\n");
    writeFileSync(path.join(root, "source.js"), "export const add = (a, b) => a + b;\n");
    const checks = await evaluateBenchmarkChecks(root, [
      { kind: "fileEquals", path: "result.txt", value: "LOCAL_RULE_OK\n" },
      { kind: "fileMatches", path: "source.js", pattern: "\\badd\\b" },
      { kind: "fileNotMatches", path: "source.js", pattern: "\\bsum\\b" },
      { kind: "command", command: process.execPath, args: ["--version"] },
    ]);

    assert.equal(checks.every((check) => check.passed), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("competitive benchmark suite rejects duplicate ids and escaping fixture paths", () => {
  assert.throws(
    () =>
      validateBenchmarkSuite({
        version: 1,
        tasks: [
          { id: "same", prompt: "one", files: { "../escape": "x" }, checks: [] },
          { id: "same", prompt: "two", files: {}, checks: [] },
        ],
      }),
    /fixture path|duplicate task id/i,
  );
});

test("benchmark summary distinguishes pass fail blocked and unavailable", () => {
  const summary = buildBenchmarkSummary([
    { status: "pass" },
    { status: "fail" },
    { status: "blocked" },
    { status: "unavailable" },
  ]);
  assert.deepEqual(summary, { total: 4, pass: 1, fail: 1, blocked: 1, unavailable: 1 });
});

test("competitive benchmark fails closed for 0/3 and a missing report with exact task summaries", () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-benchmark-exit-"));
  try {
    const missing = path.join(root, "missing.json");
    const report = {
      summary: { total: 3, pass: 0, fail: 1, blocked: 1, unavailable: 1 },
      results: [
        { system: "unclecode", taskId: "instruction", status: "fail", checks: [{ passed: false, detail: "file missing" }] },
        { system: "unclecode", taskId: "rename", status: "blocked", checks: [] },
        { system: "unclecode", taskId: "unicode", status: "unavailable", checks: [] },
      ],
    };

    assert.deepEqual(benchmarkProcessResult(report, missing), {
      exitCode: 1,
      failureSummary: [
        "report missing: " + missing,
        "unclecode/instruction: fail (file missing)",
        "unclecode/rename: blocked",
        "unclecode/unicode: unavailable",
        "runtime owner cleanup: cleanup evidence missing or incomplete",
      ],
    });
    assert.equal(formatBenchmarkFailureSummary(report).includes("unclecode/instruction: fail (file missing)"), true);
    assert.equal(existsSync(missing), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("competitive benchmark exits zero only when every required case passed and the report exists", () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-benchmark-success-"));
  try {
    const reportPath = path.join(root, "report.json");
    writeFileSync(reportPath, "{}\n");
    const report = {
      summary: { total: 3, pass: 3, fail: 0, blocked: 0, unavailable: 0 },
      results: [
        { system: "unclecode", taskId: "instruction", status: "pass", checks: [] },
        { system: "unclecode", taskId: "rename", status: "pass", checks: [] },
        { system: "unclecode", taskId: "unicode", status: "pass", checks: [] },
      ],
      runtimeOwnerCleanup: {
        status: "pass",
        ownerFound: true,
        leaseRemoved: true,
        listenerClosed: true,
      },
    };
    assert.deepEqual(benchmarkProcessResult(report, reportPath), {
      exitCode: 0,
      failureSummary: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("benchmark approval driver ignores sessions outside the exact temporary workspace", async () => {
  const approvals = [];
  const result = await driveUncleCodeBenchmarkApprovals({
    workspace: "/tmp/benchmark/workspace",
    approvalPolicy: { tools: ["write_file"], shellCommands: [] },
    timeoutMs: 25,
    sessionDiscoveryTimeoutMs: 0,
    client: {
      async listRuntimeSessions() {
        return [{ sessionId: "outside", projectPath: "/tmp/not-the-benchmark", revision: 7 }];
      },
      async readEngineState() {
        throw new Error("outside session must not be inspected");
      },
      async control(input) {
        approvals.push(input);
        return { ok: true, revision: 8 };
      },
      async releaseRuntimeSession() {
        throw new Error("outside session must not be released");
      },
    },
    sleep: async () => {},
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(approvals, []);
});

test("benchmark approval driver observes an owner session that reaches approval after the CLI exits", async () => {
  const approvals = [];
  let reads = 0;
  const result = await driveUncleCodeBenchmarkApprovals({
    workspace: "/tmp/benchmark/workspace",
    approvalPolicy: { tools: ["write_file"], shellCommands: [] },
    timeoutMs: 100,
    client: {
      async listRuntimeSessions() {
        return [{ sessionId: "inside", projectPath: "/tmp/benchmark/workspace", revision: 7 }];
      },
      async readEngineState() {
        reads += 1;
        if (reads === 1) {
          return { ok: true, revision: 7, state: { isBusy: true, turnLifecycle: { state: "running" }, agentConsole: {} } };
        }
        if (reads === 2) {
          return {
            ok: true,
            revision: 8,
            state: {
              isBusy: true,
              turnLifecycle: { state: "running" },
              agentConsole: {
                pendingDecision: {
                  kind: "security-approval",
                  id: "policy-confirmation:late-write",
                  title: "Security approval · write_file",
                  questions: [{ question: "Allow write_file?" }],
                },
              },
            },
          };
        }
        return { ok: true, revision: 9, state: { isBusy: false, turnLifecycle: { state: "completed" }, agentConsole: {} } };
      },
      async control(input) {
        approvals.push(input);
        return { ok: true, revision: 9 };
      },
      async releaseRuntimeSession() { return { ok: true, released: true }; },
    },
    sleep: async () => {},
  });

  assert.equal(result.status, "completed");
  assert.equal(result.approvals, 1);
  assert.equal(approvals[0].payload.decisionId, "policy-confirmation:late-write");
});

test("benchmark suite accepts only explicit fixture-scoped evidence hashes", () => {
  const makeSuite = (shellCommands) => ({
    version: 1,
    tasks: [{
      id: "safe-shell-policy",
      prompt: "run the fixture test",
      files: { "test.mjs": "", "source.mjs": "" },
      checks: [{ kind: "command", command: "node", args: ["test.mjs"] }],
      approvalPolicy: { tools: ["write_file"], shellCommands },
    }],
  });

  assert.doesNotThrow(() => validateBenchmarkSuite(makeSuite([
    "node test.mjs && sha256sum source.mjs test.mjs",
  ])));
  assert.throws(
    () => validateBenchmarkSuite(makeSuite(["node test.mjs && sha256sum ../outside"])),
    /fixture-scoped hashes/,
  );
  assert.throws(
    () => validateBenchmarkSuite(makeSuite(["node test.mjs && curl https://example.com"])),
    /fixture-scoped hashes/,
  );
  assert.throws(
    () => validateBenchmarkSuite(makeSuite(["set -eu\nnode test.mjs\nsha256sum source.mjs"])),
    /fixture-scoped hashes/,
  );
});

test("benchmark approval driver grants only an allowlisted one-shot policy decision and releases terminal state", async () => {
  const approvals = [];
  const releases = [];
  let reads = 0;
  const pending = {
    kind: "security-approval",
    id: "policy-confirmation:benchmark",
    title: "Security approval · write_file",
    questions: [{
      id: "policy-confirmation",
      question: "Allow write_file? All write_file actions in this workspace session.",
      options: [{ label: "Approve" }, { label: "Reject" }],
    }],
  };
  const result = await driveUncleCodeBenchmarkApprovals({
    workspace: "/tmp/benchmark/workspace",
    approvalPolicy: { tools: ["write_file"], shellCommands: [] },
    timeoutMs: 100,
    client: {
      async listRuntimeSessions() {
        return [{ sessionId: "inside", projectPath: "/tmp/benchmark/workspace", revision: 7 }];
      },
      async readEngineState() {
        reads += 1;
        return reads === 1
          ? { ok: true, revision: 7, state: { isBusy: true, turnLifecycle: { state: "running" }, agentConsole: { pendingDecision: pending } } }
          : { ok: true, revision: 8, state: { isBusy: false, turnLifecycle: { state: "completed" }, agentConsole: {} } };
      },
      async control(input) {
        approvals.push(input);
        return { ok: true, revision: 8 };
      },
      async releaseRuntimeSession(sessionId) {
        releases.push(sessionId);
        return { ok: true, released: true };
      },
    },
    sleep: async () => {},
  });

  assert.deepEqual(result, { status: "completed", approvals: 1, sessionId: "inside" });
  assert.deepEqual(approvals, [{
    sessionId: "inside",
    action: "approve",
    expectedRevision: 7,
    idempotencyKey: "benchmark-approval-policy-confirmation:benchmark",
    payload: { decision: "approve_once", decisionId: "policy-confirmation:benchmark" },
  }]);
  assert.deepEqual(releases, ["inside"]);
});

test("benchmark approval driver rejects a non-allowlisted shell command", async () => {
  const approvals = [];
  const result = await driveUncleCodeBenchmarkApprovals({
    workspace: "/tmp/benchmark/workspace",
    approvalPolicy: { tools: ["write_file"], shellCommands: ["node test.mjs"] },
    timeoutMs: 100,
    client: {
      async listRuntimeSessions() {
        return [{ sessionId: "inside", projectPath: "/tmp/benchmark/workspace", revision: 9 }];
      },
      async readEngineState() {
        return {
          ok: true,
          revision: 9,
          state: {
            isBusy: true,
            turnLifecycle: { state: "running" },
            agentConsole: {
              pendingDecision: {
                kind: "security-approval",
                id: "policy-confirmation:unsafe",
                title: "Security approval · external shell client",
                questions: [{
                  question: "Allow external shell client? Exact command: \"curl https://example.com\".",
                  options: [{ label: "Approve" }, { label: "Reject" }],
                }],
              },
            },
          },
        };
      },
      async control(input) { approvals.push(input); return { ok: true, revision: 10 }; },
      async releaseRuntimeSession() { return { ok: true, released: true }; },
    },
    sleep: async () => {},
  });

  assert.equal(result.status, "blocked");
  assert.deepEqual(approvals, []);
});

test("ordinary write_file execution still requires a real product approval", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-production-policy-"));
  let prompts = 0;
  try {
    const runtime = createToolRuntime({
      runtimeMode: "local",
      policyProfile: resolveModeExecutionPolicyProfile({ mode: "default", envShellOptIn: true }),
      interactionBridge: {
        async ask() {
          prompts += 1;
          return { status: "cancelled" };
        },
      },
    });
    const result = await runtime.executor.execute({
      toolName: "write_file",
      input: { path: "result.txt", content: "must not be written\n" },
      cwd: root,
    });
    assert.equal(prompts, 1);
    assert.equal(result.isError, true);
    assert.equal(existsSync(path.join(root, "result.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("benchmark policy approval cannot write outside the temporary workspace", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-benchmark-boundary-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside.txt");
  let prompts = 0;
  try {
    const runtime = createToolRuntime({
      runtimeMode: "local",
      policyProfile: resolveModeExecutionPolicyProfile({ mode: "default", envShellOptIn: true }),
      interactionBridge: {
        async ask() {
          prompts += 1;
          return { status: "submitted", answers: { "policy-confirmation": "approve_once" } };
        },
      },
    });
    const result = await runtime.executor.execute({
      toolName: "write_file",
      input: { path: outside, content: "escape\n" },
      cwd: workspace,
    });
    assert.equal(prompts, 1);
    assert.equal(result.isError, true);
    assert.equal(existsSync(outside), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("benchmark owner cleanup is complete when the isolated home has no lease", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-benchmark-owner-clean-"));
  try {
    assert.deepEqual(await stopBenchmarkRuntimeOwner(root), {
      status: "pass",
      ownerFound: false,
      leaseRemoved: true,
      listenerClosed: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("list_files treats an empty optional root path as the workspace root", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "unclecode-list-root-"));
  try {
    writeFileSync(path.join(root, "anchor.txt"), "visible\n");
    const runtime = createToolRuntime({
      runtimeMode: "local",
      policyProfile: resolveModeExecutionPolicyProfile({ mode: "default", envShellOptIn: false }),
    });
    const result = await runtime.executor.execute({
      toolName: "list_files",
      input: { path: "" },
      cwd: root,
    });
    assert.equal(result.isError ?? false, false);
    assert.match(result.content, /anchor\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider conformance report fails closed on an incomplete protocol", () => {
  const passing = {
    toolRoundTripVerified: true,
    requestDelta: 2,
    firstRequest: { hasTools: true },
    secondRequest: {
      hasToolResult: true,
      toolCallIdMatched: true,
      finalAnswerGatedByToolResult: true,
    },
    finalAnswerGatedByToolResult: true,
  };
  const report = buildProviderConformanceReport({
    gemini: {
      ...passing,
      secondRequest: {
        hasFunctionResponse: true,
        functionResponseNameMatched: true,
        finalAnswerGatedByToolResult: true,
      },
    },
    openai: passing,
    anthropic: {
      ...passing,
      secondRequest: {
        hasToolResult: true,
        toolUseIdMatched: false,
        finalAnswerGatedByToolResult: true,
      },
    },
  });
  assert.equal(report.engine, "pi");

  assert.equal(report.status, "fail");
  assert.equal(report.providers.gemini.status, "pass");
  assert.equal(report.providers.openai.status, "pass");
  assert.equal(report.providers.anthropic.status, "fail");
});

test("Windows benchmark termination targets the entire descendant tree", () => {
  assert.deepEqual(buildWindowsTreeKillArgs(9876), ["/PID", "9876", "/T", "/F"]);
});

test("benchmark environment excludes unrelated agent and cloud credentials", () => {
  assert.deepEqual(
    buildBenchmarkEnvironment({
      PATH: "/bin",
      HOME: "/home/benchmark",
      OPENAI_API_KEY: "openai-test-key",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      OMP_PRIVATE_TOKEN: "omp-secret",
    }),
    {
      PATH: "/bin",
      HOME: "/home/benchmark",
      OPENAI_API_KEY: "openai-test-key",
    },
  );
});

test("UncleCode benchmark profile isolates owner state while preserving the explicit Codex auth root", () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const previousHome = process.env.HOME;
  delete process.env.CODEX_HOME;
  process.env.HOME = "/auth/user";
  try {
    const profile = buildSystemProfile(
      "unclecode",
      "/tmp/benchmark/workspace",
      { prompt: "perform fixture task" },
      "gpt-5.6-sol",
      { isolatedHome: "/tmp/benchmark/home", sessionStoreRoot: "/tmp/benchmark/state" },
    );
    assert.equal(profile.env.HOME, "/tmp/benchmark/home");
    assert.equal(profile.env.USERPROFILE, "/tmp/benchmark/home");
    assert.equal(profile.env.UNCLECODE_SESSION_STORE_ROOT, "/tmp/benchmark/state");
    assert.equal(profile.env.CODEX_HOME, "/auth/user/.codex");
    assert.equal(profile.env.PI_CODING_AGENT_DIR, "/auth/user/.omp/agent");
    assert.equal(
      profile.env.UNCLECODE_OPENAI_CREDENTIALS_PATH,
      "/auth/user/.codex/auth.json",
    );
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("benchmark report excerpts redact inherited and recognizable credentials", () => {
  const secret = "openai-secret-value";
  const excerpt = sanitizeBenchmarkOutput(
    `OPENAI_API_KEY=${secret}\nBearer eyJheader.payload.signature\nAWS=AKIAABCDEFGHIJKLMNOP`,
    { OPENAI_API_KEY: secret },
  );
  assert.doesNotMatch(excerpt, /openai-secret-value|eyJheader|AKIAABCDEFGHIJKLMNOP/);
  assert.match(excerpt, /OPENAI_API_KEY=\[REDACTED\]/);
});

test("timed-out benchmark processes are force-killed after the grace period", {
  skip: process.platform === "win32",
}, async () => {
  let processGroupId;
  try {
    // The child reports its pid on stdout, so the timeout has to outlast Node's
    // own startup. At 50ms it did not: booting the interpreter costs roughly
    // 25-60ms, so under load the child was killed before it printed anything,
    // stdout came back empty, and parseInt("") failed this test about one run
    // in six. The scenario under test is unchanged — the child still ignores
    // SIGTERM and must be force-killed — it just gets room to announce itself.
    const result = await runCommand(
      process.execPath,
      [
        "-e",
        "process.stdout.write(`${process.pid}\\n`); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ],
      { cwd: tmpdir(), timeoutMs: 750 },
    );
    processGroupId = Number.parseInt(result.stdout.trim(), 10);
    assert.equal(result.timedOut, true);
    assert.equal(
      Number.isInteger(processGroupId),
      true,
      `expected the child to report its pid before the timeout, received stdout ${JSON.stringify(result.stdout)}`,
    );

    await sleep(1_200);
    assert.throws(
      () => process.kill(-processGroupId, 0),
      (error) => error?.code === "ESRCH",
    );
  } finally {
    if (Number.isInteger(processGroupId)) {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {}
    }
  }
});
