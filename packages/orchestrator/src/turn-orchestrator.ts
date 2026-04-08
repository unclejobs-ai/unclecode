import type { OrchestratorStepTraceEvent } from "@unclecode/contracts";

import { FileOwnershipRegistry } from "./file-ownership-registry.js";

export type WorkIntent = "simple" | "complex" | "research";

export type ComplexPlanTask = {
  readonly id: string;
  readonly summary: string;
  readonly writePaths?: readonly string[];
};

export type GuardianReviewResult = {
  readonly summary: string;
};

export type TurnOrchestratorTraceListener = (event: OrchestratorStepTraceEvent) => void;

export function classifyWorkIntent(prompt: string, mode: string): WorkIntent {
  if (mode === "ultrawork") {
    return "complex";
  }

  if (mode === "search" || mode === "analyze") {
    return "research";
  }

  if (prompt.startsWith("/")) {
    return "simple";
  }

  const filePathCount = (prompt.match(/[\w-./]+\.\w{1,5}/g) ?? []).length;
  const complexKeywords = /\b(refactor|migrate|rewrite|redesign|rebuild|all files|entire|every)\b/i;

  if (filePathCount >= 3 || complexKeywords.test(prompt)) {
    return "complex";
  }

  return "simple";
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
          input.onTrace?.({
            type: "orchestrator.step",
            level: "high-signal",
            stepId: `executor-${workerIndex + 1}-${task.id}-ownership`,
            role: "executor",
            status: "pending",
            summary: `Waiting for write ownership: ${writePaths.join(", ")}`,
          });
          reportedWait = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      const startedAt = Date.now();
      input.onTrace?.({
        type: "orchestrator.step",
        level: "high-signal",
        stepId: `executor-${workerIndex + 1}-${task.id}`,
        role: "executor",
        status: "running",
        summary: task.summary,
        startedAt,
      });

      try {
        results[taskIndex] = await input.executeTask(task);
        const completedAt = Date.now();
        input.onTrace?.({
          type: "orchestrator.step",
          level: "high-signal",
          stepId: `executor-${workerIndex + 1}-${task.id}`,
          role: "executor",
          status: "completed",
          summary: task.summary,
          startedAt,
          completedAt,
          durationMs: completedAt - startedAt,
        });
      } catch (error) {
        const completedAt = Date.now();
        const message = error instanceof Error ? error.message : String(error);
        input.onTrace?.({
          type: "orchestrator.step",
          level: "high-signal",
          stepId: `executor-${workerIndex + 1}-${task.id}`,
          role: "executor",
          status: "failed",
          summary: `${task.summary}: ${message}`,
          startedAt,
          completedAt,
          durationMs: completedAt - startedAt,
        });
        throw error;
      } finally {
        input.ownershipRegistry?.releaseAll(workerId);
      }
    }
  });

  await Promise.all(workers);
  return results;
}

export function createTurnOrchestrator<Task extends ComplexPlanTask, Result>(deps: {
  readonly runSimpleTurn: (prompt: string) => Promise<{ text: string }>;
  readonly runResearchTurn: (prompt: string) => Promise<{ text: string }>;
  readonly planComplexTurn: (prompt: string) => Promise<readonly Task[]>;
  readonly executeComplexTask: (task: Task) => Promise<Result>;
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

      const coordinatorStartedAt = Date.now();
      input.onTrace?.({
        type: "orchestrator.step",
        level: "high-signal",
        stepId: `coordinator-${coordinatorStartedAt}`,
        role: "coordinator",
        status: "running",
        summary: "Routing complex turn to planner",
        startedAt: coordinatorStartedAt,
      });

      const plannerStartedAt = Date.now();
      input.onTrace?.({
        type: "orchestrator.step",
        level: "high-signal",
        stepId: `planner-${plannerStartedAt}`,
        role: "planner",
        status: "running",
        summary: `Planning: ${input.prompt}`,
        startedAt: plannerStartedAt,
      });

      const tasks = await deps.planComplexTurn(input.prompt);
      const plannerCompletedAt = Date.now();
      input.onTrace?.({
        type: "orchestrator.step",
        level: "high-signal",
        stepId: `planner-${plannerStartedAt}`,
        role: "planner",
        status: "completed",
        summary: `Prepared ${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
        startedAt: plannerStartedAt,
        completedAt: plannerCompletedAt,
        durationMs: plannerCompletedAt - plannerStartedAt,
      });

      const results = await runBoundedExecutorPool({
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
            input.onTrace?.({
              type: "orchestrator.step",
              level: "high-signal",
              stepId: `reviewer-${reviewerStartedAt}`,
              role: "reviewer",
              status: "running",
              summary: "Guardian auto-review",
              startedAt: reviewerStartedAt,
            });

            try {
              const result = await runGuardianReview({
                prompt: input.prompt,
                mode: input.mode,
                tasks,
                results,
              });
              const reviewerCompletedAt = Date.now();
              input.onTrace?.({
                type: "orchestrator.step",
                level: "high-signal",
                stepId: `reviewer-${reviewerStartedAt}`,
                role: "reviewer",
                status: "completed",
                summary: `Guardian review: ${result.summary}`,
                startedAt: reviewerStartedAt,
                completedAt: reviewerCompletedAt,
                durationMs: reviewerCompletedAt - reviewerStartedAt,
              });
              return result;
            } catch (error) {
              const reviewerCompletedAt = Date.now();
              const message = error instanceof Error ? error.message : String(error);
              input.onTrace?.({
                type: "orchestrator.step",
                level: "high-signal",
                stepId: `reviewer-${reviewerStartedAt}`,
                role: "reviewer",
                status: "failed",
                summary: `Guardian review failed: ${message}`,
                startedAt: reviewerStartedAt,
                completedAt: reviewerCompletedAt,
                durationMs: reviewerCompletedAt - reviewerStartedAt,
              });
              throw error;
            }
          })()
        : undefined;

      const coordinatorCompletedAt = Date.now();
      input.onTrace?.({
        type: "orchestrator.step",
        level: "high-signal",
        stepId: `coordinator-${coordinatorStartedAt}`,
        role: "coordinator",
        status: "completed",
        summary: `Completed ${results.length} task${results.length === 1 ? "" : "s"}`,
        startedAt: coordinatorStartedAt,
        completedAt: coordinatorCompletedAt,
        durationMs: coordinatorCompletedAt - coordinatorStartedAt,
      });

      return {
        kind: "complex",
        results,
        ...(guardian ? { guardian } : {}),
      };
    },
  };
}
