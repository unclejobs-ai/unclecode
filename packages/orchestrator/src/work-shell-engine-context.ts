import {
  formatScopedMemoryTransparencyLines,
  prefetchScopedMemory,
} from "@unclecode/context-broker";
import type { MemoryLineageAdapter } from "@unclecode/context-broker";

import { createCollapsedContextPanel } from "./work-shell-engine-panels.js";
import { runRustCommandSync } from "./rust-command.js";
import type { WorkShellPanel } from "./work-shell-engine.js";

type PrefetchScopedMemory = typeof prefetchScopedMemory;
type ListScopedMemoryLines = (input: {
  scope: "session" | "project" | "user" | "agent";
  cwd: string;
  sessionId?: string;
  agentId?: string;
  lineage?: MemoryLineageAdapter;
}) => Promise<readonly string[]>;

function formatMemoryLinesFromSummaries(input: {
  readonly scope: "session" | "project" | "user" | "agent";
  readonly summaries: readonly string[];
}): readonly string[] {
  return formatScopedMemoryTransparencyLines(
    input.summaries.map((summary, index) => ({
      scope: input.scope,
      memoryId: `memory:${input.scope}:1970-01-01T00:00:00.000Z:test${String(index + 1).padStart(4, "0")}`,
      summary,
      timestamp: "1970-01-01T00:00:00.000Z",
    })),
  );
}

function normalizeScopedMemoryLines(input: {
  readonly scope: "session" | "project" | "user" | "agent";
  readonly lines: readonly string[];
}): readonly string[] {
  if (input.lines.some((line) => line.includes(" · cite memory:"))) {
    return input.lines;
  }
  return formatMemoryLinesFromSummaries({ scope: input.scope, summaries: input.lines });
}

async function resolveWorkShellMemoryLines(input: {
  cwd: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
  prefetchScopedMemory?: PrefetchScopedMemory;
  lineage?: MemoryLineageAdapter;
  listScopedMemoryLines: ListScopedMemoryLines;
}): Promise<readonly string[]> {
  const prefetch = input.prefetchScopedMemory ?? prefetchScopedMemory;
  const memoryPrefetch = await prefetch({
    cwd: input.cwd,
    sessionId: input.sessionId,
    agentId: "work-shell",
    ...(input.env ? { env: input.env } : {}),
    ...(input.lineage ? { lineage: input.lineage } : {}),
  });

  if (memoryPrefetch.status !== "degraded" && memoryPrefetch.lines.length > 0) {
    return memoryPrefetch.lines;
  }

  const summaries = await input.listScopedMemoryLines({
    scope: "session",
    cwd: input.cwd,
    sessionId: input.sessionId,
    ...(input.lineage ? { lineage: input.lineage } : {}),
  });

  return normalizeScopedMemoryLines({ scope: "session", lines: summaries });
}

type BuildContextPanel = (
  contextSummaryLines: readonly string[],
  bridgeLines: readonly string[],
  memoryLines: readonly string[],
  traceLines: readonly string[],
  expanded?: boolean,
) => WorkShellPanel;

export function applyAuthIssueLinesToContextSummaryLines(
  currentContextSummaryLines: readonly string[],
  authIssueLines: readonly string[] = [],
): readonly string[] {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "context", "auth-issues"],
      process.cwd(),
      JSON.stringify({ currentContextSummaryLines, authIssueLines }),
    ),
  ) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { contextSummaryLines?: unknown }).contextSummaryLines) ||
    !(parsed as { contextSummaryLines: unknown[] }).contextSummaryLines.every((line) => typeof line === "string")
  ) {
    throw new Error("Rust auth issue context returned an invalid payload.");
  }
  return (parsed as { contextSummaryLines: string[] }).contextSummaryLines;
}

export async function loadInitialWorkShellContextState(input: {
  cwd: string;
  sessionId: string;
  currentContextSummaryLines: readonly string[];
  listProjectBridgeLines: (cwd: string) => Promise<readonly string[]>;
  listScopedMemoryLines: ListScopedMemoryLines;
  buildContextPanel: BuildContextPanel;
  env?: NodeJS.ProcessEnv;
  prefetchScopedMemory?: PrefetchScopedMemory;
  lineage?: MemoryLineageAdapter;
}): Promise<{
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
  readonly panel: WorkShellPanel;
}> {
  const [bridgeLines, memoryLines] = await Promise.all([
    input.listProjectBridgeLines(input.cwd),
    resolveWorkShellMemoryLines({
      cwd: input.cwd,
      sessionId: input.sessionId,
      listScopedMemoryLines: input.listScopedMemoryLines,
      ...(input.env ? { env: input.env } : {}),
      ...(input.prefetchScopedMemory ? { prefetchScopedMemory: input.prefetchScopedMemory } : {}),
      ...(input.lineage ? { lineage: input.lineage } : {}),
    }),
  ]);

  return {
    bridgeLines,
    memoryLines,
    panel: createCollapsedContextPanel({
      contextSummaryLines: input.currentContextSummaryLines,
      bridgeLines,
      memoryLines,
      traceLines: [],
      buildContextPanel: input.buildContextPanel,
    }),
  };
}

export async function loadWorkShellContextState(input: {
  cwd: string;
  sessionId: string;
  currentContextSummaryLines: readonly string[];
  reloadWorkspaceContext?: ((cwd: string) => Promise<readonly string[]>) | undefined;
  listProjectBridgeLines: (cwd: string) => Promise<readonly string[]>;
  listScopedMemoryLines: ListScopedMemoryLines;
  env?: NodeJS.ProcessEnv;
  prefetchScopedMemory?: PrefetchScopedMemory;
  lineage?: MemoryLineageAdapter;
}): Promise<{
  readonly contextSummaryLines: readonly string[];
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
}> {
  const [contextSummaryLines, bridgeLines, memoryLines] = await Promise.all([
    input.reloadWorkspaceContext
      ? input.reloadWorkspaceContext(input.cwd)
      : Promise.resolve(input.currentContextSummaryLines),
    input.listProjectBridgeLines(input.cwd),
    resolveWorkShellMemoryLines({
      cwd: input.cwd,
      sessionId: input.sessionId,
      listScopedMemoryLines: input.listScopedMemoryLines,
      ...(input.env ? { env: input.env } : {}),
      ...(input.prefetchScopedMemory ? { prefetchScopedMemory: input.prefetchScopedMemory } : {}),
      ...(input.lineage ? { lineage: input.lineage } : {}),
    }),
  ]);

  return {
    contextSummaryLines,
    bridgeLines,
    memoryLines,
  };
}

export async function reloadWorkShellContextState(input: {
  cwd: string;
  sessionId: string;
  currentContextSummaryLines: readonly string[];
  reloadWorkspaceContext?: ((cwd: string) => Promise<readonly string[]>) | undefined;
  listProjectBridgeLines: (cwd: string) => Promise<readonly string[]>;
  listScopedMemoryLines: ListScopedMemoryLines;
  traceLines: readonly string[];
  buildContextPanel: BuildContextPanel;
  expanded?: boolean | undefined;
  lineage?: MemoryLineageAdapter;
}): Promise<{
  readonly contextSummaryLines: readonly string[];
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
  readonly panel: WorkShellPanel;
}> {
  const { contextSummaryLines, bridgeLines, memoryLines } = await loadWorkShellContextState({
    cwd: input.cwd,
    sessionId: input.sessionId,
    currentContextSummaryLines: input.currentContextSummaryLines,
    reloadWorkspaceContext: input.reloadWorkspaceContext,
    listProjectBridgeLines: input.listProjectBridgeLines,
    listScopedMemoryLines: input.listScopedMemoryLines,
    ...(input.lineage ? { lineage: input.lineage } : {}),
  });

  return {
    contextSummaryLines,
    bridgeLines,
    memoryLines,
    panel: createCollapsedContextPanel({
      contextSummaryLines,
      bridgeLines,
      memoryLines,
      traceLines: input.traceLines,
      buildContextPanel: input.buildContextPanel,
      ...(input.expanded ? { expanded: true } : {}),
    }),
  };
}
