import type { OrchestratorStepTraceEvent } from "@unclecode/contracts";

import { createTurnOrchestrator, type ComplexPlanTask } from "./turn-orchestrator.js";

type ReasoningLike = {
  readonly effort: string;
};

type PlannedWorkTask = ComplexPlanTask & {
  readonly prompt: string;
};

export type OrchestratedWorkAgentTraceEvent<TraceEvent extends { readonly type: string }> =
  | TraceEvent
  | OrchestratorStepTraceEvent;

export interface OrchestratedWorkTurnAgent<
  Attachment,
  TraceEvent extends { readonly type: string },
  Reasoning extends ReasoningLike,
> {
  clear(): void;
  setTraceListener(listener?: ((event: TraceEvent) => void) | undefined): void;
  updateRuntimeSettings(settings: { reasoning?: Reasoning | undefined; model?: string | undefined }): void;
  runTurn(prompt: string, attachments?: readonly Attachment[]): Promise<{ text: string }>;
}

function extractFilePaths(prompt: string): readonly string[] {
  return [...new Set(prompt.match(/[\w./-]+\.\w{1,5}/g) ?? [])];
}

function buildComplexTasks(prompt: string): readonly PlannedWorkTask[] {
  const filePaths = extractFilePaths(prompt);
  if (filePaths.length > 0) {
    return filePaths.map((filePath, index) => ({
      id: `task-${index + 1}`,
      summary: `Inspect ${filePath}`,
      prompt: `Inspect ${filePath} for this request and report the concrete changes or risks.\n\nOriginal request: ${prompt}`,
    }));
  }

  return [
    {
      id: "task-1",
      summary: "Inspect current implementation and constraints",
      prompt: `Inspect the current implementation and constraints for this request.\n\nOriginal request: ${prompt}`,
    },
    {
      id: "task-2",
      summary: "Identify risks and edge cases",
      prompt: `Identify the main risks, edge cases, and verification concerns for this request.\n\nOriginal request: ${prompt}`,
    },
  ];
}

function extractChangedFilesFromTasks(tasks: readonly PlannedWorkTask[]): readonly string[] {
  return [
    ...new Set(
      tasks.flatMap((task) => [
        ...extractFilePaths(task.summary),
        ...extractFilePaths(task.prompt),
      ]),
    ),
  ];
}

function resolveWorkerBudget(mode: string): number {
  if (mode === "ultrawork") {
    return 5;
  }
  if (mode === "search" || mode === "analyze") {
    return 3;
  }
  return 1;
}

export class WorkAgent<
  Attachment,
  TraceEvent extends { readonly type: string },
  Reasoning extends ReasoningLike,
> {
  private readonly directAgent: OrchestratedWorkTurnAgent<Attachment, TraceEvent, Reasoning>;
  private readonly mode: string;
  private reasoning: Reasoning;
  private model: string;
  private readonly runExecutableGuardianChecks?: ((input: {
    readonly prompt: string;
    readonly mode: string;
    readonly tasks: readonly PlannedWorkTask[];
    readonly results: readonly { id: string; summary: string }[];
    readonly changedFiles: readonly string[];
  }) => Promise<{ readonly summary: string }>) | undefined;
  private traceListener: ((event: OrchestratedWorkAgentTraceEvent<TraceEvent>) => void) | undefined;

  constructor(input: {
    directAgent: OrchestratedWorkTurnAgent<Attachment, TraceEvent, Reasoning>;
    mode: string;
    reasoning: Reasoning;
    model: string;
    runExecutableGuardianChecks?: ((input: {
      readonly prompt: string;
      readonly mode: string;
      readonly tasks: readonly PlannedWorkTask[];
      readonly results: readonly { id: string; summary: string }[];
      readonly changedFiles: readonly string[];
    }) => Promise<{ readonly summary: string }>) | undefined;
  }) {
    this.directAgent = input.directAgent;
    this.mode = input.mode;
    this.reasoning = input.reasoning;
    this.model = input.model;
    this.runExecutableGuardianChecks = input.runExecutableGuardianChecks;
  }

  clear(): void {
    this.directAgent.clear();
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

  async runTurn(prompt: string, attachments: readonly Attachment[] = []): Promise<{ text: string }> {
    if (attachments.length > 0) {
      return this.directAgent.runTurn(prompt, attachments);
    }

    const orchestrator = createTurnOrchestrator<PlannedWorkTask, { id: string; summary: string }>({
      runSimpleTurn: (simplePrompt) => this.directAgent.runTurn(simplePrompt, attachments),
      runResearchTurn: (researchPrompt) => this.directAgent.runTurn(researchPrompt, attachments),
      planComplexTurn: async (complexPrompt) => buildComplexTasks(complexPrompt),
      executeComplexTask: async (task) => {
        const result = await this.directAgent.runTurn(task.prompt, []);
        return { id: task.id, summary: result.text };
      },
      runGuardianReview: async ({ prompt: originalPrompt, tasks, results }) => {
        const changedFiles = extractChangedFilesFromTasks(tasks);
        const executableChecks = await this.loadExecutableGuardianSummary({
          prompt: originalPrompt,
          mode: this.mode,
          tasks,
          results,
          changedFiles,
        });
        const reviewPrompt = [
          "Review the executor findings for gaps, contradictions, and missing verification.",
          `Original request: ${originalPrompt}`,
          "Executor findings:",
          ...results.map((item, index) => `- [${index + 1}] ${item.summary}`),
          ...(executableChecks ? ["Executable verification:", executableChecks] : []),
        ].join("\n\n");
        const review = await this.directAgent.runTurn(reviewPrompt, []);
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
      maxWorkers: resolveWorkerBudget(this.mode),
      ...(this.traceListener ? { onTrace: (event) => this.emitTrace(event) } : {}),
    });

    if (result.kind !== "complex") {
      return { text: result.text };
    }

    const reviewerStartedAt = Date.now();
    this.emitTrace({
      type: "orchestrator.step",
      level: "high-signal",
      stepId: `reviewer-${reviewerStartedAt}`,
      role: "reviewer",
      status: "running",
      summary: `Synthesizing ${result.results.length} executor result${result.results.length === 1 ? "" : "s"}`,
      startedAt: reviewerStartedAt,
    });

    const synthesisPrompt = [
      "Synthesize executor findings into a single answer for the original request.",
      `Model: ${this.model}`,
      `Reasoning: ${this.reasoning.effort}`,
      `Original request: ${prompt}`,
      "Findings:",
      ...result.results.map((item, index) => `- [${index + 1}] ${item.summary}`),
      ...(result.guardian ? ["Guardian review:", result.guardian.summary] : []),
    ].join("\n\n");

    const synthesis = await this.directAgent.runTurn(synthesisPrompt, []);
    const reviewerCompletedAt = Date.now();
    this.emitTrace({
      type: "orchestrator.step",
      level: "high-signal",
      stepId: `reviewer-${reviewerStartedAt}`,
      role: "reviewer",
      status: "completed",
      summary: `Synthesized ${result.results.length} executor result${result.results.length === 1 ? "" : "s"}`,
      startedAt: reviewerStartedAt,
      completedAt: reviewerCompletedAt,
      durationMs: reviewerCompletedAt - reviewerStartedAt,
    });

    return { text: synthesis.text };
  }

  private async loadExecutableGuardianSummary(input: {
    readonly prompt: string;
    readonly mode: string;
    readonly tasks: readonly PlannedWorkTask[];
    readonly results: readonly { id: string; summary: string }[];
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
