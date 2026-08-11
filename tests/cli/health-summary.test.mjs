import assert from "node:assert/strict";
import test from "node:test";

import {
  hasDoctorJsonAuthContract,
  hasRuntimeReportContract,
  summarizeDoctorJson,
  summarizeRuntimeReport,
} from "../../scripts/health-qa/summary.mjs";
import { hasRuntimeEvidenceContract } from "../../scripts/runtime-qa/report-evidence.mjs";

test("summarizeDoctorJson keeps structured auth readiness visible", () => {
  const result = {
    code: 0,
    stdout: JSON.stringify({
      auth: {
        provider: "openai",
        source: "oauth-file",
        type: "oauth",
        runtime: "codex",
        apiReady: false,
        recovery: {
          reason: "openai-oauth-codex-runtime-not-api-ready",
          commands: [
            "OPENAI_OAUTH_CLIENT_ID=<client-id> unclecode auth login --browser",
            "unclecode auth login --api-key-stdin",
          ],
          verify: "npm run qa:live",
        },
      },
      verdicts: {
        auth: "WARN",
        mcpHost: "PASS",
        runtime: "PASS",
      },
    }),
    stderr: "",
  };

  assert.equal(
    summarizeDoctorJson(result),
    "runtime=PASS; mcp=PASS; auth=WARN/openai/oauth-file/oauth/codex; apiReady=false",
  );
  assert.equal(hasDoctorJsonAuthContract(result), true);
  assert.equal(
    hasDoctorJsonAuthContract({
      code: 0,
      stdout: JSON.stringify({ auth: { provider: "openai", source: "oauth-file", type: "oauth", runtime: "codex" } }),
      stderr: "",
    }),
    false,
  );
  assert.equal(
    hasDoctorJsonAuthContract({
      code: 0,
      stdout: JSON.stringify({
        auth: {
          provider: "openai",
          source: "oauth-file",
          type: "oauth",
          runtime: "codex",
          apiReady: false,
        },
      }),
      stderr: "",
    }),
    false,
  );
});

test("doctor json contract accepts API-key auth with no OAuth runtime", () => {
  const result = {
    code: 0,
    stdout: JSON.stringify({
      auth: {
        provider: "openai",
        source: "api-key-env",
        type: "api-key",
        runtime: null,
        apiReady: true,
      },
      verdicts: {
        auth: "PASS",
        mcpHost: "PASS",
        runtime: "PASS",
      },
    }),
    stderr: "",
  };

  assert.equal(
    summarizeDoctorJson(result),
    "runtime=PASS; mcp=PASS; auth=PASS/openai/api-key-env/api-key/none; apiReady=true",
  );
  assert.equal(hasDoctorJsonAuthContract(result), true);
  assert.equal(
    hasDoctorJsonAuthContract({
      code: 0,
      stdout: JSON.stringify({
        auth: {
          provider: "openai",
          source: "api-key-env",
          type: "api-key",
          apiReady: true,
        },
      }),
      stderr: "",
    }),
    false,
  );
});

test("summarizeRuntimeReport ignores stale runtime reports", () => {
  const result = {
    code: 1,
    stdout: "runtime command failed",
    stderr: "",
    startedAtMs: Date.parse("2026-06-27T10:00:00.000Z"),
  };
  const report = {
    status: "pass",
    finishedAt: "2026-06-27T09:59:59.999Z",
    toolCallSmoke: { toolRoundTripVerified: true },
  };

  assert.equal(summarizeRuntimeReport(result, report), "stale runtime report ignored");
});

test("summarizeRuntimeReport includes fresh tool-call evidence", () => {
  const result = {
    code: 0,
    stdout: "",
    stderr: "",
    startedAtMs: Date.parse("2026-06-27T10:00:00.000Z"),
  };
  const report = {
    status: "pass",
    finishedAt: "2026-06-27T10:00:00.001Z",
    toolCallSmoke: {
      toolRoundTripVerified: true, finalAnswerGatedByToolResult: true,
      requestDelta: 2,
      firstRequest: { hasTools: true },
      secondRequest: {
        hasFunctionResponse: true,
        functionResponseIdMatched: true,
        functionResponseNameMatched: true, finalAnswerGatedByToolResult: true,
      },
    },
    openAIToolCallSmoke: {
      toolRoundTripVerified: true, finalAnswerGatedByToolResult: true,
      requestDelta: 2,
      firstRequest: { hasTools: true },
      secondRequest: { hasToolResult: true, toolCallIdMatched: true, finalAnswerGatedByToolResult: true },
    },
    anthropicToolCallSmoke: {
      toolRoundTripVerified: true, finalAnswerGatedByToolResult: true,
      requestDelta: 2,
      firstRequest: { hasTools: true },
      secondRequest: { hasToolResult: true, toolUseIdMatched: true, finalAnswerGatedByToolResult: true },
    },
    koreanBusyTuiSmoke: {
      busySpinnerVisible: true,
      hangulDuplicateRegression: false,
      duplicateBusyActivityRegression: false,
    },
    fullTuiSmoke: {
      lightTerminalContrast: true,
    },
    contextContrastTuiSmoke: {
      contextLightContrast: true,
      foregroundColors: ["15;23;42"],
    },
    realUseTuiStress: {
      queueDrainVerified: true,
      resizeVerified: true,
      duplicateBusyActivityRegression: false,
      idleStableVerified: true,
      latencyWithinBudget: true,
      contextPacketTransparency: true,
      contextPaneExcerpt: "Sources\n1 groups · 10 in · 0 held\nWarnings · none",
    },
    slashLatencyTuiSmoke: {
      latencyWithinBudget: true,
    },
  };

  assert.equal(
    summarizeRuntimeReport(result, report),
    "pass; geminiTool=true; openaiTool=true; anthropicTool=true; toolFinalGate=true; lightContrast=true; spinner=true; hangulResidual=false; duplicateBusy=false; queueDrain=true; resize=true; idleStable=true; latencyOk=true",
  );
  assert.equal(hasRuntimeReportContract(result, report), true);
  assert.equal(
    hasRuntimeReportContract(result, {
      ...report,
      openAIToolCallSmoke: { toolRoundTripVerified: false, requestDelta: 2 },
    }),
    false,
  );
});

test("summarizeRuntimeReport accepts compact runtime evidence blocks", () => {
  const result = {
    code: 0,
    stdout: "",
    stderr: "",
    startedAtMs: Date.parse("2026-06-27T10:00:00.000Z"),
  };
  const report = {
    status: "pass",
    finishedAt: "2026-06-27T10:00:00.001Z",
    evidence: {
      providerToolCalls: {
        gemini: {
          toolRoundTrip: true,
          requestDelta: 2,
          firstRequestHadTools: true,
          toolResultObserved: true,
          protocolPaired: true, finalAnswerGatedByToolResult: true,
        },
        openai: {
          toolRoundTrip: true,
          requestDelta: 2,
          firstRequestHadTools: true,
          toolResultObserved: true,
          protocolPaired: true, finalAnswerGatedByToolResult: true,
        },
        anthropic: {
          toolRoundTrip: true,
          requestDelta: 2,
          firstRequestHadTools: true,
          toolResultObserved: true,
          protocolPaired: true, finalAnswerGatedByToolResult: true,
        },
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
        idleStable: true,
        latencyOk: true,
      },
      context: {
        contextPanelVisible: true,
        modelBoundPackets: true,
        includedExcludedWarnings: true,
        rawArtifactsHeldBack: true,
      },
    },
  };

  assert.equal(
    summarizeRuntimeReport(result, report),
    "pass; geminiTool=true; openaiTool=true; anthropicTool=true; toolFinalGate=true; lightContrast=true; spinner=true; hangulResidual=false; duplicateBusy=false; queueDrain=true; resize=true; idleStable=true; latencyOk=true",
  );
  assert.equal(hasRuntimeEvidenceContract(report.evidence), true);
  assert.equal(hasRuntimeReportContract(result, report), true);
  assert.equal(
    hasRuntimeReportContract(result, {
      ...report,
      evidence: {
        ...report.evidence,
        tui: {
          ...report.evidence.tui,
          lightTerminalContrast: false,
        },
      },
    }),
    false,
  );
  assert.equal(
    hasRuntimeReportContract(result, {
      ...report,
      evidence: {
        ...report.evidence,
        providerToolCalls: {
          ...report.evidence.providerToolCalls,
          openai: {
            toolRoundTrip: true,
            requestDelta: 2,
            firstRequestHadTools: true,
            toolResultObserved: true,
            protocolPaired: false,
          },
        },
      },
    }),
    false,
  );
});
