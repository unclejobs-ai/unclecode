import type { AgentConsoleSnapshot, ModeReasoningEffort } from "@unclecode/contracts";
import type { WorkShellChatEntry, WorkShellTraceMode } from "./work-shell-engine.js";
import type { WorkShellUiLocale } from "./work-shell-locale.js";

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
  uiLocale: WorkShellUiLocale;
  reasoningEffort?: ModeReasoningEffort | undefined;
  lastSubmittedContextReceiptId?: string | undefined;
  ownerMutationRevision?: number | undefined;
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

export type WorkShellReplaySafePauseCheckpoint = WorkShellDurablePauseCheckpoint & {
  readonly boundary: "before_approval";
  readonly decisionId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength = 512): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

function boundedRefs(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const refs = value.flatMap((item) => {
    const ref = boundedString(item);
    return ref ? [ref] : [];
  });
  return refs.length === value.length ? refs : undefined;
}

/**
 * A crashed JS continuation cannot be recreated. The one restart projection we
 * can retain without replaying provider/tool work is the question immediately
 * before approval, and only when its durable identity still matches the
 * sanitized console decision presented to the operator.
 */
export function parseWorkShellReplaySafePauseCheckpoint(
  value: unknown,
  pendingDecisionId: string | undefined,
): WorkShellReplaySafePauseCheckpoint | undefined {
  if (!isRecord(value) || value.boundary !== "before_approval") return undefined;
  const turnId = boundedString(value.turnId);
  const decisionId = boundedString(value.decisionId);
  const attachmentRefs = boundedRefs(value.attachmentRefs);
  const artifactRefs = boundedRefs(value.artifactRefs);
  if (!turnId || !decisionId || decisionId !== pendingDecisionId || !attachmentRefs || !artifactRefs) {
    return undefined;
  }
  const optionalStrings = ["currentStage", "gateStatus", "contextReceiptId"] as const;
  for (const key of optionalStrings) {
    if (value[key] !== undefined && !boundedString(value[key])) return undefined;
  }
  if (value.iteration !== undefined && (!Number.isSafeInteger(value.iteration) || Number(value.iteration) < 0)) {
    return undefined;
  }
  let activeNode: { readonly id: string; readonly attempt: number } | undefined;
  if (value.activeNode !== undefined) {
    if (!isRecord(value.activeNode)) return undefined;
    const id = boundedString(value.activeNode.id);
    if (!id || !Number.isSafeInteger(value.activeNode.attempt) || Number(value.activeNode.attempt) < 0) {
      return undefined;
    }
    activeNode = { id, attempt: Number(value.activeNode.attempt) };
  }
  return {
    turnId,
    boundary: "before_approval",
    decisionId,
    ...(activeNode ? { activeNode } : {}),
    ...(boundedString(value.currentStage) ? { currentStage: String(value.currentStage) } : {}),
    ...(boundedString(value.gateStatus) ? { gateStatus: String(value.gateStatus) } : {}),
    ...(value.iteration !== undefined ? { iteration: Number(value.iteration) } : {}),
    ...(boundedString(value.contextReceiptId) ? { contextReceiptId: String(value.contextReceiptId) } : {}),
    attachmentRefs,
    artifactRefs,
  };
}

export function createWorkShellSessionSnapshotInput(
  input: WorkShellSessionSnapshotInput,
): WorkShellSessionSnapshotInput {
  return input;
}
