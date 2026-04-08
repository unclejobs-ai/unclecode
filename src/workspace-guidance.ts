import {
  clearCachedWorkspaceGuidance,
  loadCachedWorkspaceGuidance,
  type WorkspaceGuidance,
} from "@unclecode/context-broker";

export type { WorkspaceGuidance };

export function clearWorkspaceGuidanceCache(cwd?: string): void {
  clearCachedWorkspaceGuidance(cwd, process.env.HOME);
}

export async function loadWorkspaceGuidance(cwd: string): Promise<WorkspaceGuidance> {
  return loadCachedWorkspaceGuidance({
    cwd,
    ...(process.env.HOME ? { userHomeDir: process.env.HOME } : {}),
  });
}
