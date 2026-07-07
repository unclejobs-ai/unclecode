import assert from "node:assert/strict";
import test from "node:test";

import { createInitialWorkShellEngineState } from "../../packages/orchestrator/src/work-shell-engine-state.ts";

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
