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
  updateMode?(mode: string): void;
  runTurn(prompt: string, attachments?: readonly Attachment[]): Promise<{ text: string }>;
}

export function parseAgentPlanResponse(text: string): readonly PlannedWorkTask[] {
  const jsonMatch = text.match(/\[[\s\S]*]/);
  if (!jsonMatch) return [];

  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (item): item is { id: string; summary: string; prompt: string } =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>).id === "string" &&
          typeof (item as Record<string, unknown>).summary === "string" &&
          typeof (item as Record<string, unknown>).prompt === "string",
      )
      .map((item) => ({
        id: item.id,
        summary: item.summary,
        prompt: item.prompt,
      }));
  } catch {
    return [];
  }
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
      summary: "Investigate scope and current implementation",
      prompt: `Read the relevant code to understand what exists today. Identify the files, functions, and types involved.\n\nRequest: ${prompt}`,
    },
    {
      id: "task-2",
      summary: "Plan changes and identify risks",
      prompt: `Based on the codebase, outline what needs to change, what tests are needed, and what could break.\n\nRequest: ${prompt}`,
    },
    {
      id: "task-3",
      summary: "Verify constraints and edge cases",
      prompt: `Check for edge cases, type safety concerns, and existing test coverage gaps related to this request.\n\nRequest: ${prompt}`,
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

export function resolveWorkerBudget(mode: string): number {
  if (mode === "ultrawork") {
    return 5;
  }
  if (mode === "yolo") {
    return 4;
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
  private mode: string;
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

  private async planTasks(
    prompt: string,
  ): Promise<{ readonly tasks: readonly PlannedWorkTask[]; readonly usedLlm: boolean }> {
    const staticTasks = buildComplexTasks(prompt);
    if (this.mode !== "yolo" && this.mode !== "ultrawork") {
      return { tasks: staticTasks, usedLlm: false };
    }

    try {
      const planPrompt = [
        "Break this request into 2-4 independent subtasks.",
        "Return ONLY a JSON array of objects with {id, summary, prompt} fields.",
        "Each subtask should be independently executable.",
        `Request: ${prompt}`,
      ].join("\n");
      const result = await this.directAgent.runTurn(planPrompt, []);
      const parsed = parseAgentPlanResponse(result.text);
      if (parsed.length >= 2) {
        return { tasks: parsed, usedLlm: true };
      }
    } catch {
      // Fall back to static decomposition on any failure
    }

    return { tasks: staticTasks, usedLlm: false };
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
    this.directAgent.updateMode?.(mode);
  }

  async runTurn(prompt: string, attachments: readonly Attachment[] = []): Promise<{ text: string }> {
    if (attachments.length > 0) {
      return this.directAgent.runTurn(prompt, attachments);
    }

    const orchestrator = createTurnOrchestrator<PlannedWorkTask, { id: string; summary: string }>({
      runSimpleTurn: (simplePrompt) => this.directAgent.runTurn(simplePrompt, attachments),
      runResearchTurn: (researchPrompt) => this.directAgent.runTurn(researchPrompt, attachments),
      planComplexTurn: async (complexPrompt) => {
        const { tasks, usedLlm } = await this.planTasks(complexPrompt);
        return { tasks, usedLlm };
      },
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
