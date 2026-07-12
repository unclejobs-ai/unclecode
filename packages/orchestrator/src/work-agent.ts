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
  type ComplexPlanTask,
  type TurnOrchestratorTraceListener,
} from "./turn-orchestrator.js";
import { runRustCommandSync } from "./rust-command.js";

type ReasoningLike = {
  readonly effort: string;
};

type PlannedWorkTask = ComplexPlanTask & {
  readonly prompt: string;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly dependsOn: readonly string[];
  readonly writePaths: readonly string[];
};

type PlannedWorkResult = {
  readonly id: string;
  readonly summary: string;
  readonly status: Extract<WorkNodeStatus, "completed" | "failed" | "blocked">;
};

export type OrchestratedWorkAgentTraceEvent<TraceEvent extends { readonly type: string }> =
  | TraceEvent
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

function parsePlannedWorkTasks(raw: string): readonly PlannedWorkTask[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Rust orchestrator returned invalid complex tasks.");
  }
  return parsed.map((item) => {
    const record = typeof item === "object" && item !== null
      ? item as Record<string, unknown>
      : undefined;
    if (
      !record
      || typeof record.id !== "string"
      || typeof record.summary !== "string"
      || typeof record.prompt !== "string"
      || typeof record.goal !== "string"
      || !isStringArray(record.constraints)
      || !isStringArray(record.acceptanceCriteria)
      || record.acceptanceCriteria.length === 0
      || !isStringArray(record.dependsOn)
      || !isStringArray(record.writePaths)
    ) {
      throw new Error("Rust orchestrator returned invalid complex task entries.");
    }
    return {
      id: record.id,
      summary: record.summary,
      prompt: record.prompt,
      goal: record.goal,
      constraints: record.constraints,
      acceptanceCriteria: record.acceptanceCriteria,
      dependsOn: record.dependsOn,
      writePaths: record.writePaths,
    };
  });
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function buildComplexTasks(prompt: string): readonly PlannedWorkTask[] {
  return parsePlannedWorkTasks(
    runRustCommandSync(["rust", "orchestrator", "complex-tasks"], process.cwd(), prompt),
  );
}

function buildPlannerPrompt(prompt: string): string {
  return runRustCommandSync(
    ["rust", "orchestrator", "planner-prompt"],
    process.cwd(),
    JSON.stringify({ prompt }),
  ).trimEnd();
}

function buildGuardianReviewPrompt(input: {
  readonly prompt: string;
  readonly results: readonly { readonly summary: string }[];
  readonly executableChecks?: string | undefined;
}): string {
  return runRustCommandSync(
    ["rust", "orchestrator", "guardian-review-prompt"],
    process.cwd(),
    JSON.stringify(input),
  ).trimEnd();
}

function buildSynthesisPrompt(input: {
  readonly prompt: string;
  readonly model: string;
  readonly reasoning: string;
  readonly results: readonly { readonly summary: string }[];
  readonly guardianSummary?: string | undefined;
}): string {
  return runRustCommandSync(
    ["rust", "orchestrator", "synthesis-prompt"],
    process.cwd(),
    JSON.stringify(input),
  ).trimEnd();
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

type ExecutorAgentFactory<
  Attachment,
  TraceEvent extends { readonly type: string },
  Reasoning extends ReasoningLike,
> = (settings: {
  readonly mode: string;
  readonly model: string;
  readonly reasoning: Reasoning;
}) => Promise<OrchestratedWorkTurnAgent<Attachment, TraceEvent, Reasoning>>;

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
  private readonly runExecutableGuardianChecks?: ((input: {
    readonly prompt: string;
    readonly mode: string;
    readonly tasks: readonly PlannedWorkTask[];
    readonly results: readonly PlannedWorkResult[];
    readonly changedFiles: readonly string[];
  }) => Promise<{ readonly summary: string }>) | undefined;
  private traceListener: ((event: OrchestratedWorkAgentTraceEvent<TraceEvent>) => void) | undefined;

  constructor(input: {
    directAgent: OrchestratedWorkTurnAgent<Attachment, TraceEvent, Reasoning>;
    createExecutorAgent?: ExecutorAgentFactory<Attachment, TraceEvent, Reasoning> | undefined;
    mode: string;
    reasoning: Reasoning;
    model: string;
    runExecutableGuardianChecks?: ((input: {
      readonly prompt: string;
      readonly mode: string;
      readonly tasks: readonly PlannedWorkTask[];
      readonly results: readonly PlannedWorkResult[];
      readonly changedFiles: readonly string[];
    }) => Promise<{ readonly summary: string }>) | undefined;
  }) {
    this.directAgent = input.directAgent;
    this.createExecutorAgent = input.createExecutorAgent;
    this.mode = input.mode;
    this.reasoning = input.reasoning;
    this.model = input.model;
    this.runExecutableGuardianChecks = input.runExecutableGuardianChecks;
    this.applyAutoModeShellPermission();
  }

  // YOLO / ultrawork are explicit full-autonomy opt-ins, so the agent may run
  // shell commands (open files, run builds, etc.) without the extra
  // UNCLECODE_ALLOW_RUN_SHELL env gate. Other modes keep the default gate.
  private applyAutoModeShellPermission(): void {
    if (this.mode === "yolo" || this.mode === "ultrawork") {
      process.env.UNCLECODE_ALLOW_RUN_SHELL = "1";
    }
  }

  clear(): void {
    this.directAgent.clear();
  }

  private async runInternalTurn(
    prompt: string,
    attachments: readonly Attachment[] = [],
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<{ text: string }> {
    const outerListener = this.traceListener;
    this.directAgent.setTraceListener(undefined);
    try {
      return await this.directAgent.runTurn(prompt, attachments, options);
    } finally {
      this.directAgent.setTraceListener(outerListener ? (event) => this.emitTrace(event) : undefined);
    }
  }

  private async planTasks(
    prompt: string,
    onTrace?: TurnOrchestratorTraceListener,
    signal?: AbortSignal | undefined,
  ): Promise<{ readonly tasks: readonly PlannedWorkTask[]; readonly usedLlm: boolean }> {
    const staticTasks = buildComplexTasks(prompt);
    let plannerInvoked = false;

    try {
      const planPrompt = buildPlannerPrompt(prompt);
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
    } catch {
      // A deterministic end-to-end task keeps the turn actionable when planning fails.
    }

    return { tasks: staticTasks, usedLlm: plannerInvoked };
  }

  private async runExecutorTurn(
    prompt: string,
    options: { readonly signal?: AbortSignal | undefined },
  ): Promise<{ text: string }> {
    if (!this.createExecutorAgent) {
      return this.runInternalTurn(prompt, [], options);
    }

    const executor = await this.createExecutorAgent({
      mode: this.mode,
      model: this.model,
      reasoning: this.reasoning,
    });
    executor.setTraceListener(this.traceListener ? (event) => this.emitTrace(event) : undefined);
    try {
      return await executor.runTurn(prompt, [], options);
    } finally {
      executor.clear();
    }
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

  updateMode(mode: string): void {
    this.mode = mode;
    this.applyAutoModeShellPermission();
    this.directAgent.updateMode?.(mode);
  }

  async runTurn(prompt: string, attachments: readonly Attachment[] = [], options: { readonly signal?: AbortSignal | undefined } = {}): Promise<{ text: string }> {
    if (attachments.length > 0) {
      return this.directAgent.runTurn(prompt, attachments, options);
    }

    let activeGraphId: string | undefined;
    const orchestrator = createTurnOrchestrator<PlannedWorkTask, PlannedWorkResult>({
      runSimpleTurn: (simplePrompt) => this.directAgent.runTurn(simplePrompt, attachments, options),
      runResearchTurn: (researchPrompt) => this.directAgent.runTurn(researchPrompt, attachments, options),
      planComplexTurn: async (complexPrompt, planOptions) => {
        const { tasks, usedLlm } = await this.planTasks(complexPrompt, planOptions?.onTrace, options.signal);
        return { tasks, usedLlm };
      },
      executeComplexTask: async (task) => {
        const result = await this.runExecutorTurn(task.prompt, options);
        return { id: task.id, summary: result.text, status: "completed" };
      },
      isComplexTaskSuccessful: (taskResult) => taskResult.status === "completed",
      createFailedComplexTaskResult: (task, error) => ({
        id: task.id,
        summary: `Executor failed: ${error instanceof Error ? error.message : String(error)}`,
        status: "failed",
      }),
      createBlockedComplexTaskResult: (task) => ({
        id: task.id,
        summary: "Blocked because a dependency failed.",
        status: "blocked",
      }),
      runGuardianReview: async ({ prompt: originalPrompt, tasks, results }) => {
        const changedFiles = extractChangedFilesFromTasks(tasks);
        const executableChecks = await this.loadExecutableGuardianSummary({
          prompt: originalPrompt,
          mode: this.mode,
          tasks,
          results,
          changedFiles,
        });
        const reviewPrompt = buildGuardianReviewPrompt({
          prompt: originalPrompt,
          results,
          ...(executableChecks ? { executableChecks } : {}),
        });
        const review = await this.runInternalTurn(reviewPrompt, [], options);
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

    const synthesis = await this.directAgent.runTurn(synthesisPrompt, [], options);
    const reviewerCompletedAt = Date.now();
    this.emitTrace(resolveAgentTraceEvent({
      kind: "synthesis-completed",
      resultCount: result.results.length,
      startedAt: reviewerStartedAt,
      completedAt: reviewerCompletedAt,
    }));

    return { text: synthesis.text };
  }

  private async loadExecutableGuardianSummary(input: {
    readonly prompt: string;
    readonly mode: string;
    readonly tasks: readonly PlannedWorkTask[];
    readonly results: readonly PlannedWorkResult[];
    readonly changedFiles: readonly string[];
  }): Promise<string | undefined> {
    if (!this.runExecutableGuardianChecks) {
      return undefined;
    }

    try {
      return (await this.runExecutableGuardianChecks(input)).summary;
    } catch (error) {
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
