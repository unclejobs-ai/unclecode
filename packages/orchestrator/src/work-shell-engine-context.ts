import { createCollapsedContextPanel } from "./work-shell-engine-panels.js";
import { loadWorkShellContextState } from "./work-shell-engine-persistence.js";
import type { WorkShellPanel } from "./work-shell-engine.js";

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
  const nonAuthIssueLines = currentContextSummaryLines.filter((line) => !line.startsWith("Auth issue:"));
  return [...authIssueLines, ...nonAuthIssueLines];
}

export async function loadInitialWorkShellContextState(input: {
  cwd: string;
  sessionId: string;
  currentContextSummaryLines: readonly string[];
  listProjectBridgeLines: (cwd: string) => Promise<readonly string[]>;
  listScopedMemoryLines: (input: {
    scope: "session" | "project" | "user" | "agent";
    cwd: string;
    sessionId?: string;
    agentId?: string;
  }) => Promise<readonly string[]>;
  buildContextPanel: BuildContextPanel;
}): Promise<{
  readonly bridgeLines: readonly string[];
  readonly memoryLines: readonly string[];
  readonly panel: WorkShellPanel;
}> {
  const [bridgeLines, memoryLines] = await Promise.all([
    input.listProjectBridgeLines(input.cwd),
    input.listScopedMemoryLines({ scope: "session", cwd: input.cwd, sessionId: input.sessionId }),
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

export async function reloadWorkShellContextState(input: {
  cwd: string;
  sessionId: string;
  currentContextSummaryLines: readonly string[];
  reloadWorkspaceContext?: ((cwd: string) => Promise<readonly string[]>) | undefined;
  listProjectBridgeLines: (cwd: string) => Promise<readonly string[]>;
  listScopedMemoryLines: (input: {
    scope: "session" | "project" | "user" | "agent";
    cwd: string;
    sessionId?: string;
    agentId?: string;
  }) => Promise<readonly string[]>;
  traceLines: readonly string[];
  buildContextPanel: BuildContextPanel;
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
    }),
  };
}
