import path from "node:path";

import { runRustCommandSync } from "@unclecode/orchestrator";
import { formatWorkShellModeLabelForLocale } from "@unclecode/orchestrator";

import type { GitFacts } from "./facts.js";
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
  /** Branch name for callers that have no structured read. `gitFacts` wins. */
  readonly branch?: string;
  readonly modelWindow?: number;
  readonly gitFacts?: GitFacts;
  /**
   * Session spend, already formatted by the Agent Console's own aggregate
   * (`formatAgentConsoleTotalCost`). A string rather than a number because the
   * console owns both the summation and the `$` rendering, and the footer must
   * not become a second answer to "what has this session cost".
   */
  readonly cost?: string;
  /** Last completed provider turn, preformatted for the status line. */
  readonly performance?: string;
}): string {
  void input.model;
  void input.reasoningLabel;
  void input.mode;
  void input.authLabel;
  void input.composerHint;

  const fullPath = compactWorkShellPath(input.cwd, input.home);
  const contextChip = compactWorkShellFooterContextChip(input.contextIndicator);
  // Path · branch on the left, budget on the right — the shape every terminal
  // agent settles on, because "which checkout am I in" and "how full is the
  // window" are the two things worth a permanent slot. The dirty counts ride
  // with the branch: they answer "is this checkout safe to switch" and nothing
  // else on screen carries them.
  const budget = formatWorkShellBudgetChip(input.contextIndicator, input.modelWindow);
  const dirty = formatWorkShellDirtyMarkers(input.gitFacts);
  const workspace = joinFooterWords([
    (input.gitFacts?.branch ?? input.branch)?.trim(),
    dirty,
  ]);
  const cost = input.cost?.trim();
  const performance = input.performance?.trim();

  const left = (
    workspacePath: string | undefined,
    workspaceFacts = workspace,
    withContext = true,
  ) => joinFooterParts([
    workspacePath,
    workspaceFacts || undefined,
    withContext && !budget ? contextChip : undefined,
  ]);
  const right = (withBudget: boolean, withPerformance: boolean, withCost: boolean) => joinFooterFacts([
    withBudget ? budget : undefined,
    withPerformance ? performance : undefined,
    withCost ? cost : undefined,
  ]);

  if (input.width === undefined) {
    return joinFooterParts([left(fullPath), right(true, true, true)]);
  }

  // Degradation order. Directories go first, then cost, then the entire path.
  // At the narrowest widths the branch yields before dirty markers and budget:
  // those are the two facts the operator cannot reconstruct elsewhere.
  const basePath = footerPathBasename(fullPath);
  for (const candidate of [
    { path: fullPath, workspace, budget: true, performance: true, cost: true, context: true },
    { path: basePath, workspace, budget: true, performance: true, cost: true, context: true },
    // Last-turn latency/cache is actionable and cannot be reconstructed from
    // another surface. Prefer it over the window fraction at medium widths.
    ...(performance
      ? [
          { path: basePath, workspace, budget: false, performance: true, cost: true, context: false },
          { path: undefined, workspace, budget: false, performance: true, cost: true, context: false },
        ]
      : []),
    { path: basePath, workspace, budget: true, performance: false, cost: true, context: true },
    { path: basePath, workspace, budget: true, performance: false, cost: false, context: true },
    { path: undefined, workspace, budget: true, performance: false, cost: false, context: true },
    ...(budget
      ? [{ path: undefined, workspace: dirty ?? workspace, budget: true, performance: false, cost: false, context: false }]
      : []),
    { path: basePath, workspace, budget: false, performance: false, cost: false, context: false },
    { path: undefined, workspace, budget: false, performance: false, cost: false, context: false },
  ]) {
    const leftGroup = left(candidate.path, candidate.workspace, candidate.context);
    const rightGroup = right(candidate.budget, candidate.performance, candidate.cost);
    const leftWidth = getDisplayWidth(leftGroup);
    const rightWidth = getDisplayWidth(rightGroup);
    if (rightGroup.length === 0) {
      if (leftWidth <= input.width) {
        return leftGroup;
      }
      continue;
    }
    if (leftWidth + 2 + rightWidth <= input.width) {
      const gap = input.width - leftWidth - rightWidth;
      return `${leftGroup}${" ".repeat(gap)}${rightGroup}`;
    }
  }

  const rightGroup = right(true, false, false);
  const rightWidth = getDisplayWidth(rightGroup);
  if (rightWidth >= input.width) {
    return truncateForDisplayWidth(rightGroup, input.width);
  }
  const priorityLeft = dirty ?? workspace;
  const clipped = truncateForDisplayWidth(priorityLeft, Math.max(0, input.width - rightWidth - 2));
  if (rightGroup.length === 0) {
    return clipped;
  }
  const gap = Math.max(2, input.width - getDisplayWidth(clipped) - rightWidth);
  return truncateForDisplayWidth(`${clipped}${" ".repeat(gap)}${rightGroup}`, input.width);
}

/** `*90 +2 ?34` — staged, unstaged, untracked, each omitted at zero. */
function formatWorkShellDirtyMarkers(gitFacts: GitFacts | undefined): string | undefined {
  if (gitFacts === undefined) {
    return undefined;
  }
  const markers = joinFooterWords([
    gitFacts.staged > 0 ? `*${gitFacts.staged}` : undefined,
    gitFacts.unstaged > 0 ? `+${gitFacts.unstaged}` : undefined,
    gitFacts.untracked > 0 ? `?${gitFacts.untracked}` : undefined,
  ]);
  return markers.length > 0 ? markers : undefined;
}

function footerPathBasename(compactPath: string | undefined): string | undefined {
  if (compactPath === undefined) {
    return undefined;
  }
  const segments = compactPath.split(/[\\/]/u).filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  return last === undefined || last === "~" ? compactPath : last;
}

function joinFooterWords(parts: readonly (string | undefined)[]): string {
  return parts
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join(" ");
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
  readonly uiLocale?: "en" | "ko";
}): string {
  return joinFooterFacts([
    input.model.trim(),
    resolveWorkShellModeLabel(input.mode, input.uiLocale ?? "en"),
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
const MODE_LABEL_CACHE_MAX_ENTRIES = 32;

function resolveWorkShellModeLabel(mode: string, uiLocale: "en" | "ko"): string {
  const normalized = mode.trim().toLowerCase();
  if (normalized.length === 0) {
    return "";
  }

  const cacheKey = `${uiLocale}:${normalized}`;
  const cached = modeLabelCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const label = formatWorkShellModeLabelForLocale(normalized, uiLocale);
  if (modeLabelCache.has(cacheKey)) modeLabelCache.delete(cacheKey);
  modeLabelCache.set(cacheKey, label);
  while (modeLabelCache.size > MODE_LABEL_CACHE_MAX_ENTRIES) {
    modeLabelCache.delete(modeLabelCache.keys().next().value as string);
  }
  return label;
}
