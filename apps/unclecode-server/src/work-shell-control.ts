import type { RuntimeSessionSource } from "./control-room.js";
import { LiveRuntimeControlRegistry } from "./persistent-runtime.js";
import type { RuntimeControlRequest, RuntimeControlResult } from "./runtime-adapter.js";
import type { RuntimeSessionRevisionClock } from "./runtime-engine-rpc.js";
import { RuntimeSessionMutationArbiter } from "./runtime-mutation-arbiter.js";

type DecisionOption = { readonly label: string };
type PendingDecision = {
  readonly kind: "security-approval" | "user-decision";
  readonly questions: readonly { readonly options: readonly DecisionOption[] }[];
};

export type WorkShellControlEngine = {
  getState(): {
    readonly isBusy: boolean;
    readonly queuePaused: boolean;
    readonly model: string;
    readonly mode: string;
    readonly uiLocale: "en" | "ko";
    readonly agentConsole: Readonly<Record<string, unknown>> & { readonly pendingDecision?: PendingDecision | undefined };
  };
  subscribe(listener: () => void): () => void;
  interruptTurn(): void;
  getTurnLifecycle(): {
    readonly state: "idle" | "running" | "pause_pending" | "paused" | "cancelled" | "completed";
    readonly turnId?: string | undefined;
    readonly boundary?: string | undefined;
  };
  requestTurnPause(): Promise<{ readonly turnId: string; readonly boundary: string }>;
  resumeTurn(): boolean;
  resumeQueueItems(): Promise<void>;
  handleSubmit(message: string): Promise<void>;
  answerPendingDecisionByIndex(index: number): boolean;
  getAgentControlPort(): {
    steer(agentRunId: string, message: string): Promise<{ readonly status: string; readonly message?: string }>;
  };
};

export type WorkShellRuntimeChange = {
  readonly sessionId: string;
  readonly revision: number;
  readonly state: RuntimeSessionSource["state"];
};

function messageFrom(request: RuntimeControlRequest): string | undefined {
  const value = request.payload?.message;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stateOf(engine: WorkShellControlEngine): RuntimeSessionSource["state"] {
  const state = engine.getState();
  const lifecycle = engine.getTurnLifecycle();
  if (lifecycle.state === "pause_pending" || lifecycle.state === "paused" || lifecycle.state === "cancelled") {
    return lifecycle.state;
  }
  if (state.agentConsole.pendingDecision) return "requires_action";
  if (lifecycle.state === "running" || state.isBusy) return "running";
  return "idle";
}

export function attachWorkShellRuntime(
  registry: LiveRuntimeControlRegistry,
  input: {
    readonly sessionId: string;
    readonly projectPath: string;
    readonly engine: WorkShellControlEngine;
    readonly provider?: string;
    readonly initialRevision?: number;
    readonly revisionClock?: RuntimeSessionRevisionClock | undefined;
    readonly mutationArbiter?: RuntimeSessionMutationArbiter | undefined;
    readonly onChanged?: ((event: WorkShellRuntimeChange) => void) | undefined;
  },
): () => void {
  const revisionClock = input.revisionClock ?? { value: Math.max(0, input.initialRevision ?? 0) };
  const mutationArbiter = input.mutationArbiter ?? new RuntimeSessionMutationArbiter(revisionClock);

  const emit = () => input.onChanged?.({
    sessionId: input.sessionId,
    revision: revisionClock.value,
    state: stateOf(input.engine),
  });
  const unsubscribe = input.engine.subscribe(() => {
    if (!input.mutationArbiter) mutationArbiter.publishAutonomous();
    if (!mutationArbiter.isMutationActive() || stateOf(input.engine) === "pause_pending") emit();
  });

  const snapshot = (): RuntimeSessionSource => {
    const state = input.engine.getState();
    return {
      sessionId: input.sessionId,
      projectPath: input.projectPath,
      locale: state.uiLocale,
      state: stateOf(input.engine),
      revision: revisionClock.value,
      updatedAt: new Date().toISOString(),
      metadata: {
        model: state.model,
        mode: state.mode,
        ...(input.provider ? { provider: input.provider } : {}),
      },
      agentConsole: state.agentConsole,
      context: { included: [], excluded: [], compacted: false },
    };
  };

  const deny = (code: "denied" | "invalid_action", message: string): RuntimeControlResult => ({
    ok: false,
    code,
    message,
    revision: revisionClock.value,
  });

  const detachRegistry = registry.attach(input.sessionId, {
    revision: () => revisionClock.value,
    mutationArbiter,
    snapshot,
    onCommitted(result) {
      if (result.ok) emit();
    },
    async control(request) {
      let result: RuntimeControlResult | undefined;
      try {
        if (request.action === "pause") {
          if (!input.engine.getState().isBusy) return deny("invalid_action", "Only a running turn can be paused.");
          await input.engine.requestTurnPause();
        } else if (request.action === "resume") {
          if (!input.engine.resumeTurn()) return deny("invalid_action", "Only a cooperatively paused turn can be resumed.");
        } else if (request.action === "cancel") {
          if (input.engine.getState().isBusy) input.engine.interruptTurn();
        } else if (request.action === "follow-up") {
          const message = messageFrom(request);
          if (!message) return deny("invalid_action", "A follow-up message is required.");
          await input.engine.handleSubmit(message);
        } else if (request.action === "steer") {
          const message = messageFrom(request);
          const agentRunId = request.payload?.agentRunId;
          if (!message || typeof agentRunId !== "string" || agentRunId.trim().length === 0) {
            return deny("invalid_action", "Steer requires an explicit agentRunId and message.");
          }
          const receipt = await input.engine.getAgentControlPort().steer(agentRunId.trim(), message);
          if (receipt.status !== "delivered") return deny("denied", receipt.message ?? "The steer was not delivered.");
        } else if (request.action === "approve") {
          const pending = input.engine.getState().agentConsole.pendingDecision;
          if (request.payload?.decision !== "approve_once" || pending?.kind !== "security-approval" || pending.questions.length !== 1) {
            return deny("denied", "Only an explicit one-shot security approval can be approved here.");
          }
          const index = pending.questions[0]?.options.findIndex(option => option.label === "Approve") ?? -1;
          if (index < 0 || !input.engine.answerPendingDecisionByIndex(index + 1)) {
            return deny("denied", "The security approval is no longer pending.");
          }
        } else {
          return deny("invalid_action", "Unknown runtime action.");
        }
        result = { ok: true, revision: revisionClock.value, state: stateOf(input.engine) };
      } catch (error) {
        return deny("invalid_action", error instanceof Error ? error.message : String(error));
      }
      return result ?? deny("invalid_action", "The runtime action did not complete.");
    },
  });

  return () => {
    unsubscribe();
    detachRegistry();
  };
}
