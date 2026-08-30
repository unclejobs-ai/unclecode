import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import {
  classifyQualityProfile,
  DEFAULT_ITERATION_LIMITS,
  evaluateGate,
  type GateEvidence,
  type GateFinding,
  type QualityRunProjection,
  type RiskLevel,
} from "@second-claude/core";
import {
  createPluginDiagnosticProjection,
  type OrchestratorStepTraceEvent,
  type EvolutionProposedTraceEvent,
  type PluginDiagnosticTraceEvent,
  type QualityCompletedTraceEvent,
  type QualityGateEvaluatedTraceEvent,
  type QualityGateStatus,
  type QualityHarnessStage,
  type QualityPivotRequestedTraceEvent,
  type QualityProfile,
  type QualityRefineRequestedTraceEvent,
  type QualityStageStartedTraceEvent,
  type WorkApprovedTraceEvent,
  type WorkGraph,
  type WorkNode,
  type WorkNodeStatus,
  type WorkProposedTraceEvent,
  type WorkStatusTraceEvent,
} from "@unclecode/contracts";
import {
  type PluginDecisionAggregate,
  type PluginInvocationDiagnostic,
  PluginHost,
} from "@unclecode/plugin-host";

import {
  createTurnOrchestrator,
  classifyWorkIntent,
  parsePlannedWorkTasks,
  type PlannedWorkTask,
  type TurnOrchestratorTraceListener,
  type WorkIntent,
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
  parseCriticVerdict,
  readQualityRouteObservation,
  resolveBalancedPrewalkRoute,
  resolveQualityReviewRouteEvidence,
  type BalancedPrewalkRoute,
  type PersistedQualityArtifact,
  type QualityProviderRoute,
  type QualityReviewPacket,
  type QualityReviewPacketInput,
  type QualityRouteObservation,
  type QualityWorkspaceEntry,
  type QualityWorkspaceInventory,
  type QualityWorkspaceInventoryManifest,
} from "./quality-runtime.js";
import type { CreatorEvolutionService } from "./evolution-runtime.js";
import {
  checkpointExecutionPause,
  type ExecutionPausePort,
  runExecutionNonInterruptible,
  withExecutionPausePort,
} from "./execution-pause.js";

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
type GuardianExecutableCheck = {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly summary: string;
};

type GuardianCheckResult = {
  readonly summary: string;
  readonly checks?: readonly GuardianExecutableCheck[] | undefined;
};

type LoadedGuardianChecks = {
  readonly summary: string;
  readonly checks: readonly GuardianExecutableCheck[];
  readonly status: "passed" | "failed" | "unproven";
  readonly failures: readonly string[];
};

type GuardianCheckRunner = (input: GuardianCheckRequest) => Promise<GuardianCheckResult>;

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
  | QualityCompletedTraceEvent
  | EvolutionProposedTraceEvent
  | PluginDiagnosticTraceEvent;

export interface OrchestratedWorkTurnAgent<
  Attachment,
  TraceEvent extends { readonly type: string },
  Reasoning extends ReasoningLike,
> {
  clear(): void;
  setTraceListener(listener?: ((event: TraceEvent) => void) | undefined): void;
  updateRuntimeSettings(settings: { reasoning?: Reasoning | undefined; model?: string | undefined }): void;
  updateMode?(mode: string): void;
  getCanonicalPermissionRules?(): readonly import("./permission-scope.js").CanonicalPermissionRule[];
  runTurn(
    prompt: string,
    attachments?: readonly Attachment[],
    options?: {
      readonly signal?: AbortSignal | undefined;
      /** Operator-authored prompt before workspace/context decoration. */
      readonly classificationPrompt?: string | undefined;
    },
  ): Promise<{ text: string }>;
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
  readonly qualityReadOnly?: boolean | undefined;
}): string {
  return buildRustPrompt("guardian-review-prompt", input);
}

function buildSynthesisPrompt(input: {
  readonly prompt: string;
  readonly model: string;
  readonly reasoning: string;
  readonly results: readonly { readonly summary: string }[];
  readonly guardianSummary?: string | undefined;
  readonly qualityReadOnly?: boolean | undefined;
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
let workProposalSequence = -1;

function nextWorkProposalSequence(startedAt: number): number {
  // Timestamp-derived space keeps the source-owned watermark monotonic across
  // ordinary host restarts; the increment keeps same-millisecond proposals
  // strictly ordered within a process.
  workProposalSequence = Math.max(workProposalSequence + 1, startedAt * 1_000);
  return workProposalSequence;
}

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

type QualityIterationRequest = Omit<QualityTerminal, "requested" | "nodeId"> & {
  readonly requested: Extract<QualityGateStatus, "refine" | "pivot">;
  readonly sourceIteration: number;
  readonly affectedNodeIds: ReadonlySet<string>;
  readonly rerunAll: boolean;
  readonly evidenceRefs: ReadonlySet<string>;
  readonly nodeAttempt?: number | undefined;
  readonly artifactRefs: ReadonlySet<string>;
};

type QualityTerminalProvenance = {
  readonly evidenceRefs: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly artifactHash?: string | undefined;
  readonly reviewedArtifactHash?: string | undefined;
  readonly currentArtifactHash?: string | undefined;
  readonly reviewerRunId?: string | undefined;
  readonly stale: boolean;
  readonly independentVerification: boolean;
};

type QualityRuntimeState = {
  readonly runId: string;
  readonly graphId: string;
  readonly profile: QualityProfile;
  readonly risk: RiskLevel;
  readonly creatorIntent: boolean;
  readonly artifacts: QualityArtifactStore;
  readonly completedStages: Set<QualityHarnessStage>;
  readonly workerArtifactsByNode: Map<string, PersistedQualityArtifact>;
  readonly producerRoutesByNode: Map<string, QualityProviderRoute>;
  readonly producerAgentRunIdsByNode: Map<string, string>;
  readonly failures: string[];
  readonly terminalHookNodeIds: Set<string>;
  graph?: WorkGraph;
  refineCount: number;
  pivotCount: number;
  iteration: number;
  pendingIteration?: QualityIterationRequest;
  reviewBaseline?: QualityWorkspaceInventory;
  terminalProvenance?: QualityTerminalProvenance;
  terminal?: QualityTerminal;
  completed: boolean;
};

type QualityDecisionDetail = {
  readonly nodeId?: string | undefined;
  readonly artifactHash?: string | undefined;
  readonly reviewedArtifactHash?: string | undefined;
  readonly currentArtifactHash?: string | undefined;
  readonly reviewerRunId?: string | undefined;
  readonly stale?: boolean | undefined;
  readonly evidenceRefs?: readonly string[] | undefined;
  readonly independentVerification?: boolean | undefined;
  readonly route?: BalancedPrewalkRoute | undefined;
  readonly nodeAttempt?: number | undefined;
  readonly artifactRefs?: readonly string[] | undefined;
};

export type WorkSafetyDomain =
  | "creator"
  | "auth"
  | "credentials"
  | "access-control"
  | "destructive-data"
  | "billing"
  | "deploy"
  | "release";

export type WorkMutationBoundary = "read-only" | "mutation" | "ambiguous";

export type WorkSafetyBoundary = {
  readonly domains: readonly WorkSafetyDomain[];
  readonly creatorIntent: boolean;
  readonly risk: RiskLevel;
  readonly mutation: WorkMutationBoundary;
  readonly requiresOrchestration: boolean;
};

class QualityLifecycleStop extends Error {
  constructor() {
    super("Quality lifecycle terminated explicitly.");
    this.name = "QualityLifecycleStop";
  }
}

type MultilingualTerms = {
  readonly en: readonly string[];
  readonly ko: readonly string[];
};

const CREATOR_ASSET_TERMS: MultilingualTerms = {
  en: ["agent", "plugin", "skill", "benchmark", "quality policy"],
  ko: ["에이전트", "플러그인", "스킬", "벤치마크", "품질 정책"],
};

const MUTATION_TERMS: MultilingualTerms = {
  en: [
    "add", "author", "build", "change", "charge", "configure", "create", "delete",
    "deploy", "drop", "evolve", "grant", "implement", "modify", "publish", "purge",
    "refund", "release", "remove", "reset", "revoke", "rotate", "set", "truncate",
    "update", "wipe",
  ],
  ko: [
    "추가", "작성", "구축", "변경", "과금", "설정해", "생성", "만들어", "삭제",
    "배포", "폐기", "진화", "부여", "구현", "수정", "게시", "정리", "환불",
    "출시", "제거", "초기화", "회수", "교체", "재설정",
  ],
};

const READ_ONLY_TERMS: MultilingualTerms = {
  en: [
    "audit", "check", "describe", "explain", "inspect", "list", "review", "show",
    "status", "tell me", "what", "why", "how",
  ],
  ko: ["감사", "알려", "확인", "설명", "조회", "목록", "검토", "보여", "상태", "뭐", "무엇", "왜", "어떻게"],
};

const SAFETY_DOMAIN_TERMS: ReadonlyArray<readonly [Exclude<WorkSafetyDomain, "creator">, MultilingualTerms]> = [
  ["credentials", {
    en: ["api key", "credential", "credentials", "password", "secret", "token"],
    ko: ["api 키", "자격 증명", "인증 정보", "비밀번호", "암호", "시크릿", "토큰"],
  }],
  ["access-control", {
    en: ["access control", "acl", "authorization", "permission", "role"],
    ko: ["접근 제어", "접근 권한", "인가", "권한", "역할"],
  }],
  ["destructive-data", {
    en: ["database table", "database", "customer data", "production data", "records", "table"],
    ko: ["데이터베이스 테이블", "데이터베이스", "고객 데이터", "운영 데이터", "레코드", "테이블"],
  }],
  ["billing", {
    en: ["billing", "charge", "invoice", "payment", "refund", "subscription"],
    ko: ["결제", "과금", "청구", "송장", "환불", "구독", "요금제"],
  }],
  ["deploy", {
    en: ["deploy", "deployment"],
    ko: ["배포"],
  }],
  ["release", {
    en: ["package publish", "publish", "release"],
    ko: ["패키지 게시", "게시", "릴리스", "출시"],
  }],
  ["auth", {
    en: ["auth", "authentication", "login", "oauth", "sign in"],
    ko: ["인증", "로그인", "오어스", "사인인"],
  }],
];

function normalizedEnglish(prompt: string): string {
  return ` ${prompt.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim()} `;
}

function containsTerms(prompt: string, terms: MultilingualTerms): boolean {
  const english = normalizedEnglish(prompt);
  return terms.en.some((term) => english.includes(` ${term} `))
    || terms.ko.some((term) => prompt.includes(term));
}

/**
 * Typed safety routing boundary for operator-authored prompts. The tables are
 * deliberately bilingual and the result is consumed before any agent with
 * workspace tools is dispatched.
 */
export function classifyWorkSafetyBoundary(prompt: string): WorkSafetyBoundary {
  const creatorAsset = containsTerms(prompt, CREATOR_ASSET_TERMS);
  const mutationSignal = containsTerms(prompt, MUTATION_TERMS);
  const readOnlySignal = containsTerms(prompt, READ_ONLY_TERMS);
  const creatorIntent = creatorAsset && mutationSignal;
  const domains: WorkSafetyDomain[] = [
    ...(creatorIntent ? ["creator" as const] : []),
    ...SAFETY_DOMAIN_TERMS
      .filter(([, terms]) => containsTerms(prompt, terms))
      .map(([domain]) => domain),
  ];
  const distinctDomains = [...new Set(domains)];
  const mutation: WorkMutationBoundary = mutationSignal && !readOnlySignal
    ? "mutation"
    : readOnlySignal && !mutationSignal
      ? "read-only"
      : distinctDomains.length > 0
        ? "ambiguous"
        : "read-only";
  const highImpact = distinctDomains.some((domain) => domain !== "creator");
  return {
    domains: distinctDomains,
    creatorIntent,
    risk: highImpact ? "high" : "low",
    mutation,
    requiresOrchestration: distinctDomains.length > 0 && mutation !== "read-only",
  };
}

function creatorMutableTargets(prompt: string): readonly string[] {
  const explicit = [...new Set(buildComplexTasks(prompt).flatMap((task) => task.writePaths))]
    .sort((left, right) => left.localeCompare(right));
  if (explicit.length > 0) return explicit;
  if (containsTerms(prompt, { en: ["plugin"], ko: ["플러그인"] })) return [".unclecode/plugins"];
  if (containsTerms(prompt, { en: ["agent", "skill"], ko: ["에이전트", "스킬"] })) return ["skills"];
  return [];
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
  return left.provider !== right.provider;
}

function qualityWritePaths(state: QualityRuntimeState): readonly string[] {
  return [...new Set(state.graph?.nodes.flatMap((node) => node.fileOwnership) ?? [])]
    .sort((left, right) => left.localeCompare(right));
}

function qualityNodeAttemptKey(
  state: Pick<QualityRuntimeState, "iteration">,
  node: Pick<WorkNode, "id" | "attempt">,
): string {
  return `${node.id}:attempt-${node.attempt}:iteration-${state.iteration}`;
}

function qualityJobKey(state: QualityRuntimeState, node: Pick<WorkNode, "id" | "attempt">): string {
  return state.iteration === 0 && node.attempt === 0
    ? node.id
    : `${node.id}:attempt-${node.attempt}:iteration-${state.iteration}`;
}

function currentWorkerArtifacts(state: QualityRuntimeState): readonly PersistedQualityArtifact[] {
  return state.graph?.nodes.flatMap((node) => {
    const artifact = state.workerArtifactsByNode.get(node.id);
    return artifact ? [artifact] : [];
  }) ?? [];
}

function currentProducerRoutes(state: QualityRuntimeState): readonly QualityProviderRoute[] {
  return state.graph?.nodes.flatMap((node) => {
    const route = state.producerRoutesByNode.get(node.id);
    return route ? [route] : [];
  }) ?? [];
}

function currentProducerAgentRunIds(state: QualityRuntimeState): readonly string[] {
  return state.graph?.nodes.flatMap((node) => {
    const agentRunId = state.producerAgentRunIdsByNode.get(node.id);
    return agentRunId ? [agentRunId] : [];
  }) ?? [];
}

function requestedIterationForFindings(
  findings: readonly GateFinding[],
): Extract<QualityGateStatus, "refine" | "pivot"> | undefined {
  if (findings.some((finding) => finding.kind === "plan" || finding.kind === "acceptance")) {
    return "pivot";
  }
  if (findings.length === 0 || !findings.every((finding) => finding.correctable)) {
    return undefined;
  }
  return new Set(findings.map((finding) => finding.direction ?? "default")).size === 1
    ? "refine"
    : "pivot";
}

function iterationLimitFailure(action: Extract<QualityGateStatus, "refine" | "pivot">): string {
  return action === "refine" ? "QUALITY_REFINE_LIMIT_REACHED" : "QUALITY_PIVOT_LIMIT_REACHED";
}

function iterationLimitDecision(
  action: Extract<QualityGateStatus, "refine" | "pivot">,
): PluginDecisionAggregate {
  const limit = DEFAULT_ITERATION_LIMITS[action];
  const failure = iterationLimitFailure(action);
  const reason = `Quality ${action} limit reached (${limit}); the bounded quality loop cannot continue.`;
  return {
    action: "block",
    decisions: [{
      pluginName: "unclecode-runtime",
      action: "block",
      reason,
      failures: [failure],
    }],
    failures: [failure],
  };
}

function selectRefineTasks(
  tasks: readonly PlannedWorkTask[],
  graph: WorkGraph,
  affectedNodeIds: ReadonlySet<string> | undefined,
): readonly PlannedWorkTask[] {
  if (!affectedNodeIds || affectedNodeIds.size === 0) return tasks;
  const selected = new Set<string>();
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const includeWithDependencies = (nodeId: string): void => {
    if (selected.has(nodeId)) return;
    const task = taskById.get(nodeId);
    if (!task) return;
    for (const dependencyId of task.dependsOn) includeWithDependencies(dependencyId);
    selected.add(nodeId);
  };
  for (const affectedNodeId of affectedNodeIds) includeWithDependencies(affectedNodeId);
  for (const node of graph.nodes) {
    if (node.status !== "completed") includeWithDependencies(node.id);
  }
  return tasks.filter((task) => selected.has(task.id));
}

function staleArtifactDecision(stage: "critic" | "promote"): PluginDecisionAggregate {
  const code = stage === "critic"
    ? "ARTIFACT_MANIFEST_CHANGED_DURING_CRITIC"
    : "ARTIFACT_MANIFEST_CHANGED_DURING_PROMOTE";
  return {
    action: "block",
    decisions: [{
      pluginName: "unclecode-runtime",
      action: "block",
      reason: `Artifact manifest changed during ${stage}; reviewer evidence is stale.`,
      failures: [code],
    }],
    failures: [code],
  };
}

function staleDirectWorkspaceDecision(): PluginDecisionAggregate {
  return {
    action: "block",
    decisions: [{
      pluginName: "unclecode-runtime",
      action: "block",
      reason: "The direct-turn workspace manifest changed during completion; mutation evidence is stale.",
      failures: ["DIRECT_WORKSPACE_MANIFEST_CHANGED_DURING_COMPLETION"],
    }],
    failures: ["DIRECT_WORKSPACE_MANIFEST_CHANGED_DURING_COMPLETION"],
  };
}

function trackedWorkspaceSymlinks(
  workspaceRoot: string,
  manifest: QualityWorkspaceInventoryManifest,
): ReadonlySet<string> {
  const baselineSymlinks = new Set(
    manifest.files.filter((entry) => entry.kind === "symlink").map((entry) => entry.path),
  );
  if (baselineSymlinks.size === 0 || baselineSymlinks.size > 256) return new Set();
  try {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_LITERAL_PATHSPECS: "1",
      GIT_OPTIONAL_LOCKS: "0",
    };
    for (const key of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) delete environment[key];
    const output = execFileSync(
      "git",
      [
        "-C",
        workspaceRoot,
        "-c",
        "core.fsmonitor=false",
        "ls-files",
        "--stage",
        "-z",
        "--",
        ...baselineSymlinks,
      ],
      {
        encoding: "buffer",
        env: environment,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const tracked = new Set<string>();
    for (const record of output.toString("utf8").split("\0")) {
      const separator = record.indexOf("\t");
      if (separator < 0 || !record.startsWith("120000 ")) continue;
      const relativePath = record.slice(separator + 1);
      if (baselineSymlinks.has(relativePath)) tracked.add(relativePath);
    }
    return tracked;
  } catch {
    return new Set();
  }
}

function directWorkspaceManifestAgainstBaseline(input: {
  readonly baseline: QualityWorkspaceInventoryManifest;
  readonly baselineTrackedSymlinks: ReadonlySet<string>;
  readonly current: QualityWorkspaceInventoryManifest;
  readonly currentTrackedSymlinks: ReadonlySet<string>;
}): QualityWorkspaceInventoryManifest {
  const baselineByPath = new Map(input.baseline.files.map((entry) => [entry.path, entry] as const));
  const unsupportedEntries = input.current.unsupportedEntries.filter((entry) => {
    if (
      entry.kind !== "symlink"
      || entry.sha256 === null
      || !input.baselineTrackedSymlinks.has(entry.path)
      || !input.currentTrackedSymlinks.has(entry.path)
    ) return true;
    const baselineEntry = baselineByPath.get(entry.path);
    return baselineEntry?.kind !== "symlink" || baselineEntry.sha256 !== entry.sha256;
  });
  return {
    ...input.current,
    evidenceStatus: unsupportedEntries.length === 0 ? "supported" : "unsupported",
    unsupportedEntries,
  };
}

function unsupportedOwnershipDecision(
  stage: QualityHarnessStage,
  entries: readonly QualityWorkspaceEntry[],
): PluginDecisionAggregate {
  const paths = entries.slice(0, 8).map((entry) => `${entry.path} (${entry.kind})`).join(", ");
  const remainder = entries.length > 8 ? `, and ${entries.length - 8} more` : "";
  const reason = `Unsupported owned workspace evidence encountered during ${stage}: ${paths}${remainder}.`;
  return {
    action: "block",
    decisions: [{
      pluginName: "unclecode-runtime",
      action: "block",
      reason,
      failures: ["UNSUPPORTED_OWNERSHIP_EVIDENCE"],
    }],
    failures: ["UNSUPPORTED_OWNERSHIP_EVIDENCE"],
  };
}

function forceRuntimeBlock(
  observed: PluginDecisionAggregate,
  runtime: PluginDecisionAggregate,
): PluginDecisionAggregate {
  return {
    action: "block",
    decisions: [...runtime.decisions, ...observed.decisions],
    failures: [...new Set([...runtime.failures, ...observed.failures])],
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
  readonly supportsCooperativePause = true as const;
  private readonly directAgent: OrchestratedWorkTurnAgent<Attachment, TraceEvent, Reasoning>;
  private readonly reviewAgent: OrchestratedWorkTurnAgent<Attachment, TraceEvent, Reasoning> | undefined;
  private readonly createExecutorAgent: ExecutorAgentFactory<Attachment, TraceEvent, Reasoning> | undefined;
  private mode: string;
  private reasoning: Reasoning;
  private model: string;
  private readonly runExecutableGuardianChecks?: GuardianCheckRunner | undefined;
  private readonly workspaceRoot: string;
  private readonly pluginHost: PluginHost | undefined;
  private readonly qualityRisk: RiskLevel | undefined;
  private readonly creatorEvolutionService: Pick<CreatorEvolutionService, "run" | "verifyFresh"> | undefined;
  private directRoute: QualityProviderRoute;
  private readonly commodityRoute: QualityProviderRoute | undefined;
  private readonly reviewRoute: QualityProviderRoute | undefined;
  private readonly allowDeclaredReviewRouteEvidence: boolean;
  private traceListener: ((event: OrchestratedWorkAgentTraceEvent<TraceEvent>) => void) | undefined;
  private readonly runController: WorkAgentRunController<Attachment, TraceEvent, Reasoning>;

  constructor(input: {
    directAgent: OrchestratedWorkTurnAgent<Attachment, TraceEvent, Reasoning>;
    reviewAgent?: OrchestratedWorkTurnAgent<Attachment, TraceEvent, Reasoning> | undefined;
    createExecutorAgent?: ExecutorAgentFactory<Attachment, TraceEvent, Reasoning> | undefined;
    mode: string;
    reasoning: Reasoning;
    model: string;
    runExecutableGuardianChecks?: GuardianCheckRunner | undefined;
    workspaceRoot?: string | undefined;
    pluginHost?: PluginHost | undefined;
    qualityRisk?: RiskLevel | undefined;
    creatorEvolutionService?: Pick<CreatorEvolutionService, "run" | "verifyFresh"> | undefined;
    directRoute?: QualityProviderRoute | undefined;
    commodityRoute?: QualityProviderRoute | undefined;
    reviewRoute?: QualityProviderRoute | undefined;
    /** Explicit escape hatch for deterministic agents that cannot emit provider telemetry. */
    reviewRouteEvidence?: "declared" | undefined;
  }) {
    this.directAgent = input.directAgent;
    this.reviewAgent = input.reviewAgent;
    this.createExecutorAgent = input.createExecutorAgent;
    this.mode = input.mode;
    this.reasoning = input.reasoning;
    this.model = input.model;
    this.runExecutableGuardianChecks = input.runExecutableGuardianChecks;
    this.workspaceRoot = input.workspaceRoot ?? process.cwd();
    this.pluginHost = input.pluginHost;
    this.qualityRisk = input.qualityRisk;
    this.creatorEvolutionService = input.creatorEvolutionService;
    this.directRoute = input.directRoute ?? { provider: "unknown", model: input.model };
    this.commodityRoute = input.commodityRoute;
    this.reviewRoute = input.reviewRoute;
    this.allowDeclaredReviewRouteEvidence = input.reviewRouteEvidence === "declared";
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

  getCanonicalPermissionRules(): readonly import("./permission-scope.js").CanonicalPermissionRule[] {
    return this.directAgent.getCanonicalPermissionRules?.() ?? [];
  }

  clear(): void {
    this.directAgent.clear();
    this.reviewAgent?.clear();
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
    return runExecutionNonInterruptible("provider.request", () =>
      this.runController.withDirectAgent(() =>
        this.directAgent.runTurn(prompt, attachments, options)));
  }

  private runInternalTurn(
    prompt: string,
    attachments: readonly Attachment[] = [],
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<{ text: string }> {
    // Swapping the listener is only safe while holding the shared agent's slot:
    // otherwise this turn would overwrite a live executor's scoped listener and
    // then hand the unscoped shell listener back under it.
    return runExecutionNonInterruptible("provider.request", () => this.runController.withDirectAgent(async () => {
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
    }));
  }

  /**
   * Critic and promote use a dedicated agent whose provider is constructed
   * without a tool runtime. Keeping it outside the interactive agent's lock is
   * the capability boundary: review can read the supplied manifest/prompt but
   * cannot execute a workspace mutation.
   */
  private async runReadOnlyQualityTurn(
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ readonly text: string; readonly routeObservations: readonly QualityRouteObservation[] }> {
    if (!this.reviewAgent || this.reviewAgent === this.directAgent) {
      throw new Error("A dedicated read-only quality review agent is unavailable.");
    }
    const outerListener = this.traceListener;
    const routeObservations: QualityRouteObservation[] = [];
    this.reviewAgent.setTraceListener((event) => {
      const observation = readQualityRouteObservation(event);
      if (observation) routeObservations.push(observation);
      if (outerListener && event.type === "usage.recorded") this.emitTrace(event);
    });
    try {
      const result = await runExecutionNonInterruptible(
        "provider.request",
        () => this.reviewAgent!.runTurn(prompt, [], { signal }),
      );
      return { ...result, routeObservations };
    } finally {
      this.reviewAgent.setTraceListener(undefined);
    }
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

  /** Production plugin-host telemetry enters the same run trace as provider and quality events. */
  recordPluginDiagnostic(diagnostic: PluginInvocationDiagnostic): void {
    if (diagnostic.source === "builtin") return;
    this.emitTrace(projectPluginInvocationDiagnostic(
      diagnostic as PluginInvocationDiagnostic & { readonly source: "memory" | "workspace" | "cached" },
    ));
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

  private createQualityState(
    complexity: WorkIntent,
    safety: WorkSafetyBoundary,
  ): QualityRuntimeState {
    const runId = `quality-${randomUUID()}`;
    const graphId = `goal-${runId}`;
    const risk = this.qualityRisk ?? safety.risk;
    const creatorIntent = safety.creatorIntent;
    const profile = classifyQualityProfile({
      complexity,
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
      workerArtifactsByNode: new Map(),
      producerRoutesByNode: new Map(),
      producerAgentRunIdsByNode: new Map(),
      failures: [],
      terminalHookNodeIds: new Set(),
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
    node?: Pick<WorkNode, "id" | "attempt" | "artifactRefs"> | undefined,
  ): void {
    this.emitTrace({
      type: "quality.stage_started",
      level: "high-signal",
      runId: state.runId,
      graphId: state.graphId,
      profile: state.profile,
      stage,
      iteration: state.iteration,
      ...(node
        ? {
            nodeId: node.id,
            nodeAttempt: node.attempt,
            artifactRefs: [...node.artifactRefs],
          }
        : {}),
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
    detail: QualityDecisionDetail = {},
  ): void {
    const requestedIteration = decision.action === "refine" || decision.action === "pivot"
      ? decision.action
      : undefined;
    const coalescedRequest = requestedIteration && state.pendingIteration?.requested === "pivot"
      ? "pivot"
      : requestedIteration;
    const effectiveDecision = coalescedRequest
      && (coalescedRequest === "refine" ? state.refineCount : state.pivotCount)
        >= DEFAULT_ITERATION_LIMITS[coalescedRequest]
      ? iterationLimitDecision(coalescedRequest)
      : decision;
    const failures = [...new Set(effectiveDecision.failures)];
    const reason = decisionReason(effectiveDecision);
    const reviewedArtifactHash = detail.reviewedArtifactHash ?? detail.artifactHash;
    const currentArtifactHash = detail.currentArtifactHash ?? reviewedArtifactHash;
    const stale = detail.stale
      ?? (reviewedArtifactHash !== undefined
        && currentArtifactHash !== undefined
        && reviewedArtifactHash !== currentArtifactHash);
    const reviewerRunId = detail.reviewerRunId
      ?? ((stage === "critic" || stage === "promote") && detail.route
        ? `${state.runId}:${stage}:${state.iteration}`
        : undefined);
    const evidenceRefs = [...new Set(detail.evidenceRefs ?? [])];
    const artifactRefs = [...new Set(
      detail.artifactRefs
        ?? ((stage === "critic" || stage === "promote") ? evidenceRefs : []),
    )];
    if (!state.terminal || effectiveDecision.action === "block") {
      state.failures.splice(0, state.failures.length, ...failures);
    }
    this.emitTrace({
      type: "quality.gate_evaluated",
      level: "high-signal",
      runId: state.runId,
      graphId: state.graphId,
      profile: state.profile,
      stage,
      iteration: state.iteration,
      ...(detail.nodeId ? { nodeId: detail.nodeId } : {}),
      ...(detail.nodeAttempt === undefined ? {} : { nodeAttempt: detail.nodeAttempt }),
      ...(artifactRefs.length > 0 ? { artifactRefs } : {}),
      ...(detail.route
        ? {
            provider: detail.route.provider,
            model: detail.route.model,
            route: detail.route.route,
          }
        : {}),
      decision: effectiveDecision.action,
      refineCount: state.refineCount,
      pivotCount: state.pivotCount,
      evidenceRefs,
      failures,
      reason,
      ...(detail.artifactHash ? { artifactHash: detail.artifactHash } : {}),
      ...(reviewedArtifactHash ? { reviewedArtifactHash } : {}),
      ...(currentArtifactHash ? { currentArtifactHash } : {}),
      ...(reviewerRunId ? { reviewerRunId } : {}),
      stale: stale ?? false,
      independentVerification: detail.independentVerification ?? false,
      startedAt: Date.now(),
    });

    if (stage === "critic" || stage === "promote") {
      state.terminalProvenance = {
        evidenceRefs,
        artifactRefs,
        ...(detail.artifactHash ? { artifactHash: detail.artifactHash } : {}),
        ...(reviewedArtifactHash ? { reviewedArtifactHash } : {}),
        ...(currentArtifactHash ? { currentArtifactHash } : {}),
        ...(reviewerRunId ? { reviewerRunId } : {}),
        stale: stale ?? false,
        independentVerification: detail.independentVerification ?? false,
      };
    }

    if (
      effectiveDecision.action !== "refine"
      && effectiveDecision.action !== "pivot"
      && effectiveDecision.action !== "block"
    ) {
      return;
    }
    if (effectiveDecision.action === "refine" || effectiveDecision.action === "pivot") {
      if (state.terminal) return;
      const existing = state.pendingIteration;
      const requested = existing?.requested === "pivot" || effectiveDecision.action === "pivot"
        ? "pivot"
        : "refine";
      const affectedNodeIds = new Set(existing?.affectedNodeIds ?? []);
      if (detail.nodeId) affectedNodeIds.add(detail.nodeId);
      const evidenceRefs = new Set(existing?.evidenceRefs ?? []);
      for (const reference of detail.evidenceRefs ?? []) evidenceRefs.add(reference);
      const artifactRefs = new Set(existing?.artifactRefs ?? []);
      for (const reference of detail.artifactRefs ?? []) artifactRefs.add(reference);
      state.pendingIteration = {
        requested,
        sourceIteration: state.iteration,
        stage: requested === effectiveDecision.action ? stage : existing?.stage ?? stage,
        reason: [...new Set([...(existing ? [existing.reason] : []), reason])].join("; "),
        failures: [...new Set([...(existing?.failures ?? []), ...failures])],
        affectedNodeIds,
        rerunAll: (existing?.rerunAll ?? false) || detail.nodeId === undefined,
        evidenceRefs,
        ...(detail.nodeAttempt === undefined
          ? existing?.nodeAttempt === undefined ? {} : { nodeAttempt: existing.nodeAttempt }
          : { nodeAttempt: detail.nodeAttempt }),
        artifactRefs,
      };
      state.failures.length = 0;
      return;
    }
    delete state.pendingIteration;
    state.terminal = {
      requested: "block",
      stage,
      reason,
      failures,
      ...(detail.nodeId ? { nodeId: detail.nodeId } : {}),
    };
  }

  private recordUnsupportedOwnershipDecision(
    state: QualityRuntimeState,
    stage: QualityHarnessStage,
    entries: readonly QualityWorkspaceEntry[],
    detail: QualityDecisionDetail,
  ): void {
    this.recordQualityDecision(
      state,
      stage,
      unsupportedOwnershipDecision(stage, entries),
      detail,
    );
  }

  private async finishTerminalQualityNode(
    state: QualityRuntimeState,
    node: WorkNode,
    status: Extract<WorkNodeStatus, "failed" | "cancelled" | "blocked">,
    summary: string,
    route?: BalancedPrewalkRoute | undefined,
  ): Promise<void> {
    const terminalHookKey = qualityNodeAttemptKey(state, node);
    if (!this.pluginHost || state.terminalHookNodeIds.has(terminalHookKey)) return;
    const completedAt = new Date().toISOString();
    const producerId = route
      ? `worker:${route.provider}:${route.model}:${node.id}:attempt-${node.attempt}:iteration-${state.iteration}`
      : `worker:undispatched:${node.id}:attempt-${node.attempt}:iteration-${state.iteration}`;
    const artifact = state.artifacts.persistNode({
      nodeId: node.id,
      attempt: node.attempt,
      iteration: state.iteration,
      producerId,
      summary,
      writePaths: status === "blocked" ? [] : node.fileOwnership,
      completedAt,
      status,
    });
    const graph = state.graph;
    if (!graph) throw new Error(`Quality graph is missing terminal node ${node.id}.`);
    const graphWithArtifact: WorkGraph = {
      ...graph,
      currentStage: "work",
      gateStatus: "block",
      nodes: graph.nodes.map((entry) => entry.id === node.id
        ? {
            ...entry,
            status,
            artifactRefs: entry.artifactRefs.includes(artifact.path)
              ? entry.artifactRefs
              : [...entry.artifactRefs, artifact.path],
          }
        : entry),
    };
    state.graph = graphWithArtifact;
    const evidence: GateEvidence[] = [{
      kind: "artifact",
      artifactHash: artifact.artifactHash,
      producerId,
      result: "fail",
      timestamp: completedAt,
    }];
    const observed = await this.pluginHost.dispatchAfterNodeCompleted({
      runId: state.runId,
      graph: graphWithArtifact,
      node: graphWithArtifact.nodes.find((entry) => entry.id === node.id) ?? node,
      outcome: {
        nodeId: node.id,
        status,
        summary,
        evidenceRefs: [artifact.path],
      },
      artifactHash: artifact.artifactHash,
      producerId,
      evidence,
      findings: [{
        kind: "implementation",
        severity: "critical",
        correctable: false,
        direction: `Worker ended ${status}: ${summary.slice(0, 1_000)}`,
      }],
      independentProviderAvailable: false,
      independentReviewerAvailable: false,
      refineCount: state.refineCount,
      pivotCount: state.pivotCount,
    });
    state.terminalHookNodeIds.add(terminalHookKey);
    state.completedStages.add("work");
    const decision: PluginDecisionAggregate = observed.action === "block"
      ? observed
      : {
          action: "block",
          decisions: [
            ...observed.decisions,
            {
              pluginName: "unclecode-runtime",
              action: "block",
              reason: `Worker ${node.id} ended ${status}.`,
              failures: [`WORKER_${status.toUpperCase()}`],
            },
          ],
          failures: [...new Set([...observed.failures, `WORKER_${status.toUpperCase()}`])],
        };
    const existingTerminal = state.terminal;
    this.recordQualityDecision(state, "work", decision, {
      nodeId: node.id,
      nodeAttempt: node.attempt,
      artifactRefs: [artifact.path],
      artifactHash: artifact.artifactHash,
      evidenceRefs: [artifact.path],
      independentVerification: false,
      ...(route ? { route } : {}),
    });
    if (existingTerminal) state.terminal = existingTerminal;
  }

  private async reconcileTerminalQualityResults(
    state: QualityRuntimeState,
    results: readonly PlannedWorkResult[],
  ): Promise<void> {
    // Observe real failures/cancellations before scheduler-blocked siblings.
    // A blocked dependency is provisional while the same wave has requested
    // refinement, but becomes terminal if another result proves the wave failed.
    const orderedResults = [
      ...results.filter((result) => result.status !== "blocked"),
      ...results.filter((result) => result.status === "blocked"),
    ];
    for (const result of orderedResults) {
      const node = state.graph?.nodes.find((candidate) => candidate.id === result.id);
      if (!node) throw new Error(`Quality graph is missing terminal node ${result.id}.`);
      if (result.status === "completed" || state.terminalHookNodeIds.has(qualityNodeAttemptKey(state, node))) continue;
      if (result.status === "blocked" && state.pendingIteration && !state.terminal) continue;
      await this.finishTerminalQualityNode(state, node, result.status, result.summary);
    }
  }

  private completeQuality(
    state: QualityRuntimeState,
    decision: QualityGateStatus,
    stage: QualityHarnessStage,
    input: {
      readonly evidenceRefs?: readonly string[] | undefined;
      readonly artifactRefs?: readonly string[] | undefined;
      readonly artifactHash?: string | undefined;
      readonly reviewedArtifactHash?: string | undefined;
      readonly currentArtifactHash?: string | undefined;
      readonly reviewerRunId?: string | undefined;
      readonly stale?: boolean | undefined;
      readonly failures?: readonly string[] | undefined;
      readonly independentVerification?: boolean | undefined;
    } = {},
  ): void {
    if (state.completed) return;
    state.completed = true;
    const startedAt = Date.now();
    const provenance = state.terminalProvenance;
    const evidenceRefs = [...new Set([
      ...(provenance?.evidenceRefs ?? []),
      ...(input.evidenceRefs ?? []),
    ])];
    const artifactRefs = [...new Set([
      ...(provenance?.artifactRefs ?? []),
      ...(input.artifactRefs ?? []),
    ])];
    const artifactHash = input.artifactHash ?? provenance?.artifactHash;
    const reviewedArtifactHash = input.reviewedArtifactHash ?? provenance?.reviewedArtifactHash;
    const currentArtifactHash = input.currentArtifactHash ?? provenance?.currentArtifactHash;
    const reviewerRunId = input.reviewerRunId ?? provenance?.reviewerRunId;
    const stale = input.stale ?? provenance?.stale;
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
      evidenceRefs,
      ...(artifactRefs.length > 0 ? { artifactRefs } : {}),
      ...(artifactHash ? { artifactHash } : {}),
      ...(reviewedArtifactHash ? { reviewedArtifactHash } : {}),
      ...(currentArtifactHash ? { currentArtifactHash } : {}),
      ...(reviewerRunId ? { reviewerRunId } : {}),
      ...(stale === undefined ? {} : { stale }),
      failures: [...new Set([...(input.failures ?? []), ...state.failures])],
      independentVerification: input.independentVerification
        ?? provenance?.independentVerification
        ?? false,
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

  private directQualityGraph(state: QualityRuntimeState): WorkGraph {
    return {
      id: state.graphId,
      qualityProfile: state.profile,
      currentStage: "work",
      gateStatus: "unproven",
      iteration: state.iteration,
      approval: "approved",
      nodes: [],
    };
  }

  /**
   * Creator work never enters the ordinary direct/worker runtime. The creator
   * service owns its isolated Git worktree and returns a proposal whose type
   * keeps human approval pending; this method has no promotion capability.
   */
  private async runCreatorEvolutionTurn(
    state: QualityRuntimeState,
    prompt: string,
    signal: AbortSignal,
  ): Promise<WorkAgentTurnResult> {
    state.graph = {
      ...this.directQualityGraph(state),
      currentStage: "promote",
    };
    state.completedStages.add("work");
    this.emitQualityStage(state, "work");
    const targets = creatorMutableTargets(prompt);
    const producerId = `creator:${this.directRoute.provider}:${this.directRoute.model}`;
    const block = (failure: string, reason: string): WorkAgentTurnResult => {
      this.recordQualityDecision(state, "promote", {
        action: "block",
        decisions: [{
          pluginName: "unclecode-evolution-runtime",
          action: "block",
          reason,
          failures: [failure],
        }],
        failures: [failure],
      }, { independentVerification: false });
      return this.terminateQuality(state);
    };
    if (!this.creatorEvolutionService) {
      return block(
        "CREATOR_EVOLUTION_LIFECYCLE_UNAVAILABLE",
        "Creator work requires the isolated evolution runtime before any mutation-capable execution.",
      );
    }

    let evolution: Awaited<ReturnType<CreatorEvolutionService["run"]>>;
    try {
      evolution = await this.creatorEvolutionService.run({
        runId: state.runId,
        workspaceRoot: this.workspaceRoot,
        prompt,
        creatorId: producerId,
        mutableTargets: targets,
        dispatchEvolutionProposed: (event) => this.pluginHost!.dispatchEvolutionProposed(event),
        signal,
      });
    } catch (error) {
      return block(
        "CREATOR_EVOLUTION_EXECUTION_FAILED",
        `Creator evolution failed before isolated completion: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (evolution.recorded) {
      this.emitTrace({
        type: "evolution.proposed",
        level: "high-signal",
        runId: state.runId,
        recorded: true,
        proposal: evolution.projection,
        startedAt: Date.parse(evolution.projection.createdAt),
      });
    }
    // The evolution service's distinct held-out evaluator is the creator
    // critic; no ordinary tool-capable quality agent is dispatched for it.
    state.completedStages.add("critic");
    state.completedStages.add("promote");
    const artifactHash = evolution.proposal?.validationEvidence[0]?.artifactHash
      ?? evolution.projection.hashes.candidateArtifact
      ?? `sha256:${createHash("sha256").update(JSON.stringify(evolution.projection)).digest("hex")}`;
    const completedAt = new Date().toISOString();
    const validation = evolution.proposal?.validationEvidence[0];
    const evidence: GateEvidence[] = validation && evolution.proposal
      ? [{
          kind: "artifact",
          artifactHash,
          producerId,
          result: validation.result,
          timestamp: validation.timestamp,
        }, {
          kind: "reviewer",
          artifactHash,
          producerId,
          reviewerId: evolution.proposal.evaluatorId,
          result: validation.result,
          timestamp: validation.timestamp,
        }]
      : [{
          kind: "artifact",
          artifactHash,
          producerId,
          result: evolution.status === "pr-ready" ? "pass" : "fail",
          timestamp: completedAt,
        }];
    const projection: QualityRunProjection = {
      runId: state.runId,
      profile: state.profile,
      currentStage: "promote",
      currentPhase: "act",
      score: null,
      failures: [...evolution.projection.failures],
      iteration: state.iteration,
      refineCount: state.refineCount,
      pivotCount: state.pivotCount,
      gateDecision: evolution.status === "pr-ready" ? "proceed" : "block",
      completedStages: [...state.completedStages],
    };
    let completion = await this.pluginHost!.dispatchBeforeRunComplete({
      runId: state.runId,
      graph: state.graph,
      projection,
      evidence,
      currentArtifactHash: artifactHash,
      producerId,
      independentReviewerAvailable: evolution.status === "pr-ready",
      reviewRequired: true,
      evolution: {
        proposalId: evolution.projection.id,
        state: evolution.status,
        recorded: evolution.recorded,
        stale: evolution.projection.stale,
        ...(evolution.proposal === undefined ? {} : { proposal: evolution.proposal }),
        ...(evolution.context === undefined ? {} : { context: evolution.context }),
      },
    });

    if (evolution.status === "pr-ready") {
      try {
        evolution = await this.creatorEvolutionService.verifyFresh(evolution);
        if (evolution.status !== "pr-ready" || evolution.projection.stale) {
          const failures = evolution.projection.failures.length > 0
            ? evolution.projection.failures
            : ["CREATOR_EVOLUTION_STALE"];
          completion = {
            action: "block",
            decisions: [{
              pluginName: "unclecode-evolution-runtime",
              action: "block",
              reason: "Creator evolution changed during completion validation.",
              failures,
            }],
            failures,
          };
        }
      } catch {
        completion = {
          action: "block",
          decisions: [{
            pluginName: "unclecode-evolution-runtime",
            action: "block",
            reason: "Creator evolution freshness could not be proven.",
            failures: ["CREATOR_EVOLUTION_FRESHNESS_FAILED"],
          }],
          failures: ["CREATOR_EVOLUTION_FRESHNESS_FAILED"],
        };
      }
    }

    this.recordQualityDecision(state, "promote", completion, {
      artifactHash,
      evidenceRefs: [...evolution.projection.artifactRefs],
      independentVerification: evolution.status === "pr-ready",
    });
    if (state.terminal) return this.terminateQuality(state);
    const qualityStatus = completion.action;
    this.completeQuality(state, qualityStatus, "promote", {
      evidenceRefs: [...evolution.projection.artifactRefs],
      failures: completion.failures,
      independentVerification: evolution.status === "pr-ready",
    });
    const location = evolution.projection.isolatedBranch
      ? ` Isolated candidate: ${evolution.projection.isolatedBranch}.`
      : "";
    return {
      text: `${evolution.projection.summary}${location} Human promotion remains required; the primary workspace was not promoted.`,
      qualityStatus,
    };
  }

  /**
   * Simple and research turns have no planner or execution DAG. They still
   * cross the in-process SCC completion boundary with one bounded artifact
   * bound to the provider result. Minimal completion can proceed without a
   * reviewer, while traces retain `independentVerification: false`; deeper
   * profiles remain unproven until their required review stages exist.
   */
  private async runDirectQualityTurn(
    state: QualityRuntimeState,
    intent: Extract<WorkIntent, "simple" | "research">,
    prompt: string,
    attachments: readonly Attachment[],
    signal: AbortSignal,
  ): Promise<WorkAgentTurnResult> {
    if (!this.pluginHost) {
      throw new Error("Direct quality lifecycle requires a plugin host.");
    }
    const workspaceBaseline = state.artifacts.captureWorkspaceInventoryManifest();
    const baselineTrackedSymlinks = trackedWorkspaceSymlinks(this.workspaceRoot, workspaceBaseline);
    state.graph = this.directQualityGraph(state);
    const route = resolveBalancedPrewalkRoute({
      stage: "work",
      directRoute: this.directRoute,
    });
    const context = await this.qualityContext(state, "work");
    const qualityPrompt = appendQualityContext(prompt, context);
    const producerId = `direct:${route.provider}:${route.model}:iteration-${state.iteration}`;
    this.emitQualityStage(state, "work", route, `${state.runId}:direct:${state.iteration}`);

    let directResult: { readonly text: string };
    try {
      directResult = await this.runMainTurn(qualityPrompt, attachments, { signal });
    } catch (error) {
      const status = error instanceof Error && error.name === "AbortError"
        ? "cancelled"
        : "failed";
      const failure = status === "cancelled" ? "DIRECT_TURN_CANCELLED" : "DIRECT_TURN_FAILED";
      const summary = status === "cancelled"
        ? "Direct provider turn cancelled."
        : `Direct provider turn failed: ${error instanceof Error ? error.message : String(error)}`;
      const workspaceManifest = state.artifacts.captureWorkspaceInventoryManifest();
      const artifact = state.artifacts.persistDirectTurn({
        intent,
        iteration: state.iteration,
        producerId,
        summary,
        completedAt: new Date().toISOString(),
        status,
        workspaceManifest,
      });
      state.completedStages.add("work");
      this.recordQualityDecision(state, "work", {
        action: "block",
        decisions: [{
          pluginName: "unclecode-runtime",
          action: "block",
          reason: summary,
          failures: [failure],
        }],
        failures: [failure],
      }, {
        artifactHash: artifact.artifactHash,
        evidenceRefs: [artifact.path],
        independentVerification: false,
        route,
      });
      this.completeQuality(state, "block", "work", {
        evidenceRefs: [artifact.path],
        failures: [failure],
        independentVerification: false,
      });
      throw error;
    }

    const rawWorkspaceManifest = state.artifacts.captureWorkspaceInventoryManifest();
    const workspaceManifest = directWorkspaceManifestAgainstBaseline({
      baseline: workspaceBaseline,
      baselineTrackedSymlinks,
      current: rawWorkspaceManifest,
      currentTrackedSymlinks: trackedWorkspaceSymlinks(this.workspaceRoot, rawWorkspaceManifest),
    });
    const artifact = state.artifacts.persistDirectTurn({
      intent,
      iteration: state.iteration,
      producerId,
      summary: directResult.text,
      completedAt: new Date().toISOString(),
      status: "completed",
      workspaceManifest,
    });
    const evidence: GateEvidence[] = [{
      kind: "artifact",
      artifactHash: artifact.artifactHash,
      producerId,
      result: workspaceManifest.evidenceStatus === "supported" ? "pass" : "fail",
      timestamp: new Date().toISOString(),
    }];
    state.completedStages.add("work");
    const projection: QualityRunProjection = {
      runId: state.runId,
      profile: state.profile,
      currentStage: "work",
      currentPhase: "do",
      score: null,
      failures: [],
      iteration: state.iteration,
      refineCount: state.refineCount,
      pivotCount: state.pivotCount,
      gateDecision: "proceed",
      completedStages: [...state.completedStages],
    };
    const observed = await this.pluginHost.dispatchBeforeRunComplete({
      runId: state.runId,
      graph: state.graph,
      projection,
      evidence,
      currentArtifactHash: artifact.artifactHash,
      producerId,
      independentReviewerAvailable: false,
      reviewRequired: state.profile !== "minimal",
    });
    const rawCurrentManifest = state.artifacts.captureWorkspaceInventoryManifest();
    const currentManifest = directWorkspaceManifestAgainstBaseline({
      baseline: workspaceBaseline,
      baselineTrackedSymlinks,
      current: rawCurrentManifest,
      currentTrackedSymlinks: trackedWorkspaceSymlinks(this.workspaceRoot, rawCurrentManifest),
    });
    if (workspaceManifest.evidenceStatus === "unsupported") {
      this.recordUnsupportedOwnershipDecision(state, "work", workspaceManifest.unsupportedEntries, {
        artifactHash: artifact.artifactHash,
        reviewedArtifactHash: workspaceManifest.artifactHash,
        currentArtifactHash: currentManifest.artifactHash,
        stale: true,
        evidenceRefs: [artifact.path],
        independentVerification: false,
        route,
      });
      return this.terminateQuality(state);
    }
    if (currentManifest.evidenceStatus === "unsupported") {
      this.recordUnsupportedOwnershipDecision(state, "work", currentManifest.unsupportedEntries, {
        artifactHash: artifact.artifactHash,
        reviewedArtifactHash: workspaceManifest.artifactHash,
        currentArtifactHash: currentManifest.artifactHash,
        stale: true,
        evidenceRefs: [artifact.path],
        independentVerification: false,
        route,
      });
      return this.terminateQuality(state);
    }
    if (currentManifest.artifactHash !== workspaceManifest.artifactHash) {
      this.recordQualityDecision(state, "work", staleDirectWorkspaceDecision(), {
        artifactHash: artifact.artifactHash,
        reviewedArtifactHash: workspaceManifest.artifactHash,
        currentArtifactHash: currentManifest.artifactHash,
        stale: true,
        evidenceRefs: [artifact.path],
        independentVerification: false,
        route,
      });
      return this.terminateQuality(state);
    }
    const decision = observed;
    this.recordQualityDecision(state, "work", decision, {
      artifactHash: artifact.artifactHash,
      evidenceRefs: [artifact.path],
      independentVerification: false,
      route,
    });
    if (state.terminal) return this.terminateQuality(state);
    const qualityStatus = decision.action;
    if (qualityStatus === "refine" || qualityStatus === "pivot") {
      return { text: directResult.text, qualityStatus };
    }
    state.graph = { ...state.graph, gateStatus: qualityStatus };
    this.completeQuality(state, qualityStatus, "work", {
      evidenceRefs: [artifact.path],
      failures: decision.failures,
      independentVerification: false,
    });
    return { text: directResult.text, qualityStatus };
  }

  /**
   * Every phase of a turn — attachment, simple, research, planning, executor,
   * guardian, synthesis — runs inside one epoch. A clear stops whichever phase
   * is live and yields a single typed outcome; a plain parent abort keeps its
   * ordinary `AbortError` semantics.
   */
  async runTurn(
    prompt: string,
    attachments: readonly Attachment[] = [],
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly classificationPrompt?: string | undefined;
      readonly pause?: ExecutionPausePort | undefined;
    } = {},
  ): Promise<WorkAgentTurnResult> {
    const epoch = this.runController.beginTurn(options.signal);
    try {
      const result = await withExecutionPausePort(options.pause, () =>
        this.runTurnInEpoch(
          prompt,
          attachments,
          epoch,
          options.classificationPrompt ?? prompt,
        ));
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

  private async runTurnInEpoch(
    prompt: string,
    attachments: readonly Attachment[],
    epoch: WorkAgentTurnEpoch,
    classificationPrompt: string,
  ): Promise<WorkAgentTurnResult> {
    const turnSignal = epoch.signal;
    const turnOptions = { signal: turnSignal };
    if (!this.pluginHost && attachments.length > 0) {
      return await this.runMainTurn(prompt, attachments, turnOptions);
    }

    const safety = classifyWorkSafetyBoundary(classificationPrompt);
    const classifiedIntent = this.pluginHost ? classifyWorkIntent(classificationPrompt, this.mode) : undefined;
    let effectiveIntent = classifiedIntent && safety.requiresOrchestration
      ? "complex"
      : classifiedIntent;
    const quality = effectiveIntent ? this.createQualityState(effectiveIntent, safety) : undefined;
    if (quality && this.pluginHost && effectiveIntent) {
      this.emitQualityStage(quality, "explore");
      const classified = await this.pluginHost.dispatchRunClassified({
        runId: quality.runId,
        prompt: classificationPrompt,
        complexity: effectiveIntent,
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
    if (quality?.profile === "creator" && this.pluginHost) {
      return await this.runCreatorEvolutionTurn(quality, classificationPrompt, turnSignal);
    }

    // Empty until the plan is accepted; the controller refuses any dispatch
    // naming a job the plan never queued, so no second guard is needed here.
    let activeGraphId = "";
    let completionArtifact: PersistedQualityArtifact | undefined;
    let completionReviewPacket: QualityReviewPacket | undefined;
    let completionReviewPacketInput: QualityReviewPacketInput | undefined;
    let completionManifestHash = "";
    let completionProducerId = "";
    let completionEvidence: GateEvidence[] = [];
    let criticIndependent = false;
    let criticIndependentProvider = false;
    let criticIndependentReviewer = false;
    let criticReviewerRunId = "";
    let criticGateStatus: QualityGateStatus = "proceed";
    let directQualityResult: WorkAgentTurnResult | undefined;
    let iterationKind: "initial" | "refine" | "pivot" = "initial";
    let iterationReason = "";
    let executionPlan: readonly PlannedWorkTask[] | undefined;
    let currentPlan: readonly PlannedWorkTask[] = [];
    const latestResultsByNode = new Map<string, PlannedWorkResult>();
    const orchestrator = createTurnOrchestrator<PlannedWorkTask, PlannedWorkResult>({
      runSimpleTurn: async (simplePrompt) => {
        if (!quality) return await this.runMainTurn(simplePrompt, attachments, turnOptions);
        directQualityResult = await this.runDirectQualityTurn(
          quality,
          "simple",
          simplePrompt,
          attachments,
          turnSignal,
        );
        return { text: directQualityResult.text };
      },
      runResearchTurn: async (researchPrompt) => {
        if (!quality) return await this.runMainTurn(researchPrompt, attachments, turnOptions);
        directQualityResult = await this.runDirectQualityTurn(
          quality,
          "research",
          researchPrompt,
          attachments,
          turnSignal,
        );
        return { text: directQualityResult.text };
      },
      planComplexTurn: async (complexPrompt, planOptions) => {
        if (quality && iterationKind === "refine") {
          if (!executionPlan || executionPlan.length === 0) {
            throw new Error("Quality refine requested without an executable affected subgraph.");
          }
          return { tasks: executionPlan, usedLlm: false };
        }
        const context = quality ? await this.qualityContext(quality, "plan") : undefined;
        if (quality) {
          this.emitQualityStage(quality, "plan", resolveBalancedPrewalkRoute({
            stage: "plan",
            directRoute: this.directRoute,
            ...(this.commodityRoute ? { commodityRoute: this.commodityRoute } : {}),
          }));
        }
        const plannerPrompt = quality && iterationKind === "pivot"
          ? `${complexPrompt}\n\n<quality_pivot_request>\n${iterationReason}\nProduce a replacement explicit DAG that resolves this defect.\n</quality_pivot_request>`
          : complexPrompt;
        const { tasks, usedLlm } = await this.planTasks(
          plannerPrompt,
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
          if (beforeDispatch.node.id !== task.id && !quality.terminal && !quality.pendingIteration) {
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
            this.runController.settleBlockedJob(
              activeGraphId,
              task.id,
              qualityJobKey(quality, plannedNode),
            );
            await this.finishTerminalQualityNode(
              quality,
              plannedNode,
              "blocked",
              quality.terminal.reason,
            );
            return {
              id: task.id,
              summary: quality.terminal.reason,
              status: "blocked",
            };
          }
          if (quality.pendingIteration) {
            this.runController.settleBlockedJob(
              activeGraphId,
              task.id,
              qualityJobKey(quality, plannedNode),
            );
            return {
              id: task.id,
              summary: quality.pendingIteration.reason,
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
          let outcome: Awaited<ReturnType<WorkAgentRunController<Attachment, TraceEvent, Reasoning>["runTask"]>>;
          let producerAgentRunId: string | undefined;
          try {
            outcome = await runExecutionNonInterruptible(
              "provider.request",
              () => this.runController.runTask({
                graphId: activeGraphId,
                jobKey: qualityJobKey(quality, node),
                task: {
                  id: node.id,
                  summary: node.title,
                  prompt: appendQualityContext(node.prompt, context),
                },
                signal: turnSignal,
                preferDirect: route.executor !== "commodity",
                onDispatchStarting: (agentRunId) => {
                  producerAgentRunId = agentRunId;
                  this.emitQualityStage(quality, "work", route, agentRunId, node);
                },
              }),
            );
          } catch (error) {
            const summary = `Executor failed: ${error instanceof Error ? error.message : String(error)}`;
            await this.finishTerminalQualityNode(quality, node, "failed", summary, route);
            return { id: task.id, summary, status: "failed" };
          }
          if (outcome.status !== "completed") {
            await this.finishTerminalQualityNode(quality, node, outcome.status, outcome.text, route);
            return { id: task.id, summary: outcome.text, status: outcome.status };
          }

          const completedAt = new Date().toISOString();
          const producerId = `worker:${route.provider}:${route.model}:${node.id}:attempt-${node.attempt}:iteration-${quality.iteration}`;
          const artifact = quality.artifacts.persistNode({
            nodeId: node.id,
            attempt: node.attempt,
            iteration: quality.iteration,
            producerId,
            summary: outcome.text,
            writePaths: node.fileOwnership,
            completedAt,
          });
          quality.workerArtifactsByNode.set(node.id, artifact);
          quality.producerRoutesByNode.set(node.id, { provider: route.provider, model: route.model });
          if (producerAgentRunId) quality.producerAgentRunIdsByNode.set(node.id, producerAgentRunId);
          const unsupportedEntries = artifact.unsupportedEntries ?? [];
          const evidenceUnsupported = artifact.evidenceStatus === "unsupported";
          const evidence: GateEvidence[] = [{
            kind: "artifact",
            artifactHash: artifact.artifactHash,
            producerId,
            result: evidenceUnsupported ? "fail" : "pass",
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
              ? { ...entry, status: "completed", artifactRefs: [...entry.artifactRefs, artifact.path] }
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
            findings: evidenceUnsupported
              ? [{
                  kind: "implementation",
                  severity: "critical",
                  correctable: false,
                  direction: "Owned output contains a symlink, special file, or unreadable entry and cannot be trusted as review evidence.",
                }]
              : [],
            independentProviderAvailable: independentAvailable,
            independentReviewerAvailable: false,
            refineCount: quality.refineCount,
            pivotCount: quality.pivotCount,
          });
          const afterNodeDecision = evidenceUnsupported
            ? forceRuntimeBlock(afterNode, unsupportedOwnershipDecision("work", unsupportedEntries))
            : afterNode;
          this.recordQualityDecision(quality, "work", afterNodeDecision, {
            nodeId: node.id,
            nodeAttempt: node.attempt,
            artifactRefs: [artifact.path],
            artifactHash: artifact.artifactHash,
            evidenceRefs: [artifact.path],
            // Route availability is only a capability signal. No independent
            // reviewer has examined this artifact until the critic stage runs.
            independentVerification: false,
            route,
          });
          quality.terminalHookNodeIds.add(qualityNodeAttemptKey(quality, node));
          quality.completedStages.add("work");
          const terminalAfterNode = quality.terminal as QualityTerminal | undefined;
          const iterationAfterNode = quality.pendingIteration as QualityIterationRequest | undefined;
          if (terminalAfterNode || iterationAfterNode) {
            return {
              id: task.id,
              summary: (terminalAfterNode ?? iterationAfterNode)?.reason ?? "Quality iteration requested.",
              status: "blocked",
            };
          }
          return { id: task.id, summary: outcome.text, status: "completed" };
        }

        const outcome = await runExecutionNonInterruptible(
          "provider.request",
          () => this.runController.runTask({
            graphId: activeGraphId,
            task,
            signal: turnSignal,
          }),
        );
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
        const node = quality?.graph?.nodes.find((candidate) => candidate.id === task.id);
        this.runController.settleBlockedJob(
          activeGraphId,
          task.id,
          quality && node ? qualityJobKey(quality, node) : undefined,
        );
        return { id: task.id, summary: BLOCKED_BY_DEPENDENCY_SUMMARY, status: "blocked" };
      },
      runGuardianReview: async ({ prompt: originalPrompt, tasks, results }) => {
        turnSignal.throwIfAborted();
        const changedFiles = extractChangedFilesFromTasks(tasks);
        const executableChecks = await this.loadExecutableGuardianChecks({
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
          ...(quality || this.runExecutableGuardianChecks
            ? { executableChecks: executableChecks.summary }
            : {}),
          ...(quality ? { qualityReadOnly: true } : {}),
        });
        let criticRoute: BalancedPrewalkRoute | undefined;
        if (quality) {
          completionProducerId = `graph:${quality.graphId}:iteration-${quality.iteration}`;
          const workspaceManifest = quality.artifacts.captureWorkspaceManifest(qualityWritePaths(quality));
          completionManifestHash = workspaceManifest.artifactHash;
          completionArtifact = quality.artifacts.persistRun({
            graphId: quality.graphId,
            iteration: quality.iteration,
            producerId: completionProducerId,
            artifacts: currentWorkerArtifacts(quality),
            completedAt: new Date().toISOString(),
            workspaceManifest,
          });
          if (!quality.reviewBaseline) {
            criticGateStatus = "block";
            this.recordQualityDecision(quality, "critic", {
              action: "block",
              decisions: [{
                pluginName: "unclecode-runtime",
                action: "block",
                reason: "The approved-plan workspace baseline is unavailable; changed-path ownership cannot be proven.",
                failures: ["QUALITY_REVIEW_BASELINE_MISSING"],
              }],
              failures: ["QUALITY_REVIEW_BASELINE_MISSING"],
            }, {
              artifactHash: completionArtifact.artifactHash,
              evidenceRefs: [completionArtifact.path],
              independentVerification: false,
            });
            return { summary: "Quality review blocked: workspace baseline unavailable." };
          }
          completionReviewPacketInput = {
            graphId: quality.graphId,
            iteration: quality.iteration,
            baseline: quality.reviewBaseline,
            request: originalPrompt,
            tasks: tasks.map((task) => ({
              id: task.id,
              acceptanceCriteria: task.acceptanceCriteria,
              writePaths: task.writePaths,
            })),
            results: results.map((result) => ({
              id: result.id,
              status: result.status,
              summary: result.summary,
            })),
            workerArtifacts: currentWorkerArtifacts(quality),
            executableChecks: executableChecks.checks,
          };
          try {
            completionReviewPacket = quality.artifacts.persistReviewPacket(completionReviewPacketInput);
          } catch {
            criticGateStatus = "block";
            this.recordQualityDecision(quality, "critic", {
              action: "block",
              decisions: [{
                pluginName: "unclecode-runtime",
                action: "block",
                reason: "The immutable review packet artifact could not be created or verified.",
                failures: ["IMMUTABLE_REVIEW_PACKET_ARTIFACT_INVALID"],
              }],
              failures: ["IMMUTABLE_REVIEW_PACKET_ARTIFACT_INVALID"],
            }, {
              artifactHash: completionArtifact.artifactHash,
              evidenceRefs: [completionArtifact.path],
              independentVerification: false,
            });
            return { summary: "Quality review blocked: immutable review packet artifact is invalid." };
          }
          completionEvidence = [{
            kind: "artifact",
            artifactHash: completionReviewPacket.artifactHash,
            producerId: completionProducerId,
            result: workspaceManifest.evidenceStatus === "unsupported"
              || completionReviewPacket.evidenceStatus === "unsupported" ? "fail" : "pass",
            timestamp: new Date().toISOString(),
          }];
          if (workspaceManifest.evidenceStatus === "unsupported") {
            criticGateStatus = "block";
            this.recordUnsupportedOwnershipDecision(
              quality,
              "critic",
              workspaceManifest.unsupportedEntries,
              {
                artifactHash: completionReviewPacket.artifactHash,
                evidenceRefs: [completionArtifact.path, completionReviewPacket.path],
                independentVerification: false,
              },
            );
            if (quality.graph) {
              quality.graph = { ...quality.graph, currentStage: "critic", gateStatus: "block" };
            }
            return { summary: "Quality review blocked: unsupported owned workspace evidence." };
          }
          if (completionReviewPacket.evidenceStatus === "unsupported") {
            criticGateStatus = "block";
            if (completionReviewPacket.undeclaredPaths.length > 0) {
              const paths = completionReviewPacket.undeclaredPaths.slice(0, 8).join(", ");
              const remainder = completionReviewPacket.undeclaredPaths.length > 8
                ? `, and ${completionReviewPacket.undeclaredPaths.length - 8} more`
                : "";
              this.recordQualityDecision(quality, "critic", {
                action: "block",
                decisions: [{
                  pluginName: "unclecode-runtime",
                  action: "block",
                  reason: `Worker execution changed undeclared workspace paths: ${paths}${remainder}.`,
                  failures: ["UNDECLARED_WORKSPACE_WRITE"],
                }],
                failures: ["UNDECLARED_WORKSPACE_WRITE"],
              }, {
                artifactHash: completionReviewPacket.artifactHash,
                evidenceRefs: [completionArtifact.path, completionReviewPacket.path],
                independentVerification: false,
              });
            } else {
              this.recordUnsupportedOwnershipDecision(
                quality,
                "critic",
                completionReviewPacket.unsupportedEntries ?? [],
                {
                  artifactHash: completionReviewPacket.artifactHash,
                  evidenceRefs: [completionArtifact.path, completionReviewPacket.path],
                  independentVerification: false,
                },
              );
            }
            if (quality.graph) {
              quality.graph = { ...quality.graph, currentStage: "critic", gateStatus: "block" };
            }
            return { summary: "Quality review blocked: changed-path ownership evidence is unsupported." };
          }
          criticRoute = resolveBalancedPrewalkRoute({
            stage: "critic",
            directRoute: this.directRoute,
            ...(this.commodityRoute ? { commodityRoute: this.commodityRoute } : {}),
            ...(this.reviewAgent && this.reviewRoute ? { reviewRoute: this.reviewRoute } : {}),
            producerRoutes: currentProducerRoutes(quality),
          });
          criticIndependentProvider = criticRoute.independent;
          const packetPrompt = `<immutable_quality_review_packet sha256="${completionReviewPacket.artifactHash}">\n${completionReviewPacket.canonicalContent}</immutable_quality_review_packet>`;
          const criticBoundary = "</quality_critic_read_only>";
          const criticBoundaryIndex = reviewPrompt.lastIndexOf(criticBoundary);
          reviewPrompt = criticBoundaryIndex >= 0
            ? `${reviewPrompt.slice(0, criticBoundaryIndex)}${packetPrompt}\n\n${reviewPrompt.slice(criticBoundaryIndex)}`
            : `${reviewPrompt}\n\n${packetPrompt}`;
          reviewPrompt = appendQualityContext(reviewPrompt, await this.qualityContext(quality, "critic"));
          if (!this.reviewAgent || this.reviewAgent === this.directAgent || !this.reviewRoute) {
            this.recordQualityDecision(quality, "critic", {
              action: "block",
              decisions: [{
                pluginName: "unclecode-runtime",
                action: "block",
                reason: "A dedicated read-only quality review agent is unavailable.",
                failures: ["READ_ONLY_REVIEWER_UNAVAILABLE"],
              }],
              failures: ["READ_ONLY_REVIEWER_UNAVAILABLE"],
            }, {
              artifactHash: completionReviewPacket.artifactHash,
              evidenceRefs: [completionArtifact.path, completionReviewPacket.path],
            });
            return { summary: "Quality review blocked: read-only reviewer unavailable." };
          }
          criticReviewerRunId = `${quality.runId}:critic:${quality.iteration}:reviewer`;
          criticIndependentReviewer = !currentProducerAgentRunIds(quality).includes(criticReviewerRunId);
          this.emitQualityStage(quality, "critic", criticRoute, criticReviewerRunId);
        }
        const qualityReview = quality
          ? await this.runReadOnlyQualityTurn(reviewPrompt, turnSignal)
          : undefined;
        const review = qualityReview ?? await this.runInternalTurn(reviewPrompt, [], turnOptions);
        const summary = `${review.text}\n\nExecutable checks:\n${executableChecks.summary}`;
        if (
          quality
          && criticRoute
          && completionArtifact
          && completionReviewPacket
          && completionReviewPacketInput
        ) {
          const reviewedPacketHash = completionReviewPacket.artifactHash;
          const routeEvidence = resolveQualityReviewRouteEvidence({
            declaredRoute: criticRoute,
            observations: qualityReview?.routeObservations ?? [],
            allowDeclaredEvidence: this.allowDeclaredReviewRouteEvidence,
          });
          criticIndependentProvider = criticIndependentProvider && routeEvidence.status === "matched";
          criticIndependent = criticIndependentProvider && criticIndependentReviewer;
          const reviewerId = criticReviewerRunId;
          const completedAt = new Date().toISOString();
          let postCriticPacket: QualityReviewPacket;
          try {
            postCriticPacket = quality.artifacts.persistReviewPacket(completionReviewPacketInput);
          } catch {
            completionEvidence = completionEvidence.filter((evidence) => evidence.kind !== "reviewer");
            criticGateStatus = "block";
            this.recordQualityDecision(quality, "critic", {
              action: "block",
              decisions: [{
                pluginName: "unclecode-runtime",
                action: "block",
                reason: "The immutable review packet artifact changed during critic review.",
                failures: ["IMMUTABLE_REVIEW_PACKET_ARTIFACT_INVALID"],
              }],
              failures: ["IMMUTABLE_REVIEW_PACKET_ARTIFACT_INVALID"],
            }, {
              artifactHash: completionReviewPacket.artifactHash,
              reviewedArtifactHash: completionReviewPacket.artifactHash,
              currentArtifactHash: completionReviewPacket.artifactHash,
              stale: true,
              evidenceRefs: [completionArtifact.path, completionReviewPacket.path],
              independentVerification: false,
              route: criticRoute,
            });
            quality.completedStages.add("critic");
            if (quality.graph) {
              quality.graph = { ...quality.graph, currentStage: "critic", gateStatus: "block" };
            }
            return { summary: "Immutable review packet artifact changed during critic; review invalidated." };
          }
          if (
            postCriticPacket.evidenceStatus === "unsupported"
            || postCriticPacket.artifactHash !== completionReviewPacket.artifactHash
          ) {
            const criticArtifact = quality.artifacts.persistCritic({
              reviewerId,
              iteration: quality.iteration,
              reviewedArtifactHash: completionReviewPacket.artifactHash,
              summary,
              independent: criticIndependent,
              completedAt,
            });
            completionEvidence = completionEvidence.filter((evidence) => evidence.kind !== "reviewer");
            criticGateStatus = "block";
            if (
              postCriticPacket.evidenceStatus === "unsupported"
              && (postCriticPacket.unsupportedEntries?.length ?? 0) > 0
            ) {
              this.recordUnsupportedOwnershipDecision(
                quality,
                "critic",
                postCriticPacket.unsupportedEntries ?? [],
                {
                  artifactHash: completionReviewPacket.artifactHash,
                  reviewedArtifactHash: completionReviewPacket.artifactHash,
                  currentArtifactHash: postCriticPacket.artifactHash,
                  stale: true,
                  evidenceRefs: [
                    completionArtifact.path,
                    completionReviewPacket.path,
                    postCriticPacket.path,
                    criticArtifact.path,
                  ],
                  independentVerification: false,
                  route: criticRoute,
                },
              );
            } else if (postCriticPacket.undeclaredPaths.length > 0) {
              const paths = postCriticPacket.undeclaredPaths.slice(0, 8).join(", ");
              this.recordQualityDecision(quality, "critic", {
                action: "block",
                decisions: [{
                  pluginName: "unclecode-runtime",
                  action: "block",
                  reason: `The workspace changed on undeclared paths during critic review: ${paths}.`,
                  failures: ["UNDECLARED_WORKSPACE_WRITE"],
                }],
                failures: ["UNDECLARED_WORKSPACE_WRITE"],
              }, {
                artifactHash: completionReviewPacket.artifactHash,
                reviewedArtifactHash: completionReviewPacket.artifactHash,
                currentArtifactHash: postCriticPacket.artifactHash,
                stale: true,
                evidenceRefs: [
                  completionArtifact.path,
                  completionReviewPacket.path,
                  postCriticPacket.path,
                  criticArtifact.path,
                ],
                independentVerification: false,
                route: criticRoute,
              });
            } else {
              this.recordQualityDecision(quality, "critic", staleArtifactDecision("critic"), {
                artifactHash: completionReviewPacket.artifactHash,
                reviewedArtifactHash: completionReviewPacket.artifactHash,
                currentArtifactHash: postCriticPacket.artifactHash,
                stale: true,
                evidenceRefs: [
                  completionArtifact.path,
                  completionReviewPacket.path,
                  postCriticPacket.path,
                  criticArtifact.path,
                ],
                independentVerification: false,
                route: criticRoute,
              });
            }
            quality.completedStages.add("critic");
            if (quality.graph) {
              quality.graph = { ...quality.graph, currentStage: "critic", gateStatus: "block" };
            }
            return { summary: "Review packet changed during critic; review evidence invalidated." };
          }
          const postCriticManifest = quality.artifacts.captureWorkspaceManifest(qualityWritePaths(quality));
          if (postCriticManifest.evidenceStatus === "unsupported") {
            const criticArtifact = quality.artifacts.persistCritic({
              reviewerId,
              iteration: quality.iteration,
              reviewedArtifactHash: completionReviewPacket.artifactHash,
              summary,
              independent: criticIndependent,
              completedAt,
            });
            completionEvidence = completionEvidence.filter((evidence) => evidence.kind !== "reviewer");
            criticGateStatus = "block";
            this.recordUnsupportedOwnershipDecision(
              quality,
              "critic",
              postCriticManifest.unsupportedEntries,
              {
                artifactHash: completionReviewPacket.artifactHash,
                evidenceRefs: [completionArtifact.path, completionReviewPacket.path, criticArtifact.path],
                independentVerification: false,
                route: criticRoute,
              },
            );
            quality.completedStages.add("critic");
            if (quality.graph) {
              quality.graph = { ...quality.graph, currentStage: "critic", gateStatus: "block" };
            }
            return { summary: "Unsupported owned workspace evidence encountered during critic." };
          }
          if (postCriticManifest.artifactHash !== completionManifestHash) {
            const criticArtifact = quality.artifacts.persistCritic({
              reviewerId,
              iteration: quality.iteration,
              reviewedArtifactHash: completionReviewPacket.artifactHash,
              summary,
              independent: criticIndependent,
              completedAt,
            });
            completionEvidence = completionEvidence.filter((evidence) => evidence.kind !== "reviewer");
            criticGateStatus = "block";
            this.recordQualityDecision(quality, "critic", staleArtifactDecision("critic"), {
              artifactHash: completionReviewPacket.artifactHash,
              reviewedArtifactHash: completionReviewPacket.artifactHash,
              currentArtifactHash: postCriticPacket.artifactHash,
              stale: true,
              evidenceRefs: [completionArtifact.path, completionReviewPacket.path, criticArtifact.path],
              independentVerification: false,
              route: criticRoute,
            });
            quality.completedStages.add("critic");
            if (quality.graph) {
              quality.graph = { ...quality.graph, currentStage: "critic", gateStatus: "block" };
            }
            return { summary: "Artifact manifest changed during critic; review evidence invalidated." };
          }
          const parsedVerdict = parseCriticVerdict(review.text);
          const criticArtifact = quality.artifacts.persistCritic({
            reviewerId,
            iteration: quality.iteration,
            reviewedArtifactHash: completionReviewPacket.artifactHash,
            summary,
            independent: criticIndependent,
            completedAt,
          });
          completionEvidence.push(...executableChecks.checks.map((check) => ({
            kind: "test" as const,
            artifactHash: reviewedPacketHash,
            producerId: completionProducerId,
            result: check.status === "passed" ? "pass" as const : "fail" as const,
            timestamp: completedAt,
          })));
          if (parsedVerdict) {
            completionEvidence.push({
              kind: "reviewer",
              artifactHash: completionReviewPacket.artifactHash,
              producerId: completionProducerId,
              reviewerId,
              result: parsedVerdict.verdict === "pass"
                ? "pass"
                : parsedVerdict.verdict === "fail"
                  ? "fail"
                  : "warning",
              timestamp: completedAt,
            });
          }
          const boundedRequest = parsedVerdict
            && !parsedVerdict.findings.some((finding) =>
              finding.severity === "critical" && (finding.kind === "policy" || finding.kind === "plan"))
            ? requestedIterationForFindings(parsedVerdict.findings)
            : undefined;
          const exhaustedIteration = boundedRequest
            && (boundedRequest === "refine" ? quality.refineCount : quality.pivotCount)
              >= DEFAULT_ITERATION_LIMITS[boundedRequest]
            ? boundedRequest
            : undefined;
          const failures = [
            ...executableChecks.failures,
            ...(!parsedVerdict ? ["INVALID_CRITIC_VERDICT"] : []),
            ...(parsedVerdict?.verdict === "fail" ? ["CRITIC_REJECTED"] : []),
            ...(routeEvidence.status === "missing" ? ["REVIEW_ROUTE_EVIDENCE_MISSING"] : []),
            ...(routeEvidence.status === "mismatched" ? ["REVIEW_ROUTE_EVIDENCE_MISMATCH"] : []),
            ...(!criticIndependentProvider ? ["INDEPENDENT_PROVIDER_UNAVAILABLE"] : []),
            ...(!criticIndependentReviewer ? ["INDEPENDENT_REVIEWER_UNAVAILABLE"] : []),
            ...(!criticIndependent ? ["INDEPENDENT_REVIEW_UNAVAILABLE"] : []),
            ...(exhaustedIteration ? [iterationLimitFailure(exhaustedIteration)] : []),
          ];
          const evaluated = parsedVerdict
            ? evaluateGate({
                findings: parsedVerdict.findings,
                evidence: completionEvidence,
                currentArtifactHash: completionReviewPacket.artifactHash,
                producerId: completionProducerId,
                reviewRequired: quality.profile !== "minimal",
                independentProviderAvailable: criticIndependentProvider,
                independentReviewerAvailable: criticIndependentReviewer,
                refineCount: quality.refineCount,
                pivotCount: quality.pivotCount,
              })
            : "block";
          criticGateStatus = !parsedVerdict || executableChecks.status === "failed"
            ? "block"
            : parsedVerdict.verdict === "unproven"
                || executableChecks.status === "unproven"
                || !criticIndependent
              ? "unproven"
              : exhaustedIteration
                ? "block"
                : boundedRequest
                  ? boundedRequest
                  : parsedVerdict.verdict === "fail"
                    ? "block"
                    : evaluated;
          this.recordQualityDecision(quality, "critic", {
            action: criticGateStatus,
            decisions: [{
              pluginName: "unclecode-critic",
              action: criticGateStatus,
              reason: exhaustedIteration
                ? `Quality ${exhaustedIteration} limit reached (${DEFAULT_ITERATION_LIMITS[exhaustedIteration]}); the bounded quality loop cannot continue.`
                : !parsedVerdict
                ? "Invalid critic verdict; expected the structured critic JSON contract."
                : executableChecks.status === "failed"
                  ? "Executable check failed."
                  : parsedVerdict.verdict === "fail"
                    ? `Critic rejected the implementation: ${parsedVerdict.summary}`
                    : parsedVerdict.summary,
              ...(failures.length > 0 ? { failures } : {}),
            }],
            failures,
          }, {
            artifactHash: completionReviewPacket.artifactHash,
            reviewedArtifactHash: completionReviewPacket.artifactHash,
            currentArtifactHash: completionReviewPacket.artifactHash,
            stale: false,
            evidenceRefs: [completionArtifact.path, completionReviewPacket.path, criticArtifact.path],
            reviewerRunId: criticReviewerRunId,
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
      shouldRunGuardianReview: ({ results }) =>
        !quality?.terminal
        && !quality?.pendingIteration
        && results.every((entry) => entry.status === "completed"),
    });

    const prepareNextQualityIteration = (): void => {
      if (!quality?.pendingIteration || !quality.graph) {
        throw new Error("Quality iteration preparation requires a pending request and active graph.");
      }
      if (quality.terminal) {
        throw new Error("A terminal quality decision must be handled before another iteration.");
      }
      const request = quality.pendingIteration;
      delete quality.pendingIteration;
      if (request.sourceIteration !== quality.iteration) {
        throw new Error("Quality iteration request does not belong to the active executor wave.");
      }
      if (request.requested === "refine") quality.refineCount += 1;
      else quality.pivotCount += 1;
      quality.iteration += 1;
      const count = request.requested === "refine" ? quality.refineCount : quality.pivotCount;
      const onlyAffectedNodeId = !request.rerunAll && request.affectedNodeIds.size === 1
        ? [...request.affectedNodeIds][0]
        : undefined;
      const iterationTrace = {
        level: "high-signal",
        runId: quality.runId,
        graphId: quality.graphId,
        profile: quality.profile,
        stage: request.stage,
        iteration: quality.iteration,
        count,
        reason: request.reason,
        evidenceRefs: [...request.evidenceRefs],
        failures: request.failures,
        ...(onlyAffectedNodeId ? { nodeId: onlyAffectedNodeId } : {}),
        ...(onlyAffectedNodeId && request.nodeAttempt !== undefined
          ? { nodeAttempt: request.nodeAttempt }
          : {}),
        ...(request.artifactRefs.size > 0 ? { artifactRefs: [...request.artifactRefs] } : {}),
        startedAt: Date.now(),
      } as const;
      this.emitTrace(request.requested === "refine"
        ? {
            ...iterationTrace,
            type: "quality.refine_requested",
            decision: "refine",
            limit: DEFAULT_ITERATION_LIMITS.refine,
          }
        : {
            ...iterationTrace,
            type: "quality.pivot_requested",
            decision: "pivot",
            limit: DEFAULT_ITERATION_LIMITS.pivot,
          });
      quality.failures.length = 0;
      iterationKind = request.requested;
      iterationReason = request.reason;
      completionArtifact = undefined;
      completionReviewPacket = undefined;
      completionReviewPacketInput = undefined;
      completionManifestHash = "";
      completionProducerId = "";
      completionEvidence = [];
      criticIndependent = false;
      criticIndependentProvider = false;
      criticIndependentReviewer = false;
      criticReviewerRunId = "";
      criticGateStatus = "unproven";
      delete quality.reviewBaseline;
      delete quality.terminalProvenance;

      if (request.requested === "pivot") {
        effectiveIntent = "complex";
        executionPlan = undefined;
        quality.workerArtifactsByNode.clear();
        quality.producerRoutesByNode.clear();
        latestResultsByNode.clear();
        return;
      }

      executionPlan = selectRefineTasks(
        currentPlan,
        quality.graph,
        request.rerunAll ? undefined : request.affectedNodeIds,
      );
      for (const task of executionPlan) {
        quality.workerArtifactsByNode.delete(task.id);
        quality.producerRoutesByNode.delete(task.id);
        latestResultsByNode.delete(task.id);
      }
    };

    qualityIterationLoop:
    while (true) {
      let result: Awaited<ReturnType<typeof orchestrator.run>> | undefined;
      while (!result) {
      try {
        // Research remains a distinct classification for profile selection and
        // observability, but deep quality cannot use the direct research fast
        // path: it must own an explicit graph and cross critic/promote gates.
        // The same complex executor also preserves the bounded retry,
        // cancellation, and pause/resume checkpoints for this path.
        const executionIntent = effectiveIntent === "research" && quality?.profile === "deep"
          ? "complex"
          : effectiveIntent;
        result = await orchestrator.run({
          prompt,
          mode: this.mode,
          maxWorkers: this.createExecutorAgent ? resolveWorkerBudget(this.mode) : 1,
          ...(executionIntent ? { intent: executionIntent } : {}),
          ...(this.traceListener ? { onTrace: (event) => this.emitTrace(event) } : {}),
          onPlan: async (tasks) => {
            const startedAt = Date.now();
            let graph: WorkGraph;
            if (quality && iterationKind === "refine") {
              const previousGraph = quality.graph;
              if (!previousGraph) {
                throw new Error("Quality refine requested without an active WorkGraph.");
              }
              const affectedNodeIds = new Set(tasks.map((task) => task.id));
              graph = {
                ...previousGraph,
                currentStage: "work",
                gateStatus: "unproven",
                iteration: quality.iteration,
                approval: "pending",
                nodes: previousGraph.nodes.map((node) => affectedNodeIds.has(node.id)
                  ? {
                      ...node,
                      status: "proposed",
                      stage: "work",
                      attempt: node.attempt + 1,
                    }
                  : node),
              };
            } else {
              const previousGraph = quality?.graph;
              const created = createWorkGraph(
                tasks,
                startedAt,
                quality ? { graphId: quality.graphId, profile: quality.profile } : undefined,
              );
              graph = quality
                ? {
                    ...created,
                    iteration: quality.iteration,
                    gateStatus: "unproven",
                    nodes: created.nodes.map((node) => {
                      const previous = previousGraph?.nodes.find((candidate) => candidate.id === node.id);
                      return iterationKind === "pivot" && previous
                        ? {
                            ...node,
                            attempt: previous.attempt + 1,
                            artifactRefs: previous.artifactRefs,
                          }
                        : node;
                    }),
                  }
                : created;
              currentPlan = tasks;
            }
            activeGraphId = graph.id;
            if (quality) quality.graph = graph;
            this.emitTrace({
              type: "work.proposed",
              level: "high-signal",
              graphId: graph.id,
              nodeCount: graph.nodes.length,
              sequence: nextWorkProposalSequence(startedAt),
              startedAt,
              graph,
            });
            if (quality && this.pluginHost && iterationKind !== "refine") {
              const planned = await this.pluginHost.dispatchPlanCreated({
                runId: quality.runId,
                graph,
              });
              quality.completedStages.add("plan");
              if (planned.action !== "proceed") {
                this.recordQualityDecision(quality, "plan", planned);
              }
              if (quality.terminal || quality.pendingIteration) throw new QualityLifecycleStop();
              quality.graph = { ...graph, approval: "approved", currentStage: "work" };
            } else if (quality) {
              quality.graph = { ...graph, approval: "approved", currentStage: "work" };
            }
            if (quality) {
              quality.reviewBaseline = quality.artifacts.captureWorkspaceInventory(
                tasks.flatMap((task) => task.writePaths),
              );
            }
            this.emitTrace({
              type: "work.approved",
              level: "high-signal",
              graphId: graph.id,
              startedAt: Date.now(),
            });
            this.runController.queuePlannedJobs(graph.id, tasks, startedAt, {
              resolveJobKey: (task) => {
                const node = quality?.graph?.nodes.find((candidate) => candidate.id === task.id);
                return quality && node ? qualityJobKey(quality, node) : task.id;
              },
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
            if (quality?.graph) {
              quality.graph = {
                ...quality.graph,
                nodes: quality.graph.nodes.map((node) => node.id === task.id
                  ? { ...node, status }
                  : node),
              };
            }
          },
          onTaskSettled: async () => {
            await checkpointExecutionPause("between_nodes");
          },
        });
      } catch (error) {
        if (error instanceof QualityLifecycleStop && quality?.terminal) {
          return this.terminateQuality(quality);
        }
        if (error instanceof QualityLifecycleStop && quality?.pendingIteration) {
          await checkpointExecutionPause("between_quality_iterations");
          prepareNextQualityIteration();
          result = undefined;
          continue;
        }
        throw error;
      }

      if (result.kind === "complex") {
        for (const taskResult of result.results) latestResultsByNode.set(taskResult.id, taskResult);
        if (quality) await this.reconcileTerminalQualityResults(quality, result.results);
      }
      if (epoch.isCleared()) {
        return CLEARED_TURN_RESULT;
      }
      // Every member of the executor wave has settled now. Cancellation and
      // terminal worker outcomes win over any sibling's proposed iteration.
      turnSignal.throwIfAborted();
      if (quality?.terminal) {
        return this.terminateQuality(quality);
      }
      if (quality?.pendingIteration) {
        await checkpointExecutionPause("between_quality_iterations");
        prepareNextQualityIteration();
        result = undefined;
      }
    }

    if (result.kind !== "complex") {
      return directQualityResult ?? { text: result.text };
    }
    if (quality) {
      await this.reconcileTerminalQualityResults(quality, result.results);
    }
    if (epoch.isCleared()) {
      return CLEARED_TURN_RESULT;
    }
    // A parent abort keeps its ordinary AbortError contract, but only after
    // terminal node hooks have observed cancelled/blocked scheduler outcomes.
    turnSignal.throwIfAborted();
    if (quality?.terminal) {
      return this.terminateQuality(quality);
    }

    const synthesisResults = quality
      ? currentPlan.flatMap((task) => {
          const taskResult = latestResultsByNode.get(task.id);
          return taskResult ? [taskResult] : [];
        })
      : result.results;
    if (quality && criticGateStatus !== "proceed") {
      if (quality.graph) {
        quality.graph = {
          ...quality.graph,
          currentStage: "critic",
          gateStatus: criticGateStatus,
        };
      }
      this.completeQuality(quality, criticGateStatus, "critic", {
        evidenceRefs: completionArtifact ? [completionArtifact.path] : [],
        failures: quality.failures,
        independentVerification: criticIndependent,
      });
      return {
        text: result.guardian?.summary ?? `Quality critic ended ${criticGateStatus}.`,
        qualityStatus: criticGateStatus,
      };
    }

    const reviewPacketIsFresh = (
      stage: Extract<QualityHarnessStage, "critic" | "promote">,
      route?: BalancedPrewalkRoute | undefined,
    ): boolean => {
      if (!quality || !completionArtifact || !completionReviewPacket || !completionReviewPacketInput) {
        return false;
      }
      let currentPacket: QualityReviewPacket;
      try {
        currentPacket = quality.artifacts.persistReviewPacket(completionReviewPacketInput);
      } catch {
        completionEvidence = completionEvidence.filter((evidence) => evidence.kind !== "reviewer");
        this.recordQualityDecision(quality, stage, {
          action: "block",
          decisions: [{
            pluginName: "unclecode-runtime",
            action: "block",
            reason: "The immutable review packet artifact could not be revalidated.",
            failures: ["IMMUTABLE_REVIEW_PACKET_ARTIFACT_INVALID"],
          }],
          failures: ["IMMUTABLE_REVIEW_PACKET_ARTIFACT_INVALID"],
        }, {
          artifactHash: completionReviewPacket.artifactHash,
          reviewedArtifactHash: completionReviewPacket.artifactHash,
          currentArtifactHash: completionReviewPacket.artifactHash,
          stale: true,
          evidenceRefs: [completionArtifact.path, completionReviewPacket.path],
          independentVerification: false,
          ...(route ? { route } : {}),
        });
        return false;
      }
      if (
        currentPacket.evidenceStatus === "supported"
        && currentPacket.artifactHash === completionReviewPacket.artifactHash
      ) return true;
      completionEvidence = completionEvidence.filter((evidence) => evidence.kind !== "reviewer");
      const detail = {
        artifactHash: completionReviewPacket.artifactHash,
        reviewedArtifactHash: completionReviewPacket.artifactHash,
        currentArtifactHash: currentPacket.artifactHash,
        stale: true,
        evidenceRefs: [completionArtifact.path, completionReviewPacket.path, currentPacket.path],
        independentVerification: false,
        ...(route ? { route } : {}),
      };
      if (
        currentPacket.evidenceStatus === "unsupported"
        && (currentPacket.unsupportedEntries?.length ?? 0) > 0
      ) {
        this.recordUnsupportedOwnershipDecision(
          quality,
          stage,
          currentPacket.unsupportedEntries ?? [],
          detail,
        );
      } else if (currentPacket.undeclaredPaths.length > 0) {
        const paths = currentPacket.undeclaredPaths.slice(0, 8).join(", ");
        this.recordQualityDecision(quality, stage, {
          action: "block",
          decisions: [{
            pluginName: "unclecode-runtime",
            action: "block",
            reason: `The workspace changed on undeclared paths after critic review: ${paths}.`,
            failures: ["UNDECLARED_WORKSPACE_WRITE"],
          }],
          failures: ["UNDECLARED_WORKSPACE_WRITE"],
        }, detail);
      } else {
        this.recordQualityDecision(quality, stage, staleArtifactDecision(stage), detail);
      }
      return false;
    };

    const reviewerStartedAt = Date.now();
    this.emitTrace(resolveAgentTraceEvent({
      kind: "synthesis-running",
      resultCount: synthesisResults.length,
      startedAt: reviewerStartedAt,
    }));

    let synthesisPrompt = buildSynthesisPrompt({
      prompt,
      model: this.model,
      reasoning: this.reasoning.effort,
      results: synthesisResults,
      ...(result.guardian ? { guardianSummary: result.guardian.summary } : {}),
      ...(quality ? { qualityReadOnly: true } : {}),
    });

    if (quality && completionArtifact && completionManifestHash) {
      if (!reviewPacketIsFresh("promote")) return this.terminateQuality(quality);
      const prePromoteManifest = quality.artifacts.captureWorkspaceManifest(qualityWritePaths(quality));
      if (prePromoteManifest.evidenceStatus === "unsupported") {
        completionEvidence = completionEvidence.filter((evidence) => evidence.kind !== "reviewer");
        this.recordUnsupportedOwnershipDecision(
          quality,
          "promote",
          prePromoteManifest.unsupportedEntries,
          {
            artifactHash: completionReviewPacket?.artifactHash ?? completionArtifact.artifactHash,
            evidenceRefs: [
              completionArtifact.path,
              ...(completionReviewPacket ? [completionReviewPacket.path] : []),
            ],
            independentVerification: false,
          },
        );
        return this.terminateQuality(quality);
      }
      if (prePromoteManifest.artifactHash !== completionManifestHash) {
        completionEvidence = completionEvidence.filter((evidence) => evidence.kind !== "reviewer");
        this.recordQualityDecision(quality, "promote", staleArtifactDecision("promote"), {
          artifactHash: completionReviewPacket?.artifactHash ?? completionArtifact.artifactHash,
          reviewedArtifactHash: completionReviewPacket?.artifactHash ?? completionManifestHash,
          currentArtifactHash: prePromoteManifest.artifactHash,
          stale: true,
          evidenceRefs: [
            completionArtifact.path,
            ...(completionReviewPacket ? [completionReviewPacket.path] : []),
          ],
          independentVerification: false,
        });
        return this.terminateQuality(quality);
      }
    }

    let promoteRoute: BalancedPrewalkRoute | undefined;
    if (quality) {
      promoteRoute = resolveBalancedPrewalkRoute({
        stage: "promote",
        directRoute: this.directRoute,
        ...(this.commodityRoute ? { commodityRoute: this.commodityRoute } : {}),
        ...(this.reviewAgent && this.reviewRoute ? { reviewRoute: this.reviewRoute } : {}),
        producerRoutes: currentProducerRoutes(quality),
      });
      synthesisPrompt = appendQualityContext(
        synthesisPrompt,
        await this.qualityContext(quality, "promote"),
      );
      this.emitQualityStage(
        quality,
        "promote",
        promoteRoute,
        `${quality.runId}:promote:${quality.iteration}`,
      );
    }

    const synthesis = quality
      ? await this.runReadOnlyQualityTurn(synthesisPrompt, turnSignal)
      : await this.runMainTurn(synthesisPrompt, [], turnOptions);
    const reviewerCompletedAt = Date.now();
    this.emitTrace(resolveAgentTraceEvent({
      kind: "synthesis-completed",
      resultCount: synthesisResults.length,
      startedAt: reviewerStartedAt,
      completedAt: reviewerCompletedAt,
    }));

    if (quality && completionArtifact && completionManifestHash) {
      if (!reviewPacketIsFresh("promote", promoteRoute)) return this.terminateQuality(quality);
      const postPromoteManifest = quality.artifacts.captureWorkspaceManifest(qualityWritePaths(quality));
      if (postPromoteManifest.evidenceStatus === "unsupported") {
        completionEvidence = completionEvidence.filter((evidence) => evidence.kind !== "reviewer");
        this.recordUnsupportedOwnershipDecision(
          quality,
          "promote",
          postPromoteManifest.unsupportedEntries,
          {
            artifactHash: completionReviewPacket?.artifactHash ?? completionArtifact.artifactHash,
            evidenceRefs: [
              completionArtifact.path,
              ...(completionReviewPacket ? [completionReviewPacket.path] : []),
            ],
            independentVerification: false,
            ...(promoteRoute ? { route: promoteRoute } : {}),
          },
        );
        return this.terminateQuality(quality);
      }
      if (postPromoteManifest.artifactHash !== completionManifestHash) {
        completionEvidence = completionEvidence.filter((evidence) => evidence.kind !== "reviewer");
        this.recordQualityDecision(quality, "promote", staleArtifactDecision("promote"), {
          artifactHash: completionReviewPacket?.artifactHash ?? completionArtifact.artifactHash,
          reviewedArtifactHash: completionReviewPacket?.artifactHash ?? completionManifestHash,
          currentArtifactHash: postPromoteManifest.artifactHash,
          stale: true,
          evidenceRefs: [
            completionArtifact.path,
            ...(completionReviewPacket ? [completionReviewPacket.path] : []),
          ],
          independentVerification: false,
          ...(promoteRoute ? { route: promoteRoute } : {}),
        });
        return this.terminateQuality(quality);
      }
    }

    if (quality && this.pluginHost && completionArtifact) {
      quality.completedStages.add("promote");
      if (quality.graph) {
        quality.graph = {
          ...quality.graph,
          currentStage: "promote",
          gateStatus: criticGateStatus,
        };
      }
      if (!reviewPacketIsFresh("promote", promoteRoute)) return this.terminateQuality(quality);
      const completionManifest = quality.artifacts.captureWorkspaceManifest(qualityWritePaths(quality));
      if (completionManifest.evidenceStatus === "unsupported") {
        completionEvidence = completionEvidence.filter((evidence) => evidence.kind !== "reviewer");
        this.recordUnsupportedOwnershipDecision(
          quality,
          "promote",
          completionManifest.unsupportedEntries,
          {
            artifactHash: completionReviewPacket?.artifactHash ?? completionArtifact.artifactHash,
            evidenceRefs: [
              completionArtifact.path,
              ...(completionReviewPacket ? [completionReviewPacket.path] : []),
            ],
            independentVerification: false,
            ...(promoteRoute ? { route: promoteRoute } : {}),
          },
        );
        return this.terminateQuality(quality);
      }
      if (completionManifest.artifactHash !== completionManifestHash) {
        completionEvidence = completionEvidence.filter((evidence) => evidence.kind !== "reviewer");
        this.recordQualityDecision(quality, "promote", staleArtifactDecision("promote"), {
          artifactHash: completionReviewPacket?.artifactHash ?? completionArtifact.artifactHash,
          reviewedArtifactHash: completionReviewPacket?.artifactHash ?? completionManifestHash,
          currentArtifactHash: completionManifest.artifactHash,
          stale: true,
          evidenceRefs: [
            completionArtifact.path,
            ...(completionReviewPacket ? [completionReviewPacket.path] : []),
          ],
          independentVerification: false,
          ...(promoteRoute ? { route: promoteRoute } : {}),
        });
        return this.terminateQuality(quality);
      }
      let creatorEvolution: Awaited<ReturnType<CreatorEvolutionService["run"]>> | undefined;
      if (quality.profile === "creator" && this.creatorEvolutionService) {
        try {
          creatorEvolution = await this.creatorEvolutionService.run({
            runId: quality.runId,
            workspaceRoot: this.workspaceRoot,
            prompt,
            creatorId: completionProducerId,
            mutableTargets: qualityWritePaths(quality),
            dispatchEvolutionProposed: (event) => this.pluginHost!.dispatchEvolutionProposed(event),
            signal: turnSignal,
          });
        } catch {
          // The built-in completion hook remains fail-closed when the injected
          // host cannot return a durable lifecycle result.
        }
        if (creatorEvolution?.recorded) {
          this.emitTrace({
            type: "evolution.proposed",
            level: "high-signal",
            runId: quality.runId,
            recorded: true,
            proposal: creatorEvolution.projection,
            startedAt: Date.parse(creatorEvolution.projection.createdAt),
          });
        }
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
      let completion = await this.pluginHost.dispatchBeforeRunComplete({
        runId: quality.runId,
        graph: quality.graph ?? createWorkGraph([], Date.now(), {
          graphId: quality.graphId,
          profile: quality.profile,
        }),
        projection,
        evidence: completionEvidence,
        currentArtifactHash: completionReviewPacket?.artifactHash ?? completionArtifact.artifactHash,
        producerId: completionProducerId,
        independentReviewerAvailable: criticIndependent,
        reviewRequired: quality.profile !== "minimal",
        ...(creatorEvolution === undefined
          ? {}
          : {
              evolution: {
                proposalId: creatorEvolution.projection.id,
                state: creatorEvolution.status,
                recorded: creatorEvolution.recorded,
                stale: creatorEvolution.projection.stale,
                ...(creatorEvolution.proposal === undefined ? {} : { proposal: creatorEvolution.proposal }),
                ...(creatorEvolution.context === undefined ? {} : { context: creatorEvolution.context }),
              },
            }),
      });
      if (creatorEvolution?.status === "pr-ready" && this.creatorEvolutionService) {
        try {
          const freshEvolution = await this.creatorEvolutionService.verifyFresh(creatorEvolution);
          if (freshEvolution !== creatorEvolution && freshEvolution.recorded) {
            this.emitTrace({
              type: "evolution.proposed",
              level: "high-signal",
              runId: quality.runId,
              recorded: true,
              proposal: freshEvolution.projection,
              startedAt: Date.parse(freshEvolution.projection.createdAt),
            });
          }
          creatorEvolution = freshEvolution;
          if (freshEvolution.status !== "pr-ready" || freshEvolution.projection.stale) {
            const failures = freshEvolution.projection.failures.length > 0
              ? freshEvolution.projection.failures
              : ["CREATOR_EVOLUTION_STALE"];
            completion = {
              action: "block",
              decisions: [{
                pluginName: "unclecode-evolution-runtime",
                action: "block",
                reason: "Creator evolution changed after completion validation.",
                failures,
              }],
              failures,
            };
          }
        } catch {
          const failures = ["CREATOR_EVOLUTION_FRESHNESS_FAILED"];
          completion = {
            action: "block",
            decisions: [{
              pluginName: "unclecode-evolution-runtime",
              action: "block",
              reason: "Creator evolution freshness could not be proven after completion validation.",
              failures,
            }],
            failures,
          };
        }
      }
      if (!reviewPacketIsFresh("promote", promoteRoute)) return this.terminateQuality(quality);
      const postCompletionManifest = quality.artifacts.captureWorkspaceManifest(
        qualityWritePaths(quality),
      );
      if (postCompletionManifest.evidenceStatus === "unsupported") {
        completionEvidence = completionEvidence.filter((evidence) => evidence.kind !== "reviewer");
        this.recordUnsupportedOwnershipDecision(
          quality,
          "promote",
          postCompletionManifest.unsupportedEntries,
          {
            artifactHash: completionReviewPacket?.artifactHash ?? completionArtifact.artifactHash,
            evidenceRefs: [
              completionArtifact.path,
              ...(completionReviewPacket ? [completionReviewPacket.path] : []),
            ],
            independentVerification: false,
            ...(promoteRoute ? { route: promoteRoute } : {}),
          },
        );
        return this.terminateQuality(quality);
      }
      if (postCompletionManifest.artifactHash !== completionManifestHash) {
        completionEvidence = completionEvidence.filter((evidence) => evidence.kind !== "reviewer");
        this.recordQualityDecision(quality, "promote", staleArtifactDecision("promote"), {
          artifactHash: completionReviewPacket?.artifactHash ?? completionArtifact.artifactHash,
          reviewedArtifactHash: completionReviewPacket?.artifactHash ?? completionManifestHash,
          currentArtifactHash: postCompletionManifest.artifactHash,
          stale: true,
          evidenceRefs: [
            completionArtifact.path,
            ...(completionReviewPacket ? [completionReviewPacket.path] : []),
          ],
          independentVerification: false,
          ...(promoteRoute ? { route: promoteRoute } : {}),
        });
        return this.terminateQuality(quality);
      }
      if (completion.action !== "proceed") {
        this.recordQualityDecision(quality, "promote", completion, {
          artifactHash: completionReviewPacket?.artifactHash ?? completionArtifact.artifactHash,
          evidenceRefs: [
            completionArtifact.path,
            ...(completionReviewPacket ? [completionReviewPacket.path] : []),
          ],
          independentVerification: criticIndependent,
          ...(promoteRoute ? { route: promoteRoute } : {}),
        });
      }
      if (quality.terminal) return this.terminateQuality(quality);
      if (quality.pendingIteration) {
        turnSignal.throwIfAborted();
        prepareNextQualityIteration();
        continue qualityIterationLoop;
      }
      const qualityStatus = completion.action === "proceed"
        ? criticGateStatus
        : completion.action;
      this.completeQuality(quality, qualityStatus, "promote", {
        evidenceRefs: [
          completionArtifact.path,
          ...(completionReviewPacket ? [completionReviewPacket.path] : []),
        ],
        failures: completion.failures,
        independentVerification: criticIndependent,
      });
      return { text: synthesis.text, qualityStatus };
    }

    return { text: synthesis.text };
    }
  }

  private async loadExecutableGuardianChecks(
    input: GuardianCheckRequest,
  ): Promise<LoadedGuardianChecks> {
    if (!this.runExecutableGuardianChecks) {
      return {
        summary: "No executable checks configured.",
        checks: [],
        status: "unproven",
        failures: ["EXECUTABLE_CHECKS_UNAVAILABLE"],
      };
    }

    try {
      const result = await this.runExecutableGuardianChecks(input);
      const checks = result.checks?.filter((check) =>
        typeof check.name === "string"
        && (check.status === "passed" || check.status === "failed")
        && typeof check.summary === "string") ?? [];
      if (!result.checks || checks.length !== result.checks.length || checks.length === 0) {
        return {
          summary: result.summary,
          checks,
          status: "unproven",
          failures: ["EXECUTABLE_CHECKS_UNPROVEN"],
        };
      }
      const failed = checks.some((check) => check.status === "failed");
      return {
        summary: result.summary,
        checks,
        status: failed ? "failed" : "passed",
        failures: failed ? ["EXECUTABLE_CHECK_FAILED"] : [],
      };
    } catch (error) {
      // A cancelled check has no verdict. Report the cancellation itself, not
      // whatever error raced it, and never degrade it into an "unavailable"
      // note the reviewer would read as a real result.
      input.signal?.throwIfAborted();
      return {
        summary: `Executable checks unavailable: ${error instanceof Error ? error.message : String(error)}`,
        checks: [],
        status: "unproven",
        failures: ["EXECUTABLE_CHECKS_UNAVAILABLE"],
      };
    }
  }

  /** Compatibility seam used by guardian diagnostics and shell bootstrap tests. */
  async loadExecutableGuardianSummary(
    input: GuardianCheckRequest,
  ): Promise<string | undefined> {
    if (!this.runExecutableGuardianChecks) return undefined;
    return (await this.loadExecutableGuardianChecks(input)).summary;
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

function projectPluginInvocationDiagnostic(
  diagnostic: PluginInvocationDiagnostic & { readonly source: "memory" | "workspace" | "cached" },
): PluginDiagnosticTraceEvent {
  const projection = createPluginDiagnosticProjection({
    runId: diagnostic.runId,
    source: diagnostic.source,
    trustLane: diagnostic.trustLane as "host-provided" | "workspace-trusted" | "cached-external",
    pluginId: diagnostic.pluginId,
    pluginName: diagnostic.pluginName,
    hookName: diagnostic.hookName,
    status: "error",
    errorName: diagnostic.errorName,
    errorMessage: diagnostic.errorMessage,
    ...(diagnostic.exitStatus ? { exitStatus: diagnostic.exitStatus } : {}),
    dedupeKey: `sha256:${createHash("sha256").update(diagnostic.dedupeKey).digest("hex")}`,
    startedAt: Date.now(),
  });
  return {
    type: "plugin.diagnostic",
    level: "high-signal",
    ...projection,
  };
}
