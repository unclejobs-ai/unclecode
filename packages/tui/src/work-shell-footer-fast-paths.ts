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
  void input.model;
  void input.reasoningLabel;
  void input.mode;
  void input.authLabel;
  void input.composerHint;

  const compactPath = compactWorkShellPath(input.cwd, input.home);
  const contextChip = compactWorkShellFooterContextChip(input.contextIndicator);
  const footer = joinFooterParts([compactPath, contextChip]);
  return input.width === undefined ? footer : truncateForDisplayWidth(footer, input.width);
}

export function formatWorkShellSessionFactsGroup(input: {
  readonly model: string;
  readonly mode: string;
}): string {
  return joinFooterFacts([
    input.model.trim(),
    humanizeWorkShellModeLabel(input.mode),
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
  const firstSegment = normalized.split(/\s·\s/u)[0]?.trim();
  return firstSegment && firstSegment.length > 0 ? firstSegment : normalized;
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
  switch (mode.toLowerCase()) {
    case "default":
      return "작업 모드";
    case "search":
      return "탐색 모드";
    case "analyze":
      return "분석 모드";
    case "ultrawork":
      return "집중 작업 모드";
    case "yolo":
      return "YOLO 모드";
    case "plan":
      return "계획 모드";
    case "build":
      return "구현 모드";
    default:
      return `${mode} mode`;
  }
}
