import assert from "node:assert/strict";
import test from "node:test";

import { createInitialWorkShellEngineState } from "../../packages/orchestrator/src/work-shell-engine-state.ts";
import { computeContextMeterFill } from "../../packages/tui/src/work-shell-context-inspector.tsx";

const supportedReasoning = {
  effort: "high",
  source: "mode-default",
  support: {
    status: "supported",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high"],
  },
};

function buildContextPanel(contextSummaryLines, bridgeLines, memoryLines, traceLines) {
  return {
    title: "Context",
    lines: [...contextSummaryLines, ...bridgeLines, ...memoryLines, ...traceLines],
  };
}

function buildBaseOptions() {
  return {
    provider: "openai",
    model: "gpt-5.4",
    mode: "ultrawork",
    authLabel: "oauth-file",
    reasoning: supportedReasoning,
    cwd: "/repo",
    contextSummaryLines: ["Loaded guidance: AGENTS.md"],
  };
}

test("createInitialWorkShellEngineState defaults modelWindow to 200000 when options.modelWindow is omitted", () => {
  const state = createInitialWorkShellEngineState({
    options: buildBaseOptions(),
    contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    buildContextPanel,
  });
  assert.equal(state.modelWindow, 200000);
});

test("createInitialWorkShellEngineState uses options.modelWindow when provided", () => {
  const state = createInitialWorkShellEngineState({
    options: { ...buildBaseOptions(), modelWindow: 128000 },
    contextSummaryLines: ["Loaded guidance: AGENTS.md"],
    buildContextPanel,
  });
  assert.equal(state.modelWindow, 128000);
});

test("computeContextMeterFill computes one cell for 16000 tokens against a 128000 window", () => {
  // 10-cell meter: round(16000 / 128000 * 10) = round(1.25) = 1
  assert.equal(computeContextMeterFill(16000, 128000), 1);
});

test("computeContextMeterFill scales with a larger window and clamps within [0, 10]", () => {
  // round(1600000 / 2000000 * 10) = round(8) = 8
  assert.equal(computeContextMeterFill(1600000, 2000000), 8);
  // Over-budget estimates clamp to a full meter rather than overflowing.
  assert.equal(computeContextMeterFill(5_000_000, 200_000), 10);
  // Zero tokens render an empty meter.
  assert.equal(computeContextMeterFill(0, 200_000), 0);
});
