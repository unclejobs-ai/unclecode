import type {
  AgentRun,
  AgentRunSettledTraceEvent,
  AgentRunStartedTraceEvent,
  JobQueuedTraceEvent,
  JobSettledTraceEvent,
} from "@unclecode/contracts";

export type ExecutorLifecycleTraceEvent =
  | JobQueuedTraceEvent
  | JobSettledTraceEvent
  | AgentRunStartedTraceEvent
  | AgentRunSettledTraceEvent;

export type ExecutorLifecycle = {
  readonly jobId: string;
  readonly runId: string;
  readonly label: string;
  readonly startedAt: number;
};

/**
 * Stand-in for a provider prompt built from operator control text. Steering and
 * continuation prompts carry raw operator input, so the prompt never reaches
 * the trace stream even though the provider turn really used it.
 */
export const REDACTED_CONTROL_PROMPT = "[operator control message redacted]";

/**
 * Longest operator control message handed to a provider. Steering and
 * continuation text is operator prose, not a payload: cap it so one paste
 * cannot dominate a worker's context window.
 */
export const MAX_AGENT_CONTROL_MESSAGE_CHARS = 4_000;

/** Trim, then cap. Blank input is the caller's signal to reject the control. */
export function boundControlMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > MAX_AGENT_CONTROL_MESSAGE_CHARS
    ? trimmed.slice(0, MAX_AGENT_CONTROL_MESSAGE_CHARS)
    : trimmed;
}

export const STEER_PROMPT_SUFFIX = "Continue the assigned task. Report only the updated result.";

export function buildContinuationPrompt(source: AgentRun, guidance: string | undefined): string {
  const priorResult = boundControlMessage(source.summary ?? "");
  return [
    `Continue the earlier agent run "${source.displayName}".`,
    `Previous result:\n${priorResult || "No prior result was recorded."}`,
    ...(guidance ? [`Operator guidance:\n${guidance}`] : []),
    STEER_PROMPT_SUFFIX,
  ].join("\n\n");
}

/**
 * Lifecycle families name their own owner in `runId`/`jobId`, so the executor
 * boundary leaves them untouched. A nested job an executor queues belongs to
 * the nested run; stamping the parent's ids over it would make the console
 * reject that nested run as owned by somebody else.
 */
const SELF_OWNED_TRACE_TYPES: Record<string, true> = {
  "job.queued": true,
  "job.settled": true,
  "agent.run.started": true,
  "agent.run.settled": true,
};

/** Ownership every executor-originated trace carries once it crosses the boundary. */
type ExecutorTraceOwnership = {
  readonly agentRunId: string;
  readonly asyncJobId: string;
};

export type ExecutorTraceScope = ExecutorTraceOwnership & {
  readonly redactPrompt: boolean;
};

/**
 * Reads an ownership id the producer already set. Blank counts as absent, the
 * same test the console applies: it drops usage whose `agentRunId` is present
 * but empty, so honouring such an id would silently lose the measurement.
 */
function readTraceOwner(
  event: { readonly type: string },
  key: keyof ExecutorTraceOwnership,
): string | undefined {
  if (!Object.hasOwn(event, key)) {
    return undefined;
  }
  const value: unknown = Reflect.get(event, key);
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Whether an event was produced inside an executor run rather than by the main
 * shell. The shell uses this to keep executor output out of the main
 * transcript and busy clock while still reducing it into the Agent Console.
 * Lifecycle records are excluded even though they carry `agentRunId`: they are
 * the console's own spine and must reduce like any other shell event.
 */
export function isExecutorScopedTraceEvent(event: { readonly type: string }): boolean {
  return !SELF_OWNED_TRACE_TYPES[event.type] && readTraceOwner(event, "agentRunId") !== undefined;
}

export function settleExecutorLifecycle(input: {
  readonly lifecycle: ExecutorLifecycle;
  readonly status: "completed" | "failed" | "cancelled" | "interrupted";
  readonly completedAt: number;
  readonly summary?: string | undefined;
  readonly errorSummary?: string | undefined;
}): readonly [AgentRunSettledTraceEvent, JobSettledTraceEvent] {
  const { lifecycle } = input;
  return [
    {
      type: "agent.run.settled",
      level: "high-signal",
      eventId: `${lifecycle.runId}:settled`,
      runId: lifecycle.runId,
      jobId: lifecycle.jobId,
      status: input.status,
      startedAt: lifecycle.startedAt,
      completedAt: input.completedAt,
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.errorSummary ? { errorSummary: input.errorSummary } : {}),
    },
    {
      type: "job.settled",
      level: "default",
      eventId: `${lifecycle.jobId}:settled`,
      jobId: lifecycle.jobId,
      agentRunId: lifecycle.runId,
      status: input.status,
      startedAt: lifecycle.startedAt,
      completedAt: input.completedAt,
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.errorSummary ? { errorSummary: input.errorSummary } : {}),
    },
  ];
}

/**
 * Attributes one trace to the agent run that produced it. A producer that
 * already named its owner keeps it; lifecycle records name theirs in their own
 * fields and are left alone.
 */
export function attributeTraceToAgentRun<Event extends { readonly type: string }>(
  event: Event,
  agentRunId: string,
): Event | (Event & { readonly agentRunId: string }) {
  if (SELF_OWNED_TRACE_TYPES[event.type]) {
    return event;
  }
  return readTraceOwner(event, "agentRunId") ? event : { ...event, agentRunId };
}

/**
 * Scopes one executor trace to the run and job that own it. Every family an
 * executor can emit is stamped, not just the ones the console groups today:
 * an unowned `assistant.delta` or `usage.recorded` reads as main-session work
 * and books an executor's output against the shell. When the turn was built
 * from operator control text, any prompt the event carries is redacted.
 */
export function scopeExecutorTrace<Event extends { readonly type: string }>(
  event: Event,
  scope: ExecutorTraceScope,
):
  | Event
  | (Event & ExecutorTraceOwnership)
  | (Event & ExecutorTraceOwnership & { readonly prompt: string }) {
  if (SELF_OWNED_TRACE_TYPES[event.type]) {
    return event;
  }
  const owned = {
    ...event,
    agentRunId: readTraceOwner(event, "agentRunId") ?? scope.agentRunId,
    asyncJobId: readTraceOwner(event, "asyncJobId") ?? scope.asyncJobId,
  };
  return scope.redactPrompt && Object.hasOwn(event, "prompt")
    ? { ...owned, prompt: REDACTED_CONTROL_PROMPT }
    : owned;
}

/**
 * Builds the only listener an executor is ever handed. Scoping lives here
 * rather than at each call site so no executor callback can reach the shell
 * stream unowned, and so the ids come from the lifecycle record itself instead
 * of a second copy that can drift from it.
 */
export function createExecutorTraceListener<Event extends { readonly type: string }>(input: {
  readonly lifecycle: ExecutorLifecycle;
  readonly isRedacting: () => boolean;
  readonly emit: (event: Event) => void;
}): (event: Event) => void {
  return (event) => {
    input.emit(scopeExecutorTrace(event, {
      agentRunId: input.lifecycle.runId,
      asyncJobId: input.lifecycle.jobId,
      redactPrompt: input.isRedacting(),
    }));
  };
}

/**
 * Cancellation must look like cancellation everywhere downstream: an anonymous
 * `Error` reason would reach a child process or a guardian check as an ordinary
 * failure and be summarised as one.
 */
export function abortReason(reason: string): Error {
  const error = new Error(reason);
  error.name = "AbortError";
  return error;
}

/**
 * One WorkAgent turn's cancellation scope. `signal` aborts for either reason;
 * `isCleared` is what separates an operator clear from an ordinary parent
 * abort, so a caller can keep abort semantics for the latter.
 */
export type WorkAgentTurnEpoch = {
  readonly signal: AbortSignal;
  isCleared(): boolean;
  /** Unlinks the parent listener; safe to call more than once. */
  release(): void;
};

/** The mutable half the controller owns; the epoch above is the caller's view. */
export type TurnEpoch = { readonly abortController: AbortController; cleared: boolean };

/**
 * Links a run's AbortController to the parent turn: the parent cancels every
 * child, a child cancels only itself. Returns the detach so a parent signal
 * that outlives the run does not accumulate one listener per dispatch.
 */
export function linkChildAbort(controller: AbortController, parent: AbortSignal | undefined): () => void {
  if (!parent) {
    return () => {};
  }
  if (parent.aborted) {
    controller.abort(parent.reason);
    return () => {};
  }
  const onParentAbort = (): void => controller.abort(parent.reason);
  parent.addEventListener("abort", onParentAbort, { once: true });
  return () => parent.removeEventListener("abort", onParentAbort);
}

