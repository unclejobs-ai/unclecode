import assert from "node:assert/strict";
import test from "node:test";

import {
  hasLiveProviderReportContract,
  isNativeAbiFailure,
  recoveryHintForFailure,
  summarizeLiveReport,
} from "../../scripts/health-qa/summary.mjs";

test("summarizeLiveReport ignores stale live reports", () => {
  const result = {
    code: 1,
    stdout: "live command failed",
    stderr: "",
    startedAtMs: Date.parse("2026-06-27T10:00:00.000Z"),
  };
  const report = {
    status: "pass",
    finishedAt: "2026-06-27T09:59:59.999Z",
    textSmoke: { status: "pass" },
    toolCallSmoke: { status: "pass" },
  };

  assert.equal(summarizeLiveReport(result, report), "stale live report ignored");
});

test("summarizeLiveReport keeps blocked auth recovery visible", () => {
  const result = {
    code: 0,
    stdout: "",
    stderr: "",
    startedAtMs: Date.parse("2026-06-27T10:00:00.000Z"),
  };
  const report = {
    provider: "openai",
    status: "blocked",
    finishedAt: "2026-06-27T10:00:00.001Z",
    authStatus: {
      auth: {
        apiReady: false,
      },
    },
    doctorAuth: {
      auth: {
        apiReady: false,
      },
    },
    textSmoke: { status: "blocked" },
    toolCallSmoke: {
      status: "skipped",
      reason: "text-smoke-blocked",
      runId: "2026-06-27T10_00_00_001Z",
      expectedText: "UNCLECODE_LIVE_TOOL_QA_OK_2026-06-27T10_00_00_001Z",
      markerPath: "/repo/.unclecode/qa/live-tool-call-marker-2026-06-27T10_00_00_001Z.txt",
      markerMatched: false,
    },
    credentialRecovery: {
      reason: "openai-oauth-codex-runtime-not-api-ready",
      apiReady: false,
      verify: "npm run qa:live",
    },
  };

  assert.equal(
    summarizeLiveReport(result, report),
    "blocked; text=blocked; tool=skipped; markerMatched=false; openai-oauth-codex-runtime-not-api-ready; liveRecovery=refresh credentials then npm run qa:live",
  );
  assert.equal(hasLiveProviderReportContract(result, report), true);
  assert.equal(
    hasLiveProviderReportContract(result, {
      ...report,
      toolCallSmoke: { status: "failed", markerMatched: false },
    }),
    false,
  );
  assert.equal(
    hasLiveProviderReportContract(result, {
      ...report,
      toolCallSmoke: { status: "skipped", reason: "text-smoke-blocked", markerMatched: false },
    }),
    false,
  );
});

test("hasLiveProviderReportContract requires marker proof for passing live tool QA", () => {
  const result = {
    code: 0,
    stdout: "",
    stderr: "",
    startedAtMs: Date.parse("2026-06-27T10:00:00.000Z"),
  };
  const passingReport = {
    provider: "openai",
    status: "pass",
    finishedAt: "2026-06-27T10:00:00.001Z",
    textSmoke: { status: "pass", work: { code: 0 } },
    toolCallSmoke: {
      status: "pass",
      runId: "2026-06-27T10_00_00_001Z",
      expectedText: "UNCLECODE_LIVE_TOOL_QA_OK_2026-06-27T10_00_00_001Z",
      markerPath: "/repo/.unclecode/qa/live-tool-call-marker-2026-06-27T10_00_00_001Z.txt",
      markerMatched: true,
      work: { code: 0 },
    },
  };
  const missingMarkerReport = {
    ...passingReport,
    toolCallSmoke: { status: "pass", markerMatched: false },
  };
  const missingRunProofReport = {
    ...passingReport,
    toolCallSmoke: { status: "pass", markerMatched: true, work: { code: 0 } },
  };
  const malformedExpectedTextReport = {
    ...passingReport,
    toolCallSmoke: {
      ...passingReport.toolCallSmoke,
      expectedText: "BAD_PREFIX_2026-06-27T10_00_00_001Z",
    },
  };

  assert.equal(hasLiveProviderReportContract(result, passingReport), true);
  assert.equal(hasLiveProviderReportContract(result, missingMarkerReport), false);
  assert.equal(hasLiveProviderReportContract(result, missingRunProofReport), false);
  assert.equal(hasLiveProviderReportContract(result, malformedExpectedTextReport), false);
});

test("hasLiveProviderReportContract accepts rejected API-key credentials as live blocked", () => {
  const result = {
    code: 0,
    stdout: "",
    stderr: "",
    startedAtMs: Date.parse("2026-06-27T10:00:00.000Z"),
  };
  const report = {
    provider: "openai",
    status: "blocked",
    finishedAt: "2026-06-27T10:00:00.001Z",
    authStatus: {
      auth: {
        apiReady: true,
      },
    },
    textSmoke: { status: "blocked" },
    toolCallSmoke: {
      status: "skipped",
      reason: "text-smoke-blocked",
      runId: "2026-06-27T10_00_00_001Z",
      expectedText: "UNCLECODE_LIVE_TOOL_QA_OK_2026-06-27T10_00_00_001Z",
      markerPath: "/repo/.unclecode/qa/live-tool-call-marker-2026-06-27T10_00_00_001Z.txt",
      markerMatched: false,
    },
    credentialRecovery: {
      reason: "openai-auth-rejected",
      apiReady: false,
      verify: "npm run qa:live",
    },
  };

  assert.equal(hasLiveProviderReportContract(result, report), true);
  assert.equal(summarizeLiveReport(result, report), "blocked; text=blocked; tool=skipped; markerMatched=false; openai-auth-rejected; liveRecovery=refresh credentials then npm run qa:live");
});

test("recoveryHintForFailure gives targeted native ABI and live auth fixes", () => {
  const nativeAbiOutput = "ERR_DLOPEN_FAILED: better_sqlite3.node was compiled against NODE_MODULE_VERSION 137";
  assert.equal(isNativeAbiFailure(nativeAbiOutput), true);
  assert.equal(
    recoveryHintForFailure(
      { label: "work tests" },
      nativeAbiOutput,
    ),
    "npm rebuild better-sqlite3 && npm run qa:health --silent",
  );
  assert.equal(
    recoveryHintForFailure({ label: "live provider QA" }, "api ready: no"),
    "refresh OpenAI API-capable auth, then npm run qa:live --silent",
  );
});
