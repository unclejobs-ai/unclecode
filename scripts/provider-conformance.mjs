#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startAnthropicMessagesServer } from "./runtime-qa/fake-anthropic-server.mjs";
import { startGeminiServer } from "./runtime-qa/fake-gemini-server.mjs";
import { startOpenAIChatServer } from "./runtime-qa/fake-openai-server.mjs";
import {
  runAnthropicToolCallSmoke,
  runOpenAIToolCallSmoke,
  runToolCallSmoke,
} from "./runtime-qa/provider-smokes.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_REPORT_PATH = path.join(
  REPO_ROOT,
  "benchmarks",
  "competitive",
  "results",
  "provider-conformance-local.json",
);

export function buildProviderConformanceReport(smokes, metadata = {}) {
  const providers = {
    gemini: buildProviderResult(smokes.gemini, "functionResponseNameMatched"),
    openai: buildProviderResult(smokes.openai, "toolCallIdMatched"),
    anthropic: buildProviderResult(smokes.anthropic, "toolUseIdMatched"),
  };
  return {
    schemaVersion: 1,
    suite: "UncleCode local provider tool-call conformance",
    engine: metadata.engine ?? "pi",
    status: Object.values(providers).every((provider) => provider.status === "pass")
      ? "pass"
      : "fail",
    startedAt: metadata.startedAt ?? new Date().toISOString(),
    finishedAt: metadata.finishedAt ?? new Date().toISOString(),
    environment: metadata.environment ?? {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    providers,
    contract: [
      "first request exposes tools",
      "second request carries the provider-native tool result",
      "provider call and result identifiers remain paired",
      "final answer is emitted only after the tool result round trip",
    ],
    limitation:
      "Local protocol conformance uses deterministic loopback providers; it does not claim external API availability or model quality.",
  };
}

function buildProviderResult(smoke, pairingField) {
  const firstRequest = smoke?.firstRequest;
  const secondRequest = smoke?.secondRequest;
  const checks = {
    twoRequestRoundTrip: smoke?.requestDelta === 2,
    firstRequestHadTools: firstRequest?.hasTools === true,
    toolResultObserved:
      secondRequest?.hasFunctionResponse === true || secondRequest?.hasToolResult === true,
    protocolPaired: secondRequest?.[pairingField] === true,
    finalAnswerGatedByToolResult:
      smoke?.toolRoundTripVerified === true &&
      smoke?.finalAnswerGatedByToolResult === true &&
      secondRequest?.finalAnswerGatedByToolResult === true,
  };
  return {
    status: Object.values(checks).every(Boolean) ? "pass" : "fail",
    checks,
    requestCount: Number.isInteger(smoke?.requestDelta) ? smoke.requestDelta : 0,
  };
}

export async function runProviderConformance(options = {}) {
  const reportPath = path.resolve(options.reportPath ?? DEFAULT_REPORT_PATH);
  const geminiObservations = [];
  const openAIObservations = [];
  const anthropicObservations = [];
  const startedAt = new Date().toISOString();
  const geminiServer = await startGeminiServer((observation) =>
    geminiObservations.push(observation),
  );
  const openAIServer = await startOpenAIChatServer((observation) =>
    openAIObservations.push(observation),
  );
  const anthropicServer = await startAnthropicMessagesServer((observation) =>
    anthropicObservations.push(observation),
  );
  try {
    const [gemini, openai, anthropic] = await Promise.all([
      runToolCallSmoke(geminiServer.port, geminiObservations),
      runOpenAIToolCallSmoke(openAIServer.port, openAIObservations),
      runAnthropicToolCallSmoke(anthropicServer.port, anthropicObservations),
    ]);
    const report = buildProviderConformanceReport(
      { gemini, openai, anthropic },
      { startedAt, finishedAt: new Date().toISOString() },
    );
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return { report, reportPath };
  } finally {
    await Promise.all([
      anthropicServer.close(),
      openAIServer.close(),
      geminiServer.close(),
    ]);
  }
}

function parseArgs(argv) {
  let reportPath = DEFAULT_REPORT_PATH;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      reportPath = argv[++index] ?? "";
      if (!reportPath) throw new Error("--output requires a path");
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/provider-conformance.mjs [--output path] [--json]");
      return null;
    } else {
      throw new Error(`Unknown provider conformance option: ${arg}`);
    }
  }
  return { reportPath, json };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) return;
  const { report, reportPath } = await runProviderConformance(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Provider conformance: ${report.status}`);
  for (const [provider, result] of Object.entries(report.providers)) {
    console.log(`${provider.padEnd(10)} ${result.status} (${result.requestCount} requests)`);
  }
  console.log(`Report: ${path.relative(REPO_ROOT, reportPath)}`);
  if (report.status !== "pass") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}
