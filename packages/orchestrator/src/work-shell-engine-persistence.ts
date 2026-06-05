import type { WorkShellChatEntry, WorkShellTraceMode } from "./work-shell-engine.js";

export type WorkShellSessionSnapshotInput = {
  cwd: string;
  sessionId: string;
  model: string;
  mode: string;
  state: "running" | "idle" | "requires_action";
  summary: string;
  traceMode: WorkShellTraceMode;
  reasoningEffort?: "low" | "medium" | "high" | undefined;
  entries?: readonly WorkShellChatEntry[] | undefined;
};

export function createWorkShellSessionSnapshotInput(
  input: WorkShellSessionSnapshotInput,
): WorkShellSessionSnapshotInput {
  return input;
}
