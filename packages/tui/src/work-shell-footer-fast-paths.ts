import path from "node:path";

import { runRustCommandSync } from "@unclecode/orchestrator";

import { getDisplayWidth, truncateForDisplayWidth } from "./text-width.js";

export function formatWorkShellFooterLineFast(input: {
  readonly cwd?: string;
  readonly model: string;
  readonly reasoningLabel: string;
  readonly mode: string;
  readonly authLabel: string;
  readonly contextIndicator?: string;
  readonly composerHint?: string;
  readonly width?: number;
  readonly home?: string;
  readonly branch?: string;
  readonly modelWindow?: number;
}): string {
  void input.model;
  void input.reasoningLabel;
  void input.mode;
  void input.authLabel;
  void input.composerHint;

  const compactPath = compactWorkShellPath(input.cwd, input.home);
  const contextChip = compactWorkShellFooterContextChip(input.contextIndicator);
  // Path · branch on the left, budget on the right — the shape every terminal
  // agent settles on, because "which checkout am I in" and "how full is the
  // window" are the two things worth a permanent slot.
  const budget = formatWorkShellBudgetChip(input.contextIndicator, input.modelWindow);
  const left = joinFooterParts([compactPath, input.branch?.trim(), budget ? undefined : contextChip]);
  if (input.width === undefined) {
    return joinFooterParts([left, budget]);
  }
  if (!budget) {
    return truncateForDisplayWidth(left, input.width);
  }
  const budgetWidth = getDisplayWidth(budget);
  const clipped = truncateForDisplayWidth(left, Math.max(8, input.width - budgetWidth - 2));
  const gap = Math.max(2, input.width - getDisplayWidth(clipped) - budgetWidth);
  return truncateForDisplayWidth(`${clipped}${" ".repeat(gap)}${budget}`, input.width);
}

/**
 * Turn the context indicator's token estimate into `15.5%/272K`.
 *
 * `▤ 31 ctx · ~1k` says how many sources were selected, which is a number only
 * this app cares about. How close the next request is to the model's window is
 * the number that changes what the user does next.
 */
export function formatWorkShellBudgetChip(
  contextIndicator: string | undefined,
  modelWindow: number | undefined,
): string | undefined {
  if (!modelWindow || modelWindow <= 0) return undefined;
  const tokens = parseContextIndicatorTokens(contextIndicator);
  if (tokens === undefined) return undefined;
  const percent = (tokens / modelWindow) * 100;
  const rounded = percent >= 10 ? percent.toFixed(0) : percent.toFixed(1);
  return `${rounded}%/${formatCompactWindow(modelWindow)}`;
}

function parseContextIndicatorTokens(contextIndicator: string | undefined): number | undefined {
  const normalized = contextIndicator?.trim() ?? "";
  const match = /~\s*(\d+(?:\.\d+)?)\s*([kKmM])?(?=\s|$)/.exec(normalized);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1] ?? "");
  if (Number.isNaN(value)) return undefined;
  const unit = match[2]?.toLowerCase();
  return unit === "m" ? value * 1_000_000 : unit === "k" ? value * 1_000 : value;
}

function formatCompactWindow(modelWindow: number): string {
  if (modelWindow >= 1_000_000) {
    return `${(modelWindow / 1_000_000).toFixed(modelWindow % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  return `${Math.round(modelWindow / 1_000)}K`;
}

export function formatWorkShellSessionFactsGroup(input: {
  readonly model: string;
  readonly mode: string;
}): string {
  return joinFooterFacts([
    input.model.trim(),
    resolveWorkShellModeLabel(input.mode),
  ]);
}

export function formatWorkShellAuthFactsGroup(authLabel: string): string {
  return compactWorkShellAuthLabel(authLabel);
}

export function compactWorkShellFooterContextChip(contextIndicator?: string): string | undefined {
  const normalized = contextIndicator?.trim() ?? "";
  if (normalized.length === 0) {
    return undefined;
  }
  const readyMatch = normalized.match(/^context\s+\d+\s+ready/i);
  if (readyMatch) {
    return readyMatch[0];
  }
  const segments = normalized.split(/\s·\s/u).map((segment) => segment.trim());
  const contextCount = segments[0];
  const tokenCost = segments[1];
  if (
    contextCount &&
    /^▤\s+\d+\s+ctx$/u.test(contextCount) &&
    tokenCost &&
    /^(?:~\d+(?:\.\d+)?k|~\d+t|tokens unknown)$/u.test(tokenCost)
  ) {
    return `${contextCount} · ${tokenCost}`;
  }
  return contextCount && contextCount.length > 0 ? contextCount : normalized;
}

function joinFooterParts(parts: readonly (string | undefined)[]): string {
  return parts
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join("  ·  ");
}

function compactWorkShellPath(cwd: string | undefined, home: string | undefined): string | undefined {
  if (!cwd) {
    return undefined;
  }
  const normalized = home && cwd.startsWith(home)
    ? `~${cwd.slice(home.length)}`
    : cwd;
  const parts = normalized.split(path.sep).filter((part) => part.length > 0);
  if (normalized.startsWith("~") && parts.length > 3) {
    return `~/${parts.slice(-2).join("/")}`;
  }
  if (!normalized.startsWith("~") && parts.length > 3) {
    return `…/${parts.slice(-2).join("/")}`;
  }
  return normalized;
}

function joinFooterFacts(parts: readonly (string | undefined)[]): string {
  return parts
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join(" · ");
}

function compactWorkShellAuthLabel(authLabel: string): string {
  switch (authLabel) {
    case "OAuth file · API blocked":
    case "OAuth env · API blocked":
      // The OAuth token is present but lacks the model.request scope, so API
      // calls are rejected. "needs API key" tells the user the fix (switch to
      // an API key) instead of the opaque "blocked".
      return "OAuth · needs API key";
    case "Browser OAuth · file":
      return "Saved OAuth";
    case "Browser OAuth · env":
      return "OAuth env";
    case "API key · file":
      return "Saved API key";
    case "API key · env":
      return "API key env";
    case "Not signed in":
      return "No auth";
    default:
      return authLabel;
  }
}

const modeLabelCache = new Map<string, string>();

function resolveWorkShellModeLabel(mode: string): string {
  const normalized = mode.trim().toLowerCase();
  if (normalized.length === 0) {
    return "";
  }

  const cached = modeLabelCache.get(normalized);
  if (cached !== undefined) {
    return cached;
  }

  const label = runRustCommandSync(
    ["rust", "ux", "text", "mode-label"],
    process.cwd(),
    normalized,
  ).trim();
  modeLabelCache.set(normalized, label);
  return label;
}
