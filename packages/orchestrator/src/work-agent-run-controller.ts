import { randomUUID } from "node:crypto";

import type {
  AgentControlReceipt,
  AgentRun,
  TerminalAgentRunStatus,
  WorkNodeStatus,
} from "@unclecode/contracts";

import { findGoalTaskPlanViolation, type ComplexPlanTask } from "./turn-orchestrator.js";
import {
  abortReason,
  type TurnEpoch,
  type WorkAgentTurnEpoch,
  boundControlMessage,
  buildContinuationPrompt,
  STEER_PROMPT_SUFFIX,
  linkChildAbort,
  createExecutorTraceListener,
  settleExecutorLifecycle,
  type ExecutorLifecycle,
  type ExecutorLifecycleTraceEvent,
} from "./work-agent-lifecycle.js";
export type { WorkAgentTurnEpoch } from "./work-agent-lifecycle.js";

const CANCELLED_SUMMARY = "Executor cancelled.";
const FAILED_SUMMARY = "Executor failed.";

/** Why a planned job settles without ever opening a run. */
export const BLOCKED_BY_DEPENDENCY_SUMMARY = "Blocked because a dependency failed.";

/** What a turn reports once the operator cleared it mid-flight. */
export const WORK_TURN_CANCELLED_SUMMARY = "Work turn cancelled by the operator.";

export type WorkAgentExecutorSettings<Reasoning> = {
  readonly mode: string;
  readonly model: string;
  readonly reasoning: Reasoning;
};

type ExecutorTurnAgent<Attachment, TraceEvent extends { readonly type: string }> = {
  clear(): void;
  setTraceListener(listener?: ((event: TraceEvent) => void) | undefined): void;
  runTurn(
    prompt: string,
    attachments?: readonly Attachment[],
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<{ readonly text: string }>;
};

export type WorkAgentRunControllerTraceEvent<TraceEvent extends { readonly type: string }> =
  | TraceEvent
  | ExecutorLifecycleTraceEvent;

/** A task the plan promised; the controller needs its id, label, and prompt. */
export type WorkAgentRunTask = {
  readonly id: string;
  readonly summary: string;
  readonly prompt: string;
};

/**
 * Cancellation is a first-class outcome, not a failure: a run the operator
 * (or the parent turn) stopped resolves instead of throwing, so the scheduler
 * can mark the WorkGraph node cancelled.
 */
export type WorkAgentRunOutcome = {
  readonly text: string;
  readonly status: Extract<WorkNodeStatus, "completed" | "cancelled">;
};

export type WorkAgentControlRuntime = {
  steer(agentRunId: string, message: string): Promise<AgentControlReceipt>;
  cancel(agentRunId: string): Promise<AgentControlReceipt>;
  continueRun(source: AgentRun, message?: string): Promise<AgentControlReceipt>;
  clear(reason: string): void;
};

type ActiveRun = {
  readonly abortController: AbortController;
  readonly mailbox: string[];
};

/**
 * Planned jobs are queued once per accepted plan. `dispatched` is what keeps a
 * job from opening a second agent run or settling twice.
 */
type PlannedJob = { dispatched: boolean };

/** One executor slot. A released permit is inert, so capacity never doubles. */
type ExecutorPermit = { release(): void };

type PermitWaiter = { readonly grant: (permit: ExecutorPermit | undefined) => void };

/**
 * The authoritative ceiling on concurrent paid executor runs.
 *
 * The scheduler's `maxWorkers` only shapes how fast planned work is offered,
 * and a manual continuation never passes through the scheduler at all, so
 * neither can be the cap: both charge against this one pool. Planned work waits
 * for a slot because its plan is already accepted; a continuation, which one
 * keystroke opens, is refused outright. Waiters are woken by the release that
 * frees their slot — never by polling — and a waiter whose signal aborts leaves
 * the queue at once.
 */
class ExecutorPermitPool {
  private readonly resolveBudget: () => number;
  private readonly waiting: PermitWaiter[] = [];
  private held = 0;

  constructor(resolveBudget: () => number) {
    this.resolveBudget = resolveBudget;
  }

  /** The ceiling the mode currently defines; one run may always proceed. */
  capacity(): number {
    return Math.max(1, this.resolveBudget());
  }

  /** Non-blocking, so a full pool reads as a refusal rather than a queue. */
  tryAcquire(): ExecutorPermit | undefined {
    if (this.held >= this.capacity()) {
      return undefined;
    }
    this.held += 1;
    return this.createPermit();
  }

  /**
   * Waits for a slot. Resolves `undefined` once the caller's signal aborts or
   * `cancelWaiters` runs, so a cleared turn can never park here forever.
   */
  acquire(signal: AbortSignal | undefined): Promise<ExecutorPermit | undefined> {
    const immediate = this.tryAcquire();
    if (immediate) {
      return Promise.resolve(immediate);
    }
    if (signal?.aborted) {
      return Promise.resolve(undefined);
    }
    const { promise, resolve } = Promise.withResolvers<ExecutorPermit | undefined>();
    let detach = (): void => {};
    const waiter: PermitWaiter = {
      grant: (permit) => {
        detach();
        resolve(permit);
      },
    };
    if (signal) {
      const onAbort = (): void => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) {
          this.waiting.splice(index, 1);
        }
        waiter.grant(undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // A promoted waiter must take its listener with it: a parent signal
      // outlives many dispatches and would otherwise collect one per park.
      detach = () => signal.removeEventListener("abort", onAbort);
    }
    this.waiting.push(waiter);
    return promise;
  }

  /** Wakes every parked run empty-handed; a clear must not strand one. */
  cancelWaiters(): void {
    for (const waiter of this.waiting.splice(0)) {
      waiter.grant(undefined);
    }
  }

  private createPermit(): ExecutorPermit {
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.held -= 1;
        this.promoteWaiters();
      },
    };
  }

  /** Hands freed capacity to the longest-waiting run, in arrival order. */
  private promoteWaiters(): void {
    while (this.held < this.capacity()) {
      const waiter = this.waiting.shift();
      if (!waiter) {
        return;
      }
      this.held += 1;
      waiter.grant(this.createPermit());
    }
  }
}

/**
 * Owns every executor agent run a `WorkAgent` dispatches.
 *
 * One controller holds the planned job registry, the shared executor permit
 * pool, the per-run AbortController, and the FIFO steer mailbox that drains at
 * provider-turn boundaries. Runs are siblings, never a tree: cancelling one
 * aborts only that run, while aborting the parent turn (or clearing the shell)
 * takes down all of them.
 */
export class WorkAgentRunController<
  Attachment,
  TraceEvent extends { readonly type: string },
  Reasoning,
> {
  private readonly directAgent: ExecutorTurnAgent<Attachment, TraceEvent>;
  private readonly createExecutorAgent:
    | ((settings: WorkAgentExecutorSettings<Reasoning>) => Promise<ExecutorTurnAgent<Attachment, TraceEvent>>)
    | undefined;
  private readonly resolveSettings: () => WorkAgentExecutorSettings<Reasoning>;
  private readonly resolveWorkerBudget: () => number;
  private readonly emitTrace: (event: WorkAgentRunControllerTraceEvent<TraceEvent>) => void;
  private readonly isTracing: () => boolean;
  private readonly plannedJobs = new Map<string, PlannedJob>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private turnEpoch: TurnEpoch | undefined;
  private releaseTurnLink: (() => void) | undefined;
  private readonly executorPermits = new ExecutorPermitPool(() => this.resolveWorkerBudget());
  /** Tail of the queue serialising every use of the shared direct agent. */
  private directAgentTurn: Promise<void> = Promise.resolve();
  private readonly controlRuntime: WorkAgentControlRuntime = {
    steer: (agentRunId, message) => this.steer(agentRunId, message),
    cancel: (agentRunId) => this.cancel(agentRunId),
    continueRun: (source, message) => this.continueRun(source, message),
    clear: (reason) => this.clear(reason),
  };

  constructor(input: {
    readonly directAgent: ExecutorTurnAgent<Attachment, TraceEvent>;
    readonly createExecutorAgent?:
      | ((settings: WorkAgentExecutorSettings<Reasoning>) => Promise<ExecutorTurnAgent<Attachment, TraceEvent>>)
      | undefined;
    readonly resolveSettings: () => WorkAgentExecutorSettings<Reasoning>;
    /**
     * The concurrent-run ceiling every paid executor run charges against.
     * Planned work waits for a free slot; a manual continuation is refused
     * outright, so neither dispatch path can outnumber what the mode allows.
     */
    readonly resolveWorkerBudget: () => number;
    readonly emitTrace: (event: WorkAgentRunControllerTraceEvent<TraceEvent>) => void;
    readonly isTracing: () => boolean;
  }) {
    this.directAgent = input.directAgent;
    this.createExecutorAgent = input.createExecutorAgent;
    this.resolveSettings = input.resolveSettings;
    this.resolveWorkerBudget = input.resolveWorkerBudget;
    this.emitTrace = input.emitTrace;
    this.isTracing = input.isTracing;
  }

  getControlRuntime(): WorkAgentControlRuntime {
    return this.controlRuntime;
  }

  /**
   * Runs one critical section against the shared direct agent.
   *
   * That agent has exactly one mutable trace-listener slot, so every caller —
   * the WorkAgent's own main and internal turns as much as this controller's
   * fallback executor turns — must come through here, holding the section
   * across listener install, `runTurn`, and listener teardown. A second caller
   * installing its listener mid-turn would restamp the first caller's events
   * with the wrong ownership, and a teardown landing under a live turn would
   * restore the unscoped main listener and stream worker output into the main
   * transcript. The slot changes hands between turns, never during one.
   */
  async withDirectAgent<T>(critical: () => Promise<T>): Promise<T> {
    const predecessor = this.directAgentTurn;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.directAgentTurn = promise;
    await predecessor;
    try {
      return await critical();
    } finally {
      // A rejected section still hands the slot on; one failed turn must not
      // jam the queue behind it.
      resolve();
    }
  }

  /**
   * Opens a turn epoch. The returned signal is a child of the caller's signal
   * and is what `clear()` aborts, so clearing stops the enclosing work turn and
   * not merely the runs already in flight. One turn runs at a time, so a new
   * epoch replaces the previous link instead of stacking listeners on a
   * long-lived parent signal.
   */
  beginTurn(parentSignal?: AbortSignal | undefined): WorkAgentTurnEpoch {
    this.releaseTurnLink?.();
    const epoch: TurnEpoch = { abortController: new AbortController(), cleared: false };
    const detach = linkChildAbort(epoch.abortController, parentSignal);
    this.releaseTurnLink = detach;
    this.turnEpoch = epoch;
    return {
      signal: epoch.abortController.signal,
      isCleared: () => epoch.cleared,
      release: () => {
        detach();
        // Only the live epoch may clear the controller's slot; a late release
        // from a finished turn must not unlink the turn that replaced it.
        if (this.turnEpoch === epoch) {
          this.turnEpoch = undefined;
          this.releaseTurnLink = undefined;
        }
      },
    };
  }

  /**
   * Queues one job per accepted plan node. The plan is validated first: an
   * invalid plan is refused before it can leave orphan `job.queued` records
   * behind for a turn the scheduler will reject anyway.
   */
  queuePlannedJobs(
    graphId: string,
    tasks: readonly ComplexPlanTask[],
    queuedAt: number,
  ): void {
    const violation = findGoalTaskPlanViolation(tasks);
    if (violation) {
      throw new Error(violation);
    }
    for (const task of tasks) {
      const jobId = `${graphId}:${task.id}`;
      if (this.plannedJobs.has(jobId)) {
        continue;
      }
      this.plannedJobs.set(jobId, { dispatched: false });
      this.emitTrace({
        type: "job.queued",
        level: "default",
        eventId: `${jobId}:queued`,
        jobId,
        jobType: "executor",
        label: task.summary,
        queuedAt,
      });
    }
  }

  /** Settles a planned job whose dependency failed; no agent run ever opened. */
  settleBlockedJob(graphId: string, taskId: string): void {
    this.settleQueuedJob(`${graphId}:${taskId}`, BLOCKED_BY_DEPENDENCY_SUMMARY);
  }

  /**
   * Terminally settles a job that was queued but never dispatched. Silently
   * dropping it would leave the console showing queued work that can never
   * finish.
   */
  private settleQueuedJob(jobId: string, summary: string, completedAt?: number | undefined): void {
    const planned = this.plannedJobs.get(jobId);
    if (!planned || planned.dispatched) {
      return;
    }
    this.plannedJobs.delete(jobId);
    this.emitTrace({
      type: "job.settled",
      level: "default",
      eventId: `${jobId}:settled`,
      jobId,
      status: "cancelled",
      completedAt: completedAt ?? Date.now(),
      summary,
    });
  }

  async runTask(input: {
    readonly graphId: string;
    readonly task: WorkAgentRunTask;
    readonly signal?: AbortSignal | undefined;
    /** Route this planned node through the configured direct/frontier agent. */
    readonly preferDirect?: boolean | undefined;
    /** Fires only after a queued job owns a real run and is about to dispatch. */
    readonly onDispatchStarting?: ((agentRunId: string) => void) | undefined;
  }): Promise<WorkAgentRunOutcome> {
    const jobId = `${input.graphId}:${input.task.id}`;
    // A turn cancelled before dispatch opens no run at all. The job it queued
    // still has to reach a terminal state, and `settleQueuedJob` is idempotent,
    // so a clear that already settled it is not settled twice.
    if (input.signal?.aborted) {
      this.settleQueuedJob(jobId, CANCELLED_SUMMARY);
      return { text: CANCELLED_SUMMARY, status: "cancelled" };
    }
    const planned = this.plannedJobs.get(jobId);
    if (!planned || planned.dispatched) {
      throw new Error(
        `Work task ${input.task.id} has no dispatchable planned job in graph ${input.graphId}.`,
      );
    }
    // Accepted plan work waits for capacity instead of being refused, and it
    // waits before minting anything: the job stays merely queued — and so still
    // settleable by a clear — for as long as it parks here.
    const permit = await this.executorPermits.acquire(input.signal);
    if (!permit) {
      this.settleQueuedJob(jobId, CANCELLED_SUMMARY);
      return { text: CANCELLED_SUMMARY, status: "cancelled" };
    }
    // Re-read after the wait: a clear that landed while this job parked already
    // settled it terminally, and dispatching now would resurrect stopped work.
    const dispatchable = this.plannedJobs.get(jobId);
    if (!dispatchable || dispatchable.dispatched) {
      permit.release();
      return { text: CANCELLED_SUMMARY, status: "cancelled" };
    }
    dispatchable.dispatched = true;
    return await this.execute({
      jobId,
      runId: `${jobId}:agent`,
      displayName: input.task.summary,
      prompt: input.task.prompt,
      permit,
      ...(input.preferDirect ? { preferDirect: true } : {}),
      ...(input.onDispatchStarting ? { onDispatchStarting: input.onDispatchStarting } : {}),
      ...(input.signal ? { parentSignal: input.signal } : {}),
    });
  }

  /**
   * Cancels the enclosing turn, aborts every live run, and terminally settles
   * the jobs the plan queued but never dispatched.
   */
  clear(reason: string): void {
    if (this.turnEpoch) {
      // Flag before aborting: an abort listener that asks "was this a clear?"
      // runs synchronously inside `abort()`.
      this.turnEpoch.cleared = true;
      this.turnEpoch.abortController.abort(abortReason(reason));
    }
    for (const run of [...this.activeRuns.values()]) {
      run.mailbox.length = 0;
      run.abortController.abort(abortReason(reason));
    }
    // A run parked on a busy permit has no run record of its own to abort;
    // waking it empty-handed is what keeps a clear from stranding it.
    this.executorPermits.cancelWaiters();
    for (const jobId of [...this.plannedJobs.keys()]) {
      this.settleQueuedJob(jobId, reason);
    }
  }

  private steer(agentRunId: string, message: string): Promise<AgentControlReceipt> {
    const guidance = boundControlMessage(message);
    if (!guidance) {
      return Promise.resolve({
        status: "rejected",
        message: "Steering needs a non-empty message.",
      });
    }
    const run = this.activeRuns.get(agentRunId);
    if (!run || run.abortController.signal.aborted) {
      return Promise.resolve({
        status: "not_delivered",
        message: `Agent run ${agentRunId} is no longer accepting guidance.`,
      });
    }
    run.mailbox.push(guidance);
    return Promise.resolve({
      status: "accepted",
      message: `Guidance queued for ${agentRunId}; it lands at the next turn boundary.`,
    });
  }

  private cancel(agentRunId: string): Promise<AgentControlReceipt> {
    const run = this.activeRuns.get(agentRunId);
    if (!run) {
      return Promise.resolve({
        status: "not_delivered",
        message: `Agent run ${agentRunId} is not active.`,
      });
    }
    // Queued guidance dies with the run: an executor that ignores its signal
    // must not keep steering after the operator cancelled.
    run.mailbox.length = 0;
    run.abortController.abort(abortReason(`Agent run ${agentRunId} cancelled by operator.`));
    return Promise.resolve({
      status: "accepted",
      message: `Cancelling agent run ${agentRunId}.`,
    });
  }

  /**
   * Starts a fresh run carrying the source lineage. It does not resurrect the
   * source provider session — the prior result is replayed as prompt context.
   *
   * A continuation is a paid provider run one keystroke opens, so it is
   * charged against the same concurrent-run budget the planned executors
   * share. Holding the key at the ceiling refuses the request outright rather
   * than queueing unbounded parallel work.
   */
  private continueRun(source: AgentRun, message?: string): Promise<AgentControlReceipt> {
    const sourceRunId = source.id.trim();
    if (!sourceRunId) {
      return Promise.resolve({
        status: "rejected",
        message: "Continuation needs a source agent run.",
      });
    }
    const guidance = message === undefined ? undefined : boundControlMessage(message);
    if (guidance !== undefined && !guidance) {
      return Promise.resolve({
        status: "rejected",
        message: "Continuation guidance cannot be blank.",
      });
    }

    // Refused before any identity is minted: a rejected continuation must
    // leave no queued job and no run record for the console to settle later.
    // The permit is the one planned executors spend too, so the two dispatch
    // paths cannot each open a full budget of paid runs.
    const permit = this.executorPermits.tryAcquire();
    if (!permit) {
      return Promise.resolve({
        status: "rejected",
        message: `Executor slots are all busy (${this.executorPermits.capacity()} in flight); continue ${sourceRunId} once a run finishes.`,
      });
    }

    // Resume-unique: a rebuilt controller has no memory of earlier
    // continuations, so a per-instance counter would remint `:continuation:1`
    // and the persisted reducer would dedupe the second one out of existence.
    const jobId = `${sourceRunId}:continuation:${randomUUID()}`;
    const runId = `${jobId}:agent`;
    const displayName = `${source.displayName} (continued)`;

    // A continuation owns its job outright; it never enters the planned
    // registry, which only gates plan nodes that may still be blocked.
    this.emitTrace({
      type: "job.queued",
      level: "default",
      eventId: `${jobId}:queued`,
      jobId,
      jobType: "executor",
      label: displayName,
      agentRunId: runId,
      queuedAt: Date.now(),
    });

    // The run settles its own lifecycle on failure, so the operator receipt
    // reports dispatch rather than waiting out the whole continuation.
    void this.execute({
      jobId,
      runId,
      displayName,
      prompt: buildContinuationPrompt(source, guidance),
      permit,
      lineage: { parentRunId: sourceRunId, continuationOf: sourceRunId },
    }).catch(() => {});

    return Promise.resolve({
      status: "accepted",
      message: `Continuation ${runId} started from ${sourceRunId}.`,
    });
  }

  private async execute(input: {
    readonly jobId: string;
    readonly runId: string;
    readonly displayName: string;
    readonly prompt: string;
    readonly preferDirect?: boolean | undefined;
    readonly onDispatchStarting?: ((agentRunId: string) => void) | undefined;
    /** Capacity this run already holds; released on every terminal path. */
    readonly permit: ExecutorPermit;
    readonly parentSignal?: AbortSignal | undefined;
    readonly lineage?:
      | { readonly parentRunId: string; readonly continuationOf: string }
      | undefined;
  }): Promise<WorkAgentRunOutcome> {
    const { jobId, runId, displayName } = input;
    const startedAt = Date.now();
    const abortController = new AbortController();
    const releaseParentLink = linkChildAbort(abortController, input.parentSignal);
    const signal = abortController.signal;
    const run: ActiveRun = { abortController, mailbox: [] };
    this.activeRuns.set(runId, run);

    const lifecycle: ExecutorLifecycle = { jobId, runId, label: displayName, startedAt };
    // Removing the run before the terminal events keeps a listener that reacts
    // to `agent.run.settled` from accepting guidance nobody will ever deliver.
    const settle = (
      status: TerminalAgentRunStatus,
      detail: { readonly summary?: string | undefined; readonly errorSummary?: string | undefined },
    ): void => {
      this.activeRuns.delete(runId);
      const events = settleExecutorLifecycle({
        lifecycle,
        status,
        completedAt: Date.now(),
        ...(detail.summary ? { summary: detail.summary } : {}),
        ...(detail.errorSummary ? { errorSummary: detail.errorSummary } : {}),
      });
      for (const event of events) {
        this.emitTrace(event);
      }
    };
    const settleCancelled = (): WorkAgentRunOutcome => {
      settle("cancelled", { errorSummary: CANCELLED_SUMMARY });
      return { text: CANCELLED_SUMMARY, status: "cancelled" };
    };

    if (!signal.aborted) {
      input.onDispatchStarting?.(runId);
    }
    this.emitTrace({
      type: "agent.run.started",
      level: "high-signal",
      eventId: `${runId}:started`,
      runId,
      jobId,
      displayName,
      agentType: "executor",
      ...(input.lineage ?? {}),
      startedAt,
    });

    // A continuation prompt already embeds operator text; a steer turn flips
    // this on before it dispatches.
    let redactPrompt = input.lineage !== undefined;

    /**
     * Installs this run's scoped listener, spends the dispatch turn plus every
     * steer the mailbox holds, and settles. Settling here is what keeps the
     * drained mailbox and the terminal event free of an `await` between them,
     * so a steer can never be accepted into a run that is already settling.
     */
    const runToCompletion = async (
      executor: ExecutorTurnAgent<Attachment, TraceEvent>,
    ): Promise<WorkAgentRunOutcome> => {
      executor.setTraceListener(
        this.isTracing()
          ? createExecutorTraceListener<TraceEvent>({
              lifecycle,
              isRedacting: () => redactPrompt,
              emit: (event) => this.emitTrace(event),
            })
          : undefined,
      );
      // Reaching an executor is an await boundary — building one, or queueing
      // for the shared one. A cancel that landed meanwhile must spend no turn.
      if (signal.aborted) {
        return settleCancelled();
      }
      let result = await executor.runTurn(input.prompt, [], { signal });
      // Steering lands between provider turns, never inside one. The mailbox is
      // re-read after every turn, so guidance queued during a steer turn is
      // delivered in arrival order on the next pass.
      while (!signal.aborted) {
        const guidance = run.mailbox.shift();
        if (guidance === undefined) {
          break;
        }
        redactPrompt = true;
        result = await executor.runTurn(
          `Operator guidance:\n${guidance}\n\n${STEER_PROMPT_SUFFIX}`,
          [],
          { signal },
        );
      }
      if (signal.aborted) {
        return settleCancelled();
      }
      settle("completed", { summary: result.text });
      return { text: result.text, status: "completed" };
    };

    let executor: ExecutorTurnAgent<Attachment, TraceEvent> | undefined;
    try {
      if (signal.aborted) {
        return settleCancelled();
      }

      if (!this.createExecutorAgent || input.preferDirect) {
        // Siblings and main turns share this agent's single listener slot, so
        // install, run, and restore happen as one section: nobody else can
        // observe — or overwrite — this run's scoped listener while it is live.
        return await this.withDirectAgent(async () => {
          try {
            return await runToCompletion(this.directAgent);
          } finally {
            this.directAgent.setTraceListener(
              this.isTracing() ? (event) => this.emitTrace(event) : undefined,
            );
          }
        });
      }

      executor = await this.createExecutorAgent(this.resolveSettings());
      return await runToCompletion(executor);
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        return settleCancelled();
      }
      settle("failed", { errorSummary: FAILED_SUMMARY });
      throw error;
    } finally {
      this.activeRuns.delete(runId);
      // The record only exists to gate dispatch and clear-time settlement; a
      // finished job needs neither, and keeping it grows the registry for the
      // life of the session.
      this.plannedJobs.delete(jobId);
      releaseParentLink();
      // Only the factory path owns a private agent to dispose of.
      executor?.clear();
      // Last, so the slot this run took is back before its capacity is offered
      // to the next one.
      input.permit.release();
    }
  }
}
