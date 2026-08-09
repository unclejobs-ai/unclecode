import type {
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

let executorLifecycleSequence = 0;

export function createExecutorLifecycle(input: {
  readonly taskId: string;
  readonly label: string;
  readonly startedAt: number;
}): {
  readonly lifecycle: ExecutorLifecycle;
  readonly events: readonly [JobQueuedTraceEvent, AgentRunStartedTraceEvent];
} {
  executorLifecycleSequence += 1;
  const suffix = `${input.startedAt}-${executorLifecycleSequence}`;
  const jobId = `job-${input.taskId}-${suffix}`;
  const runId = `agent-${input.taskId}-${suffix}`;
  const lifecycle = {
    jobId,
    runId,
    label: input.label,
    startedAt: input.startedAt,
  };
  return {
    lifecycle,
    events: [
      {
        type: "job.queued",
        level: "default",
        eventId: `${jobId}:queued`,
        jobId,
        jobType: "executor",
        label: input.label,
        agentRunId: runId,
        queuedAt: input.startedAt,
      },
      {
        type: "agent.run.started",
        level: "high-signal",
        eventId: `${runId}:started`,
        runId,
        jobId,
        displayName: input.label,
        agentType: "executor",
        startedAt: input.startedAt,
      },
    ],
  };
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

export function attributeTraceToAgentRun<Event extends { readonly type: string }>(
  event: Event,
  agentRunId: string,
): Event | (Event & { readonly agentRunId: string }) {
  if (
    event.type !== "usage.recorded"
    && event.type !== "tool.started"
    && event.type !== "tool.completed"
  ) {
    return event;
  }
  return Object.hasOwn(event, "agentRunId") ? event : { ...event, agentRunId };
}

type ExecutorTurnAgent<Attachment, TraceEvent extends { readonly type: string }> = {
  clear(): void;
  setTraceListener(listener?: ((event: TraceEvent) => void) | undefined): void;
  runTurn(
    prompt: string,
    attachments?: readonly Attachment[],
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<{ text: string }>;
};

export async function runExecutorWithLifecycle<
  Attachment,
  TraceEvent extends { readonly type: string },
  Reasoning,
>(input: {
  readonly taskId: string;
  readonly label: string;
  readonly prompt: string;
  readonly options: { readonly signal?: AbortSignal | undefined };
  readonly directAgent: ExecutorTurnAgent<Attachment, TraceEvent>;
  readonly createExecutorAgent?: ((settings: {
    readonly mode: string;
    readonly model: string;
    readonly reasoning: Reasoning;
  }) => Promise<ExecutorTurnAgent<Attachment, TraceEvent>>) | undefined;
  readonly settings: {
    readonly mode: string;
    readonly model: string;
    readonly reasoning: Reasoning;
  };
  readonly onTrace?: ((event: TraceEvent | ExecutorLifecycleTraceEvent) => void) | undefined;
  readonly directTraceListener?: ((event: TraceEvent) => void) | undefined;
}): Promise<{ text: string }> {
  const { lifecycle, events } = createExecutorLifecycle({
    taskId: input.taskId,
    label: input.label,
    startedAt: Date.now(),
  });
  for (const event of events) input.onTrace?.(event);

  let executor: ExecutorTurnAgent<Attachment, TraceEvent> | undefined;
  try {
    executor = input.createExecutorAgent
      ? await input.createExecutorAgent(input.settings)
      : input.directAgent;
    executor.setTraceListener(
      input.onTrace
        ? (event) => input.onTrace?.(attributeTraceToAgentRun(event, lifecycle.runId))
        : undefined,
    );
    const result = await executor.runTurn(input.prompt, [], input.options);
    const settled = settleExecutorLifecycle({
      lifecycle,
      status: "completed",
      completedAt: Date.now(),
      summary: result.text,
    });
    for (const event of settled) input.onTrace?.(event);
    return result;
  } catch (error) {
    const cancelled =
      input.options.signal?.aborted === true
      || (error instanceof Error && error.name === "AbortError");
    const settled = settleExecutorLifecycle({
      lifecycle,
      status: cancelled ? "cancelled" : "failed",
      completedAt: Date.now(),
      errorSummary: cancelled ? "Executor cancelled." : "Executor failed.",
    });
    for (const event of settled) input.onTrace?.(event);
    throw error;
  } finally {
    if (input.createExecutorAgent) {
      executor?.clear();
    } else {
      input.directAgent.setTraceListener(input.directTraceListener);
    }
  }
}
