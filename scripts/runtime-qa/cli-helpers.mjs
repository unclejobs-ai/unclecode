import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runCommand } from "../health-qa/runner.mjs";
import { repoRoot, reportPath } from "./constants.mjs";

export function providerEnv(port) {
  return {
    ...process.env,
    UNCLECODE_MODE: "default",
    GEMINI_API_BASE_URL: `http://127.0.0.1:${port}/v1beta`,
    GEMINI_API_KEY: "local-provider-test-key",
    NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(","),
  };
}

export function openAIProviderEnv(port) {
  return {
    ...process.env,
    UNCLECODE_MODE: "default",
    OPENAI_API_BASE_URL: `http://127.0.0.1:${port}/v1`,
    OPENAI_API_KEY: "sk-local-provider-test-key",
    NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(","),
  };
}

export function anthropicProviderEnv(port) {
  return {
    ...process.env,
    UNCLECODE_MODE: "default",
    ANTHROPIC_API_BASE_URL: `http://127.0.0.1:${port}/v1`,
    ANTHROPIC_API_KEY: "sk-ant-local-provider-test-key",
    NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(","),
  };
}

export function persistReport(report) {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

export async function run(command, args, env, options = {}) {
  const result = await runCommand(command, args, {
    cwd: repoRoot,
    env,
    timeoutMs: options.timeoutMs,
    killGraceMs: options.killGraceMs,
  });
  if ((result.code !== 0 || result.timedOut) && !options.allowFailure) {
    throw new Error(formatRunFailure(command, args, result));
  }
  return result;
}

function formatRunFailure(command, args, result) {
  const status = result.timedOut
    ? `timed out after ${result.timeoutMs}ms`
    : result.signal
      ? `failed with ${result.signal}`
      : `failed (${result.code})`;
  return `${command} ${args.join(" ")} ${status}\n${result.stdout}${result.stderr}`;
}

export function shellQuote(value) {
  return '\'' + String(value).replaceAll('\'', '\'\\\'\'') + '\'';
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
