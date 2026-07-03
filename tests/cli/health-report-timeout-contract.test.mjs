import assert from "node:assert/strict";
import test from "node:test";

import {
  hasLiveProviderReportContract,
  hasRuntimeReportContract,
} from "../../scripts/health-qa/summary.mjs";

const startedAtMs = Date.parse("2026-06-27T10:00:00.000Z");
const finishedAt = "2026-06-27T10:00:00.001Z";

test("runtime report contract rejects timed-out QA command even with fresh passing evidence", () => {
  const result = { code: 0, timedOut: true, stdout: "", stderr: "", startedAtMs };
  const report = {
    status: "pass",
    finishedAt,
    evidence: {
      providerToolCalls: {
        gemini: providerEvidence(),
        openai: providerEvidence(),
        anthropic: providerEvidence(),
      },
      tui: {
        lightTerminalContrast: true,
        contextPanelContrast: {
          lightTerminalContrast: true,
          foregroundColors: ["15;23;42"],
        },
        spinnerVisible: true,
        hangulResidual: false,
        duplicateBusy: false,
        queueDrain: true,
        resize: true,
      },
      context: {
        contextPanelVisible: true,
        modelBoundPackets: true,
        includedExcludedWarnings: true,
        rawArtifactsHeldBack: true,
      },
    },
  };

  assert.equal(hasRuntimeReportContract(result, report), false);
});

test("live report contract rejects timed-out QA command even with marker-backed pass", () => {
  const runId = "2026-06-27T10_00_00_001Z";
  const expectedText = `UNCLECODE_LIVE_TOOL_QA_OK_${runId}`;
  const result = { code: 0, timedOut: true, stdout: "", stderr: "", startedAtMs };
  const report = {
    provider: "openai",
    status: "pass",
    finishedAt,
    textSmoke: { status: "pass", work: { code: 0, timedOut: false } },
    toolCallSmoke: {
      status: "pass",
      runId,
      expectedText,
      markerPath: `/repo/.unclecode/qa/live-tool-call-marker-${runId}.txt`,
      markerMatched: true,
      work: { code: 0, timedOut: false },
    },
  };

  assert.equal(hasLiveProviderReportContract(result, report), false);
});

function providerEvidence() {
  return {
    toolRoundTrip: true,
    requestDelta: 2,
    firstRequestHadTools: true,
    toolResultObserved: true,
    protocolPaired: true,
    finalAnswerGatedByToolResult: true,
  };
}
