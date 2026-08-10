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
  readonly id: string;
  readonly title?: string;
  readonly questions: readonly AskUserQuestion[];
};

export type AskUserQuestionResult =
  | { readonly status: "answered"; readonly answers: readonly AskUserQuestionAnswer[] }
  | { readonly status: "cancelled" }
  | { readonly status: "timed_out"; readonly answers: readonly AskUserQuestionAnswer[] }
  | { readonly status: "unavailable"; readonly reason: string };

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
};

export type WorkGraph = {
  readonly id: string;
  readonly goal?: string;
  readonly constraints?: readonly string[];
  readonly nodes: readonly WorkNode[];
  readonly approval: "pending" | "approved" | "rejected";
};

export type WorkNodeDispatchOutcome = {
  readonly nodeId: string;
  readonly status: Extract<WorkNodeStatus, "completed" | "failed" | "blocked">;
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
 * Deduplicated usage ledger. `eventIds` is the identity set that makes usage
 * replay idempotent — a provider turn contributes to either `mainUsage` or one
 * `AgentRun.usage`, never both.
 */
export type AgentRunUsageRoute = {
  readonly provider: string;
  readonly model: string;
  readonly eventIds: readonly string[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheSavingsUsd?: number;
  readonly costUsd?: number;
};

export type AgentRunUsage = {
  readonly eventIds: readonly string[];
  /** Uncached input; cache reads and writes are tracked in their own buckets. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheSavingsUsd?: number;
  readonly costUsd?: number;
  readonly routes?: readonly AgentRunUsageRoute[];
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

export type AgentConsoleSnapshot = {
  readonly profileId: ContextProfileId;
  readonly manifest?: PersistedPromptManifest;
  readonly pendingDecision?: AskUserQuestionRequest;
  readonly workGraph?: WorkGraph;
  readonly activity: readonly ToolActivity[];
  readonly agents: readonly AgentRun[];
  readonly jobs: readonly AsyncJob[];
  readonly mainUsage?: AgentRunUsage;
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
    ...(input.manifest ? { manifest: copyPersistedPromptManifest(input.manifest) } : {}),
    ...(input.pendingDecision
      ? { pendingDecision: copyAskUserQuestionRequest(input.pendingDecision) }
      : {}),
    ...(input.workGraph ? { workGraph: copyWorkGraph(input.workGraph) } : {}),
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

function copyWorkGraph(graph: WorkGraph): WorkGraph {
  return {
    id: graph.id,
    ...(graph.goal === undefined ? {} : { goal: graph.goal }),
    ...(graph.constraints === undefined ? {} : { constraints: [...graph.constraints] }),
    approval: graph.approval,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      prompt: node.prompt,
      status: node.status,
      dependsOn: [...node.dependsOn],
      fileOwnership: [...node.fileOwnership],
      ...(node.manifestId === undefined ? {} : { manifestId: node.manifestId }),
      ...(node.acceptanceCriteria === undefined
        ? {}
        : { acceptanceCriteria: [...node.acceptanceCriteria] }),
      evidenceRefs: [...node.evidenceRefs],
    })),
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
/**
 * Keep every per-route replay identity for the same reason as the aggregate
 * ledger; route eviction would make provider/model attribution diverge.
 */
function copyAgentRunUsageRoute(route: AgentRunUsageRoute): AgentRunUsageRoute {
  return {
    provider: route.provider,
    model: route.model,
    eventIds: [...new Set(route.eventIds)],
    ...(route.inputTokens === undefined ? {} : { inputTokens: route.inputTokens }),
    ...(route.outputTokens === undefined ? {} : { outputTokens: route.outputTokens }),
    ...(route.cacheReadTokens === undefined ? {} : { cacheReadTokens: route.cacheReadTokens }),
    ...(route.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: route.cacheWriteTokens }),
    ...(route.cacheSavingsUsd === undefined ? {} : { cacheSavingsUsd: route.cacheSavingsUsd }),
    ...(route.costUsd === undefined ? {} : { costUsd: route.costUsd }),
  };
}


/**
 * Replay identities intentionally live for the full session. Evicting an older
 * id would let a resumed trace charge lifetime totals a second time.
 */
function copyAgentRunUsage(usage: AgentRunUsage): AgentRunUsage {
  return {
    eventIds: [...new Set(usage.eventIds)],
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.cacheSavingsUsd === undefined ? {} : { cacheSavingsUsd: usage.cacheSavingsUsd }),
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
    ...(usage.routes === undefined ? {} : { routes: usage.routes.map(copyAgentRunUsageRoute) }),
  };
}

const MAX_PERSISTED_TOOL_ACTIVITY = 80;
const WORK_NODE_STATUS_SET = new Set<string>(WORK_NODE_STATUSES);
const TOOL_ACTIVITY_KIND_SET = new Set<string>(TOOL_ACTIVITY_KINDS);
const TOOL_ACTIVITY_STATUS_SET = new Set<string>(TOOL_ACTIVITY_STATUSES);
const MAX_PERSISTED_AGENT_RUNS = 128;
const MAX_PERSISTED_ASYNC_JOBS = 128;
const AGENT_RUN_STATUS_SET = new Set<string>(AGENT_RUN_STATUSES);
const ASYNC_JOB_STATUS_SET = new Set<string>(ASYNC_JOB_STATUSES);

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
  const workGraph = hasOwn(record, "workGraph") ? parseWorkGraph(record.workGraph) : undefined;
  const mainUsage = hasOwn(record, "mainUsage") ? parseAgentRunUsage(record.mainUsage) : undefined;
  const activityValue = record.activity;

  if (
    (hasOwn(record, "manifest") && !manifest)
    || (hasOwn(record, "pendingDecision") && !pendingDecision)
    || (hasOwn(record, "workGraph") && !workGraph)
    || (hasOwn(record, "mainUsage") && !mainUsage)
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
    ...(manifest ? { manifest } : {}),
    ...(pendingDecision ? { pendingDecision } : {}),
    ...(workGraph ? { workGraph } : {}),
    activity,
    agents,
    jobs,
    ...(mainUsage ? { mainUsage } : {}),
  });
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

  const questions = record.questions.map(parseAskUserQuestion);
  if (questions.some((question) => question === undefined)) {
    return undefined;
  }
  const parsedQuestions = questions.filter(
    (question): question is AskUserQuestion => question !== undefined,
  );

  return {
    id: record.id,
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    questions: parsedQuestions,
  };
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
  const constraints = parseOptionalStringList(record, "constraints");
  if (
    !record
    || !isNonEmptyString(record.id)
    || !Array.isArray(record.nodes)
    || (hasOwn(record, "goal") && !isNonEmptyString(record.goal))
    || constraints === null
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
    approval: record.approval,
    nodes: parsedNodes,
  };
}

function parseWorkNode(value: unknown): WorkNode | undefined {
  const record = asRecord(value);
  const dependsOn = parseStringList(record?.dependsOn);
  const fileOwnership = parseStringList(record?.fileOwnership);
  const acceptanceCriteria = parseOptionalStringList(record, "acceptanceCriteria");
  const evidenceRefs = parseStringList(record?.evidenceRefs);
  if (
    !record
    || !isNonEmptyString(record.id)
    || !isNonEmptyString(record.title)
    || !isNonEmptyString(record.prompt)
    || typeof record.status !== "string"
    || !WORK_NODE_STATUS_SET.has(record.status)
    || !dependsOn
    || !fileOwnership
    || (hasOwn(record, "manifestId") && !isNonEmptyString(record.manifestId))
    || acceptanceCriteria === null
    || !evidenceRefs
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
    ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
    evidenceRefs,
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
  const eventIds = parseStringList(record?.eventIds);
  if (
    !record
    || typeof record.provider !== "string"
    || record.provider.trim().length === 0
    || typeof record.model !== "string"
    || record.model.trim().length === 0
    || !eventIds
    || (hasOwn(record, "inputTokens") && !isNonNegativeInteger(record.inputTokens))
    || (hasOwn(record, "outputTokens") && !isNonNegativeInteger(record.outputTokens))
    || (hasOwn(record, "cacheReadTokens") && !isNonNegativeInteger(record.cacheReadTokens))
    || (hasOwn(record, "cacheWriteTokens") && !isNonNegativeInteger(record.cacheWriteTokens))
    || (hasOwn(record, "cacheSavingsUsd") && !isNonNegativeFinite(record.cacheSavingsUsd))
    || (hasOwn(record, "costUsd") && !isNonNegativeFinite(record.costUsd))
  ) {
    return undefined;
  }
  return copyAgentRunUsageRoute({
    provider: record.provider.trim(),
    model: record.model.trim(),
    eventIds,
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
  });
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
    for (const eventId of route.eventIds) {
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
  const eventIds = parseStringList(record?.eventIds);
  const routes = record && hasOwn(record, "routes")
    ? parseAgentRunUsageRoutes(record.routes)
    : undefined;
  if (
    !record
    || !eventIds
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
  if (routes && !usageRoutesMatchAggregate(record, eventIds, routes)) {
    return undefined;
  }


  return copyAgentRunUsage({
    eventIds,
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
