import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import React from "react";
import { Text } from "ink";

import {
  formatProviderPerformanceReceipt,
  formatProviderPerformanceStatus,
  projectProviderPerformanceReceipt,
} from "../../packages/tui/src/work-shell-performance-receipt.ts";
import { WorkShellView } from "../../packages/tui/src/work-shell-view.tsx";
import { renderDebugFrame, waitForSettledFrame } from "./work-shell-render-harness.mjs";

const completedPerformance = {
  provider: "openai",
  model: "gpt-5.6-sol",
  startedAt: 1_000,
  firstTokenAt: 1_180,
  completedAt: 2_220,
  inputTokens: 32_000,
  outputTokens: 100,
  cacheReadTokens: 32_000,
  cacheWriteTokens: 4_000,
  costUsd: 0.04,
};

async function renderReceiptFrame(terminalRows, isBusy = false) {
  const terminalColumns = 80;
  const { instance, getOutput, getFrame } = renderDebugFrame(
    React.createElement(WorkShellView, {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningLabel: "unsupported",
      reasoningSupported: false,
      mode: "Work",
      authLabel: "OAuth · pi engine",
      entries: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ],
      isBusy,
      activePanel: { title: "Session status", lines: ["Work context ready."] },
      composer: React.createElement(Text, null, ""),
      inputValue: "",
      slashSuggestionCount: 0,
      terminalColumns,
      terminalRows,
      cwd: "/tmp/workspace",
      agentConsole: {
        profileId: "build",
        activity: [],
        agents: [],
        jobs: [],
        lastTurnPerformance: completedPerformance,
      },
    }),
    { columns: terminalColumns, rows: terminalRows },
  );
  await waitForSettledFrame(getOutput);
  const frame = stripVTControlCharacters(getFrame());
  instance.unmount();
  instance.cleanup();
  return frame;
}

test("performance receipt is one bounded English line with provider cache evidence", () => {
  const performance = {
    provider: "openai",
    model: "gpt-5.6-sol",
    startedAt: 1_000,
    firstTokenAt: 1_180,
    completedAt: 2_220,
    inputTokens: 32_000,
    outputTokens: 100,
    cacheReadTokens: 32_000,
    cacheWriteTokens: 4_000,
    costUsd: 0.04,
  };

  const projection = projectProviderPerformanceReceipt(performance);
  assert.equal(projection.cache, "HIT");
  assert.equal(projection.ttftMs, 180);
  assert.equal(projection.generationDurationMs, 1_040);
  assert.equal(projection.tokensPerSecond, 96.15384615384616);

  const line = formatProviderPerformanceReceipt(performance, 80);
  assert.ok(line);
  assert.equal(line.includes("\n"), false);
  assert.ok(line.length > 0);
  assert.match(line, /cache HIT/);
  assert.match(line, /tok\/s/);
  assert.match(line, /TTFT/);
  assert.match(line, /read 32k/);
  assert.match(line, /write 4k/);
  assert.match(line, /\$0\.04/);
});

test("receipt does not fabricate speed, TTFT, cache miss, or zero cost from absent usage", () => {
  const performance = {
    provider: "openai",
    model: "gpt-5.6-sol",
    startedAt: 1_000,
    completedAt: 2_000,
  };

  const projection = projectProviderPerformanceReceipt(performance);
  assert.equal(projection.cache, "n/a");
  assert.equal(projection.tokensPerSecond, undefined);
  assert.equal(projection.ttftMs, undefined);
  assert.equal(projection.costUsd, undefined);

  const line = formatProviderPerformanceReceipt(performance, 80);
  assert.equal(line, "✓ cache n/a");
  assert.equal(formatProviderPerformanceReceipt(undefined, 80), undefined);
});

test("footer status omits the decorative receipt mark and per-turn cost", () => {
  assert.equal(
    formatProviderPerformanceStatus(completedPerformance, 80),
    "TTFT 180ms · cache HIT · 96 tok/s",
  );
});

test("narrow receipt drops optional counters before it exceeds the available width", () => {
  const line = formatProviderPerformanceReceipt({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    startedAt: 1_000,
    firstTokenAt: 1_200,
    completedAt: 2_200,
    outputTokens: 1_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.0042,
  }, 24);

  assert.ok(line);
  assert.equal(line.includes("\n"), false);
  assert.ok([...line].length <= 24);
  assert.match(line, /cache MISS/);
});

test("roomy idle work shell keeps performance in the footer and preserves the composer hint", async () => {
  const frame = await renderReceiptFrame(24);
  assert.equal((frame.match(/cache HIT/g) ?? []).length, 1);
  assert.match(frame, /tok\/s/);
  assert.match(frame, /TTFT/);
  assert.match(frame, /Enter send/);
  const rows = frame.split("\n");
  const footer = rows.find((row) => row.includes("workspace"));
  assert.match(footer ?? "", /TTFT 180ms · cache HIT · 96 tok\/s/);
});

test("short split keeps performance inside the footer without consuming a dock row", async () => {
  const frame = await renderReceiptFrame(12);
  assert.equal((frame.match(/cache HIT/g) ?? []).length, 1);
  assert.match(frame, /›/);
  assert.match(frame, /workspace/);
});

test("a live turn does not label the previous turn's performance as current", async () => {
  const frame = await renderReceiptFrame(24, true);
  assert.doesNotMatch(frame, /TTFT|cache HIT|tok\/s/u);
  assert.match(frame, /Thinking through the next step/u);
});
