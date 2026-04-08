import type { WorkspaceGuidance } from "@unclecode/context-broker";

export type { WorkspaceGuidance } from "@unclecode/context-broker";
export function clearWorkspaceGuidanceCache(cwd?: string): void;
export function loadWorkspaceGuidance(cwd: string): Promise<WorkspaceGuidance>;
