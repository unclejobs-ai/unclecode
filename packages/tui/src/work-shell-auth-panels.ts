import { runRustCommandSync } from "@unclecode/orchestrator";

import { getDisplayWidth, truncateForDisplayWidth } from "./text-width.js";
import type { WorkShellPanel } from "./work-shell-view.js";

export function formatAuthLabelForDisplay(authLabel: string): string {
  return runRustCommandSync(["rust", "ux", "auth-label"], process.cwd(), authLabel).trimEnd();
}

function resolveAuthLauncherLines(input: {
  readonly mode: "default" | "normalize";
  readonly lines?: readonly string[];
  readonly authLabel?: string;
  readonly browserOAuthAvailable: boolean;
  readonly oauthRoute?: string;
}): readonly string[] | undefined {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "auth-launcher-lines"],
      process.cwd(),
      JSON.stringify(input),
    ),
  ) as { lines?: unknown };
  if (parsed.lines === null || parsed.lines === undefined) {
    return undefined;
  }
  if (!Array.isArray(parsed.lines) || !parsed.lines.every((line) => typeof line === "string")) {
    throw new Error("Rust auth launcher lines returned an invalid payload.");
  }
  return parsed.lines;
}

export function buildDefaultAuthLauncherLines(
  authLabel?: string,
  browserOAuthAvailable = true,
  oauthRoute?: string,
): readonly string[] {
  return resolveAuthLauncherLines({
    mode: "default",
    ...(authLabel ? { authLabel } : {}),
    browserOAuthAvailable,
    ...(oauthRoute ? { oauthRoute } : {}),
  }) ?? [];
}

export function extractAuthLabel(lines: readonly string[]): string | undefined {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "auth-extract-label"],
      process.cwd(),
      JSON.stringify(lines),
    ),
  ) as { authLabel?: unknown };
  if (parsed.authLabel === null || parsed.authLabel === undefined) {
    return undefined;
  }
  if (typeof parsed.authLabel !== "string") {
    throw new Error("Rust auth label extraction returned an invalid payload.");
  }
  return parsed.authLabel;
}

export function normalizeAuthLauncherLines(input: {
  readonly lines?: readonly string[];
  readonly authLabel?: string;
  readonly browserOAuthAvailable: boolean;
}): readonly string[] | undefined {
  return resolveAuthLauncherLines({
    mode: "normalize",
    ...(input.lines ? { lines: input.lines } : {}),
    ...(input.authLabel ? { authLabel: input.authLabel } : {}),
    browserOAuthAvailable: input.browserOAuthAvailable,
  });
}

export function isAuthStatusInlineCommand(args: readonly string[]): boolean {
  return args[0] === "auth" && args[1] === "status";
}

export function refineAuthStatusPanelLines(input: {
  readonly lines: readonly string[];
  readonly browserOAuthAvailable: boolean;
}): readonly string[] {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "auth-status-panel-lines"],
      process.cwd(),
      JSON.stringify(input),
    ),
  ) as { lines?: unknown };
  if (!Array.isArray(parsed.lines) || !parsed.lines.every((line) => typeof line === "string")) {
    throw new Error("Rust auth status panel lines returned an invalid payload.");
  }
  return parsed.lines;
}

export function refineAuthBrowserFailureLines(input: {
  readonly args: readonly string[];
  readonly lines: readonly string[];
  readonly failed: boolean;
  readonly authLabel: string;
}): readonly string[] {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "ux", "auth-browser-failure-lines"],
      process.cwd(),
      JSON.stringify(input),
    ),
  ) as { lines?: unknown };
  if (!Array.isArray(parsed.lines) || !parsed.lines.every((line) => typeof line === "string")) {
    throw new Error("Rust auth browser failure lines returned an invalid payload.");
  }
  return parsed.lines;
}

function normalizeVisibleLine(line: string): string {
  const trimmed = line.trim();
  const dedupeCommaList = (prefix: string): string => {
    if (!trimmed.startsWith(prefix)) {
      return trimmed;
    }
    const items = trimmed.slice(prefix.length).split(",").map((value) => value.trim()).filter((value) => value.length > 0);
    const unique = items.filter((value, index) => items.indexOf(value) === index);
    return `${prefix}${unique.join(", ")}`;
  };

  return dedupeCommaList("Loaded guidance: ");
}

export function dedupeVisibleLines(lines: readonly string[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const line of lines.map((value) => normalizeVisibleLine(value)).filter((value) => value.length > 0)) {
    if (seen.has(line)) {
      continue;
    }
    seen.add(line);
    result.push(line);
  }
  return result;
}

export function compactContextValue(label: string, value: string): string {
  const normalized = value
    .replace(/^Auth issue:\s*/i, "")
    .replace(/^Loaded guidance:\s*/i, "")
    .replace(/^Loaded extension:\s*/i, "ext ")
    .replace(/^Loaded skills:\s*/i, "skills ")
    .replace(/^Skill catalog:\s*/i, "skills ")
    .replace(/^AGENTS\.md:\s*/i, "AGENTS: ")
    .replace(/^CLAUDE\.md:\s*/i, "CLAUDE: ");
  const limit = label === "Issue" ? 35 : 36;
  if (getDisplayWidth(normalized) <= limit) {
    return normalized;
  }
  return truncateForDisplayWidth(normalized, limit);
}
