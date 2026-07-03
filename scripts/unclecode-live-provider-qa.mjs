#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runCommand } from "./health-qa/runner.mjs";
import {
  buildLiveToolSmoke,
  buildCredentialRecovery,
  classifyLiveProviderPreflight,
  classifyLiveProviderResult,
  classifyLiveToolSmokeResult,
  combineLiveProviderStatus,
  formatLiveProviderCompactReport,
  parseOpenAIDoctorAuthSummary,
  parseOpenAIAuthStatusSummary,
  summarizeCommand,
} from "./unclecode-live-provider-qa-lib.mjs";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const binEntrypoint = path.join(repoRoot, "bin", "unclecode.cjs");
const reportPath = path.join(repoRoot, ".unclecode", "qa", "live-provider-latest.json");
const expectedText = "UNCLECODE_LIVE_QA_OK";
const args = parseArgs(process.argv.slice(2));

if (!existsSync(binEntrypoint)) {
  throw new Error(`Missing UncleCode bin entrypoint: ${binEntrypoint}`);
}

const startedAt = new Date().toISOString();
const liveToolSmoke = buildLiveToolSmoke(repoRoot, startedAt);
rmSync(liveToolSmoke.markerPath, { force: true });
const authStatus = args.provider === "openai"
  ? await runNode(["--import", "dotenv/config", binEntrypoint, "auth", "status", "--json"], process.env, 20_000)
  : null;
const doctorAuth = args.provider === "openai"
  ? await runNode(["--import", "dotenv/config", binEntrypoint, "doctor", "--json"], process.env, 20_000)
  : null;
const preflightStatus = classifyLiveProviderPreflight({ provider: args.provider, authStatus, doctorAuth });
const textWork = preflightStatus === "blocked"
  ? skippedWork("auth-preflight-blocked")
  : await runNode(
      buildWorkArgs(`Respond with exactly ${expectedText}.`),
      { ...process.env, UNCLECODE_MODE: "default" },
      args.timeoutMs,
    );
const textStatus = preflightStatus ?? classifyLiveProviderResult(textWork, authStatus, expectedText);
const toolCallSmoke = textStatus === "pass"
  ? await runLiveToolSmoke(liveToolSmoke)
  : {
      status: "skipped",
      reason: `text-smoke-${textStatus}`,
      runId: liveToolSmoke.runId,
      expectedText: liveToolSmoke.expectedText,
      markerPath: liveToolSmoke.markerPath,
      markerMatched: false,
      work: null,
    };
const status = combineLiveProviderStatus(textStatus, toolCallSmoke.status);
const recoveryWork = textStatus === "blocked" ? textWork : toolCallSmoke.rawWork ?? textWork;
const credentialRecovery = buildCredentialRecovery({
  provider: args.provider,
  status,
  authStatus,
  doctorAuth,
  work: recoveryWork,
});
const report = {
  status,
  startedAt,
  finishedAt: new Date().toISOString(),
  reportPath,
  provider: args.provider,
  model: args.model ?? null,
  expectedText,
  authStatus: authStatus
    ? { ...summarizeCommand(authStatus), auth: parseOpenAIAuthStatusSummary(authStatus.stdout) }
    : null,
  doctorAuth: doctorAuth
    ? { ...summarizeCommand(doctorAuth), auth: parseOpenAIDoctorAuthSummary(doctorAuth.stdout) }
    : null,
  textSmoke: {
    status: textStatus,
    expectedText,
    work: summarizeCommand(textWork),
  },
  work: summarizeCommand(textWork),
  toolCallSmoke: {
    status: toolCallSmoke.status,
    reason: toolCallSmoke.reason,
    runId: toolCallSmoke.runId,
    expectedText: toolCallSmoke.expectedText,
    markerPath: toolCallSmoke.markerPath,
    markerMatched: toolCallSmoke.markerMatched,
    work: toolCallSmoke.work,
  },
  credentialGate:
    status === "blocked"
      ? "real provider response is blocked by missing, invalid, stale, or insufficient-scope credentials"
      : null,
  credentialRecovery,
};

persistReport(report);
console.log(args.json ? JSON.stringify(report, null, 2) : formatLiveProviderCompactReport(report, repoRoot));

if (status === "pass") {
  process.exitCode = 0;
} else if (status === "blocked" && args.allowBlocked) {
  process.exitCode = 0;
} else {
  process.exitCode = status === "blocked" ? 2 : 1;
}

function parseArgs(argv) {
  let provider = "openai";
  let model = null;
  let allowBlocked = false;
  let json = false;
  let timeoutMs = 60_000;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--allow-blocked") {
      allowBlocked = true;
      continue;
    }
    if (arg === "--provider") {
      provider = argv[++index] ?? provider;
      continue;
    }
    if (arg === "--model") {
      model = argv[++index] ?? model;
      continue;
    }
    if (arg === "--timeout-ms") {
      const parsed = Number.parseInt(argv[++index] ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        timeoutMs = parsed;
      }
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsageAndExit();
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["openai", "anthropic", "gemini"].includes(provider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  return { provider, model, allowBlocked, json, timeoutMs };
}

function buildWorkArgs(prompt) {
  const baseArgs = ["--import", "dotenv/config", binEntrypoint, "work", "--provider", args.provider];
  return [...baseArgs, ...(args.model ? ["--model", args.model] : []), prompt];
}

async function runLiveToolSmoke(smoke) {
  rmSync(smoke.markerPath, { force: true });
  const work = await runNode(
    buildWorkArgs(smoke.prompt),
    {
      ...process.env,
      UNCLECODE_MODE: "default",
      UNCLECODE_ALLOW_RUN_SHELL: "1",
    },
    args.timeoutMs,
  );
  const markerText = readTextIfExists(smoke.markerPath);
  const status = classifyLiveToolSmokeResult({
    work,
    markerText,
    expectedText: smoke.expectedText,
  });
  return {
    status,
    reason: status === "failed" ? "marker-missing-or-final-text-mismatch" : null,
    runId: smoke.runId,
    expectedText: smoke.expectedText,
    markerPath: smoke.markerPath,
    markerMatched: markerText.trim() === smoke.expectedText,
    work: summarizeCommand(work),
    rawWork: work,
  };
}

function runNode(nodeArgs, env, timeoutMs) {
  return runCommand(process.execPath, nodeArgs, { cwd: repoRoot, env, timeoutMs });
}

function skippedWork(reason) {
  return {
    code: 2,
    timedOut: false,
    stdout: "",
    stderr: `Skipped live provider call: ${reason}`,
  };
}

function readTextIfExists(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

function persistReport(report) {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function printUsageAndExit() {
  console.log(`Usage: node scripts/unclecode-live-provider-qa.mjs [--allow-blocked] [--json] [--provider openai|anthropic|gemini] [--model id] [--timeout-ms ms]`);
  process.exit(0);
}
