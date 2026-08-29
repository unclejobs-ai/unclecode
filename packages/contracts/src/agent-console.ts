import type {
  ContextPacketSourceCategory,
  ContextPacketView,
} from "./context-packet-view.js";

export const CONTEXT_PROFILE_IDS = ["build", "explore", "review"] as const;
export type ContextProfileId = (typeof CONTEXT_PROFILE_IDS)[number];

export const CONSOLE_MOTION_PREFERENCES = ["full", "reduced", "off"] as const;
export type ConsoleMotionPreference = (typeof CONSOLE_MOTION_PREFERENCES)[number];

export type ContextProfile = {
  readonly id: ContextProfileId;
  readonly label: string;
  readonly preferredSourceCategories: readonly ContextPacketSourceCategory[];
};

export type PromptManifestPolicySource = {
  readonly id: string;
  readonly label: string;
  readonly authority: "mandatory" | "profile-eligible";
  readonly digest: string;
};

export type PromptManifest = {
  readonly id: string;
  readonly profileId: ContextProfileId;
  readonly createdAt: string;
  readonly policy: readonly PromptManifestPolicySource[];
  readonly packet: ContextPacketView;
  readonly systemPromptAppendix: string;
  readonly userPrompt: string;
  readonly providerPrompt: string;
};

/** Metadata that is safe to write into a resume checkpoint. */
export type PersistedPromptManifest = {
  readonly id: string;
  readonly profileId: ContextProfileId;
  readonly createdAt: string;
  readonly packetId: string;
  readonly policy: readonly PromptManifestPolicySource[];
  readonly includedSourceCount: number;
  readonly excludedSourceCount: number;
  readonly tokenEstimate: number;
};

export type AskUserQuestionOption = {
  readonly label: string;
  readonly description?: string;
};

export type AskUserQuestion = {
  readonly id: string;
  readonly question: string;
  readonly options: readonly AskUserQuestionOption[];
  readonly multi?: boolean;
  readonly recommended?: number;
};

export type AskUserQuestionAnswer = {
  readonly id: string;
  readonly selectedOptions: readonly string[];
  readonly customInput?: string;
};

export type AskUserQuestionRequest = {
  readonly kind: "security-approval" | "user-decision";
  readonly id: string;
  readonly title?: string;
  readonly questions: readonly AskUserQuestion[];
};

export type PersistedSecurityApprovalRule = {
  readonly kind: "tool";
  readonly key: string;
};

export type AskUserQuestionResult =
  | { readonly status: "answered"; readonly answers: readonly AskUserQuestionAnswer[] }
  | { readonly status: "cancelled" }
  | { readonly status: "timed_out"; readonly answers: readonly AskUserQuestionAnswer[] }
  | { readonly status: "unavailable"; readonly reason: string };

/** Bounded, display-safe pending decision exposed by the Control Room API. */
export type ControlRoomPendingDecision = {
  readonly kind: "security-approval" | "user-decision";
  readonly id: string;
  readonly title?: string;
  readonly questions: readonly {
    readonly id: string;
    readonly question: string;
    readonly options: readonly {
      readonly label: string;
      readonly description?: string;
    }[];
    readonly multi?: boolean;
    readonly recommended?: number;
  }[];
};

/** Typed answer mutation for one exact Control Room user decision. */
export type ControlRoomDecisionPayload = {
  readonly decisionId: string;
  readonly answers: readonly AskUserQuestionAnswer[];
};

/** One-shot approval mutation bound to one exact security prompt instance. */
export type ControlRoomApprovalPayload = {
  readonly decision: "approve_once";
  readonly decisionId: string;
};

export const WORK_NODE_STATUSES = [
  "proposed",
  "approved",
  "ready",
  "running",
  "blocked",
  "requires_action",
  "completed",
  "failed",
  "cancelled",
] as const;
export type WorkNodeStatus = (typeof WORK_NODE_STATUSES)[number];

export const QUALITY_PROFILES = ["minimal", "standard", "deep", "creator"] as const;
export type QualityProfile = (typeof QUALITY_PROFILES)[number];

export const QUALITY_HARNESS_STAGES = ["explore", "plan", "work", "critic", "promote"] as const;
export type QualityHarnessStage = (typeof QUALITY_HARNESS_STAGES)[number];

export const QUALITY_GATE_STATUSES = ["proceed", "refine", "pivot", "block", "unproven"] as const;
export type QualityGateStatus = (typeof QUALITY_GATE_STATUSES)[number];

export const WORK_NODE_ROLES = ["explorer", "planner", "worker", "critic", "promoter"] as const;
export type WorkNodeRole = (typeof WORK_NODE_ROLES)[number];

export type WorkNode = {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly status: WorkNodeStatus;
  readonly dependsOn: readonly string[];
  readonly fileOwnership: readonly string[];
  readonly manifestId?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly stage: QualityHarnessStage;
  readonly role: WorkNodeRole;
  readonly attempt: number;
  readonly artifactRefs: readonly string[];
  readonly reviewRequired: boolean;
};

export type WorkGraph = {
  readonly id: string;
  readonly goal?: string;
  readonly constraints?: readonly string[];
  readonly qualityProfile: QualityProfile;
  readonly currentStage: QualityHarnessStage;
  readonly gateStatus: QualityGateStatus;
  readonly iteration: number;
  readonly nodes: readonly WorkNode[];
  readonly approval: "pending" | "approved" | "rejected";
};

export const MAX_QUALITY_REVIEW_HISTORY = 32;

export type QualityReviewHistoryEntry = {
  readonly event: "gate" | "refine" | "pivot" | "completed";
  readonly stage: QualityHarnessStage;
  readonly decision: QualityGateStatus;
  readonly iteration: number;
  readonly reason?: string;
  readonly failures: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly artifactHash?: string;
  readonly reviewedArtifactHash?: string;
  readonly currentArtifactHash?: string;
  readonly reviewerId?: string;
  readonly reviewerRunId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly route?: "direct" | "frontier" | "commodity" | "fallback";
  readonly count?: number;
  readonly limit?: number;
  readonly independentVerification: boolean;
  readonly stale: boolean;
  readonly startedAt: number;
};

export type QualityReviewProjection = {
  readonly runId: string;
  readonly graphId: string;
  /** Current lifecycle state, including graph-less minimal turns. */
  readonly profile?: QualityProfile;
  readonly currentStage?: QualityHarnessStage;
  readonly iteration?: number;
  readonly refineCount: number;
  readonly pivotCount: number;
  readonly latestDecision: QualityGateStatus;
  readonly history: readonly QualityReviewHistoryEntry[];
};

export const MAX_EVOLUTION_PROPOSALS = 32;

export type EvolutionCleanupResourceProjection = {
  readonly kind: "branch" | "worktree" | "baseline-worktree";
  readonly identity: string;
  readonly status: "removed" | "retained" | "cleanup-failed";
};

export type EvolutionCleanupProjection = {
  readonly status: "completed" | "retained" | "failed";
  readonly resources: readonly EvolutionCleanupResourceProjection[];
  readonly summary?: string;
};

/**
 * Bounded, content-free projection of a host-recorded evolution candidate.
 * Candidate file bodies and evaluator output are artifact-owned and never
 * enter a console snapshot.
 */
export type EvolutionProposalProjection = {
  readonly id: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly creatorId: string;
  readonly evaluatorId: string;
  readonly attestorId: string;
  readonly state: "pr-ready" | "rejected" | "failed" | "cancelled" | "stale";
  readonly isolation: "worktree";
  readonly isolatedBranch?: string;
  readonly isolatedWorktree?: string;
  readonly heldOutBenchmark: boolean;
  readonly heldOutBenchmarkId: string;
  readonly humanApproval: "pending";
  readonly mergeRequiresHumanApproval: true;
  readonly stale: boolean;
  readonly changedAssets: readonly { readonly path: string; readonly sha256: string }[];
  readonly hashes: {
    readonly baseCommit?: string;
    readonly candidateCommit?: string;
    readonly patch?: string;
    readonly candidateArtifact?: string;
    readonly evaluator: string;
    readonly evaluatorEnvironment: string;
    readonly policy: string;
    readonly suite: string;
    readonly baselineResult?: string;
    readonly candidateResult?: string;
  };
  readonly comparison?: {
    readonly baselineScore: number;
    readonly candidateScore: number;
    readonly delta: number;
    readonly passed: boolean;
    readonly thresholdsHash: string;
  };
  readonly attestation?: {
    readonly timestamp: string;
    readonly maxAgeMs: number;
    readonly branchExists: boolean;
    readonly worktreeExists: boolean;
  };
  readonly cleanup: EvolutionCleanupProjection;
  readonly failures: readonly string[];
  readonly summary: string;
  readonly artifactRefs: readonly string[];
  readonly createdAt: string;
};

export type WorkNodeDispatchOutcome = {
  readonly nodeId: string;
  readonly status: Extract<WorkNodeStatus, "completed" | "failed" | "cancelled" | "blocked">;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
};

export const TOOL_ACTIVITY_KINDS = [
  "read",
  "search",
  "write",
  "delete",
  "execute",
  "interaction",
  "other",
] as const;
export type ToolActivityKind = (typeof TOOL_ACTIVITY_KINDS)[number];

export const TOOL_ACTIVITY_STATUSES = ["running", "completed", "failed", "cancelled"] as const;
export type ToolActivityStatus = (typeof TOOL_ACTIVITY_STATUSES)[number];

/**
 * Largest preview a snapshot will carry. Raw tool output is still excluded —
 * this is a bounded excerpt so a console snapshot cannot grow with the size of
 * a file a tool happened to print.
 */
export const MAX_TOOL_ACTIVITY_PREVIEW_CHARS = 4_000;

/** Deliberately excludes raw tool output so console snapshots are resume-safe. */
export type ToolActivity = {
  readonly id: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly kind: ToolActivityKind;
  readonly intent: string;
  readonly status: ToolActivityStatus;
  readonly target?: string;
  readonly summary?: string;
  /**
   * Bounded excerpt of what the tool changed — a unified diff for write and
   * patch tools. Present so the console can show the change itself rather than
   * only "completed · 12ms"; capped at MAX_TOOL_ACTIVITY_PREVIEW_CHARS so the
   * snapshot stays resume-safe.
   */
  readonly preview?: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  /** Set when the tool ran inside a subagent so the inspector can scope rows. */
  readonly agentRunId?: string;
};

/** Clamp a preview to the snapshot budget, marking it when truncated. */
export function boundToolActivityPreview(preview: string): string {
  const normalized = preview.replace(/\s+$/, "");
  if (normalized.length <= MAX_TOOL_ACTIVITY_PREVIEW_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TOOL_ACTIVITY_PREVIEW_CHARS)}\n… preview truncated`;
}

/**
 * Largest lifecycle summary a snapshot will carry. Agent and job summaries are
 * operator-facing prose, so they are clamped instead of persisting whatever a
 * worker happened to return.
 */
export const MAX_LIFECYCLE_SUMMARY_CHARS = 400;

const LIFECYCLE_SUMMARY_TRUNCATION_MARKER = " … summary truncated";

/**
 * Clamp a lifecycle summary to the snapshot budget, marking it when truncated.
 * The marker is charged against the budget, so the result never exceeds
 * `MAX_LIFECYCLE_SUMMARY_CHARS`.
 */
export function boundLifecycleSummary(summary: string): string {
  const normalized = summary.replace(/\s+$/, "");
  if (normalized.length <= MAX_LIFECYCLE_SUMMARY_CHARS) {
    return normalized;
  }
  const kept = normalized.slice(
    0,
    MAX_LIFECYCLE_SUMMARY_CHARS - LIFECYCLE_SUMMARY_TRUNCATION_MARKER.length,
  );
  return `${kept}${LIFECYCLE_SUMMARY_TRUNCATION_MARKER}`;
}

export const AGENT_RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export type TerminalAgentRunStatus = Extract<
  AgentRunStatus,
  "completed" | "failed" | "cancelled" | "interrupted"
>;

export const ASYNC_JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type AsyncJobStatus = (typeof ASYNC_JOB_STATUSES)[number];

export type TerminalAsyncJobStatus = Extract<
  AsyncJobStatus,
  "completed" | "failed" | "cancelled" | "interrupted"
>;

/**
 * Materialized usage totals. Legacy checkpoints may still carry `eventIds`;
 * parsers validate those arrays for migration and always remove them from the
 * returned projection. Exact replay identity belongs to the runtime ledger.
 */
export type AgentRunUsageRoute = {
  readonly provider: string;
  readonly model: string;
  /** @deprecated Accepted as legacy input only; never emitted in a snapshot. */
  readonly eventIds?: readonly string[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheSavingsUsd?: number;
  readonly costUsd?: number;
};

export type AgentRunUsage = {
  /** @deprecated Accepted as legacy input only; never emitted in a snapshot. */
  readonly eventIds?: readonly string[];
  /** Uncached input; cache reads and writes are tracked in their own buckets. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheSavingsUsd?: number;
  readonly costUsd?: number;
  readonly routes?: readonly AgentRunUsageRoute[];
};

export type AgentUsageRouteTotals = Omit<AgentRunUsageRoute, "eventIds">;
export type AgentUsageTotals = Omit<AgentRunUsage, "eventIds" | "routes"> & {
  readonly routes?: readonly AgentUsageRouteTotals[];
};

/**
 * Safe projection of one agent run. Deliberately excludes the worker system
 * prompt, raw assignment text, and provider frames; `transcriptRef` points at
 * the filtered transcript instead of inlining it.
 */
export type AgentRun = {
  readonly id: string;
  readonly displayName: string;
  readonly agentType: string;
  readonly status: AgentRunStatus;
  readonly currentActivity?: string;
  readonly parentRunId?: string;
  readonly continuationOf?: string;
  readonly transcriptRef?: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly summary?: string;
  readonly errorSummary?: string;
  readonly usage?: AgentRunUsage;
};

/** Background unit of work; at most one owning agent run. */
export type AsyncJob = {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly status: AsyncJobStatus;
  readonly agentRunId?: string;
  readonly queuedAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly summary?: string;
  readonly errorSummary?: string;
};

export const AGENT_CONTROL_RECEIPT_STATUSES = [
  "accepted",
  "not_delivered",
  "rejected",
] as const;
export type AgentControlReceiptStatus = (typeof AGENT_CONTROL_RECEIPT_STATUSES)[number];

export type AgentControlReceipt = {
  readonly status: AgentControlReceiptStatus;
  readonly message: string;
};

/**
 * Operator control surface for a running agent.
 *
 * - `steer` appends to a per-agent FIFO mailbox delivered at the next safe
 *   boundary; it never mutates an in-flight tool call, and a steer that
 *   arrives after settlement resolves `not_delivered` rather than vanishing.
 * - `cancel` aborts the agent runtime and its owned active job.
 * - `continue` starts a new run carrying prior lineage; it does not resurrect
 *   a disposed provider session.
 */
export type AgentControlPort = {
  steer(agentRunId: string, message: string): Promise<AgentControlReceipt>;
  cancel(agentRunId: string): Promise<AgentControlReceipt>;
  continue(agentRunId: string, message?: string): Promise<AgentControlReceipt>;
};

export const AGENT_CONSOLE_TABS = ["agents", "jobs", "plan"] as const;
export type AgentConsoleTab = (typeof AGENT_CONSOLE_TABS)[number];

/** Bounded, redacted diagnostic safe for traces, checkpoints, and operator projections. */
export type PluginDiagnosticProjection = {
  readonly runId: string;
  readonly source: "memory" | "workspace" | "cached";
  readonly trustLane: "host-provided" | "workspace-trusted" | "cached-external";
  readonly pluginId: string;
  readonly pluginName: string;
  readonly hookName: string;
  readonly status: "error";
  readonly errorName: string;
  readonly errorMessage: string;
  readonly exitStatus?: string | undefined;
  readonly dedupeKey: string;
  readonly startedAt: number;
};

export type AgentConsoleSnapshot = {
  readonly profileId: ContextProfileId;
  readonly securityApprovals?: readonly PersistedSecurityApprovalRule[];
  readonly manifest?: PersistedPromptManifest;
  readonly pendingDecision?: AskUserQuestionRequest;
  readonly workGraph?: WorkGraph;
  readonly qualityReview?: QualityReviewProjection;
  readonly evolutionProposals?: readonly EvolutionProposalProjection[];
  readonly pluginDiagnostics?: readonly PluginDiagnosticProjection[];
  readonly activity: readonly ToolActivity[];
  readonly agents: readonly AgentRun[];
  readonly jobs: readonly AsyncJob[];
  readonly mainUsage?: AgentRunUsage;
  /** Owner-materialized lifetime session total; contains no replay identity. */
  readonly totalUsage?: AgentUsageTotals;
};

export type AgentConsoleJournalEvent =
  | { readonly type: "context.manifested"; readonly manifest: PersistedPromptManifest }
  | { readonly type: "decision.opened"; readonly request: AskUserQuestionRequest }
  | { readonly type: "decision.resolved"; readonly requestId: string; readonly result: AskUserQuestionResult }
  | { readonly type: "work.proposed"; readonly graph: WorkGraph }
  | { readonly type: "work.approved"; readonly graphId: string }
  | { readonly type: "work.status"; readonly graphId: string; readonly nodeId: string; readonly status: WorkNodeStatus }
  | { readonly type: "activity.upserted"; readonly activity: ToolActivity };

export function isAskUserQuestionAnswered(
  result: AskUserQuestionResult,
): result is Extract<AskUserQuestionResult, { readonly status: "answered" }> {
  return result.status === "answered";
}

export function isWorkGraphDispatchable(graph: WorkGraph): boolean {
  return graph.approval === "approved" && graph.nodes.some((node) => node.status === "ready");
}

export function isCoalescibleToolActivity(activity: ToolActivity): boolean {
  return activity.status === "completed" && (activity.kind === "read" || activity.kind === "search");
}

/**
 * Drops any undeclared runtime fields (notably raw tool output) before a
 * console projection crosses the persistence boundary.
 */
export function createAgentConsoleSnapshot(
  input: Omit<AgentConsoleSnapshot, "agents" | "jobs"> &
    Partial<Pick<AgentConsoleSnapshot, "agents" | "jobs">>,
): AgentConsoleSnapshot {
  return {
    profileId: input.profileId,
    ...(input.securityApprovals && input.securityApprovals.length > 0
      ? { securityApprovals: copySecurityApprovalRules(input.securityApprovals) }
      : {}),
    ...(input.manifest ? { manifest: copyPersistedPromptManifest(input.manifest) } : {}),
    ...(input.pendingDecision
      ? { pendingDecision: copyAskUserQuestionRequest(input.pendingDecision) }
      : {}),
    ...(input.workGraph ? { workGraph: copyWorkGraph(input.workGraph) } : {}),
    ...(input.qualityReview ? { qualityReview: copyQualityReview(input.qualityReview) } : {}),
    ...(input.evolutionProposals && input.evolutionProposals.length > 0
      ? { evolutionProposals: input.evolutionProposals.slice(-MAX_EVOLUTION_PROPOSALS).map(copyEvolutionProposal) }
      : {}),
    ...(input.pluginDiagnostics && input.pluginDiagnostics.length > 0
      ? { pluginDiagnostics: input.pluginDiagnostics.slice(-MAX_PERSISTED_PLUGIN_DIAGNOSTICS).map(copyPluginDiagnostic) }
      : {}),
    activity: input.activity.map((activity) => ({
      id: activity.id,
      toolCallId: activity.toolCallId,
      toolName: activity.toolName,
      kind: activity.kind,
      intent: activity.intent,
      status: activity.status,
      ...(activity.target === undefined ? {} : { target: activity.target }),
      ...(activity.summary === undefined ? {} : { summary: activity.summary }),
      ...(activity.preview === undefined
        ? {}
        : { preview: boundToolActivityPreview(activity.preview) }),
      startedAt: activity.startedAt,
      ...(activity.completedAt === undefined ? {} : { completedAt: activity.completedAt }),
      ...(activity.agentRunId === undefined ? {} : { agentRunId: activity.agentRunId }),
    })),
    // A snapshot written before the lifecycle projection existed carries
    // neither array; treat that as empty rather than throwing on resume.
    agents: boundLifecycleRecords(input.agents ?? [], MAX_PERSISTED_AGENT_RUNS, isActiveAgentRun)
      .map(copyAgentRun),
    jobs: boundLifecycleRecords(input.jobs ?? [], MAX_PERSISTED_ASYNC_JOBS, isActiveAsyncJob)
      .map(copyAsyncJob),
    ...(input.mainUsage ? { mainUsage: copyAgentRunUsage(input.mainUsage) } : {}),
    ...(input.totalUsage ? { totalUsage: copyAgentUsageTotals(input.totalUsage) } : {}),
  };
}

/**
 * One definition of "still live", shared by the snapshot factory, the resume
 * parser, and resume normalization. The three have to agree exactly: a record
 * one of them counts as history and another counts as live would be trimmed
 * away while still running, or resurrected on resume.
 */
function isActiveAgentRun(run: AgentRun): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "waiting";
}

function isActiveAsyncJob(job: AsyncJob): boolean {
  return job.status === "queued" || job.status === "running";
}

/**
 * Bound a lifecycle projection without losing work that is still live.
 *
 * The cap exists so settled history cannot grow with session length, so
 * history is what pays for it: the oldest settled records are discarded first
 * and every active record is kept, because a run or job the operator can still
 * steer, cancel, or resume has to stay addressable. Relative order is
 * preserved, so the console renders the sequence it persisted.
 *
 * When active records alone exceed the cap the list overflows rather than
 * erasing live work. The producer caps concurrency; an overflow here is a
 * visible symptom instead of an agent that silently disappeared.
 */
function boundLifecycleRecords<T>(
  records: readonly T[],
  limit: number,
  isActive: (record: T) => boolean,
): readonly T[] {
  if (records.length <= limit) {
    return records;
  }
  let discardable = records.length - limit;
  const retained: T[] = [];
  for (const record of records) {
    if (discardable > 0 && !isActive(record)) {
      discardable -= 1;
      continue;
    }
    retained.push(record);
  }
  return retained;
}

function copyPersistedPromptManifest(manifest: PersistedPromptManifest): PersistedPromptManifest {
  return {
    id: manifest.id,
    profileId: manifest.profileId,
    createdAt: manifest.createdAt,
    packetId: manifest.packetId,
    policy: manifest.policy.map((source) => ({
      id: source.id,
      label: source.label,
      authority: source.authority,
      digest: source.digest,
    })),
    includedSourceCount: manifest.includedSourceCount,
    excludedSourceCount: manifest.excludedSourceCount,
    tokenEstimate: manifest.tokenEstimate,
  };
}

function copyAskUserQuestionRequest(request: AskUserQuestionRequest): AskUserQuestionRequest {
  return {
    kind: request.kind ?? "user-decision",
    id: request.id,
    ...(request.title === undefined ? {} : { title: request.title }),
    questions: request.questions.map((question) => ({
      id: question.id,
      question: question.question,
      options: question.options.map((option) => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
      ...(question.multi === undefined ? {} : { multi: question.multi }),
      ...(question.recommended === undefined ? {} : { recommended: question.recommended }),
    })),
  };
}

function copySecurityApprovalRules(
  rules: readonly PersistedSecurityApprovalRule[],
): readonly PersistedSecurityApprovalRule[] {
  const unique = new Map<string, PersistedSecurityApprovalRule>();
  for (const rule of rules) {
    if (rule.kind === "tool" && isSafePermissionRuleKey(rule.key)) {
      unique.set(rule.key, { kind: "tool", key: rule.key });
    }
  }
  return [...unique.values()];
}

function isSafePermissionRuleKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function copyWorkGraph(graph: WorkGraph): WorkGraph {
  return {
    id: graph.id,
    ...(graph.goal === undefined ? {} : { goal: graph.goal }),
    ...(graph.constraints === undefined ? {} : { constraints: [...graph.constraints] }),
    qualityProfile: graph.qualityProfile ?? "minimal",
    currentStage: graph.currentStage ?? "work",
    gateStatus: graph.gateStatus ?? "unproven",
    iteration: graph.iteration ?? 0,
    approval: graph.approval,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      prompt: node.prompt,
      status: node.status,
      dependsOn: [...node.dependsOn],
      fileOwnership: [...node.fileOwnership],
      ...(node.manifestId === undefined ? {} : { manifestId: node.manifestId }),
      acceptanceCriteria: [...(node.acceptanceCriteria ?? [])],
      evidenceRefs: [...node.evidenceRefs],
      stage: node.stage ?? "work",
      role: node.role ?? "worker",
      attempt: node.attempt ?? 0,
      artifactRefs: [...(node.artifactRefs ?? [])],
      reviewRequired: node.reviewRequired ?? false,
    })),
  };
}

function copyQualityReview(projection: QualityReviewProjection): QualityReviewProjection {
  return {
    runId: projection.runId.slice(0, 256),
    graphId: projection.graphId.slice(0, 256),
    ...(projection.profile === undefined ? {} : { profile: projection.profile }),
    ...(projection.currentStage === undefined ? {} : { currentStage: projection.currentStage }),
    ...(projection.iteration === undefined ? {} : { iteration: projection.iteration }),
    refineCount: projection.refineCount,
    pivotCount: projection.pivotCount,
    latestDecision: projection.latestDecision,
    history: projection.history.slice(-MAX_QUALITY_REVIEW_HISTORY).map((entry) => ({
      event: entry.event,
      stage: entry.stage,
      decision: entry.decision,
      iteration: entry.iteration,
      ...(entry.reason === undefined ? {} : { reason: entry.reason.slice(0, 2_000) }),
      failures: entry.failures.slice(0, 32).map((failure) => failure.slice(0, 500)),
      evidenceRefs: entry.evidenceRefs.slice(0, 64).map((reference) => reference.slice(0, 1_000)),
      artifactRefs: entry.artifactRefs.slice(0, 64).map((reference) => reference.slice(0, 1_000)),
      ...(entry.artifactHash === undefined ? {} : { artifactHash: entry.artifactHash.slice(0, 256) }),
      ...(entry.reviewedArtifactHash === undefined
        ? {}
        : { reviewedArtifactHash: entry.reviewedArtifactHash.slice(0, 256) }),
      ...(entry.currentArtifactHash === undefined
        ? {}
        : { currentArtifactHash: entry.currentArtifactHash.slice(0, 256) }),
      ...(entry.reviewerId === undefined ? {} : { reviewerId: entry.reviewerId.slice(0, 256) }),
      ...(entry.reviewerRunId === undefined
        ? {}
        : { reviewerRunId: entry.reviewerRunId.slice(0, 256) }),
      ...(entry.provider === undefined ? {} : { provider: entry.provider.slice(0, 128) }),
      ...(entry.model === undefined ? {} : { model: entry.model.slice(0, 256) }),
      ...(entry.route === undefined ? {} : { route: entry.route }),
      ...(entry.count === undefined ? {} : { count: entry.count }),
      ...(entry.limit === undefined ? {} : { limit: entry.limit }),
      independentVerification: entry.independentVerification,
      stale: entry.stale,
      startedAt: entry.startedAt,
    })),
  };
}

function copyEvolutionProposal(proposal: EvolutionProposalProjection): EvolutionProposalProjection {
  return {
    id: proposal.id.slice(0, 256),
    runId: proposal.runId.slice(0, 256),
    candidateId: proposal.candidateId.slice(0, 256),
    creatorId: proposal.creatorId.slice(0, 256),
    evaluatorId: proposal.evaluatorId.slice(0, 256),
    attestorId: proposal.attestorId.slice(0, 256),
    state: proposal.state,
    isolation: "worktree",
    ...(proposal.isolatedBranch === undefined
      ? {}
      : { isolatedBranch: proposal.isolatedBranch.slice(0, 512) }),
    ...(proposal.isolatedWorktree === undefined
      ? {}
      : { isolatedWorktree: proposal.isolatedWorktree.slice(0, 1_000) }),
    heldOutBenchmark: proposal.heldOutBenchmark,
    heldOutBenchmarkId: proposal.heldOutBenchmarkId.slice(0, 256),
    humanApproval: "pending",
    mergeRequiresHumanApproval: true,
    stale: proposal.stale,
    changedAssets: proposal.changedAssets.slice(0, 128).map((entry) => ({
      path: entry.path.slice(0, 1_000),
      sha256: entry.sha256.slice(0, 80),
    })),
    hashes: {
      ...(proposal.hashes.baseCommit === undefined ? {} : { baseCommit: proposal.hashes.baseCommit.slice(0, 80) }),
      ...(proposal.hashes.candidateCommit === undefined
        ? {}
        : { candidateCommit: proposal.hashes.candidateCommit.slice(0, 80) }),
      ...(proposal.hashes.patch === undefined ? {} : { patch: proposal.hashes.patch.slice(0, 80) }),
      ...(proposal.hashes.candidateArtifact === undefined
        ? {}
        : { candidateArtifact: proposal.hashes.candidateArtifact.slice(0, 80) }),
      evaluator: proposal.hashes.evaluator.slice(0, 80),
      evaluatorEnvironment: proposal.hashes.evaluatorEnvironment.slice(0, 80),
      policy: proposal.hashes.policy.slice(0, 80),
      suite: proposal.hashes.suite.slice(0, 80),
      ...(proposal.hashes.baselineResult === undefined
        ? {}
        : { baselineResult: proposal.hashes.baselineResult.slice(0, 80) }),
      ...(proposal.hashes.candidateResult === undefined
        ? {}
        : { candidateResult: proposal.hashes.candidateResult.slice(0, 80) }),
    },
    ...(proposal.comparison === undefined
      ? {}
      : {
          comparison: {
            baselineScore: proposal.comparison.baselineScore,
            candidateScore: proposal.comparison.candidateScore,
            delta: proposal.comparison.delta,
            passed: proposal.comparison.passed,
            thresholdsHash: proposal.comparison.thresholdsHash.slice(0, 80),
          },
        }),
    ...(proposal.attestation === undefined
      ? {}
      : {
          attestation: {
            timestamp: proposal.attestation.timestamp.slice(0, 80),
            maxAgeMs: proposal.attestation.maxAgeMs,
            branchExists: proposal.attestation.branchExists,
            worktreeExists: proposal.attestation.worktreeExists,
          },
        }),
    cleanup: {
      status: proposal.cleanup.status,
      resources: proposal.cleanup.resources.slice(0, 16).map((resource) => ({
        kind: resource.kind,
        identity: resource.identity.slice(0, 1_000),
        status: resource.status,
      })),
      ...(proposal.cleanup.summary === undefined
        ? {}
        : { summary: proposal.cleanup.summary.slice(0, 512) }),
    },
    failures: proposal.failures.slice(0, 32).map((failure) => failure.slice(0, 256)),
    summary: proposal.summary.slice(0, 512),
    artifactRefs: proposal.artifactRefs.slice(0, 32).map((reference) => reference.slice(0, 1_000)),
    createdAt: proposal.createdAt.slice(0, 80),
  };
}

/** Fixed, bounded summary for a tool call resume can no longer settle. */
const INTERRUPTED_TOOL_ACTIVITY_SUMMARY = "cancelled · interrupted before the tool reported";

/**
 * Resume normalization: a run or job that was active when the process died
 * cannot be reattached, so it settles as `interrupted` instead of rendering a
 * phantom running count, and it drops the tool label it was working through
 * because nothing is in flight any more. A tool call that never reported is
 * cancelled for the same reason — no completion will ever arrive for it.
 * Settled records are left exactly as persisted, and the caller's snapshot is
 * never mutated.
 */
export function markUnrecoverableAgentConsoleWorkInterrupted(
  snapshot: AgentConsoleSnapshot,
  now = Date.now(),
): AgentConsoleSnapshot {
  let changed = false;
  const agents = (snapshot.agents ?? []).map((agent) => {
    if (!isActiveAgentRun(agent)) {
      return agent;
    }
    changed = true;
    const { currentActivity, ...settled } = agent;
    return { ...settled, status: "interrupted" as const, completedAt: now };
  });
  const jobs = (snapshot.jobs ?? []).map((job) => {
    if (!isActiveAsyncJob(job)) {
      return job;
    }
    changed = true;
    return { ...job, status: "interrupted" as const, completedAt: now };
  });
  const activity = snapshot.activity.map((entry) => {
    if (entry.status !== "running") {
      return entry;
    }
    changed = true;
    return {
      ...entry,
      status: "cancelled" as const,
      summary: INTERRUPTED_TOOL_ACTIVITY_SUMMARY,
      completedAt: now,
    };
  });

  if (!changed) {
    return snapshot;
  }
  return createAgentConsoleSnapshot({ ...snapshot, activity, agents, jobs });
}

function copyAgentRun(run: AgentRun): AgentRun {
  return {
    id: run.id,
    displayName: run.displayName,
    agentType: run.agentType,
    status: run.status,
    ...(run.currentActivity === undefined ? {} : { currentActivity: run.currentActivity }),
    ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
    ...(run.continuationOf === undefined ? {} : { continuationOf: run.continuationOf }),
    ...(run.transcriptRef === undefined ? {} : { transcriptRef: run.transcriptRef }),
    startedAt: run.startedAt,
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    ...(run.summary === undefined ? {} : { summary: boundLifecycleSummary(run.summary) }),
    ...(run.errorSummary === undefined
      ? {}
      : { errorSummary: boundLifecycleSummary(run.errorSummary) }),
    ...(run.usage === undefined ? {} : { usage: copyAgentRunUsage(run.usage) }),
  };
}

function copyAsyncJob(job: AsyncJob): AsyncJob {
  return {
    id: job.id,
    type: job.type,
    label: job.label,
    status: job.status,
    ...(job.agentRunId === undefined ? {} : { agentRunId: job.agentRunId }),
    queuedAt: job.queuedAt,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
    ...(job.summary === undefined ? {} : { summary: boundLifecycleSummary(job.summary) }),
    ...(job.errorSummary === undefined
      ? {}
      : { errorSummary: boundLifecycleSummary(job.errorSummary) }),
  };
}
function copyAgentRunUsageRoute(route: AgentRunUsageRoute): AgentRunUsageRoute {
  return {
    provider: route.provider,
    model: route.model,
    ...(route.inputTokens === undefined ? {} : { inputTokens: route.inputTokens }),
    ...(route.outputTokens === undefined ? {} : { outputTokens: route.outputTokens }),
    ...(route.cacheReadTokens === undefined ? {} : { cacheReadTokens: route.cacheReadTokens }),
    ...(route.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: route.cacheWriteTokens }),
    ...(route.cacheSavingsUsd === undefined ? {} : { cacheSavingsUsd: route.cacheSavingsUsd }),
    ...(route.costUsd === undefined ? {} : { costUsd: route.costUsd }),
  };
}


function copyAgentRunUsage(usage: AgentRunUsage): AgentRunUsage {
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.cacheSavingsUsd === undefined ? {} : { cacheSavingsUsd: usage.cacheSavingsUsd }),
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
    ...(usage.routes === undefined ? {} : { routes: usage.routes.map(copyAgentRunUsageRoute) }),
  };
}

function copyAgentUsageTotals(usage: AgentUsageTotals): AgentUsageTotals {
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.cacheSavingsUsd === undefined ? {} : { cacheSavingsUsd: usage.cacheSavingsUsd }),
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
    ...(usage.routes === undefined
      ? {}
      : {
          routes: usage.routes.map((route) => ({
            provider: route.provider,
            model: route.model,
            ...(route.inputTokens === undefined ? {} : { inputTokens: route.inputTokens }),
            ...(route.outputTokens === undefined ? {} : { outputTokens: route.outputTokens }),
            ...(route.cacheReadTokens === undefined
              ? {}
              : { cacheReadTokens: route.cacheReadTokens }),
            ...(route.cacheWriteTokens === undefined
              ? {}
              : { cacheWriteTokens: route.cacheWriteTokens }),
            ...(route.cacheSavingsUsd === undefined
              ? {}
              : { cacheSavingsUsd: route.cacheSavingsUsd }),
            ...(route.costUsd === undefined ? {} : { costUsd: route.costUsd }),
          })),
        }),
  };
}

const MAX_PERSISTED_TOOL_ACTIVITY = 80;
const MAX_PERSISTED_PLUGIN_DIAGNOSTICS = 64;
export const MAX_PLUGIN_DIAGNOSTIC_FIELD_CHARS = 240;
const PLUGIN_DIAGNOSTIC_DEDUPE_KEY = /^sha256:[a-f0-9]{64}$/;
const PLUGIN_DIAGNOSTIC_TRUST_BY_SOURCE = {
  memory: "host-provided",
  workspace: "workspace-trusted",
  cached: "cached-external",
} as const;
const PLUGIN_DIAGNOSTIC_SECRET_PATTERNS = [
  /\bBearer\s+[^\s,;]+/gi,
  /\b(?:sk|ghp|xoxb)-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi,
] as const;
const PLUGIN_DIAGNOSTIC_PATH_PATTERN = /(^|[\s([{"'=])(?:\.{1,2}\/|\/|[A-Za-z]:\\)[^\s,;)\]}"']+/g;
const WORK_NODE_STATUS_SET = new Set<string>(WORK_NODE_STATUSES);
const QUALITY_PROFILE_SET = new Set<string>(QUALITY_PROFILES);
const QUALITY_HARNESS_STAGE_SET = new Set<string>(QUALITY_HARNESS_STAGES);
const QUALITY_GATE_STATUS_SET = new Set<string>(QUALITY_GATE_STATUSES);
const WORK_NODE_ROLE_SET = new Set<string>(WORK_NODE_ROLES);
const TOOL_ACTIVITY_KIND_SET = new Set<string>(TOOL_ACTIVITY_KINDS);
const TOOL_ACTIVITY_STATUS_SET = new Set<string>(TOOL_ACTIVITY_STATUSES);
const MAX_PERSISTED_AGENT_RUNS = 128;
const MAX_PERSISTED_ASYNC_JOBS = 128;
const AGENT_RUN_STATUS_SET = new Set<string>(AGENT_RUN_STATUSES);
const ASYNC_JOB_STATUS_SET = new Set<string>(ASYNC_JOB_STATUSES);
const EVOLUTION_STATE_SET = new Set(["pr-ready", "rejected", "failed", "cancelled", "stale"] as const);
const EVOLUTION_CLEANUP_STATUS_SET = new Set(["completed", "retained", "failed"] as const);
const EVOLUTION_RESOURCE_KIND_SET = new Set(["branch", "worktree", "baseline-worktree"] as const);
const EVOLUTION_RESOURCE_STATUS_SET = new Set(["removed", "retained", "cleanup-failed"] as const);
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

/**
 * Validates the durable console projection at the resume boundary. The parser
 * deliberately reconstructs known fields, so raw tool output and future
 * runtime-only fields cannot cross that boundary by accident.
 */
export function parseAgentConsoleSnapshot(value: unknown): AgentConsoleSnapshot | undefined {
  const record = asRecord(value);
  if (!record || !isContextProfileId(record.profileId)) {
    return undefined;
  }

  const manifest = hasOwn(record, "manifest") ? parsePersistedPromptManifest(record.manifest) : undefined;
  const pendingDecision = hasOwn(record, "pendingDecision")
    ? parseAskUserQuestionRequest(record.pendingDecision)
    : undefined;
  const securityApprovals = hasOwn(record, "securityApprovals")
    ? parseSecurityApprovalRules(record.securityApprovals)
    : undefined;
  const workGraph = hasOwn(record, "workGraph") ? parseWorkGraph(record.workGraph) : undefined;
  const qualityReview = hasOwn(record, "qualityReview")
    ? parseQualityReviewProjection(record.qualityReview)
    : undefined;
  const evolutionProposals = hasOwn(record, "evolutionProposals")
    ? parseEvolutionProposals(record.evolutionProposals)
    : undefined;
  const pluginDiagnostics = hasOwn(record, "pluginDiagnostics")
    ? parsePluginDiagnostics(record.pluginDiagnostics)
    : undefined;
  const mainUsage = hasOwn(record, "mainUsage") ? parseAgentRunUsage(record.mainUsage) : undefined;
  const totalUsage = hasOwn(record, "totalUsage")
    ? parseAgentUsageTotals(record.totalUsage)
    : undefined;
  const activityValue = record.activity;

  if (
    (hasOwn(record, "manifest") && !manifest)
    || (hasOwn(record, "pendingDecision") && !pendingDecision)
    || (hasOwn(record, "securityApprovals") && !securityApprovals)
    || (hasOwn(record, "workGraph") && !workGraph)
    || (hasOwn(record, "qualityReview") && !qualityReview)
    || (hasOwn(record, "evolutionProposals") && !evolutionProposals)
    || (hasOwn(record, "pluginDiagnostics") && !pluginDiagnostics)
    || (hasOwn(record, "mainUsage") && !mainUsage)
    || (hasOwn(record, "totalUsage") && !totalUsage)
    || !Array.isArray(activityValue)
  ) {
    return undefined;
  }

  // Absent lifecycle fields are a legacy snapshot, not a malformed one.
  const agents = parseBoundedList(
    record,
    "agents",
    parseAgentRun,
    MAX_PERSISTED_AGENT_RUNS,
    isActiveAgentRun,
  );
  const jobs = parseBoundedList(
    record,
    "jobs",
    parseAsyncJob,
    MAX_PERSISTED_ASYNC_JOBS,
    isActiveAsyncJob,
  );
  if (!agents || !jobs) {
    return undefined;
  }

  const activity = activityValue
    .map(parseToolActivity)
    .filter((item): item is ToolActivity => item !== undefined)
    .slice(-MAX_PERSISTED_TOOL_ACTIVITY);
  if (activity.length !== activityValue.length && activityValue.length <= MAX_PERSISTED_TOOL_ACTIVITY) {
    return undefined;
  }

  return createAgentConsoleSnapshot({
    profileId: record.profileId,
    ...(securityApprovals && securityApprovals.length > 0 ? { securityApprovals } : {}),
    ...(manifest ? { manifest } : {}),
    ...(pendingDecision ? { pendingDecision } : {}),
    ...(workGraph ? { workGraph } : {}),
    ...(qualityReview ? { qualityReview } : {}),
    ...(evolutionProposals && evolutionProposals.length > 0 ? { evolutionProposals } : {}),
    ...(pluginDiagnostics && pluginDiagnostics.length > 0 ? { pluginDiagnostics } : {}),
    activity,
    agents,
    jobs,
    ...(mainUsage ? { mainUsage } : {}),
    ...(totalUsage ? { totalUsage } : {}),
  });
}

function copyPluginDiagnostic(diagnostic: PluginDiagnosticProjection): PluginDiagnosticProjection {
  return {
    runId: boundedPluginDiagnosticField(diagnostic.runId),
    source: diagnostic.source,
    trustLane: diagnostic.trustLane,
    pluginId: boundedPluginDiagnosticField(diagnostic.pluginId),
    pluginName: boundedPluginDiagnosticField(diagnostic.pluginName),
    hookName: boundedPluginDiagnosticField(diagnostic.hookName),
    status: "error",
    errorName: boundedPluginDiagnosticField(diagnostic.errorName),
    errorMessage: boundedPluginDiagnosticField(diagnostic.errorMessage),
    ...(diagnostic.exitStatus === undefined
      ? {}
      : { exitStatus: boundedPluginDiagnosticField(diagnostic.exitStatus) }),
    dedupeKey: boundedPluginDiagnosticField(diagnostic.dedupeKey),
    startedAt: diagnostic.startedAt,
  };
}

function boundedPluginDiagnosticField(value: string): string {
  let projected = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
  for (const pattern of PLUGIN_DIAGNOSTIC_SECRET_PATTERNS) {
    projected = projected.replace(pattern, (match) => {
      const key = match.match(/^(api[_-]?key|token|secret|password)/i)?.[1];
      return key ? `${key}=[REDACTED]` : "[REDACTED]";
    });
  }
  projected = projected.replace(
    PLUGIN_DIAGNOSTIC_PATH_PATTERN,
    (_match, prefix: string) => `${prefix}[PATH]`,
  );
  const chars = Array.from(projected.trim());
  return chars.length <= MAX_PLUGIN_DIAGNOSTIC_FIELD_CHARS
    ? chars.join("")
    : `${chars.slice(0, MAX_PLUGIN_DIAGNOSTIC_FIELD_CHARS - 1).join("")}…`;
}

export function createPluginDiagnosticProjection(
  diagnostic: PluginDiagnosticProjection,
): PluginDiagnosticProjection {
  return copyPluginDiagnostic(diagnostic);
}

function parsePluginDiagnostics(value: unknown): readonly PluginDiagnosticProjection[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PERSISTED_PLUGIN_DIAGNOSTICS) return undefined;
  const parsed = value.map(parsePluginDiagnosticProjection);
  return parsed.every((item): item is PluginDiagnosticProjection => item !== undefined)
    ? parsed
    : undefined;
}

export function parsePluginDiagnosticProjection(value: unknown): PluginDiagnosticProjection | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const source = record.source;
  const trustLane = record.trustLane;
  const strings = ["runId", "pluginId", "pluginName", "hookName", "errorName", "errorMessage", "dedupeKey"] as const;
  if (
    (source !== "memory" && source !== "workspace" && source !== "cached")
    || (trustLane !== "host-provided" && trustLane !== "workspace-trusted" && trustLane !== "cached-external")
    || PLUGIN_DIAGNOSTIC_TRUST_BY_SOURCE[source] !== trustLane
    || record.status !== "error"
    || !strings.every((key) => typeof record[key] === "string" && record[key].trim().length > 0)
    || !PLUGIN_DIAGNOSTIC_DEDUPE_KEY.test(record.dedupeKey as string)
    || (record.exitStatus !== undefined
      && (typeof record.exitStatus !== "string" || record.exitStatus.trim().length === 0))
    || typeof record.startedAt !== "number"
    || !Number.isFinite(record.startedAt)
    || record.startedAt < 0
  ) {
    return undefined;
  }
  return createPluginDiagnosticProjection({
    runId: record.runId as string,
    source,
    trustLane,
    pluginId: record.pluginId as string,
    pluginName: record.pluginName as string,
    hookName: record.hookName as string,
    status: "error",
    errorName: record.errorName as string,
    errorMessage: record.errorMessage as string,
    ...(typeof record.exitStatus === "string" ? { exitStatus: record.exitStatus } : {}),
    dedupeKey: record.dedupeKey as string,
    startedAt: record.startedAt,
  });
}

function parseEvolutionProposals(value: unknown): readonly EvolutionProposalProjection[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_EVOLUTION_PROPOSALS) return undefined;
  const parsed = value.map(parseEvolutionProposal);
  return parsed.every((item): item is EvolutionProposalProjection => item !== undefined)
    ? parsed
    : undefined;
}

function parseEvolutionProposal(value: unknown): EvolutionProposalProjection | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const requiredIdentities = ["id", "runId", "candidateId", "creatorId", "evaluatorId", "attestorId"] as const;
  const state = record.state;
  const changedAssets = parseEvolutionChangedAssets(record.changedAssets);
  const hashes = parseEvolutionHashes(record.hashes);
  const comparison = hasOwn(record, "comparison") ? parseEvolutionComparison(record.comparison) : undefined;
  const attestation = hasOwn(record, "attestation") ? parseEvolutionAttestation(record.attestation) : undefined;
  const cleanup = parseEvolutionCleanup(record.cleanup);
  const failures = parseBoundedEvolutionStrings(record.failures, 32, 256);
  const artifactRefs = parseBoundedEvolutionStrings(record.artifactRefs, 32, 1_000);
  if (
    !requiredIdentities.every((key) => isBoundedNonEmptyString(record[key], 256))
    || !EVOLUTION_STATE_SET.has(state as EvolutionProposalProjection["state"])
    || record.isolation !== "worktree"
    || (record.isolatedBranch !== undefined && !isBoundedNonEmptyString(record.isolatedBranch, 512))
    || (record.isolatedWorktree !== undefined && !isBoundedNonEmptyString(record.isolatedWorktree, 1_000))
    || typeof record.heldOutBenchmark !== "boolean"
    || !isBoundedNonEmptyString(record.heldOutBenchmarkId, 256)
    || record.humanApproval !== "pending"
    || record.mergeRequiresHumanApproval !== true
    || typeof record.stale !== "boolean"
    || !changedAssets
    || !hashes
    || (hasOwn(record, "comparison") && !comparison)
    || (hasOwn(record, "attestation") && !attestation)
    || !cleanup
    || !failures
    || !isBoundedString(record.summary, 512)
    || !artifactRefs
    || !isCanonicalUtcMilliseconds(record.createdAt)
  ) {
    return undefined;
  }
  return copyEvolutionProposal({
    id: record.id as string,
    runId: record.runId as string,
    candidateId: record.candidateId as string,
    creatorId: record.creatorId as string,
    evaluatorId: record.evaluatorId as string,
    attestorId: record.attestorId as string,
    state: state as EvolutionProposalProjection["state"],
    isolation: "worktree",
    ...(typeof record.isolatedBranch === "string" ? { isolatedBranch: record.isolatedBranch } : {}),
    ...(typeof record.isolatedWorktree === "string" ? { isolatedWorktree: record.isolatedWorktree } : {}),
    heldOutBenchmark: record.heldOutBenchmark,
    heldOutBenchmarkId: record.heldOutBenchmarkId as string,
    humanApproval: "pending",
    mergeRequiresHumanApproval: true,
    stale: record.stale,
    changedAssets,
    hashes,
    ...(comparison ? { comparison } : {}),
    ...(attestation ? { attestation } : {}),
    cleanup,
    failures,
    summary: record.summary as string,
    artifactRefs,
    createdAt: record.createdAt as string,
  });
}

function parseEvolutionChangedAssets(
  value: unknown,
): EvolutionProposalProjection["changedAssets"] | undefined {
  if (!Array.isArray(value) || value.length > 128) return undefined;
  const parsed = value.map((entry) => {
    const record = asRecord(entry);
    return record
      && isBoundedNonEmptyString(record.path, 1_000)
      && isBoundedNonEmptyString(record.sha256, 80)
      ? { path: record.path, sha256: record.sha256 }
      : undefined;
  });
  return parsed.every((entry): entry is { readonly path: string; readonly sha256: string } => entry !== undefined)
    ? parsed
    : undefined;
}

function parseEvolutionHashes(value: unknown): EvolutionProposalProjection["hashes"] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const required = ["evaluator", "evaluatorEnvironment", "policy", "suite"] as const;
  const optional = [
    "baseCommit",
    "candidateCommit",
    "patch",
    "candidateArtifact",
    "baselineResult",
    "candidateResult",
  ] as const;
  if (
    !required.every((key) => typeof record[key] === "string" && SHA256_DIGEST.test(record[key]))
    || !optional.every((key) => record[key] === undefined || isBoundedNonEmptyString(record[key], 80))
  ) {
    return undefined;
  }
  return {
    ...(typeof record.baseCommit === "string" ? { baseCommit: record.baseCommit } : {}),
    ...(typeof record.candidateCommit === "string" ? { candidateCommit: record.candidateCommit } : {}),
    ...(typeof record.patch === "string" ? { patch: record.patch } : {}),
    ...(typeof record.candidateArtifact === "string" ? { candidateArtifact: record.candidateArtifact } : {}),
    evaluator: record.evaluator as string,
    evaluatorEnvironment: record.evaluatorEnvironment as string,
    policy: record.policy as string,
    suite: record.suite as string,
    ...(typeof record.baselineResult === "string" ? { baselineResult: record.baselineResult } : {}),
    ...(typeof record.candidateResult === "string" ? { candidateResult: record.candidateResult } : {}),
  };
}

function parseEvolutionComparison(
  value: unknown,
): NonNullable<EvolutionProposalProjection["comparison"]> | undefined {
  const record = asRecord(value);
  if (
    !record
    || !isFiniteNumber(record.baselineScore)
    || !isFiniteNumber(record.candidateScore)
    || !isFiniteNumber(record.delta)
    || typeof record.passed !== "boolean"
    || typeof record.thresholdsHash !== "string"
    || !SHA256_DIGEST.test(record.thresholdsHash)
  ) {
    return undefined;
  }
  return {
    baselineScore: record.baselineScore,
    candidateScore: record.candidateScore,
    delta: record.delta,
    passed: record.passed,
    thresholdsHash: record.thresholdsHash,
  };
}

function parseEvolutionAttestation(
  value: unknown,
): NonNullable<EvolutionProposalProjection["attestation"]> | undefined {
  const record = asRecord(value);
  if (
    !record
    || !isCanonicalUtcMilliseconds(record.timestamp)
    || !isNonNegativeInteger(record.maxAgeMs)
    || record.maxAgeMs > 3_600_000
    || typeof record.branchExists !== "boolean"
    || typeof record.worktreeExists !== "boolean"
  ) {
    return undefined;
  }
  return {
    timestamp: record.timestamp,
    maxAgeMs: record.maxAgeMs,
    branchExists: record.branchExists,
    worktreeExists: record.worktreeExists,
  };
}

function parseEvolutionCleanup(value: unknown): EvolutionCleanupProjection | undefined {
  const record = asRecord(value);
  if (
    !record
    || !EVOLUTION_CLEANUP_STATUS_SET.has(record.status as EvolutionCleanupProjection["status"])
    || !Array.isArray(record.resources)
    || record.resources.length > 16
    || (record.summary !== undefined && !isBoundedString(record.summary, 512))
  ) {
    return undefined;
  }
  const resources = record.resources.map((entry) => {
    const resource = asRecord(entry);
    return resource
      && EVOLUTION_RESOURCE_KIND_SET.has(resource.kind as EvolutionCleanupResourceProjection["kind"])
      && isBoundedNonEmptyString(resource.identity, 1_000)
      && EVOLUTION_RESOURCE_STATUS_SET.has(resource.status as EvolutionCleanupResourceProjection["status"])
      ? {
          kind: resource.kind as EvolutionCleanupResourceProjection["kind"],
          identity: resource.identity,
          status: resource.status as EvolutionCleanupResourceProjection["status"],
        }
      : undefined;
  });
  if (!resources.every((entry): entry is EvolutionCleanupResourceProjection => entry !== undefined)) {
    return undefined;
  }
  return {
    status: record.status as EvolutionCleanupProjection["status"],
    resources,
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
  };
}

function parseBoundedEvolutionStrings(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): readonly string[] | undefined {
  return Array.isArray(value)
    && value.length <= maximumItems
    && value.every((entry) => isBoundedNonEmptyString(entry, maximumLength))
    ? value
    : undefined;
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length <= maximumLength;
}

function isBoundedNonEmptyString(value: unknown, maximumLength: number): value is string {
  return isBoundedString(value, maximumLength) && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCanonicalUtcMilliseconds(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isContextProfileId(value: unknown): value is ContextProfileId {
  return typeof value === "string" && CONTEXT_PROFILE_IDS.includes(value as ContextProfileId);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Rebuilds a bounded lifecycle list. A missing key is a legacy snapshot and
 * yields `[]`; a malformed entry rejects the whole snapshot even when the
 * bound would have discarded it, so a poisoned prefix cannot be laundered.
 *
 * Every untrusted entry is validated, but only the newest `limit` records and
 * the active records evicted from that window are held live, so an oversized
 * persisted list cannot inflate retained memory with projections that are
 * about to be discarded. Active records outlive the window because the bound
 * is charged to settled history, exactly as it is when the snapshot is built.
 *
 * A list whose active records alone exceed the bound is rejected outright: the
 * writer caps concurrent work, so that shape is corrupt persisted data, and
 * quietly dropping live records would hide work an operator can still act on.
 */
function parseBoundedList<T>(
  record: Record<string, unknown>,
  key: string,
  parseEntry: (value: unknown) => T | undefined,
  limit: number,
  isActive: (item: T) => boolean,
): readonly T[] | undefined {
  if (!hasOwn(record, key)) {
    return [];
  }
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  const ring: T[] = [];
  const evictedActive: T[] = [];
  let activeCount = 0;
  let oldest = 0;
  for (const entry of value) {
    const item = parseEntry(entry);
    if (item === undefined) {
      return undefined;
    }
    if (isActive(item)) {
      activeCount += 1;
      if (activeCount > limit) {
        return undefined;
      }
    }
    if (ring.length < limit) {
      ring.push(item);
      continue;
    }
    const displaced = ring[oldest];
    if (displaced !== undefined && isActive(displaced)) {
      evictedActive.push(displaced);
    }
    ring[oldest] = item;
    oldest = (oldest + 1) % limit;
  }

  const newest = oldest === 0 ? ring : [...ring.slice(oldest), ...ring.slice(0, oldest)];
  return boundLifecycleRecords(
    evictedActive.length === 0 ? newest : [...evictedActive, ...newest],
    limit,
    isActive,
  );
}

function parseStringList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every(isNonEmptyString) ? value : undefined;
}

function parsePersistedPromptManifest(value: unknown): PersistedPromptManifest | undefined {
  const record = asRecord(value);
  if (
    !record
    || !isNonEmptyString(record.id)
    || !isContextProfileId(record.profileId)
    || !isNonEmptyString(record.createdAt)
    || !isNonEmptyString(record.packetId)
    || !isNonNegativeInteger(record.includedSourceCount)
    || !isNonNegativeInteger(record.excludedSourceCount)
    || !isNonNegativeInteger(record.tokenEstimate)
    || !Array.isArray(record.policy)
  ) {
    return undefined;
  }

  const policy = record.policy.map(parsePromptManifestPolicySource);
  if (policy.some((source) => source === undefined)) {
    return undefined;
  }
  const parsedPolicy = policy.filter(
    (source): source is PromptManifestPolicySource => source !== undefined,
  );

  return {
    id: record.id,
    profileId: record.profileId,
    createdAt: record.createdAt,
    packetId: record.packetId,
    policy: parsedPolicy,
    includedSourceCount: record.includedSourceCount,
    excludedSourceCount: record.excludedSourceCount,
    tokenEstimate: record.tokenEstimate,
  };
}

function parsePromptManifestPolicySource(value: unknown): PromptManifestPolicySource | undefined {
  const record = asRecord(value);
  if (
    !record
    || !isNonEmptyString(record.id)
    || !isNonEmptyString(record.label)
    || (record.authority !== "mandatory" && record.authority !== "profile-eligible")
    || !isNonEmptyString(record.digest)
  ) {
    return undefined;
  }
  return {
    id: record.id,
    label: record.label,
    authority: record.authority,
    digest: record.digest,
  };
}

function parseAskUserQuestionRequest(value: unknown): AskUserQuestionRequest | undefined {
  const record = asRecord(value);
  if (!record || !isNonEmptyString(record.id) || !Array.isArray(record.questions) || record.questions.length === 0) {
    return undefined;
  }
  if (hasOwn(record, "title") && !isNonEmptyString(record.title)) {
    return undefined;
  }
  if (
    hasOwn(record, "kind")
    && record.kind !== "security-approval"
    && record.kind !== "user-decision"
  ) {
    return undefined;
  }

  const questions = record.questions.map(parseAskUserQuestion);
  if (questions.some((question) => question === undefined)) {
    return undefined;
  }
  const parsedQuestions = questions.filter(
    (question): question is AskUserQuestion => question !== undefined,
  );

  return {
    kind: record.kind === "security-approval" ? "security-approval" : "user-decision",
    id: record.id,
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    questions: parsedQuestions,
  };
}

function parseSecurityApprovalRules(value: unknown): readonly PersistedSecurityApprovalRule[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const rules: PersistedSecurityApprovalRule[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const record = asRecord(candidate);
    if (!record || record.kind !== "tool" || !isSafePermissionRuleKey(record.key)) {
      return undefined;
    }
    if (!seen.has(record.key)) {
      seen.add(record.key);
      rules.push({ kind: "tool", key: record.key });
    }
  }
  return rules;
}

function parseAskUserQuestion(value: unknown): AskUserQuestion | undefined {
  const record = asRecord(value);
  if (
    !record
    || !isNonEmptyString(record.id)
    || !isNonEmptyString(record.question)
    || !Array.isArray(record.options)
    || record.options.length === 0
    || (hasOwn(record, "multi") && typeof record.multi !== "boolean")
    || (hasOwn(record, "recommended")
      && (!isNonNegativeInteger(record.recommended) || record.recommended >= record.options.length))
  ) {
    return undefined;
  }

  const options = record.options.map(parseAskUserQuestionOption);
  if (options.some((option) => option === undefined)) {
    return undefined;
  }
  const parsedOptions = options.filter(
    (option): option is AskUserQuestionOption => option !== undefined,
  );

  return {
    id: record.id,
    question: record.question,
    options: parsedOptions,
    ...(typeof record.multi === "boolean" ? { multi: record.multi } : {}),
    ...(typeof record.recommended === "number" ? { recommended: record.recommended } : {}),
  };
}

function parseAskUserQuestionOption(value: unknown): AskUserQuestionOption | undefined {
  const record = asRecord(value);
  if (!record || !isNonEmptyString(record.label) || (hasOwn(record, "description") && !isNonEmptyString(record.description))) {
    return undefined;
  }
  return {
    label: record.label,
    ...(typeof record.description === "string" ? { description: record.description } : {}),
  };
}

function parseWorkGraph(value: unknown): WorkGraph | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const constraints = parseOptionalStringList(record, "constraints");
  const qualityProfile = hasOwn(record, "qualityProfile") ? record.qualityProfile : "minimal";
  const currentStage = hasOwn(record, "currentStage") ? record.currentStage : "work";
  const gateStatus = hasOwn(record, "gateStatus") ? record.gateStatus : "unproven";
  const iteration = hasOwn(record, "iteration") ? record.iteration : 0;
  if (
    !isNonEmptyString(record.id)
    || !Array.isArray(record.nodes)
    || (hasOwn(record, "goal") && !isNonEmptyString(record.goal))
    || constraints === null
    || typeof qualityProfile !== "string"
    || !QUALITY_PROFILE_SET.has(qualityProfile)
    || typeof currentStage !== "string"
    || !QUALITY_HARNESS_STAGE_SET.has(currentStage)
    || typeof gateStatus !== "string"
    || !QUALITY_GATE_STATUS_SET.has(gateStatus)
    || !isNonNegativeInteger(iteration)
    || (record.approval !== "pending" && record.approval !== "approved" && record.approval !== "rejected")
  ) {
    return undefined;
  }

  const nodes = record.nodes.map(parseWorkNode);
  if (nodes.some((node) => node === undefined)) {
    return undefined;
  }
  const parsedNodes = nodes.filter(
    (node): node is WorkNode => node !== undefined,
  );
  return {
    id: record.id,
    ...(typeof record.goal === "string" ? { goal: record.goal } : {}),
    ...(constraints === undefined ? {} : { constraints }),
    qualityProfile: qualityProfile as QualityProfile,
    currentStage: currentStage as QualityHarnessStage,
    gateStatus: gateStatus as QualityGateStatus,
    iteration,
    approval: record.approval,
    nodes: parsedNodes,
  };
}

function parseQualityReviewProjection(value: unknown): QualityReviewProjection | undefined {
  const record = asRecord(value);
  if (
    !record
    || !isNonEmptyString(record.runId)
    || !isNonEmptyString(record.graphId)
    || (hasOwn(record, "profile")
      && (typeof record.profile !== "string" || !QUALITY_PROFILE_SET.has(record.profile)))
    || (hasOwn(record, "currentStage")
      && (typeof record.currentStage !== "string"
        || !QUALITY_HARNESS_STAGE_SET.has(record.currentStage)))
    || (hasOwn(record, "iteration") && !isNonNegativeInteger(record.iteration))
    || !isNonNegativeInteger(record.refineCount)
    || !isNonNegativeInteger(record.pivotCount)
    || typeof record.latestDecision !== "string"
    || !QUALITY_GATE_STATUS_SET.has(record.latestDecision)
    || !Array.isArray(record.history)
    || record.history.length > MAX_QUALITY_REVIEW_HISTORY
  ) {
    return undefined;
  }
  const history = record.history.map(parseQualityReviewHistoryEntry);
  if (history.some((entry) => entry === undefined)) return undefined;
  return {
    runId: record.runId,
    graphId: record.graphId,
    ...(typeof record.profile === "string" && QUALITY_PROFILE_SET.has(record.profile)
      ? { profile: record.profile as QualityProfile }
      : {}),
    ...(typeof record.currentStage === "string" && QUALITY_HARNESS_STAGE_SET.has(record.currentStage)
      ? { currentStage: record.currentStage as QualityHarnessStage }
      : {}),
    ...(isNonNegativeInteger(record.iteration) ? { iteration: record.iteration } : {}),
    refineCount: record.refineCount,
    pivotCount: record.pivotCount,
    latestDecision: record.latestDecision as QualityGateStatus,
    history: history.filter((entry): entry is QualityReviewHistoryEntry => entry !== undefined),
  };
}

function parseQualityReviewHistoryEntry(value: unknown): QualityReviewHistoryEntry | undefined {
  const record = asRecord(value);
  const failures = parseStringList(record?.failures);
  const evidenceRefs = parseStringList(record?.evidenceRefs);
  const artifactRefs = parseStringList(record?.artifactRefs);
  if (
    !record
    || (record.event !== "gate" && record.event !== "refine" && record.event !== "pivot" && record.event !== "completed")
    || typeof record.stage !== "string"
    || !QUALITY_HARNESS_STAGE_SET.has(record.stage)
    || typeof record.decision !== "string"
    || !QUALITY_GATE_STATUS_SET.has(record.decision)
    || !isNonNegativeInteger(record.iteration)
    || (hasOwn(record, "reason") && !isNonEmptyString(record.reason))
    || !failures
    || failures.length > 32
    || !evidenceRefs
    || evidenceRefs.length > 64
    || !artifactRefs
    || artifactRefs.length > 64
    || (hasOwn(record, "artifactHash") && !isNonEmptyString(record.artifactHash))
    || (hasOwn(record, "reviewedArtifactHash") && !isNonEmptyString(record.reviewedArtifactHash))
    || (hasOwn(record, "currentArtifactHash") && !isNonEmptyString(record.currentArtifactHash))
    || (hasOwn(record, "reviewerId") && !isNonEmptyString(record.reviewerId))
    || (hasOwn(record, "reviewerRunId") && !isNonEmptyString(record.reviewerRunId))
    || (hasOwn(record, "provider") && !isNonEmptyString(record.provider))
    || (hasOwn(record, "model") && !isNonEmptyString(record.model))
    || (hasOwn(record, "route")
      && record.route !== "direct"
      && record.route !== "frontier"
      && record.route !== "commodity"
      && record.route !== "fallback")
    || (hasOwn(record, "count") && !isNonNegativeInteger(record.count))
    || (hasOwn(record, "limit") && !isNonNegativeInteger(record.limit))
    || typeof record.independentVerification !== "boolean"
    || typeof record.stale !== "boolean"
    || !isNonNegativeFinite(record.startedAt)
  ) {
    return undefined;
  }
  return {
    event: record.event,
    stage: record.stage as QualityHarnessStage,
    decision: record.decision as QualityGateStatus,
    iteration: record.iteration,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    failures,
    evidenceRefs,
    artifactRefs,
    ...(typeof record.artifactHash === "string" ? { artifactHash: record.artifactHash } : {}),
    ...(typeof record.reviewedArtifactHash === "string"
      ? { reviewedArtifactHash: record.reviewedArtifactHash }
      : {}),
    ...(typeof record.currentArtifactHash === "string"
      ? { currentArtifactHash: record.currentArtifactHash }
      : {}),
    ...(typeof record.reviewerId === "string" ? { reviewerId: record.reviewerId } : {}),
    ...(typeof record.reviewerRunId === "string" ? { reviewerRunId: record.reviewerRunId } : {}),
    ...(typeof record.provider === "string" ? { provider: record.provider } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(typeof record.route === "string"
      ? { route: record.route as NonNullable<QualityReviewHistoryEntry["route"]> }
      : {}),
    ...(typeof record.count === "number" ? { count: record.count } : {}),
    ...(typeof record.limit === "number" ? { limit: record.limit } : {}),
    independentVerification: record.independentVerification,
    stale: record.stale,
    startedAt: record.startedAt,
  };
}

function parseWorkNode(value: unknown): WorkNode | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const dependsOn = parseStringList(record.dependsOn);
  const fileOwnership = parseStringList(record.fileOwnership);
  const acceptanceCriteria = parseOptionalStringList(record, "acceptanceCriteria");
  const evidenceRefs = parseStringList(record.evidenceRefs);
  const stage = hasOwn(record, "stage") ? record.stage : "work";
  const role = hasOwn(record, "role") ? record.role : "worker";
  const attempt = hasOwn(record, "attempt") ? record.attempt : 0;
  const artifactRefs = hasOwn(record, "artifactRefs")
    ? parseStringList(record.artifactRefs)
    : [];
  const reviewRequired = hasOwn(record, "reviewRequired") ? record.reviewRequired : false;
  if (
    !isNonEmptyString(record.id)
    || !isNonEmptyString(record.title)
    || !isNonEmptyString(record.prompt)
    || typeof record.status !== "string"
    || !WORK_NODE_STATUS_SET.has(record.status)
    || !dependsOn
    || !fileOwnership
    || (hasOwn(record, "manifestId") && !isNonEmptyString(record.manifestId))
    || acceptanceCriteria === null
    || !evidenceRefs
    || typeof stage !== "string"
    || !QUALITY_HARNESS_STAGE_SET.has(stage)
    || typeof role !== "string"
    || !WORK_NODE_ROLE_SET.has(role)
    || !isNonNegativeInteger(attempt)
    || !artifactRefs
    || typeof reviewRequired !== "boolean"
  ) {
    return undefined;
  }
  return {
    id: record.id,
    title: record.title,
    prompt: record.prompt,
    status: record.status as WorkNodeStatus,
    dependsOn,
    fileOwnership,
    ...(typeof record.manifestId === "string" ? { manifestId: record.manifestId } : {}),
    acceptanceCriteria: acceptanceCriteria ?? [],
    evidenceRefs,
    stage: stage as QualityHarnessStage,
    role: role as WorkNodeRole,
    attempt,
    artifactRefs,
    reviewRequired,
  };
}

function parseOptionalStringList(
  record: Record<string, unknown> | undefined,
  key: string,
): readonly string[] | undefined | null {
  if (!record || !hasOwn(record, key)) {
    return undefined;
  }
  return parseStringList(record[key]) ?? null;
}

function parseToolActivity(value: unknown): ToolActivity | undefined {
  const record = asRecord(value);
  if (
    !record
    || !isNonEmptyString(record.id)
    || !isNonEmptyString(record.toolCallId)
    || !isNonEmptyString(record.toolName)
    || typeof record.kind !== "string"
    || !TOOL_ACTIVITY_KIND_SET.has(record.kind)
    || !isNonEmptyString(record.intent)
    || typeof record.status !== "string"
    || !TOOL_ACTIVITY_STATUS_SET.has(record.status)
    || !isNonNegativeInteger(record.startedAt)
    || (hasOwn(record, "target") && !isNonEmptyString(record.target))
    || (hasOwn(record, "summary") && !isNonEmptyString(record.summary))
    || (hasOwn(record, "preview") && !isNonEmptyString(record.preview))
    || (hasOwn(record, "completedAt") && !isNonNegativeInteger(record.completedAt))
    || (hasOwn(record, "agentRunId") && !isNonEmptyString(record.agentRunId))
  ) {
    return undefined;
  }

  return {
    id: record.id,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    kind: record.kind as ToolActivityKind,
    intent: record.intent,
    status: record.status as ToolActivityStatus,
    ...(typeof record.target === "string" ? { target: record.target } : {}),
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
    // Re-bound on the way in: a persisted snapshot could have been written by
    // a build with a larger budget, or edited by hand.
    ...(typeof record.preview === "string"
      ? { preview: boundToolActivityPreview(record.preview) }
      : {}),
    startedAt: record.startedAt,
    ...(typeof record.completedAt === "number" ? { completedAt: record.completedAt } : {}),
    ...(typeof record.agentRunId === "string" ? { agentRunId: record.agentRunId } : {}),
  };
}

function parseAgentRun(value: unknown): AgentRun | undefined {
  const record = asRecord(value);
  const usage = record && hasOwn(record, "usage") ? parseAgentRunUsage(record.usage) : undefined;
  if (
    !record
    || !isNonEmptyString(record.id)
    || !isNonEmptyString(record.displayName)
    || !isNonEmptyString(record.agentType)
    || typeof record.status !== "string"
    || !AGENT_RUN_STATUS_SET.has(record.status)
    || !isNonNegativeInteger(record.startedAt)
    || (hasOwn(record, "currentActivity") && !isNonEmptyString(record.currentActivity))
    || (hasOwn(record, "parentRunId") && !isNonEmptyString(record.parentRunId))
    || (hasOwn(record, "continuationOf") && !isNonEmptyString(record.continuationOf))
    || (hasOwn(record, "transcriptRef") && !isNonEmptyString(record.transcriptRef))
    || (hasOwn(record, "completedAt") && !isNonNegativeInteger(record.completedAt))
    || (hasOwn(record, "summary") && !isNonEmptyString(record.summary))
    || (hasOwn(record, "errorSummary") && !isNonEmptyString(record.errorSummary))
    || (hasOwn(record, "usage") && !usage)
  ) {
    return undefined;
  }

  return copyAgentRun({
    id: record.id,
    displayName: record.displayName,
    agentType: record.agentType,
    status: record.status as AgentRunStatus,
    ...(typeof record.currentActivity === "string" ? { currentActivity: record.currentActivity } : {}),
    ...(typeof record.parentRunId === "string" ? { parentRunId: record.parentRunId } : {}),
    ...(typeof record.continuationOf === "string" ? { continuationOf: record.continuationOf } : {}),
    ...(typeof record.transcriptRef === "string" ? { transcriptRef: record.transcriptRef } : {}),
    startedAt: record.startedAt,
    ...(typeof record.completedAt === "number" ? { completedAt: record.completedAt } : {}),
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
    ...(typeof record.errorSummary === "string" ? { errorSummary: record.errorSummary } : {}),
    ...(usage ? { usage } : {}),
  });
}

function parseAsyncJob(value: unknown): AsyncJob | undefined {
  const record = asRecord(value);
  if (
    !record
    || !isNonEmptyString(record.id)
    || !isNonEmptyString(record.type)
    || !isNonEmptyString(record.label)
    || typeof record.status !== "string"
    || !ASYNC_JOB_STATUS_SET.has(record.status)
    || !isNonNegativeInteger(record.queuedAt)
    || (hasOwn(record, "agentRunId") && !isNonEmptyString(record.agentRunId))
    || (hasOwn(record, "startedAt") && !isNonNegativeInteger(record.startedAt))
    || (hasOwn(record, "completedAt") && !isNonNegativeInteger(record.completedAt))
    || (hasOwn(record, "summary") && !isNonEmptyString(record.summary))
    || (hasOwn(record, "errorSummary") && !isNonEmptyString(record.errorSummary))
  ) {
    return undefined;
  }

  return copyAsyncJob({
    id: record.id,
    type: record.type,
    label: record.label,
    status: record.status as AsyncJobStatus,
    ...(typeof record.agentRunId === "string" ? { agentRunId: record.agentRunId } : {}),
    queuedAt: record.queuedAt,
    ...(typeof record.startedAt === "number" ? { startedAt: record.startedAt } : {}),
    ...(typeof record.completedAt === "number" ? { completedAt: record.completedAt } : {}),
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
    ...(typeof record.errorSummary === "string" ? { errorSummary: record.errorSummary } : {}),
  });
}

function parseAgentRunUsageRoute(value: unknown): AgentRunUsageRoute | undefined {
  const record = asRecord(value);
  const eventIds = record && hasOwn(record, "eventIds")
    ? parseStringList(record.eventIds)
    : undefined;
  if (
    !record
    || typeof record.provider !== "string"
    || record.provider.trim().length === 0
    || typeof record.model !== "string"
    || record.model.trim().length === 0
    || (hasOwn(record, "eventIds") && !eventIds)
    || (hasOwn(record, "inputTokens") && !isNonNegativeInteger(record.inputTokens))
    || (hasOwn(record, "outputTokens") && !isNonNegativeInteger(record.outputTokens))
    || (hasOwn(record, "cacheReadTokens") && !isNonNegativeInteger(record.cacheReadTokens))
    || (hasOwn(record, "cacheWriteTokens") && !isNonNegativeInteger(record.cacheWriteTokens))
    || (hasOwn(record, "cacheSavingsUsd") && !isNonNegativeFinite(record.cacheSavingsUsd))
    || (hasOwn(record, "costUsd") && !isNonNegativeFinite(record.costUsd))
  ) {
    return undefined;
  }
  return {
    provider: record.provider.trim(),
    model: record.model.trim(),
    ...(eventIds === undefined ? {} : { eventIds }),
    ...(typeof record.inputTokens === "number" ? { inputTokens: record.inputTokens } : {}),
    ...(typeof record.outputTokens === "number" ? { outputTokens: record.outputTokens } : {}),
    ...(typeof record.cacheReadTokens === "number"
      ? { cacheReadTokens: record.cacheReadTokens }
      : {}),
    ...(typeof record.cacheWriteTokens === "number"
      ? { cacheWriteTokens: record.cacheWriteTokens }
      : {}),
    ...(typeof record.cacheSavingsUsd === "number"
      ? { cacheSavingsUsd: record.cacheSavingsUsd }
      : {}),
    ...(typeof record.costUsd === "number" ? { costUsd: record.costUsd } : {}),
  };
}

function parseAgentRunUsageRoutes(value: unknown): readonly AgentRunUsageRoute[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const routes: AgentRunUsageRoute[] = [];
  for (const entry of value) {
    const route = parseAgentRunUsageRoute(entry);
    if (!route) return undefined;
    routes.push(route);
  }
  return routes;
}

const USAGE_ROUTE_TOKEN_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;
const USAGE_ROUTE_MONEY_KEYS = ["cacheSavingsUsd", "costUsd"] as const;

function usageRoutesMatchAggregate(
  aggregate: Record<string, unknown>,
  aggregateEventIds: readonly string[],
  routes: readonly AgentRunUsageRoute[],
): boolean {
  const aggregateIds = new Set(aggregateEventIds);
  const routedIds = new Set<string>();
  const routeKeys = new Set<string>();
  for (const route of routes) {
    const routeKey = `${route.provider}\0${route.model}`;
    if (routeKeys.has(routeKey)) return false;
    routeKeys.add(routeKey);
    for (const eventId of route.eventIds ?? []) {
      if (!aggregateIds.has(eventId) || routedIds.has(eventId)) return false;
      routedIds.add(eventId);
    }
  }

  const allEventsAttributed = routedIds.size === aggregateIds.size;
  for (const key of USAGE_ROUTE_TOKEN_KEYS) {
    const aggregateTotal = typeof aggregate[key] === "number" ? aggregate[key] : 0;
    let routeTotal = 0;
    for (const route of routes) routeTotal += route[key] ?? 0;
    if (
      !Number.isSafeInteger(routeTotal)
      || (allEventsAttributed ? routeTotal !== aggregateTotal : routeTotal > aggregateTotal)
    ) {
      return false;
    }
  }
  for (const key of USAGE_ROUTE_MONEY_KEYS) {
    const aggregateTotal = typeof aggregate[key] === "number" ? aggregate[key] : 0;
    let routeTotal = 0;
    for (const route of routes) routeTotal += route[key] ?? 0;
    const operationCount = aggregateIds.size + routes.length;
    const tolerance = Number.EPSILON
      * Math.max(1, Math.abs(aggregateTotal), Math.abs(routeTotal))
      * Math.max(4, operationCount);
    if (
      !Number.isFinite(routeTotal)
      || (allEventsAttributed
        ? Math.abs(routeTotal - aggregateTotal) > tolerance
        : routeTotal - aggregateTotal > tolerance)
    ) {
      return false;
    }
  }
  return true;
}

function parseAgentRunUsage(value: unknown): AgentRunUsage | undefined {
  const record = asRecord(value);
  const eventIds = record && hasOwn(record, "eventIds")
    ? parseStringList(record.eventIds)
    : undefined;
  const routes = record && hasOwn(record, "routes")
    ? parseAgentRunUsageRoutes(record.routes)
    : undefined;
  if (
    !record
    || (hasOwn(record, "eventIds") && !eventIds)
    || (hasOwn(record, "inputTokens") && !isNonNegativeInteger(record.inputTokens))
    || (hasOwn(record, "outputTokens") && !isNonNegativeInteger(record.outputTokens))
    || (hasOwn(record, "cacheReadTokens") && !isNonNegativeInteger(record.cacheReadTokens))
    || (hasOwn(record, "cacheWriteTokens") && !isNonNegativeInteger(record.cacheWriteTokens))
    || (hasOwn(record, "cacheSavingsUsd") && !isNonNegativeFinite(record.cacheSavingsUsd))
    || (hasOwn(record, "costUsd") && !isNonNegativeFinite(record.costUsd))
    || (hasOwn(record, "routes") && !routes)
  ) {
    return undefined;
  }
  if (
    eventIds
    && routes
    && routes.every((route) => (route.eventIds?.length ?? 0) > 0)
    && !usageRoutesMatchAggregate(record, eventIds, routes)
  ) {
    return undefined;
  }


  return copyAgentRunUsage({
    eventIds: eventIds ?? [],
    ...(typeof record.inputTokens === "number" ? { inputTokens: record.inputTokens } : {}),
    ...(typeof record.outputTokens === "number" ? { outputTokens: record.outputTokens } : {}),
    ...(typeof record.cacheReadTokens === "number"
      ? { cacheReadTokens: record.cacheReadTokens }
      : {}),
    ...(typeof record.cacheWriteTokens === "number"
      ? { cacheWriteTokens: record.cacheWriteTokens }
      : {}),
    ...(typeof record.cacheSavingsUsd === "number"
      ? { cacheSavingsUsd: record.cacheSavingsUsd }
      : {}),
    ...(typeof record.costUsd === "number" ? { costUsd: record.costUsd } : {}),
    ...(routes === undefined ? {} : { routes }),
  });
}

function parseAgentUsageTotals(value: unknown): AgentUsageTotals | undefined {
  const record = asRecord(value);
  if (!record || !usageCounterRecordIsValid(record)) return undefined;
  let routes: AgentUsageRouteTotals[] | undefined;
  if (hasOwn(record, "routes")) {
    if (!Array.isArray(record.routes)) return undefined;
    routes = [];
    const routeKeys = new Set<string>();
    for (const value of record.routes) {
      const route = asRecord(value);
      if (
        !route
        || !isNonEmptyString(route.provider)
        || !isNonEmptyString(route.model)
        || !usageCounterRecordIsValid(route)
      ) {
        return undefined;
      }
      const key = `${route.provider.trim()}\0${route.model.trim()}`;
      if (routeKeys.has(key)) return undefined;
      routeKeys.add(key);
      routes.push({
        provider: route.provider.trim(),
        model: route.model.trim(),
        ...copyUsageCounterFields(route),
      });
    }
  }
  return copyAgentUsageTotals({
    ...copyUsageCounterFields(record),
    ...(routes === undefined ? {} : { routes }),
  });
}

function usageCounterRecordIsValid(record: Record<string, unknown>): boolean {
  return !(
    (hasOwn(record, "inputTokens") && !isNonNegativeInteger(record.inputTokens))
    || (hasOwn(record, "outputTokens") && !isNonNegativeInteger(record.outputTokens))
    || (hasOwn(record, "cacheReadTokens") && !isNonNegativeInteger(record.cacheReadTokens))
    || (hasOwn(record, "cacheWriteTokens") && !isNonNegativeInteger(record.cacheWriteTokens))
    || (hasOwn(record, "cacheSavingsUsd") && !isNonNegativeFinite(record.cacheSavingsUsd))
    || (hasOwn(record, "costUsd") && !isNonNegativeFinite(record.costUsd))
  );
}

function copyUsageCounterFields(record: Record<string, unknown>): Omit<AgentUsageTotals, "routes"> {
  return {
    ...(typeof record.inputTokens === "number" ? { inputTokens: record.inputTokens } : {}),
    ...(typeof record.outputTokens === "number" ? { outputTokens: record.outputTokens } : {}),
    ...(typeof record.cacheReadTokens === "number"
      ? { cacheReadTokens: record.cacheReadTokens }
      : {}),
    ...(typeof record.cacheWriteTokens === "number"
      ? { cacheWriteTokens: record.cacheWriteTokens }
      : {}),
    ...(typeof record.cacheSavingsUsd === "number"
      ? { cacheSavingsUsd: record.cacheSavingsUsd }
      : {}),
    ...(typeof record.costUsd === "number" ? { costUsd: record.costUsd } : {}),
  };
}
