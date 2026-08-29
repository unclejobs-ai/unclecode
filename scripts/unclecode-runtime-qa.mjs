#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { binEntrypoint, repoRoot, reportPath, tmpPrefix } from "./runtime-qa/constants.mjs";
import { persistReport } from "./runtime-qa/cli-helpers.mjs";
import { startAnthropicMessagesServer } from "./runtime-qa/fake-anthropic-server.mjs";
import { startGeminiServer } from "./runtime-qa/fake-gemini-server.mjs";
import { startOpenAIChatServer } from "./runtime-qa/fake-openai-server.mjs";
import {
  runAnthropicToolCallSmoke,
  runOpenAIToolCallSmoke,
  runPromptSmoke,
  runToolCallSmoke,
} from "./runtime-qa/provider-smokes.mjs";
import {
  buildRuntimeEvidence,
  formatRuntimeQaCompactReport,
} from "./runtime-qa/report-evidence.mjs";
import { runAgentConsoleTuiSmoke } from "./runtime-qa/tui-basic-smokes.mjs";
import { killRuntimeTmuxServer } from "./runtime-qa/tmux-helpers.mjs";
import { runTtySmoke } from "./runtime-qa/tty-smoke.mjs";
import { runTuiSmokeSuite } from "./runtime-qa/tui-suite-smokes.mjs";

if (!existsSync(binEntrypoint)) {
  throw new Error(`Missing UncleCode bin entrypoint: ${binEntrypoint}`);
}

const args = parseArgs(process.argv.slice(2));
const tmp = mkdtempSync(path.join(tmpdir(), tmpPrefix));
const observations = [];
const openAIObservations = [];
const anthropicObservations = [];
const startedAt = new Date().toISOString();

try {
  const server = await startGeminiServer((observation) => observations.push(observation));
  const openAIServer = await startOpenAIChatServer((observation) => openAIObservations.push(observation));
  const anthropicServer = await startAnthropicMessagesServer((observation) => anthropicObservations.push(observation));
  try {
    const promptSmoke = await runPromptSmoke(server.port, observations);
    const toolCallSmoke = await runToolCallSmoke(server.port, observations);
    const openAIToolCallSmoke = await runOpenAIToolCallSmoke(openAIServer.port, openAIObservations);
    const anthropicToolCallSmoke = await runAnthropicToolCallSmoke(anthropicServer.port, anthropicObservations);
    const ttySmoke = await runTtySmoke({ port: server.port, tmp, observations });
    const tuiSmokes = await runTuiSmokeSuite({ port: server.port, tmp, observations });
    // The Agent Console gate scripts its own provider and OMP executor
    // boundaries, so it needs no shared fake-provider port or observation log.
    const agentConsoleTuiSmoke = await runAgentConsoleTuiSmoke({ tmp });
    const providerSmokes = { toolCallSmoke, openAIToolCallSmoke, anthropicToolCallSmoke };
    const evidence = buildRuntimeEvidence({ ...providerSmokes, ...tuiSmokes });
    const report = {
      status: "pass",
      startedAt,
      finishedAt: new Date().toISOString(),
      reportPath,
      evidence,
      providerRequests: observations.length,
      openAIProviderRequests: openAIObservations.length,
      anthropicProviderRequests: anthropicObservations.length,
      requests: observations,
      openAIRequests: openAIObservations,
      anthropicRequests: anthropicObservations,
      promptSmoke,
      ttySmoke,
      ...providerSmokes,
      ...tuiSmokes,
      agentConsoleTuiSmoke,
      externalLiveProviderGate: "not covered by local QA; run a real provider smoke after OPENAI_API_KEY or equivalent provider credentials are API-ready",
      checks: [
        "real bin work prompt response",
        "Gemini REST body has no SDK config/model envelope",
        "real bin work tool-call loop dispatches run_shell and returns functionResponse",
        "real bin OpenAI chat tool-call loop dispatches run_shell and returns a tool message",
        "real bin Anthropic messages tool-use loop dispatches run_shell and returns a tool_result",
        "interactive Work TTY /status",
        "interactive Work TTY /context",
        "interactive Work TTY assistant response",
        "full-screen Work TUI assistant response uses terminal foreground",
        "full-screen Work TUI reaches idle after response",
        "short full-screen replies render compactly without heavy cards",
        "reasoning picker closes after explicit /reasoning selection",
        "YOLO greeting stays on the simple one-call path",
        "YOLO greeting does not leak planner or guardian internals",
        "Korean full-screen input does not duplicate during submit",
        "real prompt line edits committed Hangul and ASCII with cursor, Backspace, and forward Delete",
        "Ctrl+O preserves the draft while toggling only tool-history presentation",
        "busy composer submits a distinct queued follow-up after prompt editing",
        "Korean delayed response shows a live busy spinner",
        "busy state avoids a duplicate lower activity row below the conversation",
        "ultrawork Korean parallel-mode question strips planner JSON and English meta leaks",
        "single-session real-use TUI stress covers context, reasoning, busy queue drain, idle stability, and resize",
        "PageUp scrollback indicator appears in the real boot chain and Escape returns to newest",
        "context expanded overlay uses readable foreground colors on light terminals",
        "slash commander first paint, warm reopen, filter, and model picker stay within latency budgets",
        "model-bound context packets expose included/excluded/warnings sections during real TUI turns",
        "80-column and 120-column TUI resize captures do not overflow",
        "Agent Console fans one work turn out to two live executor runs",
        "Alt+A opens the Agent Console roster and inspector over live runs",
        "steering a live agent run returns an accepted control receipt",
        "confirmed cancel settles one run and leaves the other executing",
        "settled delegated work clears every live agent and job count",
        "/jobs keeps both settled job records after the turn ends",
        "resuming the session rebuilds the console with no running phantom",
        "100-column TTY display width",
      ],
    };
    persistReport(report);
    console.log(args.json ? JSON.stringify(report, null, 2) : formatRuntimeQaCompactReport(report, reportPath, repoRoot));
  } finally {
    await anthropicServer.close();
    await openAIServer.close();
    await server.close();
  }
} finally {
  await killRuntimeTmuxServer();
  rmSync(tmp, { recursive: true, force: true });
}

function parseArgs(argv) {
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/unclecode-runtime-qa.mjs [--json]");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { json };
}
