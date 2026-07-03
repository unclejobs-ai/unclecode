import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { repoRoot } from "./constants.mjs";
import { run, shellQuote, sleep } from "./cli-helpers.mjs";
import { capturePane, runTmux, typeKeys, waitForPane } from "./tmux-helpers.mjs";

export const SLASH_LATENCY_BUDGETS_MS = Object.freeze({
  firstSlash: 300,
  warmSlash: 200,
  filter: 150,
  modelPicker: 200,
});

export async function runSlashLatencyTuiSmoke({ tmp }) {
  const tmux = await run("sh", ["-lc", "command -v tmux"], process.env);
  assert.equal(tmux.code, 0, "tmux is required for the slash latency TUI QA gate");

  const session = `unclecode-slash-latency-qa-${process.pid}`;
  const paneFile = path.join(tmp, "slash-latency-pane.txt");
  await runTmux(["kill-session", "-t", session], { allowFailure: true });

  const command = [
    `cd ${shellQuote(repoRoot)}`,
    [
      `UNCLECODE_MODE=default`,
      `OPENAI_API_KEY=sk-local-slash-latency-test-key`,
      `NO_PROXY=127.0.0.1,localhost`,
      `node bin/unclecode.cjs tui --provider openai --model gpt-5.4`,
    ].join(" "),
    `echo EXIT:$?`,
    `sleep 20`,
  ].join(" && ");

  try {
    await runTmux(["new-session", "-d", "-x", "120", "-y", "32", "-s", session, command]);
    await waitForPane(session, /prompt deck|UncleCode · OpenAI/, paneFile);
    await sleep(500);

    const firstSlash = await measureBudgetedKeyToPane(
      session,
      paneFile,
      "/",
      /Commands|\/doctor|\/model/,
      SLASH_LATENCY_BUDGETS_MS.firstSlash,
      "first slash picker paint",
      { resetBeforeFirst: false },
    );

    const warmSlash = await measureBudgetedKeyToPane(
      session,
      paneFile,
      "/",
      /Commands|\/doctor|\/model/,
      SLASH_LATENCY_BUDGETS_MS.warmSlash,
      "warm slash picker paint",
    );

    const moFilter = await measureBudgetedKeyToPane(
      session,
      paneFile,
      "/mo",
      /\/mo matches|\/model  Show/,
      SLASH_LATENCY_BUDGETS_MS.filter,
      "/mo filter paint",
    );

    const modelPicker = await measureBudgetedKeyToPane(
      session,
      paneFile,
      "/model del",
      /Model picker|Current model|Pick model/,
      SLASH_LATENCY_BUDGETS_MS.modelPicker,
      "/model picker paint",
    );

    return {
      latencyWithinBudget: true,
      latencies: {
        firstSlashMs: firstSlash,
        warmSlashMs: warmSlash,
        moFilterMs: moFilter,
        modelPickerMs: modelPicker,
      },
      budgets: {
        firstSlashMs: SLASH_LATENCY_BUDGETS_MS.firstSlash,
        warmSlashMs: SLASH_LATENCY_BUDGETS_MS.warmSlash,
        moFilterMs: SLASH_LATENCY_BUDGETS_MS.filter,
        modelPickerMs: SLASH_LATENCY_BUDGETS_MS.modelPicker,
      },
    };
  } finally {
    await runTmux(["kill-session", "-t", session], { allowFailure: true });
  }
}

async function measureBudgetedKeyToPane(
  session,
  paneFile,
  keys,
  pattern,
  budgetMs,
  label,
  options = {},
) {
  return retryBudgetedMeasurement({
    label,
    budgetMs,
    clear: () => clearComposer(session),
    measure: () => measureKeyToPane(session, paneFile, keys, pattern),
    resetBeforeFirst: options.resetBeforeFirst ?? true,
  });
}

export async function retryBudgetedMeasurement({
  label,
  budgetMs,
  clear,
  measure,
  maxAttempts = 2,
  resetBeforeFirst = true,
}) {
  const attempts = [];
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (resetBeforeFirst || attempt > 0) {
      await clear();
    }
    const latencyMs = await measure();
    attempts.push(latencyMs);
    if (latencyMs <= budgetMs) {
      return latencyMs;
    }
  }
  assert.fail(`${label} took ${attempts.join("ms, ")}ms; budget ${budgetMs}ms`);
}

async function clearComposer(session) {
  await runTmux(["send-keys", "-t", session, "Escape"], { allowFailure: true });
  await sleep(120);
}

async function measureKeyToPane(session, paneFile, keys, pattern) {
  await typeKeys(session, keys);
  const started = performance.now();
  let lastPane = "";
  while (performance.now() - started <= 3000) {
    const pane = await capturePane(session, paneFile);
    lastPane = pane;
    if (pattern.test(pane)) {
      return Math.round(performance.now() - started);
    }
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${pattern}\nLast pane:\n${lastPane.trimEnd()}`);
}
