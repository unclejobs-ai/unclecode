import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("runtime evidence summary fails closed when provider evidence is missing", () => {
  assert.equal(summarizeRuntimeEvidence({ evidence: { providerToolCalls: {} } }).toolFinalGate, false);
  assert.equal(summarizeRuntimeEvidence({ evidence: { providerToolCalls: { gemini: providerEvidence() } } }).toolFinalGate, false);
  assert.equal(summarizeRuntimeEvidence({ evidence: runtimeEvidence() }).toolFinalGate, true);
});
