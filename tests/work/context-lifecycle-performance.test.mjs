import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { createCrpRuntime } from "../../apps/unclecode-cli/src/work-runtime-crp.ts";
import { createContextPacketView } from "../../packages/context-broker/src/context-packet-view.ts";

const MAX_MAIN_THREAD_BLOCK_MS = 50;
const COLD_RESOLVE_BUDGET_MS = 1_500;
const FIVE_REFRESH_BUDGET_MS = 2_500;
const LARGE_SOURCE_RESOLVE_BUDGET_MS = 3_000;

function legacyPacket() {
  return createContextPacketView({
    id: "legacy-performance-packet",
    generatedAt: "2026-07-13T00:00:00.000Z",
    included: [],
    excluded: [],
    warnings: [],
    preview: [],
  });
}

function packetInput(cwd, sessionId) {
  return {
    cwd,
    sessionId,
    contextSummaryLines: ["Performance fixture"],
    bridgeLines: [],
    memoryLines: [],
    traceLines: [],
  };
}

async function measureDuration(operation) {
  const startedAt = performance.now();
  const value = await operation();
  return { value, totalMs: performance.now() - startedAt };
}

function assertTurnPathSamplesWithinBudget(samples) {
  const turnSamples = samples.filter((sample) => sample.label !== "store-open");
  assert.ok(turnSamples.length > 0);
  for (const sample of turnSamples) {
    assert.ok(
      sample.durationMs <= MAX_MAIN_THREAD_BLOCK_MS,
      `${sample.label} synchronous wall time ${sample.durationMs.toFixed(1)}ms`,
    );
  }
}

function runtimeOptions(cwd, userHomeDir, sourceMetadata, samples) {
  return {
    sourceMetadata,
    crpConfig: { enabled: true, tokenBudget: 32_000, modelWindow: 200_000 },
    env: { ...process.env, HOME: userHomeDir },
    userHomeDir,
    storeHome: path.join(userHomeDir, ".unclecode", "agentops"),
    workspaceRoot: cwd,
    recordPerformanceSample: (sample) => samples.push(sample),
  };
}

test("CRP cold start, refresh, and large-source paths stay within explicit budgets", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "unclecode-context-performance-"));
  const userHomeDir = path.join(cwd, "home");
  mkdirSync(userHomeDir, { recursive: true });

  try {
    let runtime;
    const coldSamples = [];
    const coldCreate = await measureDuration(async () => {
      runtime = createCrpRuntime(
        async () => legacyPacket(),
        runtimeOptions(cwd, userHomeDir, [], coldSamples),
      );
    });
    const coldResolve = await measureDuration(() =>
      runtime.resolveContextPacket(packetInput(cwd, "cold-session"))
    );
    assert.ok(
      coldCreate.totalMs + coldResolve.totalMs <= COLD_RESOLVE_BUDGET_MS,
      `cold startup ${(coldCreate.totalMs + coldResolve.totalMs).toFixed(1)}ms`,
    );
    assertTurnPathSamplesWithinBudget(coldSamples);

    const refresh = await measureDuration(async () => {
      for (let index = 0; index < 5; index += 1) {
        await runtime.resolveContextPacket(packetInput(cwd, "cold-session"));
      }
    });
    assert.ok(refresh.totalMs <= FIVE_REFRESH_BUDGET_MS, `five refreshes ${refresh.totalMs.toFixed(1)}ms`);
    assertTurnPathSamplesWithinBudget(coldSamples);

    const largeCwd = path.join(cwd, "large-workspace");
    const largeHome = path.join(cwd, "large-home");
    mkdirSync(largeCwd, { recursive: true });
    mkdirSync(largeHome, { recursive: true });
    const sourceMetadata = Array.from({ length: 500 }, (_, index) => ({
      id: `large-source-${String(index).padStart(4, "0")}`,
      category: "runtime",
      label: `Large source ${index}`,
      reason: "bounded performance fixture",
      preview: `Summary ${index}`,
      tokenEstimate: 8,
    }));
    const largeSamples = [];
    let largeRuntime;
    const large = await measureDuration(async () => {
      largeRuntime = createCrpRuntime(
        async () => legacyPacket(),
        runtimeOptions(largeCwd, largeHome, sourceMetadata, largeSamples),
      );
      return largeRuntime.resolveContextPacket(packetInput(largeCwd, "large-session"));
    });
    assert.ok(large.totalMs <= LARGE_SOURCE_RESOLVE_BUDGET_MS, `large resolve ${large.totalMs.toFixed(1)}ms`);
    assertTurnPathSamplesWithinBudget(largeSamples);
    assert.ok(
      largeSamples.some((sample) => sample.label === "source-upsert-batch"),
      "large-source path must measure complete synchronous upsert batches",
    );
    assert.ok(large.value.sourceCounts.included <= 128);
    assert.ok(
      large.value.warnings.some(
        (warning) => warning.code === "context.sources.bounded",
      ),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
