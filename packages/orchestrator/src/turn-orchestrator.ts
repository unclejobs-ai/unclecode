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
  const complexKeywordsKo = /(리팩터|마이그레이션|전체|모든 파일|재작성|재설계)/;
  const yoloComplexKeywords = /\b(fix|implement|add|update|change|create|build|improve)\b/i;
  const yoloComplexKeywordsKo = /(수정|구현|추가|변경|고쳐|만들어|개선|빌드)/;

  if (filePathCount >= 3 || complexKeywords.test(prompt) || complexKeywordsKo.test(prompt)) {
    return "complex";
  }

  if (mode === "yolo" && (filePathCount >= 2 || yoloComplexKeywords.test(prompt) || yoloComplexKeywordsKo.test(prompt))) {
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
            kind: "agent-step",
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
        kind: "agent-step",
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
          kind: "agent-step",
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
          kind: "agent-step",
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
  readonly planComplexTurn: (
    prompt: string,
  ) => Promise<{ readonly tasks: readonly Task[]; readonly usedLlm: boolean }>;
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

      // Structural span bracketing the entire complex turn for UI grouping.
      // This is NOT an agent participant — no LLM dispatch corresponds to it.
      // See docs/specs/2026-04-05-unclecode-tui-orchestration-redesign.md §Phase 0.
      const turnStartedAt = Date.now();
      input.onTrace?.({
        type: "orchestrator.step",
        level: "high-signal",
        stepId: `turn-${turnStartedAt}`,
        role: "turn",
        kind: "span",
        status: "running",
        summary: "Routing complex turn to planner",
        startedAt: turnStartedAt,
      });

      // Phase 0 trace honesty: only emit a planner step when planning actually
      // invoked an LLM. Synchronous static decomposition (e.g. default complex
      // mode `buildComplexTasks`) returns no agent-visible work, so emitting a
      // planner role would mislead consumers about the engine's capabilities.
      // See docs/specs/2026-04-05-unclecode-tui-orchestration-redesign.md §Phase 0.
      //
      // Live-progress nuance: because the orchestrator only knows `usedLlm`
      // after `planComplexTurn` resolves, the `running` and `completed` events
      // here fire in the same tick — UIs rendering a spinner for slow LLM
      // planning will not see an intermediate state. A follow-up refactor
      // should let the planner implementation emit `running` itself (e.g. by
      // accepting a trace listener), but that touches the dependency contract
      // and is out of scope for this Phase 0 cleanup.
      const plannerStartedAt = Date.now();
      const planOutcome = await deps.planComplexTurn(input.prompt);
      const tasks = planOutcome.tasks;
      const plannerCompletedAt = Date.now();
      if (planOutcome.usedLlm) {
        input.onTrace?.({
          type: "orchestrator.step",
          level: "high-signal",
          stepId: `planner-${plannerStartedAt}`,
          role: "planner",
          kind: "agent-step",
          status: "running",
          summary: `Planning: ${input.prompt}`,
          startedAt: plannerStartedAt,
        });
        input.onTrace?.({
          type: "orchestrator.step",
          level: "high-signal",
          stepId: `planner-${plannerStartedAt}`,
          role: "planner",
          kind: "agent-step",
          status: "completed",
          summary: `Prepared ${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
          startedAt: plannerStartedAt,
          completedAt: plannerCompletedAt,
          durationMs: plannerCompletedAt - plannerStartedAt,
        });
      }

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
              kind: "agent-step",
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
                kind: "agent-step",
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
                kind: "agent-step",
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

      const turnCompletedAt = Date.now();
      input.onTrace?.({
        type: "orchestrator.step",
        level: "high-signal",
        stepId: `turn-${turnStartedAt}`,
        role: "turn",
        kind: "span",
        status: "completed",
        summary: `Completed ${results.length} task${results.length === 1 ? "" : "s"}`,
        startedAt: turnStartedAt,
        completedAt: turnCompletedAt,
        durationMs: turnCompletedAt - turnStartedAt,
      });

      return {
        kind: "complex",
        results,
        ...(guardian ? { guardian } : {}),
      };
    },
  };
}
