import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRuntimeEvidence,
  hasRuntimeEvidenceContract,
  summarizeRuntimeEvidence,
} from "../../scripts/runtime-qa/report-evidence.mjs";

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

function runtimeEvidence() {
  return {
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
      idleStable: true,
      latencyOk: true,
    },
    context: {
      contextPanelVisible: true,
      modelBoundPackets: true,
      includedExcludedWarnings: true,
      rawArtifactsHeldBack: true,
    },
  };
}

test("runtime evidence contract requires final answers gated by tool results", () => {
  const evidence = runtimeEvidence();
  const missingFinalGate = {
    ...evidence,
    providerToolCalls: {
      ...evidence.providerToolCalls,
      openai: {
        ...evidence.providerToolCalls.openai,
        finalAnswerGatedByToolResult: false,
      },
    },
  };

  assert.equal(hasRuntimeEvidenceContract(evidence), true);
  assert.equal(hasRuntimeEvidenceContract(missingFinalGate), false);
  assert.equal(
    hasRuntimeEvidenceContract({ ...evidence, tui: { ...evidence.tui, latencyOk: false } }),
    false,
  );
});

test("Gemini 2.x protocol pairing accepts the required function name without an optional call ID", () => {
  const evidence = buildRuntimeEvidence({
    toolCallSmoke: {
      toolRoundTripVerified: true,
      requestDelta: 2,
      firstRequest: { hasTools: true },
      secondRequest: {
        hasFunctionResponse: true,
        functionResponseNameMatched: true,
        functionResponseIdMatched: false,
        finalAnswerGatedByToolResult: true,
      },
      finalAnswerGatedByToolResult: true,
    },
  });

  assert.equal(evidence.providerToolCalls.gemini.protocolPaired, true);
});

test("runtime evidence recognizes the shipped compact Context Desk inventory", () => {
  const evidence = buildRuntimeEvidence({
    realUseTuiStress: {
      contextPacketTransparency: true,
      contextPaneExcerpt: [
        "Context Desk · what reaches the next answer",
        "Sources · 10 sent · 0 held · ~201t / 200k",
        "Ready · Context packet looks ready for the next answer.",
      ].join("\n"),
    },
  });

  assert.deepEqual(evidence.context, {
    contextPanelVisible: true,
    modelBoundPackets: true,
    includedExcludedWarnings: true,
    rawArtifactsHeldBack: true,
  });
});

test("runtime evidence summary fails closed when provider evidence is missing", () => {
  assert.equal(summarizeRuntimeEvidence({ evidence: { providerToolCalls: {} } }).toolFinalGate, false);
  assert.equal(summarizeRuntimeEvidence({ evidence: { providerToolCalls: { gemini: providerEvidence() } } }).toolFinalGate, false);
  assert.equal(summarizeRuntimeEvidence({ evidence: runtimeEvidence() }).toolFinalGate, true);
});
