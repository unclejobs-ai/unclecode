import assert from "node:assert/strict";
import test from "node:test";

import React from "react";

import { WorkShellView } from "../../packages/tui/src/work-shell-view.tsx";
import { getDisplayWidth } from "../../packages/tui/src/text-width.ts";
import { renderDebugFrame, waitForSettledFrame } from "./work-shell-render-harness.mjs";

process.env.UNCLECODE_TERMINAL_BACKGROUND = "light";

const NARROW_COLUMNS = 52;

/**
 * A session where the main conversation runs on a hosted provider while a
 * delegated worker run is routed through OMP. Both ledgers carry cache read and
 * cache write, so the overlays have to keep the two routes apart.
 */
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
    terminalColumns: NARROW_COLUMNS,
    cwd: "/tmp/unclecode-test-workspace",
    agentConsole: {
      profileId: "build",
      activity: [],
      mainUsage: {
        eventIds: ["usage-main"],
        inputTokens: 800,
        outputTokens: 150,
        cacheReadTokens: 400,
        cacheWriteTokens: 60,
        cacheSavingsUsd: 0.003,
        costUsd: 0.02,
        routes: [{
          provider: "openai",
          model: "gpt-5.6-sol",
          eventIds: ["usage-main"],
          inputTokens: 800,
          outputTokens: 150,
          cacheReadTokens: 400,
          cacheWriteTokens: 60,
          cacheSavingsUsd: 0.003,
          costUsd: 0.02,
        }],
      },
      agents: [{
        id: "run-omp-worker",
        displayName: "OmpWorker",
        agentType: "executor",
        status: "running",
        currentActivity: "Running the OMP worker turn",
        startedAt: 200,
        usage: {
          eventIds: ["usage-omp-1"],
          inputTokens: 1_200,
          outputTokens: 340,
          cacheReadTokens: 900,
          cacheWriteTokens: 120,
          costUsd: 0.0042,
          routes: [{
            provider: "omp",
            model: "kimi-code/k3",
            eventIds: ["usage-omp-1"],
            inputTokens: 1_200,
            outputTokens: 340,
            cacheReadTokens: 900,
            cacheWriteTokens: 120,
            costUsd: 0.0042,
          }],
        },
      }],
      jobs: [{
        id: "job-omp",
        type: "work-node",
        label: "Worker slice",
        status: "running",
        agentRunId: "run-omp-worker",
        queuedAt: 190,
        startedAt: 200,
      }],
    },
  };
}

async function renderOverlay(title, terminalColumns = NARROW_COLUMNS, consoleOverride) {
  const props = baseProps({ title, lines: [] });
  const { instance, getOutput } = renderDebugFrame(
    React.createElement(WorkShellView, {
      ...props,
      terminalColumns,
      ...(consoleOverride ? { agentConsole: consoleOverride(props.agentConsole) } : {}),
    }),
  );
  await waitForSettledFrame(getOutput);
  const output = getOutput();
  instance.unmount();
  instance.cleanup();
  return output;
}

function overlayOverflow(output, columns) {
  return output
    .split("\n")
    .filter((line) => /[┌│└]/.test(line))
    .filter((line) => getDisplayWidth(line) > columns)
    .map((line) => `${getDisplayWidth(line)}:${line}`);
}

/** At narrow widths the stat cells stack, so a label's value is the next line. */
function narrowStatValue(output, label) {
  const lines = output.split("\n").filter((line) => /[┌│└]/.test(line));
  const index = lines.findIndex((line) => line.includes(label));
  assert.notEqual(index, -1, `no stat cell labelled ${label}`);
  return lines[index + 1]?.replaceAll("│", "").trim();
}

test("Cache Telemetry separates the OMP worker route from the hosted route at 52 columns", async () => {
  const output = await renderOverlay("Cache Telemetry");

  assert.deepEqual(overlayOverflow(output, NARROW_COLUMNS), [], "overlay overflowed 52 columns");
  assert.match(output, /omp\/kimi-code\/k3/, "the OMP selector must stay visible");
  assert.match(output, /openai\/gpt-5\.6-sol/, "the hosted route must stay visible");
  assert.match(output, /OmpWorker/, "the ledger row must correlate to its agent run");
  // Cache read and cache write belong to the route that produced them, not only
  // to the session aggregate.
  assert.match(output, /900 cache read\s+·\s+120 cache write/);
  assert.match(output, /400 cache read\s+·\s+60 cache write/);
});

test("Agent History shows the OMP worker selector and its cache evidence at 52 columns", async () => {
  const output = await renderOverlay("Agent History");

  assert.deepEqual(overlayOverflow(output, NARROW_COLUMNS), [], "overlay overflowed 52 columns");
  assert.match(output, /OmpWorker/);
  assert.match(output, /omp\/kimi-code\/k3/, "a delegated run must name the route it spent on");
  assert.match(output, /900 cache read\s+·\s+120 cache write/);
  assert.match(output, /Running the OMP worker turn/, "current activity must survive the route line");
  assert.match(output, /Worker slice\s+running/, "job correlation must survive");
});

test("both overlays keep the OMP route and cache evidence at a wide terminal", async () => {
  for (const title of ["Cache Telemetry", "Agent History"]) {
    const output = await renderOverlay(title, 100);
    assert.deepEqual(overlayOverflow(output, 100), [], `${title} overflowed 100 columns`);
    assert.match(output, /omp\/kimi-code\/k3/, `${title} dropped the OMP selector`);
    assert.match(output, /900 cache read/, `${title} dropped the OMP cache read total`);
    assert.match(output, /120 cache write/, `${title} dropped the OMP cache write total`);
  }
});

/**
 * OMP fronts arbitrary upstreams, so UncleCode has no per-token price table for
 * the selector and `estimateCacheSavingsUsd` reports nothing rather than guess.
 * The overlay therefore has to say the savings are unknown. Formatting the
 * absent estimate as `$0.00` would claim the reuse saved nothing, which is a
 * fabricated number on the one surface that exists to be evidence.
 */
test("Cache Telemetry reports unpriced OMP cache reuse as unknown, never as zero savings", async () => {
  const output = await renderOverlay("Cache Telemetry");

  assert.match(output, /n\/a saved/, "an unpriced route must not claim a savings figure");
  assert.doesNotMatch(output, /\$0\.00 saved/, "absent savings must never render as zero savings");
  // The priced route keeps its real estimate.
  assert.match(output, /\$0\.0030 saved/);
  // The session estimate only covers the priced route, so it is a floor.
  assert.match(output, /SAVED · EST/);
  assert.match(output, /\$0\.0030\+/, "a partially priced session estimate must read as a lower bound");
});

test("Cache Telemetry reports an entirely unpriced session estimate as unknown", async () => {
  const output = await renderOverlay("Cache Telemetry", NARROW_COLUMNS, (console) => {
    const { mainUsage: _dropped, ...withoutMain } = console;
    return withoutMain;
  });

  assert.deepEqual(overlayOverflow(output, NARROW_COLUMNS), [], "overlay overflowed 52 columns");
  assert.match(output, /omp\/kimi-code\/k3/);
  assert.match(output, /900 cache read\s+·\s+120 cache write/, "cache evidence survives an absent estimate");
  assert.equal(
    narrowStatValue(output, "SAVED · EST"),
    "n/a",
    "a session with no priced route has no estimate to show",
  );
  assert.doesNotMatch(output, /\$0\.00\b/, "nothing on the surface may read as a real zero");
});

test("a priced route with no cache reuse still reports a real zero", async () => {
  const output = await renderOverlay("Cache Telemetry", 100, (console) => ({
    ...console,
    agents: [],
    mainUsage: {
      eventIds: ["usage-cold"],
      inputTokens: 400,
      outputTokens: 90,
      costUsd: 0.01,
      routes: [{
        provider: "openai",
        model: "gpt-5.6-sol",
        eventIds: ["usage-cold"],
        inputTokens: 400,
        outputTokens: 90,
        costUsd: 0.01,
      }],
    },
  }));

  assert.match(output, /MISS/, "no cache reads is a miss, not an unknown");
  assert.match(output, /\$0\.00 saved/, "a route that read no cache genuinely saved nothing");
  assert.doesNotMatch(output, /n\/a/, "a priced route must not be reported as unpriced");
});
