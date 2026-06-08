import type { OrchestratorStepTraceEvent } from "@unclecode/contracts";

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
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>).id !== "string" ||
      typeof (item as Record<string, unknown>).summary !== "string" ||
      typeof (item as Record<string, unknown>).prompt !== "string"
    ) {
      throw new Error("Rust orchestrator returned invalid complex task entries.");
    }
    return {
      id: (item as { id: string }).id,
      summary: (item as { summary: string }).summary,
      prompt: (item as { prompt: string }).prompt,
    };
  });
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

  private async planTasks(
    prompt: string,
    onTrace?: TurnOrchestratorTraceListener,
    signal?: AbortSignal | undefined,
  ): Promise<{ readonly tasks: readonly PlannedWorkTask[]; readonly usedLlm: boolean }> {
    const staticTasks = buildComplexTasks(prompt);
    if (this.mode !== "yolo" && this.mode !== "ultrawork") {
      return { tasks: staticTasks, usedLlm: false };
    }

    try {
      const planPrompt = buildPlannerPrompt(prompt);
      // Emit running BEFORE the LLM call so a UI rendering live progress
      // sees the planner's spinner state for the duration of the actual
      // model invocation. The orchestrator emits the matching completed
      // event after planComplexTurn resolves with usedLlm:true. This is
      // option C from Hermes review of c91cd24's Codex S3 finding.
      const plannerStartedAt = Date.now();
      onTrace?.(resolveAgentTraceEvent({
        kind: "planner-running",
        prompt,
        startedAt: plannerStartedAt,
      }));
      const result = await this.directAgent.runTurn(planPrompt, [], { signal });
      const parsed = parseAgentPlanResponse(result.text);
      if (parsed.length >= 2) {
        return { tasks: parsed, usedLlm: true };
      }
      // Parse failure — silently fall through to static. The running event
      // is left dangling on purpose: the orchestrator's usedLlm:false path
      // will not emit a completed event, so the UI will see the running
      // state cleared by the next turn's events. A "failed" event would
      // misrepresent a successful turn that simply could not parse 2+
      // subtasks; we prefer the smaller dishonesty (a phantom running
      // tile) until the planner has a richer outcome enum.
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
    this.applyAutoModeShellPermission();
    this.directAgent.updateMode?.(mode);
  }

  async runTurn(prompt: string, attachments: readonly Attachment[] = [], options: { readonly signal?: AbortSignal | undefined } = {}): Promise<{ text: string }> {
    if (attachments.length > 0) {
      return this.directAgent.runTurn(prompt, attachments, options);
    }

    const orchestrator = createTurnOrchestrator<PlannedWorkTask, { id: string; summary: string }>({
      runSimpleTurn: (simplePrompt) => this.directAgent.runTurn(simplePrompt, attachments, options),
      runResearchTurn: (researchPrompt) => this.directAgent.runTurn(researchPrompt, attachments, options),
      planComplexTurn: async (complexPrompt, planOptions) => {
        const { tasks, usedLlm } = await this.planTasks(complexPrompt, planOptions?.onTrace, options.signal);
        return { tasks, usedLlm };
      },
      executeComplexTask: async (task) => {
        const result = await this.directAgent.runTurn(task.prompt, [], options);
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
        const reviewPrompt = buildGuardianReviewPrompt({
          prompt: originalPrompt,
          results,
          ...(executableChecks ? { executableChecks } : {}),
        });
        const review = await this.directAgent.runTurn(reviewPrompt, [], options);
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
