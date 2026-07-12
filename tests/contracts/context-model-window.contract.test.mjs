import assert from "node:assert/strict";
import test from "node:test";

import { createInitialWorkShellEngineState } from "../../packages/orchestrator/src/work-shell-engine-state.ts";
import {
  computeContextMeterFill,
  computeContextOverlaySectionMaxRows,
} from "../../packages/tui/src/work-shell-context-inspector.tsx";

const supportedReasoning = {
  effort: "high",
  source: "mode-default",
  support: {
    status: "supported",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high"],
  },
};

function buildContextPanel(
  contextSummaryLines,
  bridgeLines,
  memoryLines,
  traceLines,
) {
  return {
    title: "Context",
    lines: [
      ...contextSummaryLines,
      ...bridgeLines,
      ...memoryLines,
      ...traceLines,
    ],
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

test("computeContextOverlaySectionMaxRows scales with terminalRows", () => {
  // round(24 * 0.4) = round(9.6) = 10 ; round(24 * 0.25) = round(6) = 6
  assert.deepEqual(computeContextOverlaySectionMaxRows({ terminalRows: 24 }), {
    included: 10,
    held: 6,
  });
});

test("computeContextOverlaySectionMaxRows clamps to the maximum when terminalRows is large", () => {
  // round(50 * 0.4) = 20 (capped at 20) ; round(50 * 0.25) = round(12.5) = 12 (capped at 12)
  assert.deepEqual(computeContextOverlaySectionMaxRows({ terminalRows: 50 }), {
    included: 20,
    held: 12,
  });
});

test("computeContextOverlaySectionMaxRows preserves the legacy defaults with no input", () => {
  assert.deepEqual(computeContextOverlaySectionMaxRows({}), {
    included: 12,
    held: 7,
  });
});

test("computeContextOverlaySectionMaxRows adapts to sourceCount and clamps", () => {
  // 30 sources clamp included to 20 ; held = round(30 * 0.5) = 15, clamped to 12
  assert.deepEqual(computeContextOverlaySectionMaxRows({ sourceCount: 30 }), {
    included: 20,
    held: 12,
  });
});
