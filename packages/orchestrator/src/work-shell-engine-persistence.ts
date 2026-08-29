import type { AgentConsoleSnapshot, ModeReasoningEffort } from "@unclecode/contracts";
import type { WorkShellChatEntry, WorkShellTraceMode } from "./work-shell-engine.js";

export type WorkShellSessionState =
  | "running"
  | "pause_pending"
  | "paused"
  | "idle"
  | "requires_action";

export type WorkShellSessionSnapshotInput = {
  cwd: string;
  sessionId: string;
  model: string;
  mode: string;
  state: WorkShellSessionState;
  summary: string;
  traceMode: WorkShellTraceMode;
  reasoningEffort?: ModeReasoningEffort | undefined;
  lastSubmittedContextReceiptId?: string | undefined;
  entries?: readonly WorkShellChatEntry[] | undefined;
  agentConsole?: AgentConsoleSnapshot | undefined;
  pauseCheckpoint?: WorkShellDurablePauseCheckpoint | undefined;
};

export type WorkShellDurablePauseCheckpoint = {
  readonly turnId: string;
  readonly boundary: string;
  readonly activeNode?: { readonly id: string; readonly attempt: number } | undefined;
  readonly currentStage?: string | undefined;
  readonly gateStatus?: string | undefined;
  readonly iteration?: number | undefined;
  readonly decisionId?: string | undefined;
  readonly contextReceiptId?: string | undefined;
  readonly attachmentRefs: readonly string[];
  readonly artifactRefs: readonly string[];
};

export function createWorkShellSessionSnapshotInput(
  input: WorkShellSessionSnapshotInput,
): WorkShellSessionSnapshotInput {
  return input;
}
