import assert from "node:assert/strict";
import test from "node:test";

import React from "react";

import { WorkShellView } from "../../packages/tui/src/work-shell-view.tsx";
import { getDisplayWidth } from "../../packages/tui/src/text-width.ts";
import { renderDebugFrame, waitForSettledFrame } from "./work-shell-render-harness.mjs";

process.env.UNCLECODE_TERMINAL_BACKGROUND = "light";

function baseProps(activePanel) {
  return {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningLabel: "medium",
    reasoningSupported: true,
    mode: "Default",
    authLabel: "Saved OAuth",
    entries: [],
    isBusy: false,
    activePanel,
    composer: React.createElement("span", null, ""),
    inputValue: "",
    slashSuggestionCount: 0,
    terminalColumns: 100,
    cwd: "/tmp/unclecode-test-workspace",
    agentConsole: {
      profileId: "build",
      activity: [],
      mainUsage: {
        eventIds: ["usage-main"],
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 750,
        cacheWriteTokens: 50,
        cacheSavingsUsd: 0.004,
        costUsd: 0.01,
        routes: [{
          provider: "openai",
          model: "gpt-5.6-sol",
          eventIds: ["usage-main"],
          inputTokens: 1_000,
          outputTokens: 200,
          cacheReadTokens: 750,
          cacheWriteTokens: 50,
          cacheSavingsUsd: 0.004,
          costUsd: 0.01,
        }],
      },
      agents: [
        {
          id: "agent-running",
          displayName: "CacheScout",
          agentType: "scout",
          status: "running",
          currentActivity: "Checking cache headers",
          startedAt: 200,
          usage: {
            eventIds: ["usage-agent-running"],
            inputTokens: 500,
            outputTokens: 40,
            cacheReadTokens: 250,
            cacheSavingsUsd: 0.002,
            costUsd: 0.004,
            routes: [{
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              eventIds: ["usage-agent-running"],
              inputTokens: 500,
              outputTokens: 40,
              cacheReadTokens: 250,
              cacheSavingsUsd: 0.002,
              costUsd: 0.004,
            }],
          },
        },
        {
          id: "agent-complete",
          displayName: "ReviewAgent",
          agentType: "reviewer",
          status: "completed",
          summary: "Reviewed telemetry",
          startedAt: 100,
          completedAt: 180,
        },
      ],
      jobs: [{
        id: "job-1",
        type: "research",
        label: "Audit cache telemetry",
        status: "running",
        agentRunId: "agent-running",
        queuedAt: 190,
        startedAt: 200,
      }],
    },
  };
}

async function renderView(activePanel, terminalColumns = 100) {
  const props = baseProps(activePanel);
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, { ...props, terminalColumns }),
  );
  await waitForSettledFrame(getOutput);
  const output = getOutput();
  instance.unmount();
  instance.cleanup();
  return output;
}

test("Cache Telemetry renders provider cache evidence and estimated savings", async () => {
  const output = await renderView({ title: "Cache Telemetry", lines: [] });

  assert.match(output, /Cache Telemetry/);
  assert.match(output, /Live provider evidence/);
  assert.match(output, /CACHE STATE\s+REUSE\s+SAVED · EST\s+COST · EST/);
  assert.match(output, /HIT\s+39%\s+\$0\.0060\s+\$0\.01/);
  assert.match(output, /1\.0k reused/);
  assert.match(output, /2\.5k total\s+·\s+50 cache write\s+·\s+240 output/);
  assert.match(output, /Main conversation/);
  assert.match(output, /CacheScout/);
  assert.match(output, /openai\/gpt-5\.6-sol/);
  assert.match(output, /anthropic\/claude-sonnet-4-6/);
});

test("Agent History renders current-session runs and correlated jobs", async () => {
  const output = await renderView({ title: "Agent History", lines: [] });

  assert.match(output, /Agent History/);
  assert.match(output, /Current-session runs/);
  assert.match(output, /1 active\s+2 total\s+0 failed\s+\$0\.01 cost/);
  assert.match(output, /CacheScout/);
  assert.match(output, /Checking cache headers/);
  assert.match(output, /ReviewAgent/);
  assert.match(output, /Audit cache telemetry\s+running/);
});

test("telemetry overlays preserve every line at 52 columns", async () => {
  for (const title of ["Cache Telemetry", "Agent History"]) {
    const output = await renderView({ title, lines: [] }, 52);
    const overlayLines = output
      .split("\n")
      .filter((line) => /[┌│└]/.test(line));
    const overflow = overlayLines
      .filter((line) => getDisplayWidth(line) > 52)
      .map((line) => `${getDisplayWidth(line)}:${line}`);
    assert.deepEqual(overflow, [], `${title} overflowed its terminal width`);
    assert.match(output, /\[C\] Cache\s+\[A\] Agents/);
    assert.match(output, /Esc close/);
  }
});
