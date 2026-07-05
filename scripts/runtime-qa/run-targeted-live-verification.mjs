#!/usr/bin/env node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { repoRoot, tmpPrefix } from "./constants.mjs";
import { startGeminiServer } from "./fake-gemini-server.mjs";
import { killRuntimeTmuxServer } from "./tmux-helpers.mjs";
import { runFullTuiSmoke } from "./tui-basic-smokes.mjs";
import { runContextContrastTuiSmoke } from "./tui-context-contrast-smoke.mjs";
import { runKoreanBusyTuiSmoke } from "./tui-korean-smoke.mjs";
import { runParallelModeKoreanTuiSmoke } from "./tui-parallel-mode-korean-smoke.mjs";
import { listWorkShellSlashSuggestionEntries } from "../../packages/orchestrator/dist/work-shell-slash.js";

const qaDir = path.join(repoRoot, ".unclecode", "qa");
mkdirSync(qaDir, { recursive: true });
const reportPath = path.join(qaDir, "live-verification-latest.json");
const tmp = mkdtempSync(path.join(tmpdir(), `${tmpPrefix}live-`));
const observations = [];
const startedAt = new Date().toISOString();
const results = {};

try {
  const server = await startGeminiServer((observation) => observations.push(observation));
  try {
    results.fullTuiSmoke = await runFullTuiSmoke({ port: server.port, tmp });
    results.koreanBusyTuiSmoke = await runKoreanBusyTuiSmoke({ port: server.port, tmp, observations });
    results.contextContrastTuiSmoke = await runContextContrastTuiSmoke({ tmp });
    results.parallelModeKoreanTuiSmoke = await runParallelModeKoreanTuiSmoke({
      port: server.port,
      tmp,
      observations,
    });
  } finally {
    await server.close();
  }

  const contextEntry = listWorkShellSlashSuggestionEntries().find((entry) => entry.command === "/context");
  results.slashContextKo = {
    ok: Boolean(contextEntry && /context packet|next answer/i.test(contextEntry.description)),
    command: contextEntry?.command,
    description: contextEntry?.description,
  };
  if (!results.slashContextKo.ok) {
    throw new Error(`/context Korean description missing: ${contextEntry?.description ?? "not found"}`);
  }

  const report = {
    status: "pass",
    startedAt,
    finishedAt: new Date().toISOString(),
    reportPath,
    results,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  for (const [name, value] of Object.entries(results)) {
    if (value?.paneExcerpt) {
      const excerptPath = path.join(qaDir, `live-verification-${name}-pane.txt`);
      writeFileSync(excerptPath, `${value.paneExcerpt}\n`);
    }
  }
  console.log(`UncleCode live verification: pass\nreport: ${reportPath}`);
} catch (error) {
  const report = {
    status: "fail",
    startedAt,
    finishedAt: new Date().toISOString(),
    reportPath,
    error: error instanceof Error ? error.message : String(error),
    results,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`UncleCode live verification: fail\n${report.error}\nreport: ${reportPath}`);
  process.exitCode = 1;
} finally {
  await killRuntimeTmuxServer();
  rmSync(tmp, { recursive: true, force: true });
}
