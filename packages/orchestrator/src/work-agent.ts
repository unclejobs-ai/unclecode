import { randomUUID } from "node:crypto";

import {
  classifyQualityProfile,
  DEFAULT_ITERATION_LIMITS,
  type GateEvidence,
  type QualityRunProjection,
  type RiskLevel,
} from "@second-claude/core";
import type {
  OrchestratorStepTraceEvent,
  QualityCompletedTraceEvent,
  QualityGateEvaluatedTraceEvent,
  QualityGateStatus,
  QualityHarnessStage,
  QualityPivotRequestedTraceEvent,
  QualityProfile,
  QualityRefineRequestedTraceEvent,
  QualityStageStartedTraceEvent,
  WorkApprovedTraceEvent,
  WorkGraph,
  WorkNodeStatus,
  WorkProposedTraceEvent,
  WorkStatusTraceEvent,
} from "@unclecode/contracts";
import {
  type PluginDecisionAggregate,
  PluginHost,
} from "@unclecode/plugin-host";

import {
  createTurnOrchestrator,
  classifyWorkIntent,
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
import {
  QualityArtifactStore,
  resolveBalancedPrewalkRoute,
  type BalancedPrewalkRoute,
  type PersistedQualityArtifact,
  type QualityProviderRoute,
} from "./quality-runtime.js";

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
  readonly qualityStatus?: QualityGateStatus;
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
  | WorkStatusTraceEvent
  | QualityStageStartedTraceEvent
  | QualityGateEvaluatedTraceEvent
  | QualityRefineRequestedTraceEvent
  | QualityPivotRequestedTraceEvent
  | QualityCompletedTraceEvent;

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

function createWorkGraph(
  tasks: readonly PlannedWorkTask[],
  startedAt: number,
  quality?: { readonly graphId: string; readonly profile: QualityProfile } | undefined,
): WorkGraph {
  workGraphSequence += 1;
  return {
    id: quality?.graphId ?? `goal-${startedAt}-${workGraphSequence}`,
    ...(tasks[0]?.goal ? { goal: tasks[0].goal } : {}),
    ...(tasks[0]?.constraints ? { constraints: tasks[0].constraints } : {}),
    qualityProfile: quality?.profile ?? "minimal",
    currentStage: "plan",
    gateStatus: "unproven",
    iteration: 0,
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
      stage: "work",
      role: "worker",
      attempt: 0,
      artifactRefs: [],
      reviewRequired: quality ? quality.profile !== "minimal" : false,
    })),
  };
}

type QualityTerminal = {
  readonly requested: Extract<QualityGateStatus, "refine" | "pivot" | "block">;
  readonly stage: QualityHarnessStage;
  readonly reason: string;
  readonly failures: readonly string[];
  readonly nodeId?: string;
};

type QualityRuntimeState = {
  readonly runId: string;
  readonly graphId: string;
  readonly profile: QualityProfile;
  readonly risk: RiskLevel;
  readonly creatorIntent: boolean;
  readonly artifacts: QualityArtifactStore;
  readonly completedStages: Set<QualityHarnessStage>;
  readonly workerArtifacts: PersistedQualityArtifact[];
  readonly producerRoutes: QualityProviderRoute[];
  readonly failures: string[];
  graph?: WorkGraph;
  refineCount: number;
  pivotCount: number;
  iteration: number;
  terminal?: QualityTerminal;
  completed: boolean;
};

class QualityLifecycleStop extends Error {
  constructor() {
    super("Quality lifecycle terminated explicitly.");
    this.name = "QualityLifecycleStop";
  }
}

function creatorIntentFromPrompt(prompt: string): boolean {
  return /\b(?:create|evolve|author|modify)\b[\s\S]{0,80}\b(?:agent|plugin|skill|benchmark|quality\s+policy)\b/iu.test(prompt);
}

function riskFromPrompt(prompt: string): RiskLevel {
  if (/\b(?:production|payment|billing|credential|secret|authorization|security-critical)\b/iu.test(prompt)) {
    return "high";
  }
  return "low";
}

function decisionReason(decision: PluginDecisionAggregate): string {
  return decision.decisions.find((entry) => entry.action === decision.action)?.reason
    ?? `Quality plugin requested ${decision.action}.`;
}

function appendQualityContext(
  prompt: string,
  contributions: readonly { readonly pluginName: string; readonly content: string }[],
): string {
  if (contributions.length === 0) return prompt;
  const body = contributions.map(({ pluginName, content }) => `[${pluginName}] ${content}`).join("\n");
  return `${prompt}\n\n<quality_engine_context>\n${body}\n</quality_engine_context>`;
}

function routesDiffer(left: QualityProviderRoute, right: QualityProviderRoute): boolean {
  return left.provider !== right.provider || left.model !== right.model;
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
  private readonly workspaceRoot: string;
  private readonly pluginHost: PluginHost | undefined;
  private readonly qualityRisk: RiskLevel | undefined;
  private directRoute: QualityProviderRoute;
  private readonly commodityRoute: QualityProviderRoute | undefined;
  private traceListener: ((event: OrchestratedWorkAgentTraceEvent<TraceEvent>) => void) | undefined;
  private readonly runController: WorkAgentRunController<Attachment, TraceEvent, Reasoning>;

  constructor(input: {
    directAgent: OrchestratedWorkTurnAgent<Attachment, TraceEvent, Reasoning>;
    createExecutorAgent?: ExecutorAgentFactory<Attachment, TraceEvent, Reasoning> | undefined;
    mode: string;
    reasoning: Reasoning;
    model: string;
    runExecutableGuardianChecks?: GuardianCheckRunner | undefined;
    workspaceRoot?: string | undefined;
    pluginHost?: PluginHost | undefined;
    qualityRisk?: RiskLevel | undefined;
    directRoute?: QualityProviderRoute | undefined;
    commodityRoute?: QualityProviderRoute | undefined;
  }) {
    this.directAgent = input.directAgent;
    this.createExecutorAgent = input.createExecutorAgent;
    this.mode = input.mode;
    this.reasoning = input.reasoning;
    this.model = input.model;
    this.runExecutableGuardianChecks = input.runExecutableGuardianChecks;
    this.workspaceRoot = input.workspaceRoot ?? process.cwd();
    this.pluginHost = input.pluginHost;
    this.qualityRisk = input.qualityRisk;
    this.directRoute = input.directRoute ?? { provider: "unknown", model: input.model };
    this.commodityRoute = input.commodityRoute;
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
    qualityContext?: readonly { readonly pluginName: string; readonly content: string }[] | undefined,
  ): Promise<{ readonly tasks: readonly PlannedWorkTask[]; readonly usedLlm: boolean }> {
    const staticTasks = buildComplexTasks(prompt);
    let plannerInvoked = false;

    try {
      const planPrompt = appendQualityContext(
        buildRustPrompt("planner-prompt", { prompt }),
        qualityContext ?? [],
      );
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
      this.directRoute = { ...this.directRoute, model: this.model };
    }
  }

  // Shell autonomy for yolo/ultrawork is granted per agent instance by the
  // execution policy profile, never through process.env.
  updateMode(mode: string): void {
    this.mode = mode;
    this.directAgent.updateMode?.(mode);
  }

  private createQualityState(prompt: string): QualityRuntimeState {
    const runId = `quality-${randomUUID()}`;
    const graphId = `goal-${runId}`;
    const risk = this.qualityRisk ?? riskFromPrompt(prompt);
    const creatorIntent = creatorIntentFromPrompt(prompt);
    const profile = classifyQualityProfile({
      complexity: "complex",
      risk,
      creatorIntent,
    });
    return {
      runId,
      graphId,
      profile,
      risk,
      creatorIntent,
      artifacts: new QualityArtifactStore(this.workspaceRoot, runId),
      completedStages: new Set(),
      workerArtifacts: [],
      producerRoutes: [],
      failures: [],
      refineCount: 0,
      pivotCount: 0,
      iteration: 0,
      completed: false,
    };
  }

  private async qualityContext(
    state: QualityRuntimeState,
    stage: QualityHarnessStage,
  ): Promise<readonly { readonly pluginName: string; readonly content: string }[]> {
    return await this.pluginHost?.dispatchContextContribute({
      runId: state.runId,
      graphId: state.graphId,
      profile: state.profile,
      stage,
    }) ?? [];
  }

  private emitQualityStage(
    state: QualityRuntimeState,
    stage: QualityHarnessStage,
    route?: BalancedPrewalkRoute | undefined,
    agentRunId?: string | undefined,
  ): void {
    this.emitTrace({
      type: "quality.stage_started",
      level: "high-signal",
      runId: state.runId,
      graphId: state.graphId,
      profile: state.profile,
      stage,
      iteration: state.iteration,
      ...(route
        ? {
            provider: route.provider,
            model: route.model,
            route: route.route,
            ...(agentRunId ? { agentRunId } : {}),
          }
        : {}),
      startedAt: Date.now(),
    });
  }

  private recordQualityDecision(
    state: QualityRuntimeState,
    stage: QualityHarnessStage,
    decision: PluginDecisionAggregate,
    detail: {
      readonly nodeId?: string | undefined;
      readonly artifactHash?: string | undefined;
      readonly evidenceRefs?: readonly string[] | undefined;
      readonly independentVerification?: boolean | undefined;
      readonly route?: BalancedPrewalkRoute | undefined;
    } = {},
  ): void {
    const failures = [...new Set(decision.failures)];
    for (const failure of failures) {
      if (!state.failures.includes(failure)) state.failures.push(failure);
    }
    this.emitTrace({
      type: "quality.gate_evaluated",
      level: "high-signal",
      runId: state.runId,
      graphId: state.graphId,
      profile: state.profile,
      stage,
      iteration: state.iteration,
      ...(detail.route
        ? {
            provider: detail.route.provider,
            model: detail.route.model,
            route: detail.route.route,
          }
        : {}),
      decision: decision.action,
      refineCount: state.refineCount,
      pivotCount: state.pivotCount,
      evidenceRefs: detail.evidenceRefs ?? [],
      failures,
      ...(detail.artifactHash ? { artifactHash: detail.artifactHash } : {}),
      independentVerification: detail.independentVerification ?? false,
      startedAt: Date.now(),
    });

    if (decision.action !== "refine" && decision.action !== "pivot" && decision.action !== "block") {
      return;
    }
    const reason = decisionReason(decision);
    if (decision.action === "refine") {
      state.refineCount += 1;
      state.iteration += 1;
      this.emitTrace({
        type: "quality.refine_requested",
        level: "high-signal",
        runId: state.runId,
        graphId: state.graphId,
        profile: state.profile,
        stage,
        iteration: state.iteration,
        decision: "refine",
        count: state.refineCount,
        limit: DEFAULT_ITERATION_LIMITS.refine,
        reason,
        evidenceRefs: detail.evidenceRefs ?? [],
        failures,
        ...(detail.nodeId ? { nodeId: detail.nodeId } : {}),
        startedAt: Date.now(),
      });
    } else if (decision.action === "pivot") {
      state.pivotCount += 1;
      state.iteration += 1;
      this.emitTrace({
        type: "quality.pivot_requested",
        level: "high-signal",
        runId: state.runId,
        graphId: state.graphId,
        profile: state.profile,
        stage,
        iteration: state.iteration,
        decision: "pivot",
        count: state.pivotCount,
        limit: DEFAULT_ITERATION_LIMITS.pivot,
        reason,
        evidenceRefs: detail.evidenceRefs ?? [],
        failures,
        startedAt: Date.now(),
      });
    }
    state.terminal = {
      requested: decision.action,
      stage,
      reason,
      failures,
      ...(detail.nodeId ? { nodeId: detail.nodeId } : {}),
    };
  }

  private completeQuality(
    state: QualityRuntimeState,
    decision: QualityGateStatus,
    stage: QualityHarnessStage,
    input: {
      readonly evidenceRefs?: readonly string[] | undefined;
      readonly failures?: readonly string[] | undefined;
      readonly independentVerification?: boolean | undefined;
    } = {},
  ): void {
    if (state.completed) return;
    state.completed = true;
    const startedAt = Date.now();
    this.emitTrace({
      type: "quality.completed",
      level: "high-signal",
      runId: state.runId,
      graphId: state.graphId,
      profile: state.profile,
      stage,
      iteration: state.iteration,
      decision,
      completedStages: [...state.completedStages],
      evidenceRefs: input.evidenceRefs ?? [],
      failures: [...new Set([...(input.failures ?? []), ...state.failures])],
      independentVerification: input.independentVerification ?? false,
      startedAt,
      completedAt: Date.now(),
    });
  }

  private terminateQuality(state: QualityRuntimeState): WorkAgentTurnResult {
    const terminal = state.terminal;
    if (!terminal) {
      throw new Error("Quality termination requested without a terminal decision.");
    }
    this.completeQuality(state, "block", terminal.stage, { failures: terminal.failures });
    return {
      text: `Quality ${terminal.requested} requested; run terminated explicitly: ${terminal.reason}`,
      qualityStatus: "block",
    };
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

    const classifiedIntent = this.pluginHost ? classifyWorkIntent(prompt, this.mode) : undefined;
    const quality = classifiedIntent === "complex" ? this.createQualityState(prompt) : undefined;
    if (quality && this.pluginHost) {
      this.emitQualityStage(quality, "explore");
      const classified = await this.pluginHost.dispatchRunClassified({
        runId: quality.runId,
        prompt,
        complexity: "complex",
        risk: quality.risk,
        creatorIntent: quality.creatorIntent,
        proposedProfile: quality.profile,
      });
      quality.completedStages.add("explore");
      if (classified.action !== "proceed") {
        this.recordQualityDecision(quality, "explore", classified);
      }
      if (quality.terminal) return this.terminateQuality(quality);
    }

    // Empty until the plan is accepted; the controller refuses any dispatch
    // naming a job the plan never queued, so no second guard is needed here.
    let activeGraphId = "";
    let completionArtifact: PersistedQualityArtifact | undefined;
    let completionProducerId = "";
    let completionEvidence: GateEvidence[] = [];
    let criticIndependent = false;
    let criticGateStatus: QualityGateStatus = "proceed";
    const orchestrator = createTurnOrchestrator<PlannedWorkTask, PlannedWorkResult>({
      runSimpleTurn: (simplePrompt) => this.runMainTurn(simplePrompt, attachments, turnOptions),
      runResearchTurn: (researchPrompt) => this.runMainTurn(researchPrompt, attachments, turnOptions),
      planComplexTurn: async (complexPrompt, planOptions) => {
        const context = quality ? await this.qualityContext(quality, "plan") : undefined;
        if (quality) {
          this.emitQualityStage(quality, "plan", resolveBalancedPrewalkRoute({
            stage: "plan",
            directRoute: this.directRoute,
            ...(this.commodityRoute ? { commodityRoute: this.commodityRoute } : {}),
          }));
        }
        const { tasks, usedLlm } = await this.planTasks(
          complexPrompt,
          planOptions?.onTrace,
          turnSignal,
          context,
        );
        return { tasks, usedLlm };
      },
      executeComplexTask: async (task) => {
        if (quality && this.pluginHost) {
          const graph = quality.graph;
          const plannedNode = graph?.nodes.find((node) => node.id === task.id);
          if (!graph || !plannedNode) {
            throw new Error(`Quality graph is missing planned node ${task.id}.`);
          }
          const beforeDispatch = await this.pluginHost.dispatchBeforeNodeDispatch({
            runId: quality.runId,
            graph,
            node: plannedNode,
          });
          if (beforeDispatch.action !== "proceed") {
            this.recordQualityDecision(quality, "work", beforeDispatch, { nodeId: task.id });
          }
          if (beforeDispatch.node.id !== task.id && !quality.terminal) {
            this.recordQualityDecision(quality, "work", {
              action: "block",
              decisions: [{
                pluginName: "unclecode-runtime",
                action: "block",
                reason: "A replacement node must preserve the planned node id.",
                failures: ["REPLACEMENT_NODE_ID_MISMATCH"],
              }],
              failures: ["REPLACEMENT_NODE_ID_MISMATCH"],
            }, { nodeId: task.id });
          }
          if (quality.terminal) {
            this.runController.settleBlockedJob(activeGraphId, task.id);
            return {
              id: task.id,
              summary: quality.terminal.reason,
              status: "blocked",
            };
          }

          const node = beforeDispatch.node;
          quality.graph = {
            ...graph,
            currentStage: "work",
            nodes: graph.nodes.map((entry) => entry.id === task.id ? node : entry),
          };
          const taskIndex = graph.nodes.findIndex((entry) => entry.id === task.id);
          const route = resolveBalancedPrewalkRoute({
            stage: "work",
            workerIndex: Math.max(0, taskIndex),
            directRoute: this.directRoute,
            ...(this.createExecutorAgent && this.commodityRoute
              ? { commodityRoute: this.commodityRoute }
              : {}),
          });
          const context = await this.qualityContext(quality, "work");
          const outcome = await this.runController.runTask({
            graphId: activeGraphId,
            task: {
              id: node.id,
              summary: node.title,
              prompt: appendQualityContext(node.prompt, context),
            },
            signal: turnSignal,
            preferDirect: route.executor !== "commodity",
            onDispatchStarting: (agentRunId) => this.emitQualityStage(
              quality,
              "work",
              route,
              agentRunId,
            ),
          });
          if (outcome.status !== "completed") {
            return { id: task.id, summary: outcome.text, status: outcome.status };
          }

          const completedAt = new Date().toISOString();
          const producerId = `worker:${route.provider}:${route.model}:${node.id}`;
          const artifact = quality.artifacts.persistNode({
            nodeId: node.id,
            attempt: node.attempt,
            producerId,
            summary: outcome.text,
            writePaths: node.fileOwnership,
            completedAt,
          });
          quality.workerArtifacts.push(artifact);
          quality.producerRoutes.push({ provider: route.provider, model: route.model });
          const evidence: GateEvidence[] = [{
            kind: "artifact",
            artifactHash: artifact.artifactHash,
            producerId,
            result: "pass",
            timestamp: completedAt,
          }];
          const alternateRoutes = [
            this.directRoute,
            ...(this.createExecutorAgent && this.commodityRoute ? [this.commodityRoute] : []),
          ];
          const independentAvailable = alternateRoutes.some((candidate) =>
            routesDiffer(candidate, { provider: route.provider, model: route.model }));
          const graphWithArtifact: WorkGraph = {
            ...quality.graph,
            nodes: quality.graph.nodes.map((entry) => entry.id === node.id
              ? { ...entry, artifactRefs: [...entry.artifactRefs, artifact.path] }
              : entry),
          };
          quality.graph = graphWithArtifact;
          const afterNode = await this.pluginHost.dispatchAfterNodeCompleted({
            runId: quality.runId,
            graph: graphWithArtifact,
            node: graphWithArtifact.nodes.find((entry) => entry.id === node.id) ?? node,
            outcome: {
              nodeId: node.id,
              status: "completed",
              summary: outcome.text,
              evidenceRefs: [artifact.path],
            },
            artifactHash: artifact.artifactHash,
            producerId,
            evidence,
            findings: [],
            independentProviderAvailable: independentAvailable,
            independentReviewerAvailable: independentAvailable,
            refineCount: quality.refineCount,
            pivotCount: quality.pivotCount,
          });
          this.recordQualityDecision(quality, "work", afterNode, {
            nodeId: node.id,
            artifactHash: artifact.artifactHash,
            evidenceRefs: [artifact.path],
            independentVerification: independentAvailable,
            route,
          });
          quality.completedStages.add("work");
          const terminalAfterNode = quality.terminal as QualityTerminal | undefined;
          if (terminalAfterNode) {
            return {
              id: task.id,
              summary: terminalAfterNode.reason,
              status: "blocked",
            };
          }
          return { id: task.id, summary: outcome.text, status: "completed" };
        }

        const outcome = await this.runController.runTask({
          graphId: activeGraphId,
          task,
          signal: turnSignal,
        });
        return { id: task.id, summary: outcome.text, status: outcome.status };
      },
      isComplexTaskSuccessful: (taskResult) => taskResult.status === "completed",
      // Cancelled and quality-blocked are typed terminal outcomes, not failures.
      resolveComplexTaskStatus: ({ status }) => status,
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
        let reviewPrompt = buildGuardianReviewPrompt({
          prompt: originalPrompt,
          results,
          ...(executableChecks ? { executableChecks } : {}),
        });
        let criticRoute: BalancedPrewalkRoute | undefined;
        if (quality) {
          completionProducerId = `graph:${quality.graphId}`;
          completionArtifact = quality.artifacts.persistRun({
            graphId: quality.graphId,
            producerId: completionProducerId,
            artifacts: quality.workerArtifacts,
            completedAt: new Date().toISOString(),
          });
          completionEvidence = [{
            kind: "artifact",
            artifactHash: completionArtifact.artifactHash,
            producerId: completionProducerId,
            result: "pass",
            timestamp: new Date().toISOString(),
          }];
          criticRoute = resolveBalancedPrewalkRoute({
            stage: "critic",
            directRoute: this.directRoute,
            ...(this.commodityRoute ? { commodityRoute: this.commodityRoute } : {}),
            producerRoutes: quality.producerRoutes,
          });
          criticIndependent = criticRoute.independent;
          reviewPrompt = `${reviewPrompt}\n\nArtifact manifest: ${completionArtifact.path}\nArtifact SHA-256: ${completionArtifact.artifactHash}`;
          reviewPrompt = appendQualityContext(reviewPrompt, await this.qualityContext(quality, "critic"));
          this.emitQualityStage(quality, "critic", criticRoute);
        }
        const review = await this.runInternalTurn(reviewPrompt, [], turnOptions);
        const summary = executableChecks
          ? `${review.text}\n\nExecutable checks:\n${executableChecks}`
          : review.text;
        if (quality && criticRoute && completionArtifact) {
          const reviewerId = `critic:${criticRoute.provider}:${criticRoute.model}`;
          const completedAt = new Date().toISOString();
          const criticArtifact = quality.artifacts.persistCritic({
            reviewerId,
            reviewedArtifactHash: completionArtifact.artifactHash,
            summary,
            independent: criticIndependent,
            completedAt,
          });
          completionEvidence.push({
            kind: "reviewer",
            artifactHash: completionArtifact.artifactHash,
            producerId: completionProducerId,
            reviewerId,
            result: "pass",
            timestamp: completedAt,
          });
          criticGateStatus = criticIndependent ? "proceed" : "unproven";
          const failures = criticIndependent ? [] : ["INDEPENDENT_REVIEW_UNAVAILABLE"];
          this.recordQualityDecision(quality, "critic", {
            action: criticGateStatus,
            decisions: [{
              pluginName: "unclecode-routing",
              action: criticGateStatus,
              ...(criticIndependent
                ? {}
                : {
                    reason: "No distinct reviewer route was available.",
                    failures,
                  }),
            }],
            failures,
          }, {
            artifactHash: completionArtifact.artifactHash,
            evidenceRefs: [completionArtifact.path, criticArtifact.path],
            independentVerification: criticIndependent,
            route: criticRoute,
          });
          quality.completedStages.add("critic");
          if (quality.graph) {
            quality.graph = {
              ...quality.graph,
              currentStage: "critic",
              gateStatus: criticGateStatus,
            };
          }
        }
        return { summary };
      },
      shouldRunGuardianReview: () => !quality?.terminal,
    });

    let result: Awaited<ReturnType<typeof orchestrator.run>>;
    try {
      result = await orchestrator.run({
        prompt,
        mode: this.mode,
        maxWorkers: this.createExecutorAgent ? resolveWorkerBudget(this.mode) : 1,
        ...(classifiedIntent ? { intent: classifiedIntent } : {}),
        ...(this.traceListener ? { onTrace: (event) => this.emitTrace(event) } : {}),
        onPlan: async (tasks) => {
          const startedAt = Date.now();
          const graph = createWorkGraph(
            tasks,
            startedAt,
            quality ? { graphId: quality.graphId, profile: quality.profile } : undefined,
          );
          activeGraphId = graph.id;
          if (quality) quality.graph = graph;
          this.emitTrace({
            type: "work.proposed",
            level: "high-signal",
            graphId: graph.id,
            nodeCount: graph.nodes.length,
            startedAt,
            graph,
          });
          if (quality && this.pluginHost) {
            const planned = await this.pluginHost.dispatchPlanCreated({
              runId: quality.runId,
              graph,
            });
            quality.completedStages.add("plan");
            if (planned.action !== "proceed") {
              this.recordQualityDecision(quality, "plan", planned);
            }
            if (quality.terminal) throw new QualityLifecycleStop();
            quality.graph = { ...graph, approval: "approved", currentStage: "work" };
          }
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
    } catch (error) {
      if (error instanceof QualityLifecycleStop && quality?.terminal) {
        return this.terminateQuality(quality);
      }
      throw error;
    }

    if (result.kind !== "complex") {
      return { text: result.text };
    }
    if (epoch.isCleared()) {
      return CLEARED_TURN_RESULT;
    }
    if (quality?.terminal) {
      return this.terminateQuality(quality);
    }

    const reviewerStartedAt = Date.now();
    this.emitTrace(resolveAgentTraceEvent({
      kind: "synthesis-running",
      resultCount: result.results.length,
      startedAt: reviewerStartedAt,
    }));

    let synthesisPrompt = buildSynthesisPrompt({
      prompt,
      model: this.model,
      reasoning: this.reasoning.effort,
      results: result.results,
      ...(result.guardian ? { guardianSummary: result.guardian.summary } : {}),
    });

    let promoteRoute: BalancedPrewalkRoute | undefined;
    if (quality) {
      promoteRoute = resolveBalancedPrewalkRoute({
        stage: "promote",
        directRoute: this.directRoute,
        ...(this.commodityRoute ? { commodityRoute: this.commodityRoute } : {}),
        producerRoutes: quality.producerRoutes,
      });
      synthesisPrompt = appendQualityContext(
        synthesisPrompt,
        await this.qualityContext(quality, "promote"),
      );
      this.emitQualityStage(quality, "promote", promoteRoute);
    }

    const synthesis = await this.runMainTurn(synthesisPrompt, [], turnOptions);
    const reviewerCompletedAt = Date.now();
    this.emitTrace(resolveAgentTraceEvent({
      kind: "synthesis-completed",
      resultCount: result.results.length,
      startedAt: reviewerStartedAt,
      completedAt: reviewerCompletedAt,
    }));

    if (quality && this.pluginHost && completionArtifact) {
      quality.completedStages.add("promote");
      if (quality.graph) {
        quality.graph = {
          ...quality.graph,
          currentStage: "promote",
          gateStatus: criticGateStatus,
        };
      }
      const projection: QualityRunProjection = {
        runId: quality.runId,
        profile: quality.profile,
        currentStage: "promote",
        currentPhase: "act",
        score: null,
        failures: [],
        iteration: quality.iteration,
        refineCount: quality.refineCount,
        pivotCount: quality.pivotCount,
        // Completion validation independently verifies review availability;
        // this field represents the implementation gate entering completion.
        gateDecision: "proceed",
        completedStages: [...quality.completedStages],
      };
      const completion = await this.pluginHost.dispatchBeforeRunComplete({
        runId: quality.runId,
        graph: quality.graph ?? createWorkGraph([], Date.now(), {
          graphId: quality.graphId,
          profile: quality.profile,
        }),
        projection,
        evidence: completionEvidence,
        currentArtifactHash: completionArtifact.artifactHash,
        producerId: completionProducerId,
        independentReviewerAvailable: criticIndependent,
        reviewRequired: quality.profile !== "minimal",
      });
      if (completion.action !== "proceed") {
        this.recordQualityDecision(quality, "promote", completion, {
          artifactHash: completionArtifact.artifactHash,
          evidenceRefs: [completionArtifact.path],
          independentVerification: criticIndependent,
          ...(promoteRoute ? { route: promoteRoute } : {}),
        });
      }
      if (quality.terminal) return this.terminateQuality(quality);
      const qualityStatus = completion.action === "proceed"
        ? criticGateStatus
        : completion.action;
      this.completeQuality(quality, qualityStatus, "promote", {
        evidenceRefs: [completionArtifact.path],
        failures: completion.failures,
        independentVerification: criticIndependent,
      });
      return { text: synthesis.text, qualityStatus };
    }

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
