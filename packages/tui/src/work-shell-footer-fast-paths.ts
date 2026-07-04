import path from "node:path";

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
}): string {
  const compactPath = compactWorkShellPath(input.cwd, input.home);
  const reasoningLabel = compactWorkShellReasoningLabel(input.reasoningLabel);
  const hasContextIndicator = (input.contextIndicator?.trim().length ?? 0) > 0;
  const fullStatusLine = formatWorkShellStatusLineFast(
    input.model,
    reasoningLabel,
    input.mode,
    input.authLabel,
    { includeContext: !hasContextIndicator },
  );
  const fullCoreFooter = joinFooterParts([compactPath, fullStatusLine]);
  const statusLine = input.width !== undefined && getDisplayWidth(fullCoreFooter) > input.width
    ? fullStatusLine.replace(" · work context", " · context")
    : fullStatusLine;
  const coreFooter = joinFooterParts([compactPath, statusLine]);
  const fullFooter = joinFooterParts([
    coreFooter,
    input.contextIndicator,
  ]);
  // Overflow fallbacks keep cwd anchored first (footer contract shared with
  // the Rust footer path): drop the reasoning fact, then the context
  // indicator — never the cwd. Composer hints live above the prompt deck.
  const cwdContextFooter = joinFooterParts([
    compactPath,
    statusLine,
    input.contextIndicator,
  ]);
  const slimStatusLine = formatWorkShellStatusLineFast(
    input.model,
    "",
    input.mode,
    input.authLabel,
    { includeContext: false },
  );
  const slimCwdContextFooter = hasContextIndicator
    ? joinFooterParts([compactPath, slimStatusLine, input.contextIndicator])
    : "";
  const overflows = input.width !== undefined && getDisplayWidth(fullFooter) > input.width;
  let footer = fullFooter;
  if (overflows && cwdContextFooter.length > 0 && getDisplayWidth(cwdContextFooter) <= input.width) {
    footer = cwdContextFooter;
  } else if (overflows && slimCwdContextFooter.length > 0 && getDisplayWidth(slimCwdContextFooter) <= input.width) {
    footer = slimCwdContextFooter;
  } else if (overflows && getDisplayWidth(coreFooter) <= input.width) {
    footer = coreFooter;
  }
  return input.width === undefined ? footer : truncateForDisplayWidth(footer, input.width);
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

function formatWorkShellStatusLineFast(
  model: string,
  reasoningLabel: string,
  mode: string,
  authLabel: string,
  options: { readonly includeContext: boolean },
): string {
  return joinFooterFacts([
    model,
    reasoningLabel,
    humanizeWorkShellModeLabel(mode),
    compactWorkShellAuthLabel(authLabel),
    options.includeContext ? "work context" : undefined,
  ]);
}

function compactWorkShellReasoningLabel(reasoningLabel: string): string {
  const normalized = reasoningLabel.trim().toLowerCase();
  if (!normalized || normalized.includes("unsupported") || normalized.includes("unavailable")) {
    return "Reasoning off";
  }
  if (normalized.startsWith("low") || normalized.startsWith("light")) {
    return "Light";
  }
  if (normalized.startsWith("medium") || normalized.startsWith("balanced")) {
    return "Balanced";
  }
  if (normalized.startsWith("high") || normalized.startsWith("deep")) {
    return "Deep";
  }
  return reasoningLabel.trim();
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
      return "OAuth blocked";
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

function humanizeWorkShellModeLabel(mode: string): string {
  switch (mode) {
    case "default":
      return "Work mode";
    case "search":
      return "Search mode";
    case "analyze":
      return "Analyze mode";
    case "ultrawork":
      return "Parallel mode";
    case "yolo":
      return "YOLO mode";
    default:
      return `${mode} mode`;
  }
}
