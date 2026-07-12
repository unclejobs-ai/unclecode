import type { OrchestratorStepTraceEvent, WorkNodeStatus } from "@unclecode/contracts";

import { FileOwnershipRegistry } from "./file-ownership-registry.js";
import { runRustCommandSync } from "./rust-command.js";

export type WorkIntent = "simple" | "complex" | "research";

export type ComplexPlanTask = {
  readonly id: string;
  readonly summary: string;
  readonly goal?: string;
  readonly constraints?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly writePaths?: readonly string[];
};

export type GuardianReviewResult = {
  readonly summary: string;
};

export type TurnOrchestratorTraceListener = (event: OrchestratorStepTraceEvent) => void;

export function classifyWorkIntent(prompt: string, mode: string): WorkIntent {
  const raw = runRustCommandSync(
    ["rust", "orchestrator", "classify-intent"],
    process.cwd(),
    JSON.stringify({ prompt, mode }),
  );
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !["simple", "complex", "research"].includes(String((parsed as { intent?: unknown }).intent))
  ) {
    throw new Error("Rust orchestrator returned an invalid work intent.");
  }
  return (parsed as { intent: WorkIntent }).intent;
}

function resolveOrchestratorTraceEvent(input: Record<string, unknown>): OrchestratorStepTraceEvent {
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

export async function runBoundedExecutorPool<Task extends ComplexPlanTask, Result>(input: {
  readonly tasks: readonly Task[];
  readonly maxWorkers: number;
  readonly executeTask: (task: Task) => Promise<Result>;
  readonly ownershipRegistry?: FileOwnershipRegistry | undefined;
  readonly onTrace?: TurnOrchestratorTraceListener | undefined;
}): Promise<readonly Result[]> {
  const maxWorkers = Math.max(1, input.maxWorkers);
  const results = new Array<Result>(input.tasks.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(maxWorkers, input.tasks.length) }, async (_, workerIndex) => {
    const workerId = `executor-${workerIndex + 1}`;
    while (true) {
      const taskIndex = nextIndex;
      nextIndex += 1;
      const task = input.tasks[taskIndex];
      if (!task) {
        input.ownershipRegistry?.releaseAll(workerId);
        return;
      }

      const writePaths = task.writePaths ?? [];
      let reportedWait = false;
      while (writePaths.length > 0 && input.ownershipRegistry && !input.ownershipRegistry.claimAll(workerId, writePaths)) {
        if (!reportedWait) {
          input.onTrace?.(resolveOrchestratorTraceEvent({
            kind: "ownership-pending",
            workerId,
            taskId: task.id,
            writePaths,
          }));
          reportedWait = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      const startedAt = Date.now();
      input.onTrace?.(resolveOrchestratorTraceEvent({
        kind: "executor-running",
        workerId,
        taskId: task.id,
        summary: task.summary,
        startedAt,
      }));

      try {
        results[taskIndex] = await input.executeTask(task);
        const completedAt = Date.now();
        input.onTrace?.(resolveOrchestratorTraceEvent({
          kind: "executor-completed",
          workerId,
          taskId: task.id,
          summary: task.summary,
          startedAt,
          completedAt,
        }));
      } catch (error) {
        const completedAt = Date.now();
        const message = error instanceof Error ? error.message : String(error);
        input.onTrace?.(resolveOrchestratorTraceEvent({
          kind: "executor-failed",
          workerId,
          taskId: task.id,
          summary: task.summary,
          message,
          startedAt,
          completedAt,
        }));
        throw error;
      } finally {
        input.ownershipRegistry?.releaseAll(workerId);
      }
    }
  });

  await Promise.all(workers);
  return results;
}

export async function runGoalTaskExecutorPool<Task extends ComplexPlanTask, Result>(input: {
  readonly tasks: readonly Task[];
  readonly maxWorkers: number;
  readonly executeTask: (task: Task) => Promise<Result>;
  readonly isSuccessful: (result: Result) => boolean;
  readonly createFailedResult?: ((task: Task, error: unknown) => Result) | undefined;
  readonly createBlockedResult?: ((task: Task) => Result) | undefined;
  readonly ownershipRegistry?: FileOwnershipRegistry | undefined;
  readonly onTrace?: TurnOrchestratorTraceListener | undefined;
  readonly onStatus?: ((task: Task, status: WorkNodeStatus) => void) | undefined;
}): Promise<readonly Result[]> {
  const taskById = new Map(input.tasks.map((task) => [task.id, task]));
  if (taskById.size !== input.tasks.length) {
    throw new Error("Goal task plan contains duplicate task ids.");
  }

  for (const [index, task] of input.tasks.entries()) {
    for (const dependencyId of task.dependsOn ?? []) {
      const dependencyIndex = input.tasks.findIndex((candidate) => candidate.id === dependencyId);
      if (dependencyIndex < 0 || dependencyIndex >= index) {
        throw new Error(`Goal task ${task.id} has an invalid dependency: ${dependencyId}`);
      }
    }
  }

  const pending = new Set(input.tasks.map((task) => task.id));
  const successful = new Set<string>();
  const failed = new Set<string>();
  const results = new Map<string, Result>();
  const ownershipRegistry = input.ownershipRegistry ?? new FileOwnershipRegistry();

  while (pending.size > 0) {
    const blocked = input.tasks.filter((task) =>
      pending.has(task.id) && (task.dependsOn ?? []).some((dependencyId) => failed.has(dependencyId))
    );
    for (const task of blocked) {
      pending.delete(task.id);
      failed.add(task.id);
      input.onStatus?.(task, "blocked");
      const blockedResult = input.createBlockedResult?.(task);
      if (blockedResult !== undefined) {
        results.set(task.id, blockedResult);
      }
    }
    if (blocked.length > 0) {
      continue;
    }


    const ready = input.tasks.filter((task) =>
      pending.has(task.id) && (task.dependsOn ?? []).every((dependencyId) => successful.has(dependencyId))
    );
    if (ready.length === 0) {
      if (pending.size > 0) {
        throw new Error("Goal task plan cannot make progress.");
      }
      break;
    }

    for (const task of ready) {
      pending.delete(task.id);
      input.onStatus?.(task, "ready");
    }
    const waveResults = await runBoundedExecutorPool({
      tasks: ready,
      maxWorkers: input.maxWorkers,
      ownershipRegistry,
      executeTask: async (task) => {
        input.onStatus?.(task, "running");
        try {
          const result = await input.executeTask(task);
          input.onStatus?.(task, input.isSuccessful(result) ? "completed" : "failed");
          return result;
        } catch (error) {
          input.onStatus?.(task, "failed");
          const failedResult = input.createFailedResult?.(task, error);
          if (failedResult === undefined) {
            throw error;
          }
          return failedResult;
        }
      },
      ...(input.onTrace ? { onTrace: input.onTrace } : {}),
    });

    for (const [index, task] of ready.entries()) {
      const result = waveResults[index];
      if (result === undefined) {
        throw new Error(`Goal task ${task.id} did not produce a result.`);
      }
      results.set(task.id, result);
      (input.isSuccessful(result) ? successful : failed).add(task.id);
    }
  }

  return input.tasks.flatMap((task) => {
    const result = results.get(task.id);
    return result === undefined ? [] : [result];
  });
}

export function createTurnOrchestrator<Task extends ComplexPlanTask, Result>(deps: {
  readonly runSimpleTurn: (prompt: string) => Promise<{ text: string }>;
  readonly runResearchTurn: (prompt: string) => Promise<{ text: string }>;
  readonly planComplexTurn: (
    prompt: string,
    options?: { readonly onTrace?: TurnOrchestratorTraceListener | undefined },
  ) => Promise<{ readonly tasks: readonly Task[]; readonly usedLlm: boolean }>;
  readonly executeComplexTask: (task: Task) => Promise<Result>;
  readonly isComplexTaskSuccessful?: ((result: Result) => boolean) | undefined;
  readonly createFailedComplexTaskResult?: ((task: Task, error: unknown) => Result) | undefined;
  readonly createBlockedComplexTaskResult?: ((task: Task) => Result) | undefined;
  readonly runGuardianReview?: ((input: {
    readonly prompt: string;
    readonly mode: string;
    readonly tasks: readonly Task[];
    readonly results: readonly Result[];
  }) => Promise<GuardianReviewResult>) | undefined;
}) {
  return {
    async run(input: {
      readonly prompt: string;
      readonly mode: string;
      readonly maxWorkers?: number | undefined;
      readonly ownershipRegistry?: FileOwnershipRegistry | undefined;
      readonly onTrace?: TurnOrchestratorTraceListener | undefined;
      readonly onPlan?: ((tasks: readonly Task[]) => void) | undefined;
      readonly onTaskStatus?: ((task: Task, status: WorkNodeStatus) => void) | undefined;
    }): Promise<
      | { readonly kind: "simple"; readonly text: string }
      | { readonly kind: "research"; readonly text: string }
      | { readonly kind: "complex"; readonly results: readonly Result[]; readonly guardian?: GuardianReviewResult }
    > {
      const intent = classifyWorkIntent(input.prompt, input.mode);

      if (intent === "simple") {
        const result = await deps.runSimpleTurn(input.prompt);
        return { kind: "simple", text: result.text };
      }

      if (intent === "research") {
        const result = await deps.runResearchTurn(input.prompt);
        return { kind: "research", text: result.text };
      }

      // Structural span bracketing the entire complex turn for UI grouping.
      // This is NOT an agent participant — no LLM dispatch corresponds to it.
      // See docs/specs/2026-04-05-unclecode-tui-orchestration-redesign.md §Phase 0.
      const turnStartedAt = Date.now();
      input.onTrace?.(resolveOrchestratorTraceEvent({
        kind: "turn-running",
        startedAt: turnStartedAt,
      }));

      // Phase 0 trace honesty: only emit a planner step when planning actually
      // invoked an LLM. Synchronous static decomposition (e.g. default complex
      // mode `buildComplexTasks`) returns no agent-visible work, so emitting a
      // planner role would mislead consumers about the engine's capabilities.
      // See docs/specs/2026-04-05-unclecode-tui-orchestration-redesign.md §Phase 0.
      //
      // Live-progress: planComplexTurn now receives an onTrace listener and
      // emits the planner running event ITSELF when it actually invokes the
      // LLM (work-agent.ts planTasks). This is option C from Hermes review
      // of c91cd24's Codex S3 finding — the only honest event model: the
      // running event fires when the LLM call begins, not optimistically
      // before await. The orchestrator emits the completed/failed bracket
      // after planComplexTurn resolves, with usedLlm:false suppressing the
      // entire bracket so static plans stay invisible (the running event
      // only fires when the planner itself decided to invoke an LLM).
      const plannerStartedAt = Date.now();
      const planOutcome = await deps.planComplexTurn(input.prompt, {
        onTrace: input.onTrace,
      });
      const tasks = planOutcome.tasks;
      input.onPlan?.(tasks);
      const plannerCompletedAt = Date.now();
      if (planOutcome.usedLlm) {
        // Pair the running event the planner already emitted with a
        // matching completed event keyed on the same step id. Step ids
        // use the orchestrator-side timestamp so consumers can rely on
        // matching pairs without seeing the planner's internal clock.
        input.onTrace?.(resolveOrchestratorTraceEvent({
          kind: "planner-completed",
          taskCount: tasks.length,
          startedAt: plannerStartedAt,
          completedAt: plannerCompletedAt,
        }));
      }

      const results = deps.isComplexTaskSuccessful
        ? await runGoalTaskExecutorPool({
            tasks,
            maxWorkers: input.maxWorkers ?? 1,
            executeTask: deps.executeComplexTask,
            isSuccessful: deps.isComplexTaskSuccessful,
            ...(deps.createFailedComplexTaskResult
              ? { createFailedResult: deps.createFailedComplexTaskResult }
              : {}),
            ...(deps.createBlockedComplexTaskResult
              ? { createBlockedResult: deps.createBlockedComplexTaskResult }
              : {}),
            ownershipRegistry: input.ownershipRegistry ?? new FileOwnershipRegistry(),
            ...(input.onTrace ? { onTrace: input.onTrace } : {}),
            ...(input.onTaskStatus ? { onStatus: input.onTaskStatus } : {}),
          })
        : await runBoundedExecutorPool({
            tasks,
            maxWorkers: input.maxWorkers ?? 1,
            executeTask: deps.executeComplexTask,
            ownershipRegistry: input.ownershipRegistry ?? new FileOwnershipRegistry(),
            ...(input.onTrace ? { onTrace: input.onTrace } : {}),
          });

      const runGuardianReview = deps.runGuardianReview;
      const guardian = runGuardianReview
        ? await (async () => {
            const reviewerStartedAt = Date.now();
            input.onTrace?.(resolveOrchestratorTraceEvent({
              kind: "guardian-running",
              startedAt: reviewerStartedAt,
            }));

            try {
              const result = await runGuardianReview({
                prompt: input.prompt,
                mode: input.mode,
                tasks,
                results,
              });
              const reviewerCompletedAt = Date.now();
              input.onTrace?.(resolveOrchestratorTraceEvent({
                kind: "guardian-completed",
                summary: result.summary,
                startedAt: reviewerStartedAt,
                completedAt: reviewerCompletedAt,
              }));
              return result;
            } catch (error) {
              const reviewerCompletedAt = Date.now();
              const message = error instanceof Error ? error.message : String(error);
              input.onTrace?.(resolveOrchestratorTraceEvent({
                kind: "guardian-failed",
                message,
                startedAt: reviewerStartedAt,
                completedAt: reviewerCompletedAt,
              }));
              throw error;
            }
          })()
        : undefined;

      const turnCompletedAt = Date.now();
      input.onTrace?.(resolveOrchestratorTraceEvent({
        kind: "turn-completed",
        taskCount: results.length,
        startedAt: turnStartedAt,
        completedAt: turnCompletedAt,
      }));

      return {
        kind: "complex",
        results,
        ...(guardian ? { guardian } : {}),
      };
    },
  };
}
