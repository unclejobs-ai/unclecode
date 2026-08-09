import assert from "node:assert/strict";
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
    ...(options.detached === undefined ? {} : { detached: options.detached }),
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

const TRUECOLOR_FOREGROUND_PATTERN = /\x1b\[38;2;(\d+);(\d+);(\d+)m/g;

export { TRUECOLOR_FOREGROUND_PATTERN };

const ANSI_NAMED_FOREGROUND_PATTERN = /\x1b\[(3[0-7]|9[0-7])m/g;

export { ANSI_NAMED_FOREGROUND_PATTERN };

/**
 * The work shell paints with ANSI colour names so it inherits the user's
 * terminal theme. Two things must hold on a live pane:
 *
 *  1. no truecolor foreground survives — a hardcoded pigment ignores the
 *     user's theme and can land unreadable on their background;
 *  2. an explicit foreground is still set — inheriting the terminal default
 *     is what made typed input vanish on some themes.
 *
 * Contrast itself is no longer ours to assert: the terminal theme owns what
 * "cyan" looks like. That is checked structurally in
 * tests/contracts/work-shell-dark-palette-contrast.contract.test.mjs.
 */
export function assertReadableForegroundEscapes(ansiText, message, options = {}) {
  const truecolor = [...ansiText.matchAll(TRUECOLOR_FOREGROUND_PATTERN)]
    .map((match) => `${match[1]};${match[2]};${match[3]}`);
  assert.deepEqual(
    [...new Set(truecolor)],
    [],
    `${message} — found hardcoded truecolor foregrounds instead of ANSI colour names`,
  );
  if (options.requireNonEmpty) {
    const named = [...ansiText.matchAll(ANSI_NAMED_FOREGROUND_PATTERN)];
    assert.ok(named.length > 0, `${message} — expected explicit ANSI foregrounds`);
  }
}

export function contrastRatio(left, right) {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color) {
  const [red, green, blue] = [color.red, color.green, color.blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
