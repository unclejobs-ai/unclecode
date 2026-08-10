import type {
  OrchestratorStepTraceEvent,
  WorkApprovedTraceEvent,
  WorkGraph,
  WorkNodeStatus,
  WorkProposedTraceEvent,
  WorkStatusTraceEvent,
} from "@unclecode/contracts";

import {
  createTurnOrchestrator,
  parsePlannedWorkTasks,
  type PlannedWorkTask,
  type TurnOrchestratorTraceListener,
} from "./turn-orchestrator.js";
import { runRustCommandSync } from "./rust-command.js";
import {
  BLOCKED_BY_DEPENDENCY_SUMMARY,
  WORK_TURN_CANCELLED_SUMMARY,
  WorkAgentRunController,
  type WorkAgentControlRuntime,
  type WorkAgentExecutorSettings,
  type WorkAgentTurnEpoch,
  type WorkAgentRunControllerTraceEvent,
} from "./work-agent-run-controller.js";

type ReasoningLike = {
  readonly effort: string;
};

type PlannedWorkResult = {
  readonly id: string;
  readonly summary: string;
  readonly status: Extract<WorkNodeStatus, "completed" | "failed" | "cancelled" | "blocked">;
};

/**
 * What a WorkAgent turn hands back. `cancelled` is the engine boundary's typed
 * signal: it is present only when the operator cleared the turn, so a consumer
 * never has to recognise cancellation by matching the assistant text.
 */
export type WorkAgentTurnResult = {
  readonly text: string;
  readonly cancelled?: true;
};

const CLEARED_TURN_RESULT: WorkAgentTurnResult = { text: WORK_TURN_CANCELLED_SUMMARY, cancelled: true };

/** What an executable guardian check is told about a finished plan. */
type GuardianCheckRequest = {
  readonly prompt: string;
  readonly mode: string;
  readonly tasks: readonly PlannedWorkTask[];
  readonly results: readonly PlannedWorkResult[];
  readonly changedFiles: readonly string[];
  readonly signal: AbortSignal;
};
type GuardianCheckRunner = (input: GuardianCheckRequest) => Promise<{ readonly summary: string }>;

export type OrchestratedWorkAgentTraceEvent<TraceEvent extends { readonly type: string }> =
  | WorkAgentRunControllerTraceEvent<TraceEvent>
  | OrchestratorStepTraceEvent
  | WorkProposedTraceEvent
  | WorkApprovedTraceEvent
  | WorkStatusTraceEvent;

export interface OrchestratedWorkTurnAgent<
  Attachment,
  TraceEvent extends { readonly type: string },
  Reasoning extends ReasoningLike,
> {
  clear(): void;
  setTraceListener(listener?: ((event: TraceEvent) => void) | undefined): void;
  updateRuntimeSettings(settings: { reasoning?: Reasoning | undefined; model?: string | undefined }): void;
  updateMode?(mode: string): void;
  runTurn(prompt: string, attachments?: readonly Attachment[], options?: { readonly signal?: AbortSignal | undefined }): Promise<{ text: string }>;
}

export function parseAgentPlanResponse(text: string): readonly PlannedWorkTask[] {
  return parsePlannedWorkTasks(
    runRustCommandSync(["rust", "orchestrator", "parse-plan-response"], process.cwd(), text),
  );
}

function buildComplexTasks(prompt: string): readonly PlannedWorkTask[] {
  return parsePlannedWorkTasks(
    runRustCommandSync(["rust", "orchestrator", "complex-tasks"], process.cwd(), prompt),
  );
}

/** Every work prompt is built by the Rust orchestrator and trimmed for the provider. */
function buildRustPrompt(command: string, payload: unknown): string {
  return runRustCommandSync(["rust", "orchestrator", command], process.cwd(), JSON.stringify(payload)).trimEnd();
}

function buildGuardianReviewPrompt(input: {
  readonly prompt: string;
  readonly results: readonly { readonly summary: string }[];
  readonly executableChecks?: string | undefined;
}): string {
  return buildRustPrompt("guardian-review-prompt", input);
}

function buildSynthesisPrompt(input: {
  readonly prompt: string;
  readonly model: string;
  readonly reasoning: string;
  readonly results: readonly { readonly summary: string }[];
  readonly guardianSummary?: string | undefined;
}): string {
  return buildRustPrompt("synthesis-prompt", input);
}

function resolveAgentTraceEvent(input: Record<string, unknown>): OrchestratorStepTraceEvent {
  const parsed: unknown = JSON.parse(
    runRustCommandSync(
      ["rust", "orchestrator", "trace-event"],
      process.cwd(),
      JSON.stringify(input),
    ),
  );
  if (typeof parsed !== "object" || parsed === null || (parsed as { type?: unknown }).type !== "orchestrator.step") {
    throw new Error("Rust orchestrator returned an invalid trace event.");
  }
  return parsed as OrchestratorStepTraceEvent;
}

function extractChangedFilesFromTasks(tasks: readonly PlannedWorkTask[]): readonly string[] {
  const parsed: unknown = JSON.parse(
    runRustCommandSync(
      ["rust", "orchestrator", "changed-files"],
      process.cwd(),
      JSON.stringify(tasks),
    ),
  );
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Rust orchestrator returned invalid changed file paths.");
  }
  return parsed;
}

export function resolveWorkerBudget(mode: string): number {
  const parsed: unknown = JSON.parse(
    runRustCommandSync(["rust", "orchestrator", "worker-budget", mode], process.cwd()),
  );
  const workerBudget = typeof parsed === "object" && parsed !== null
    ? (parsed as { workerBudget?: unknown }).workerBudget
    : undefined;
  if (typeof workerBudget !== "number" || !Number.isInteger(workerBudget) || workerBudget < 1) {
    throw new Error("Rust orchestrator returned an invalid worker budget.");
  }
  return workerBudget;
}

let workGraphSequence = 0;

function createWorkGraph(tasks: readonly PlannedWorkTask[], startedAt: number): WorkGraph {
  workGraphSequence += 1;
  return {
    id: `goal-${startedAt}-${workGraphSequence}`,
    ...(tasks[0]?.goal ? { goal: tasks[0].goal } : {}),
    ...(tasks[0]?.constraints ? { constraints: tasks[0].constraints } : {}),
    approval: "pending",
    nodes: tasks.map((task) => ({
      id: task.id,
      title: task.summary,
      prompt: task.prompt,
      status: "proposed",
      dependsOn: task.dependsOn,
      fileOwnership: task.writePaths,
      acceptanceCriteria: task.acceptanceCriteria,
      evidenceRefs: [],
    })),
  };
}

type ExecutorAgentFactory<Attachment, TraceEvent extends { readonly type: string }, Reasoning extends ReasoningLike> = (
  settings: WorkAgentExecutorSettings<Reasoning>,
) => Promise<OrchestratedWorkTurnAgent<Attachment, TraceEvent, Reasoning>>;

export class WorkAgent<
  Attachment,
  TraceEvent extends { readonly type: string },
  Reasoning extends ReasoningLike,
> {
  private readonly directAgent: OrchestratedWorkTurnAgent<Attachment, TraceEvent, Reasoning>;
  private readonly createExecutorAgent: ExecutorAgentFactory<Attachment, TraceEvent, Reasoning> | undefined;
  private mode: string;
  private reasoning: Reasoning;
  private model: string;
  private readonly runExecutableGuardianChecks?: GuardianCheckRunner | undefined;
  private traceListener: ((event: OrchestratedWorkAgentTraceEvent<TraceEvent>) => void) | undefined;
  private readonly runController: WorkAgentRunController<Attachment, TraceEvent, Reasoning>;

  constructor(input: {
    directAgent: OrchestratedWorkTurnAgent<Attachment, TraceEvent, Reasoning>;
    createExecutorAgent?: ExecutorAgentFactory<Attachment, TraceEvent, Reasoning> | undefined;
    mode: string;
    reasoning: Reasoning;
    model: string;
    runExecutableGuardianChecks?: GuardianCheckRunner | undefined;
  }) {
    this.directAgent = input.directAgent;
    this.createExecutorAgent = input.createExecutorAgent;
    this.mode = input.mode;
    this.reasoning = input.reasoning;
    this.model = input.model;
    this.runExecutableGuardianChecks = input.runExecutableGuardianChecks;
    this.runController = new WorkAgentRunController({
      directAgent: input.directAgent,
      ...(input.createExecutorAgent ? { createExecutorAgent: input.createExecutorAgent } : {}),
      resolveSettings: () => ({ mode: this.mode, model: this.model, reasoning: this.reasoning }),
      // The same ceiling `runParallelTasks` gets, resolved per call so a mode
      // switch moves the operator's continuation budget with it.
      resolveWorkerBudget: () => (this.createExecutorAgent ? resolveWorkerBudget(this.mode) : 1),
      emitTrace: (event) => this.emitTrace(event),
      isTracing: () => this.traceListener !== undefined,
    });
  }

  getAgentControlRuntime(): WorkAgentControlRuntime {
    return this.runController.getControlRuntime();
  }

  clear(): void {
    this.directAgent.clear();
    this.runController.clear("Work agent cleared.");
  }

  /**
   * A main-session turn: its output belongs to the shell transcript, so it runs
   * under the unscoped listener that is already installed. It still takes the
   * shared agent's slot — a continuation the controller dispatched onto that
   * same agent must not have its scoped listener swapped out from under it, and
   * this turn must not inherit that scope either.
   */
  private runMainTurn(
    prompt: string,
    attachments: readonly Attachment[],
    options: { readonly signal?: AbortSignal | undefined },
  ): Promise<{ text: string }> {
    return this.runController.withDirectAgent(() =>
      this.directAgent.runTurn(prompt, attachments, options));
  }

  private runInternalTurn(
    prompt: string,
    attachments: readonly Attachment[] = [],
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<{ text: string }> {
    // Swapping the listener is only safe while holding the shared agent's slot:
    // otherwise this turn would overwrite a live executor's scoped listener and
    // then hand the unscoped shell listener back under it.
    return this.runController.withDirectAgent(async () => {
      const outerListener = this.traceListener;
      // Planner and guardian turns stay invisible as provider brackets, but
      // their spend is real: forward usage only, unscoped, so it lands on the
      // main ledger instead of vanishing.
      this.directAgent.setTraceListener(
        outerListener
          ? (event) => {
              if (event.type === "usage.recorded") {
                this.emitTrace(event);
              }
            }
          : undefined,
      );
      try {
        return await this.directAgent.runTurn(prompt, attachments, options);
      } finally {
        this.directAgent.setTraceListener(outerListener ? (event) => this.emitTrace(event) : undefined);
      }
    });
  }

  private async planTasks(
    prompt: string,
    onTrace?: TurnOrchestratorTraceListener,
    signal?: AbortSignal | undefined,
  ): Promise<{ readonly tasks: readonly PlannedWorkTask[]; readonly usedLlm: boolean }> {
    const staticTasks = buildComplexTasks(prompt);
    let plannerInvoked = false;

    try {
      const planPrompt = buildRustPrompt("planner-prompt", { prompt });
      const plannerStartedAt = Date.now();
      onTrace?.(resolveAgentTraceEvent({
        kind: "planner-running",
        prompt,
        startedAt: plannerStartedAt,
      }));
      plannerInvoked = true;
      const result = await this.runInternalTurn(planPrompt, [], { signal });
      const parsed = parseAgentPlanResponse(result.text);
      if (parsed.length >= 2) {
        return { tasks: parsed, usedLlm: true };
      }
    } catch (error) {
      // A cancelled turn must not fall back to a static plan and keep working;
      // only a genuine planning failure earns the deterministic fallback.
      if (signal?.aborted) {
        throw error;
      }
      // A deterministic end-to-end task keeps the turn actionable when planning fails.
    }

    return { tasks: staticTasks, usedLlm: plannerInvoked };
  }

  setTraceListener(listener?: ((event: OrchestratedWorkAgentTraceEvent<TraceEvent>) => void) | undefined): void {
    this.traceListener = listener;
    this.directAgent.setTraceListener(listener ? (event) => this.emitTrace(event) : undefined);
  }

  updateRuntimeSettings(settings: { reasoning?: Reasoning | undefined; model?: string | undefined }): void {
    this.directAgent.updateRuntimeSettings(settings);
    if (settings.reasoning) {
      this.reasoning = settings.reasoning;
    }
    if (settings.model?.trim()) {
      this.model = settings.model.trim();
    }
  }

  // Shell autonomy for yolo/ultrawork is granted per agent instance by the
  // execution policy profile, never through process.env.
  updateMode(mode: string): void {
    this.mode = mode;
    this.directAgent.updateMode?.(mode);
  }

  /**
   * Every phase of a turn — attachment, simple, research, planning, executor,
   * guardian, synthesis — runs inside one epoch. A clear stops whichever phase
   * is live and yields a single typed outcome; a plain parent abort keeps its
   * ordinary `AbortError` semantics.
   */
  async runTurn(prompt: string, attachments: readonly Attachment[] = [], options: { readonly signal?: AbortSignal | undefined } = {}): Promise<WorkAgentTurnResult> {
    const epoch = this.runController.beginTurn(options.signal);
    try {
      const result = await this.runTurnInEpoch(prompt, attachments, epoch);
      return epoch.isCleared() ? CLEARED_TURN_RESULT : result;
    } catch (error) {
      if (epoch.isCleared()) {
        return CLEARED_TURN_RESULT;
      }
      throw error;
    } finally {
      epoch.release();
    }
  }

  private async runTurnInEpoch(prompt: string, attachments: readonly Attachment[], epoch: WorkAgentTurnEpoch): Promise<WorkAgentTurnResult> {
    const turnSignal = epoch.signal;
    const turnOptions = { signal: turnSignal };
    if (attachments.length > 0) {
      return await this.runMainTurn(prompt, attachments, turnOptions);
    }

    // Empty until the plan is accepted; the controller refuses any dispatch
    // naming a job the plan never queued, so no second guard is needed here.
    let activeGraphId = "";
    const orchestrator = createTurnOrchestrator<PlannedWorkTask, PlannedWorkResult>({
      runSimpleTurn: (simplePrompt) => this.runMainTurn(simplePrompt, attachments, turnOptions),
      runResearchTurn: (researchPrompt) => this.runMainTurn(researchPrompt, attachments, turnOptions),
      planComplexTurn: async (complexPrompt, planOptions) => {
        const { tasks, usedLlm } = await this.planTasks(complexPrompt, planOptions?.onTrace, turnSignal);
        return { tasks, usedLlm };
      },
      executeComplexTask: async (task) => {
        const outcome = await this.runController.runTask({
          graphId: activeGraphId,
          task,
          signal: turnSignal,
        });
        return { id: task.id, summary: outcome.text, status: outcome.status };
      },
      isComplexTaskSuccessful: (taskResult) => taskResult.status === "completed",
      // Cancelled is not failed; only the dependency gate treats them alike.
      resolveComplexTaskStatus: ({ status }) => (status === "blocked" ? "failed" : status),
      createFailedComplexTaskResult: (task, error) => ({
        id: task.id,
        summary: `Executor failed: ${error instanceof Error ? error.message : String(error)}`,
        status: "failed",
      }),
      createBlockedComplexTaskResult: (task) => {
        this.runController.settleBlockedJob(activeGraphId, task.id);
        return { id: task.id, summary: BLOCKED_BY_DEPENDENCY_SUMMARY, status: "blocked" };
      },
      runGuardianReview: async ({ prompt: originalPrompt, tasks, results }) => {
        turnSignal.throwIfAborted();
        const changedFiles = extractChangedFilesFromTasks(tasks);
        const executableChecks = await this.loadExecutableGuardianSummary({
          prompt: originalPrompt,
          mode: this.mode,
          tasks,
          results,
          changedFiles,
          signal: turnSignal,
        });
        // The checks can run for minutes; a clear that landed while they ran
        // must not still spend a review turn.
        turnSignal.throwIfAborted();
        const reviewPrompt = buildGuardianReviewPrompt({
          prompt: originalPrompt,
          results,
          ...(executableChecks ? { executableChecks } : {}),
        });
        const review = await this.runInternalTurn(reviewPrompt, [], turnOptions);
        return {
          summary: executableChecks
            ? `${review.text}\n\nExecutable checks:\n${executableChecks}`
            : review.text,
        };
      },
    });

    const result = await orchestrator.run({
      prompt,
      mode: this.mode,
      maxWorkers: this.createExecutorAgent ? resolveWorkerBudget(this.mode) : 1,
      ...(this.traceListener ? { onTrace: (event) => this.emitTrace(event) } : {}),
      onPlan: (tasks) => {
        const startedAt = Date.now();
        const graph = createWorkGraph(tasks, startedAt);
        activeGraphId = graph.id;
        this.emitTrace({
          type: "work.proposed",
          level: "high-signal",
          graphId: graph.id,
          nodeCount: graph.nodes.length,
          startedAt,
          graph,
        });
        this.emitTrace({
          type: "work.approved",
          level: "high-signal",
          graphId: graph.id,
          startedAt: Date.now(),
        });
        this.runController.queuePlannedJobs(graph.id, tasks, startedAt);
      },
      onTaskStatus: (task, status) => {
        if (!activeGraphId) {
          return;
        }
        this.emitTrace({
          type: "work.status",
          level: "high-signal",
          graphId: activeGraphId,
          nodeId: task.id,
          status,
          summary: task.summary,
          startedAt: Date.now(),
        });
      },
    });

    if (result.kind !== "complex") {
      return { text: result.text };
    }
    if (epoch.isCleared()) {
      return CLEARED_TURN_RESULT;
    }

    const reviewerStartedAt = Date.now();
    this.emitTrace(resolveAgentTraceEvent({
      kind: "synthesis-running",
      resultCount: result.results.length,
      startedAt: reviewerStartedAt,
    }));

    const synthesisPrompt = buildSynthesisPrompt({
      prompt,
      model: this.model,
      reasoning: this.reasoning.effort,
      results: result.results,
      ...(result.guardian ? { guardianSummary: result.guardian.summary } : {}),
    });

    const synthesis = await this.runMainTurn(synthesisPrompt, [], turnOptions);
    const reviewerCompletedAt = Date.now();
    this.emitTrace(resolveAgentTraceEvent({
      kind: "synthesis-completed",
      resultCount: result.results.length,
      startedAt: reviewerStartedAt,
      completedAt: reviewerCompletedAt,
    }));

    return { text: synthesis.text };
  }

  private async loadExecutableGuardianSummary(
    input: GuardianCheckRequest,
  ): Promise<string | undefined> {
    if (!this.runExecutableGuardianChecks) {
      return undefined;
    }

    try {
      return (await this.runExecutableGuardianChecks(input)).summary;
    } catch (error) {
      // A cancelled check has no verdict. Report the cancellation itself, not
      // whatever error raced it, and never degrade it into an "unavailable"
      // note the reviewer would read as a real result.
      input.signal?.throwIfAborted();
      return `Executable checks unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private emitTrace(event: OrchestratedWorkAgentTraceEvent<TraceEvent>): void {
    if (!this.traceListener) {
      return;
    }

    try {
      this.traceListener(event);
    } catch {
      // Trace visibility must not break the work loop.
    }
  }
}
