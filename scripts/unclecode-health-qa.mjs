#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { extractNodeTestFailures } from "./health-qa/node-test-failures.mjs";
import {
  hasDoctorJsonAuthContract,
  hasLiveProviderReportContract,
  hasRuntimeReportContract,
  isNativeAbiFailure,
  recoveryHintForFailure,
  summarizeDoctor,
  summarizeDoctorJson,
  summarizeFirstLine,
  summarizeLiveReport,
  summarizeMcp,
  summarizeNoOutputPass,
  summarizeNodeTest,
  summarizeResearchStatus,
  summarizeRuntimeReport,
} from "./health-qa/summary.mjs";
import { DEFAULT_CHECK_TIMEOUT_MS, runCommand } from "./health-qa/runner.mjs";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const runtimeReportPath = path.join(repoRoot, ".unclecode", "qa", "runtime-qa-latest.json");
const liveReportPath = path.join(repoRoot, ".unclecode", "qa", "live-provider-latest.json");

const checks = [
  { label: "cli version", command: process.execPath, args: ["bin/unclecode.cjs", "--version"], summarize: summarizeFirstLine },
  { label: "node version", command: "npm", args: ["run", "node:check", "--silent"], summarize: summarizeFirstLine },
  { label: "doctor", command: process.execPath, args: ["bin/unclecode.cjs", "doctor"], summarize: summarizeDoctor },
  {
    label: "doctor json",
    command: process.execPath,
    args: ["bin/unclecode.cjs", "doctor", "--json"],
    summarize: summarizeDoctorJson,
    accept: hasDoctorJsonAuthContract,
  },
  { label: "mcp list", command: process.execPath, args: ["bin/unclecode.cjs", "mcp", "list"], summarize: summarizeMcp },
  {
    label: "research status",
    command: process.execPath,
    args: ["bin/unclecode.cjs", "research", "status", "--json"],
    summarize: summarizeResearchStatus,
  },
  { label: "typecheck", command: "npm", args: ["run", "check", "--silent"], summarize: summarizeNoOutputPass },
  { label: "lint", command: "npm", args: ["run", "lint", "--silent"], summarize: summarizeFirstLine },
  { label: "work tests", command: "npm", args: ["run", "test:work", "--silent"], summarize: summarizeNodeTest },
  { label: "cli tests", command: "npm", args: ["run", "test:cli", "--silent"], summarize: summarizeNodeTest },
  { label: "tui tests", command: "npm", args: ["run", "test:tui", "--silent"], summarize: summarizeNodeTest },
  {
    label: "runtime QA",
    command: "npm",
    args: ["run", "qa:runtime", "--silent"],
    summarize: summarizeRuntimeQa,
    accept: acceptRuntimeQa,
  },
  {
    label: "live provider QA",
    command: "npm",
    args: ["run", "qa:live:record", "--silent"],
    summarize: summarizeLiveQa,
    accept: acceptLiveQa,
  },
  { label: "diff whitespace", command: "git", args: ["diff", "--check"], summarize: summarizeNoOutputPass },
];

const startedAt = Date.now();
const results = [];
let failed = false;

for (const check of checks) {
  process.stdout.write(`- ${check.label} ... `);
  let attempt = await runCheck(check);
  if (!attempt.ok && isNativeAbiFailure(commandOutput(attempt.result))) {
    process.stdout.write(`${formatCheckStatus(attempt)}\n`);
    process.stdout.write("- native ABI recovery ... ");
    const recovery = await run("npm", ["rebuild", "better-sqlite3"]);
    if (recovery.code !== 0) {
      process.stdout.write(`FAIL - ${summarizeFirstLine(recovery)}\n`);
      attempt = { ...attempt, result: recovery };
    } else {
      process.stdout.write("PASS - rebuilt better-sqlite3 for current Node\n");
      process.stdout.write(`- ${check.label} retry ... `);
      attempt = await runCheck(check);
    }
  }
  results.push({ label: check.label, ok: attempt.ok, summary: attempt.summary });
  process.stdout.write(`${formatCheckStatus(attempt)}\n`);
  if (!attempt.ok) {
    failed = true;
    printFailure(check, attempt.result, attempt.accepted);
    break;
  }
}

const liveBlocked = !failed && results.some((result) =>
  result.label === "live provider QA" && result.summary.startsWith("blocked;")
);
const status = failed ? "failed" : liveBlocked ? "pass (live blocked recorded)" : "pass";
const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
process.stdout.write(`\nUncleCode health: ${status} (${durationSeconds}s)\n`);
process.stdout.write(`reports: ${path.relative(repoRoot, runtimeReportPath)}, ${path.relative(repoRoot, liveReportPath)}\n`);

process.exitCode = failed ? 1 : 0;

function run(command, args) {
  return runCommand(command, args, { cwd: repoRoot, env: process.env });
}

async function runCheck(check) {
  const result = await run(check.command, check.args);
  const summary = result.timedOut ? `timed out after ${result.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS}ms` : check.summarize(result);
  const accepted = check.accept?.(result) ?? true;
  return { result, summary, accepted, ok: result.code === 0 && result.timedOut !== true && accepted };
}

function formatCheckStatus(attempt) {
  return `${attempt.ok ? "PASS" : "FAIL"}${attempt.summary ? ` - ${attempt.summary}` : ""}`;
}

function summarizeRuntimeQa(result) {
  return summarizeRuntimeReport(result, readJsonFile(runtimeReportPath));
}

function acceptRuntimeQa(result) {
  return hasRuntimeReportContract(result, readJsonFile(runtimeReportPath));
}

function summarizeLiveQa(result) {
  return summarizeLiveReport(result, readJsonFile(liveReportPath));
}

function acceptLiveQa(result) {
  return hasLiveProviderReportContract(result, readJsonFile(liveReportPath));
}

function printFailure(check, result, accepted) {
  const output = commandOutput(result);
  const reason = result.timedOut
    ? `timed out after ${result.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS}ms`
    : result.code === 0 && !accepted ? "contract check failed" : `exit ${result.code}`;
  process.stderr.write(`\n${check.label} failed with ${reason}\n`);
  if (output) {
    const nodeTestFailures = check.label.endsWith(" tests") ? extractNodeTestFailures(output) : "";
    process.stderr.write(`${nodeTestFailures || tailLines(output, 80)}\n`);
  }
  const recovery = recoveryHintForFailure(check, output);
  if (recovery) {
    process.stderr.write(`recovery: ${recovery}\n`);
  }
}

function commandOutput(result) {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function tailLines(value, count) {
  return value.split(/\r?\n/).slice(-count).join("\n");
}
