import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

import {
  buildBenchmarkSummary,
  buildBenchmarkEnvironment,
  buildWindowsTreeKillArgs,
  evaluateBenchmarkChecks,
  runCommand,
  sanitizeBenchmarkOutput,
  validateBenchmarkSuite,
} from "../../scripts/competitive-benchmark.mjs";
import { buildProviderConformanceReport } from "../../scripts/provider-conformance.mjs";

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
