import {
  boundToolActivityPreview,
  createAgentConsoleSnapshot,
  isCoalescibleToolActivity,
  parseAgentConsoleSnapshot,
  type AgentConsoleSnapshot,
  type AgentRun,
  type AgentRunUsage,
  type AgentRunUsageRoute,
  type AsyncJob,
  MAX_QUALITY_REVIEW_HISTORY,
  type QualityReviewHistoryEntry,
  type QualityReviewProjection,
  type QualityProfile,
  type TerminalAgentRunStatus,
  type ToolActivity,
  type WorkNodeStatus,
  type ToolActivityKind,
} from "@unclecode/contracts";

const MAX_TOOL_ACTIVITY = 80;

type TraceRecord = Record<string, unknown>;

/**
 * Projects provider tool lifecycle events into bounded, resume-safe console
 * evidence. Tool output is intentionally never read or retained here.
 */
export function applyTraceEventToAgentConsole(
  snapshot: AgentConsoleSnapshot,
  event: { readonly type: string },
  usageRecorder?: AgentConsoleUsageRecorder,
): AgentConsoleSnapshot {
  const evolutionSnapshot = applyEvolutionProposalEvent(snapshot, event);
  if (evolutionSnapshot !== snapshot) {
    return evolutionSnapshot;
  }
  const lifecycleSnapshot = applyAgentLifecycleEvent(snapshot, event, usageRecorder);
  if (lifecycleSnapshot !== snapshot) {
    return lifecycleSnapshot;
  }

  const workSnapshot = applyWorkLifecycleEvent(snapshot, event);
  if (workSnapshot !== snapshot) {
    return workSnapshot;
  }

  return applyToolLifecycleEvent(snapshot, event);
}

function applyEvolutionProposalEvent(
  snapshot: AgentConsoleSnapshot,
  event: { readonly type: string },
): AgentConsoleSnapshot {
  if (event.type !== "evolution.proposed") return snapshot;
  const trace = asRecord(event);
  const proposal = asRecord(trace?.proposal);
  const runId = trace ? readNonEmptyString(trace, "runId") : undefined;
  if (trace?.recorded !== true || !proposal || !runId || proposal.runId !== runId) {
    return snapshot;
  }
  const id = readNonEmptyString(proposal, "id");
  const candidateId = readNonEmptyString(proposal, "candidateId");
  if (!id || !candidateId) return snapshot;
  const retained = (snapshot.evolutionProposals ?? []).filter((current) =>
    current.id !== id && !(current.runId === runId && current.candidateId === candidateId));
  return parseAgentConsoleSnapshot({
    ...snapshot,
    evolutionProposals: [...retained, proposal].slice(-32),
  }) ?? snapshot;
}

/**
 * Projects one tool call into the bounded activity list and, when the call is
 * owned by a subagent, points that run at what it is doing. Both writes land in
 * a single projection so a run's `currentActivity` can never disagree with the
 * activity row it was derived from.
 */
function applyToolLifecycleEvent(
  snapshot: AgentConsoleSnapshot,
  event: { readonly type: string },
): AgentConsoleSnapshot {
  if (event.type !== "tool.started" && event.type !== "tool.completed") {
    return snapshot;
  }

  const trace = asRecord(event);
  if (!trace) {
    return snapshot;
  }
  const toolCallId = readNonEmptyString(trace, "toolCallId");
  const toolName = readNonEmptyString(trace, "toolName");
  if (!toolCallId || !toolName) {
    return snapshot;
  }

  const existingIndex = snapshot.activity.findIndex((activity) => activity.toolCallId === toolCallId);
  const current = existingIndex === -1 ? undefined : snapshot.activity[existingIndex];
  // A tool call reports its outcome once. A late start or a repeated
  // completion would rewrite a row the console has already settled — and drag
  // the owning run's current activity back onto it — so both are dropped.
  if (current && current.status !== "running") {
    return snapshot;
  }
  const startedAt = readTimestamp(trace, "startedAt") ?? current?.startedAt ?? Date.now();
  const input = asRecord(trace.input);
  const scopedRunId = resolveToolAgentRunId(snapshot, trace);
  // A call keeps the owner it was opened with. A later event claiming a
  // different run is mis-routed, and honouring it would move the row and drag
  // both runs' current activity onto a call neither of them made.
  if (
    scopedRunId !== undefined
    && current?.agentRunId !== undefined
    && scopedRunId !== current.agentRunId
  ) {
    return snapshot;
  }
  const agentRunId = scopedRunId ?? current?.agentRunId;
  const nextActivity = event.type === "tool.started"
    ? createStartedActivity({ toolCallId, toolName, startedAt, input, current, agentRunId })
    : createCompletedActivity({ toolCallId, toolName, startedAt, input, trace, current, agentRunId });

  const activity = existingIndex === -1
    ? [...snapshot.activity, nextActivity]
    : snapshot.activity.map((entry, index) => index === existingIndex ? nextActivity : entry);

  return createAgentConsoleSnapshot({
    ...snapshot,
    activity: capToolActivity(activity),
    agents: withCurrentActivity(snapshot.agents, agentRunId, nextActivity.intent),
  });
}

/**
 * Attribute a tool call to the run that made it. The run id is authoritative;
 * an async job id is resolved through the job that owns the run, which is how
 * background work reports calls it never tagged with a run id. Blank
 * identifiers count as absent so a main-agent call is never mis-scoped.
 */
function resolveToolAgentRunId(
  snapshot: AgentConsoleSnapshot,
  trace: TraceRecord,
): string | undefined {
  const agentRunId = readNonEmptyString(trace, "agentRunId");
  if (agentRunId) {
    return agentRunId;
  }
  const asyncJobId = readNonEmptyString(trace, "asyncJobId");
  return asyncJobId
    ? snapshot.jobs.find((job) => job.id === asyncJobId)?.agentRunId
    : undefined;
}

/**
 * Point one active run at the intent it is working through. Only a run that is
 * actually executing is touched: a queued run has not reached a tool call yet,
 * a settled run must not be reanimated by a straggling event, and an unknown
 * run id scopes nothing rather than fabricating an agent.
 */
function withCurrentActivity(
  agents: readonly AgentRun[],
  agentRunId: string | undefined,
  currentActivity: string,
): readonly AgentRun[] {
  if (!agentRunId) {
    return agents;
  }
  const index = agents.findIndex((agent) => agent.id === agentRunId);
  const current = index === -1 ? undefined : agents[index];
  if (
    !current
    || (current.status !== "running" && current.status !== "waiting")
    || current.currentActivity === currentActivity
  ) {
    return agents;
  }
  return agents.map((agent, at) => at === index ? { ...agent, currentActivity } : agent);
}

function applyAgentLifecycleEvent(
  snapshot: AgentConsoleSnapshot,
  event: { readonly type: string },
  usageRecorder: AgentConsoleUsageRecorder | undefined,
): AgentConsoleSnapshot {
  const trace = asRecord(event);
  if (!trace) {
    return snapshot;
  }

  if (event.type === "usage.recorded") {
    return applyUsageEvent(snapshot, trace, usageRecorder);
  }

  if (event.type === "job.queued") {
    const id = readNonEmptyString(trace, "jobId");
    const type = readNonEmptyString(trace, "jobType");
    const label = readNonEmptyString(trace, "label");
    const queuedAt = readTimestamp(trace, "queuedAt");
    if (!id || !type || !label || queuedAt === undefined) {
      return snapshot;
    }
    // A job is queued once. A repeat is a replay or a stale re-emit; honouring
    // it would reset a job that has since started or settled.
    if (snapshot.jobs.some((job) => job.id === id)) {
      return snapshot;
    }
    const agentRunId = readNonEmptyString(trace, "agentRunId");
    const job: AsyncJob = {
      id,
      type,
      label,
      status: "queued",
      ...(agentRunId ? { agentRunId } : {}),
      queuedAt,
    };
    return createAgentConsoleSnapshot({
      ...snapshot,
      jobs: upsertById(snapshot.jobs, job),
    });
  }

  if (event.type === "job.settled") {
    const id = readNonEmptyString(trace, "jobId");
    const completedAt = readTimestamp(trace, "completedAt");
    const status = readTerminalStatus(trace.status);
    const current = snapshot.jobs.find((job) => job.id === id);
    if (!id || !current || completedAt === undefined || !status) {
      return snapshot;
    }
    // A job an agent run owns settles only with that run, in the run's own
    // projection: honouring a standalone settlement here would leave a finished
    // job beside a run the console still shows as live. The event cannot be
    // trusted to name its owner — a foreign, matching, or absent `agentRunId`
    // all describe the same split — so the job's own link is what decides. A
    // job that never opened a run still settles on its own, which is how work
    // that was queued and then blocked or cancelled before dispatch reaches a
    // terminal status at all.
    if (current.agentRunId !== undefined) {
      return snapshot;
    }
    const startedAt = readTimestamp(trace, "startedAt");
    // A job settles once, and never against a timeline that runs backwards: a
    // supplied start cannot predate the queueing or an earlier recorded start,
    // and completion cannot predate any bound the job already carries.
    if (
      readTerminalStatus(current.status)
      || completedAt < current.queuedAt
      || (current.startedAt !== undefined && completedAt < current.startedAt)
      || (startedAt !== undefined
        && (startedAt < current.queuedAt
          || completedAt < startedAt
          || (current.startedAt !== undefined && startedAt < current.startedAt)))
    ) {
      return snapshot;
    }
    const summary = readNonEmptyString(trace, "summary");
    const errorSummary = readNonEmptyString(trace, "errorSummary");
    const job: AsyncJob = {
      ...current,
      status,
      ...(startedAt === undefined ? {} : { startedAt }),
      completedAt,
      ...(summary ? { summary } : {}),
      ...(errorSummary ? { errorSummary } : {}),
    };
    return createAgentConsoleSnapshot({ ...snapshot, jobs: upsertById(snapshot.jobs, job) });
  }

  if (event.type === "agent.run.started") {
    const id = readNonEmptyString(trace, "runId");
    const displayName = readNonEmptyString(trace, "displayName");
    const agentType = readNonEmptyString(trace, "agentType");
    const startedAt = readTimestamp(trace, "startedAt");
    if (!id || !displayName || !agentType || startedAt === undefined) {
      return snapshot;
    }
    // A run id is issued once — a continuation is a new run. A repeat is a
    // replay or a stale re-emit, and honouring it would resurrect a run that
    // has already settled.
    if (snapshot.agents.some((agent) => agent.id === id)) {
      return snapshot;
    }
    const parentRunId = readNonEmptyString(trace, "parentRunId");
    const continuationOf = readNonEmptyString(trace, "continuationOf");
    const agent: AgentRun = {
      id,
      displayName,
      agentType,
      status: "running",
      ...(parentRunId ? { parentRunId } : {}),
      ...(continuationOf ? { continuationOf } : {}),
      startedAt,
    };
    // Every run owns exactly one job, and that link travels on the event. The
    // named job has to exist and has to be able to adopt this run: a settled
    // job cannot be reopened, a job already owned by another run cannot be
    // stolen, and a run cannot predate the job that queued it. Anything else
    // is mis-routed, so the whole event is rejected rather than registering a
    // run beside a job that never took ownership.
    const jobId = readNonEmptyString(trace, "jobId");
    const linkedJob = jobId === undefined
      ? undefined
      : snapshot.jobs.find((job) => job.id === jobId);
    if (
      !linkedJob
      || readTerminalStatus(linkedJob.status)
      || (linkedJob.agentRunId !== undefined && linkedJob.agentRunId !== id)
      || linkedJob.queuedAt > startedAt
    ) {
      return snapshot;
    }
    return createAgentConsoleSnapshot({
      ...snapshot,
      agents: upsertById(snapshot.agents, agent),
      // Keyed on the resolved record, so no other job can be reached from here.
      jobs: upsertById(snapshot.jobs, {
        ...linkedJob,
        agentRunId: id,
        status: "running" as const,
        startedAt,
      }),
    });
  }

  if (event.type !== "agent.run.settled") {
    return snapshot;
  }
  const id = readNonEmptyString(trace, "runId");
  const current = snapshot.agents.find((agent) => agent.id === id);
  const completedAt = readTimestamp(trace, "completedAt");
  const status = readTerminalStatus(trace.status);
  if (!id || !current || completedAt === undefined || !status) {
    return snapshot;
  }
  // A run settles once, and never before it started.
  if (readTerminalStatus(current.status) || completedAt < current.startedAt) {
    return snapshot;
  }
  const summary = readNonEmptyString(trace, "summary");
  const errorSummary = readNonEmptyString(trace, "errorSummary");
  // A settled run has no in-flight tool call, so the transient activity label
  // is dropped instead of freezing at whatever tool happened to run last.
  const { currentActivity, ...settled } = current;
  const agent: AgentRun = {
    ...settled,
    status,
    completedAt,
    ...(summary ? { summary } : {}),
    ...(errorSummary ? { errorSummary } : {}),
  };
  // A run settles with the job it owns, in the same projection, so the console
  // can never render a finished agent beside a job that is still running. The
  // link has to name that exact job: an absent, unknown, unowned, or
  // foreign-owned job means ownership was never established, and a job whose
  // own timeline outlives the run is mis-routed. Reject the event rather than
  // settle half of it.
  const jobId = readNonEmptyString(trace, "jobId");
  const linkedJob = jobId === undefined
    ? undefined
    : snapshot.jobs.find((job) => job.id === jobId);
  if (
    !linkedJob
    || linkedJob.agentRunId !== id
    || linkedJob.queuedAt > completedAt
    || (linkedJob.startedAt !== undefined && linkedJob.startedAt > completedAt)
  ) {
    return snapshot;
  }
  return createAgentConsoleSnapshot({
    ...snapshot,
    agents: upsertById(snapshot.agents, agent),
    jobs: settleLinkedJob(snapshot.jobs, linkedJob, {
      status,
      completedAt,
      summary,
      errorSummary,
    }),
  });
}

/**
 * Settle the job that owns a run, inside the run's own projection. A job that
 * already reached a terminal status keeps its own record instead of inheriting
 * the run's.
 */
function settleLinkedJob(
  jobs: readonly AsyncJob[],
  current: AsyncJob,
  settlement: {
    readonly status: AsyncJob["status"];
    readonly completedAt: number;
    readonly summary: string | undefined;
    readonly errorSummary: string | undefined;
  },
): readonly AsyncJob[] {
  if (readTerminalStatus(current.status)) {
    return jobs;
  }
  return upsertById(jobs, {
    ...current,
    status: settlement.status,
    completedAt: settlement.completedAt,
    ...(settlement.summary === undefined ? {} : { summary: settlement.summary }),
    ...(settlement.errorSummary === undefined ? {} : { errorSummary: settlement.errorSummary }),
  });
}

const USAGE_TOKEN_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
const USAGE_MONEY_KEYS = ["cacheSavingsUsd", "costUsd"] as const;

export type AgentConsoleUsageCounterVector = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheSavingsUsd: number;
  readonly costUsd: number;
};

export type AgentConsoleUsageTotalsSnapshot = {
  readonly session: AgentConsoleUsageCounterVector;
  readonly byMain: readonly {
    readonly mainId: string;
    readonly totals: AgentConsoleUsageCounterVector;
  }[];
  readonly byAgent: readonly {
    readonly agentId: string;
    readonly totals: AgentConsoleUsageCounterVector;
  }[];
  readonly byRoute: readonly {
    readonly provider: string;
    readonly model: string;
    readonly totals: AgentConsoleUsageCounterVector;
  }[];
};

export type AgentConsoleUsageRecordInput = {
  readonly eventId: string;
  readonly agentId?: string;
  readonly route: { readonly provider: string; readonly model: string };
  readonly counters: AgentConsoleUsageCounterVector;
};

export type AgentConsoleUsageRecordResult =
  | {
      readonly kind: "recorded" | "duplicate";
      readonly mainId: string;
      readonly totals: AgentConsoleUsageTotalsSnapshot;
    }
  | { readonly kind: "scope_mismatch" };

/** Narrow synchronous port owned by the persistent runtime process. */
export interface AgentConsoleUsageRecorder {
  recordUsage(input: AgentConsoleUsageRecordInput): AgentConsoleUsageRecordResult;
}

export type RuntimeUsageLedgerPort = {
  recordUsage(input: AgentConsoleUsageRecordInput & {
    readonly sessionId: string;
    readonly mainId?: string;
  }): { readonly kind: "recorded" | "duplicate" | "scope_mismatch" };
  snapshotUsageTotals(
    sessionId: string,
    options?: {
      readonly mainIds?: readonly string[];
      readonly agentIds?: readonly string[];
      readonly includeRoutes?: boolean;
    },
  ): AgentConsoleUsageTotalsSnapshot;
};

/**
 * Bind one owner-opened ledger to one session. The adapter requests only the
 * main projection and the at-most-128 agent rows the console can retain; exact
 * event membership and lifetime session totals remain SQLite-owned.
 */
export function bindRuntimeUsageRecorder(input: {
  readonly sessionId: string;
  readonly ledger: RuntimeUsageLedgerPort;
  readonly mainId?: string;
  readonly projectedAgentIds?: (() => readonly string[]) | undefined;
}): AgentConsoleUsageRecorder {
  const mainId = input.mainId ?? "main";
  return {
    recordUsage(usage) {
      const result = input.ledger.recordUsage({
        ...usage,
        sessionId: input.sessionId,
        ...(usage.agentId ? {} : { mainId }),
      });
      if (result.kind === "scope_mismatch") return { kind: "scope_mismatch" };
      const projectedAgentIds = [...new Set(input.projectedAgentIds?.() ?? (
        usage.agentId ? [usage.agentId] : []
      ))].slice(-128);
      return {
        kind: result.kind,
        mainId,
        totals: input.ledger.snapshotUsageTotals(input.sessionId, {
          mainIds: [mainId],
          agentIds: projectedAgentIds,
          includeRoutes: true,
        }),
      };
    },
  };
}

/**
 * Gate a usage measurement before it reaches a ledger.
 *
 * Three things are settled before the write: which ledger already owns the
 * event id, whether the scope on the wire is meaningful, and whether the
 * resulting totals are still values a resume can reload. Each failure returns
 * the caller's snapshot, so a bad measurement is inert rather than half-applied.
 */
function applyUsageEvent(
  snapshot: AgentConsoleSnapshot,
  trace: TraceRecord,
  recorder: AgentConsoleUsageRecorder | undefined,
): AgentConsoleSnapshot {
  const eventId = readNonEmptyString(trace, "eventId");
  if (!eventId || !recorder) {
    return snapshot;
  }
  const provider = readNonEmptyString(trace, "provider");
  const model = readNonEmptyString(trace, "model");
  if (!provider || !model) {
    return snapshot;
  }


  // Only an omitted scope means the main session. `exactOptionalPropertyTypes`
  // lets a producer leave `agentRunId` out; it never lets one set the property
  // to undefined. So a present property that is not a usable run id is a broken
  // producer, and charging main usage for it would book a subagent's spend
  // against the session.
  const agentRunId = readNonEmptyString(trace, "agentRunId");
  if (Object.hasOwn(trace, "agentRunId") && !agentRunId) {
    return snapshot;
  }

  const scopedRun = agentRunId
    ? snapshot.agents.find((agent) => agent.id === agentRunId)
    : undefined;
  if (agentRunId && !scopedRun) {
    return snapshot;
  }
  if (!usageTraceIsStorable(trace)) return snapshot;

  const counters = readUsageCounterVector(trace);
  try {
    const result = recorder.recordUsage({
      eventId,
      ...(agentRunId ? { agentId: agentRunId } : {}),
      route: { provider, model },
      counters,
    });
    if (result.kind === "scope_mismatch") return snapshot;
    if (
      result.kind === "duplicate"
      && usageTotalsAlreadyMaterialized(snapshot, result.mainId, result.totals)
    ) return snapshot;
    return materializeUsageTotals(snapshot, result.mainId, result.totals);
  } catch {
    // The projection never guesses after an owner-ledger failure. A write that
    // committed before a read failure is recovered by the next exact replay.
    return snapshot;
  }
}

function usageTotalsAlreadyMaterialized(
  snapshot: AgentConsoleSnapshot,
  mainId: string,
  totals: AgentConsoleUsageTotalsSnapshot,
): boolean {
  if (!sameUsageVector(snapshot.totalUsage, totals.session)) return false;
  const routes = snapshot.totalUsage?.routes ?? [];
  if (
    routes.length !== totals.byRoute.length
    || totals.byRoute.some((entry, index) => {
      const route = routes[index];
      return route?.provider !== entry.provider
        || route.model !== entry.model
        || !sameUsageVector(route, entry.totals);
    })
  ) return false;
  const mainUsage = totals.byMain.find((entry) => entry.mainId === mainId)?.totals;
  if (mainUsage && !sameUsageVector(snapshot.mainUsage, mainUsage)) return false;
  for (const entry of totals.byAgent) {
    const usage = snapshot.agents.find((agent) => agent.id === entry.agentId)?.usage;
    if (!sameUsageVector(usage, entry.totals)) return false;
  }
  return true;
}

function sameUsageVector(
  usage: AgentRunUsage | AgentRunUsageRoute | undefined,
  vector: AgentConsoleUsageCounterVector,
): boolean {
  return usage !== undefined
    && USAGE_TOKEN_KEYS.every((key) => (usage[key] ?? 0) === vector[key])
    && USAGE_MONEY_KEYS.every((key) => (usage[key] ?? 0) === vector[key]);
}

function materializeUsageTotals(
  snapshot: AgentConsoleSnapshot,
  mainId: string,
  totals: AgentConsoleUsageTotalsSnapshot,
): AgentConsoleSnapshot {
  if (
    !usageVectorIsStorable(totals.session)
    || totals.byMain.some((entry) => !usageVectorIsStorable(entry.totals))
    || totals.byAgent.some((entry) => !usageVectorIsStorable(entry.totals))
    || totals.byRoute.some((entry) => !usageVectorIsStorable(entry.totals))
  ) {
    return snapshot;
  }
  const mainUsage = totals.byMain.find((entry) => entry.mainId === mainId)?.totals;
  const byAgent = new Map(totals.byAgent.map((entry) => [entry.agentId, entry.totals]));
  const totalUsage: AgentRunUsage = {
    ...totals.session,
    routes: totals.byRoute.map((entry): AgentRunUsageRoute => ({
      provider: entry.provider,
      model: entry.model,
      ...entry.totals,
    })),
  };
  return createAgentConsoleSnapshot({
    ...snapshot,
    ...(mainUsage ? { mainUsage } : {}),
    totalUsage,
    agents: snapshot.agents.map((agent) => {
      const usage = byAgent.get(agent.id);
      return usage ? { ...agent, usage } : agent;
    }),
  });
}

function usageTraceIsStorable(trace: TraceRecord): boolean {
  for (const key of USAGE_TOKEN_KEYS) {
    const value = trace[key];
    if (
      typeof value === "number"
      && value > 0
      && Number.isInteger(value)
      && !Number.isSafeInteger(value)
    ) return false;
  }
  return true;
}

function usageVectorIsStorable(vector: AgentConsoleUsageCounterVector): boolean {
  return USAGE_TOKEN_KEYS.every((key) => Number.isSafeInteger(vector[key]) && vector[key] >= 0)
    && USAGE_MONEY_KEYS.every((key) => Number.isFinite(vector[key]) && vector[key] >= 0);
}

function readUsageCounterVector(trace: TraceRecord): AgentConsoleUsageCounterVector {
  const vector = {} as Record<keyof AgentConsoleUsageCounterVector, number>;
  for (const key of USAGE_TOKEN_KEYS) {
    const value = trace[key];
    vector[key] = typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value
      : 0;
  }
  for (const key of USAGE_MONEY_KEYS) {
    const value = trace[key];
    vector[key] = typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : 0;
  }
  return vector;
}

function upsertById<T extends { readonly id: string }>(items: readonly T[], item: T): readonly T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  return index === -1
    ? [...items, item]
    : items.map((candidate, candidateIndex) => candidateIndex === index ? item : candidate);
}

/**
 * Runs and jobs share one terminal vocabulary, so one reader keeps a run and
 * the job it owns from settling on different words for the same outcome.
 */
function readTerminalStatus(value: unknown): TerminalAgentRunStatus | undefined {
  return value === "completed" || value === "failed"
    || value === "cancelled" || value === "interrupted"
    ? value
    : undefined;
}

function applyWorkLifecycleEvent(
  snapshot: AgentConsoleSnapshot,
  event: { readonly type: string },
): AgentConsoleSnapshot {
  const trace = asRecord(event);
  if (!trace) {
    return snapshot;
  }

  if (event.type === "work.proposed") {
    const parsed = parseAgentConsoleSnapshot({
      ...snapshot,
      workGraph: trace.graph,
    });
    if (
      !parsed?.workGraph
      || parsed.workGraph.id !== readNonEmptyString(trace, "graphId")
    ) {
      return snapshot;
    }
    return parsed;
  }

  if (
    event.type === "quality.stage_started"
    || event.type === "quality.gate_evaluated"
    || event.type === "quality.refine_requested"
    || event.type === "quality.pivot_requested"
    || event.type === "quality.completed"
  ) {
    const graph = snapshot.workGraph;
    const graphId = readNonEmptyString(trace, "graphId");
    if (!graphId || (graph && graphId !== graph.id)) return snapshot;
    const stage = readQualityStage(trace.stage);
    const iteration = readNonNegativeInteger(trace.iteration);
    const currentIteration = graph?.iteration ?? snapshot.qualityReview?.iteration ?? 0;
    if (!stage || iteration === undefined || iteration < currentIteration) return snapshot;
    const gateStatus = event.type === "quality.stage_started"
      ? graph?.gateStatus ?? snapshot.qualityReview?.latestDecision ?? "unproven"
      : readQualityGateStatus(trace.decision);
    if (!gateStatus) return snapshot;

    const nodeId = readNonEmptyString(trace, "nodeId");
    const nodeAttempt = readNonNegativeInteger(trace.nodeAttempt);
    const artifactRefs = readQualityArtifactRefs(trace.artifactRefs);
    const nodes = nodeId && graph
      ? graph.nodes.map((node) => {
          if (node.id !== nodeId) return node;
          return {
            ...node,
            stage,
            ...(nodeAttempt === undefined ? {} : { attempt: Math.max(node.attempt, nodeAttempt) }),
            ...(artifactRefs === undefined
              ? {}
              : { artifactRefs: [...new Set([...node.artifactRefs, ...artifactRefs])] }),
          };
        })
      : graph?.nodes;
    const qualityReview = event.type === "quality.stage_started"
      ? projectQualityStage(snapshot.qualityReview, trace, stage, iteration)
      : projectQualityReview(snapshot.qualityReview, trace, event.type, stage, gateStatus, iteration);
    if (!qualityReview) return snapshot;
    return createAgentConsoleSnapshot({
      ...snapshot,
      ...(graph && nodes ? { workGraph: { ...graph, currentStage: stage, gateStatus, iteration, nodes } } : {}),
      qualityReview,
    });
  }

  const graph = snapshot.workGraph;
  if (!graph || readNonEmptyString(trace, "graphId") !== graph.id) return snapshot;

  if (event.type === "work.approved") {
    return createAgentConsoleSnapshot({
      ...snapshot,
      workGraph: { ...graph, approval: "approved" },
    });
  }

  if (event.type !== "work.status") {
    return snapshot;
  }
  const nodeId = readNonEmptyString(trace, "nodeId");
  const status = readWorkNodeStatus(trace.status);
  const node = nodeId === undefined
    ? undefined
    : graph.nodes.find((candidate) => candidate.id === nodeId);
  // A node reports each outcome once. A terminal node is finished work, so a
  // straggling start from a runner that has already been torn down — or a
  // repeated terminal event — must not rewrite the plan after the fact.
  if (
    !node
    || !status
    || node.status === status
    || node.status === "completed"
    || node.status === "failed"
    || node.status === "cancelled"
  ) {
    return snapshot;
  }
  return createAgentConsoleSnapshot({
    ...snapshot,
    workGraph: {
      ...graph,
      nodes: graph.nodes.map((candidate) =>
        candidate.id === node.id ? { ...candidate, status } : candidate),
    },
  });
}

function projectQualityStage(
  current: QualityReviewProjection | undefined,
  trace: TraceRecord,
  stage: QualityReviewHistoryEntry["stage"],
  iteration: number,
): QualityReviewProjection | undefined {
  const runId = readNonEmptyString(trace, "runId");
  const graphId = readNonEmptyString(trace, "graphId");
  const profile = readQualityProfile(trace.profile);
  if (!runId || !graphId || !profile) return undefined;
  const sameRun = current?.runId === runId && current.graphId === graphId;
  return {
    runId,
    graphId,
    profile,
    currentStage: stage,
    iteration,
    refineCount: sameRun ? current.refineCount : 0,
    pivotCount: sameRun ? current.pivotCount : 0,
    latestDecision: sameRun ? current.latestDecision : "unproven",
    history: sameRun ? current.history : [],
  };
}

function projectQualityReview(
  current: QualityReviewProjection | undefined,
  trace: TraceRecord,
  type: "quality.gate_evaluated" | "quality.refine_requested" | "quality.pivot_requested" | "quality.completed",
  stage: QualityReviewHistoryEntry["stage"],
  decision: QualityReviewHistoryEntry["decision"],
  iteration: number,
): QualityReviewProjection | undefined {
  const runId = readNonEmptyString(trace, "runId");
  const graphId = readNonEmptyString(trace, "graphId");
  const startedAt = readTimestamp(trace, "startedAt");
  const profile = readQualityProfile(trace.profile);
  if (!runId || !graphId || !profile || startedAt === undefined) return undefined;
  const sameRun = current?.runId === runId && current.graphId === graphId;
  const baseHistory = sameRun ? current.history : [];
  const failures = readQualityArtifactRefs(trace.failures) ?? [];
  const evidenceRefs = readQualityArtifactRefs(trace.evidenceRefs) ?? [];
  const artifactRefs = readQualityArtifactRefs(trace.artifactRefs) ?? [];
  const reason = readNonEmptyString(trace, "reason");
  const provider = readNonEmptyString(trace, "provider");
  const model = readNonEmptyString(trace, "model");
  const artifactHash = readNonEmptyString(trace, "artifactHash");
  const reviewedArtifactHash = readNonEmptyString(trace, "reviewedArtifactHash");
  const currentArtifactHash = readNonEmptyString(trace, "currentArtifactHash");
  const reviewerRunId = readNonEmptyString(trace, "reviewerRunId")
    ?? readNonEmptyString(trace, "agentRunId");
  const routeValue = readNonEmptyString(trace, "route");
  const route = routeValue === "direct" || routeValue === "frontier"
    || routeValue === "commodity" || routeValue === "fallback" ? routeValue : undefined;
  const count = readNonNegativeInteger(trace.count);
  const limit = readNonNegativeInteger(trace.limit);
  const refineCount = type === "quality.refine_requested"
    ? count ?? (sameRun ? current.refineCount : 0)
    : readNonNegativeInteger(trace.refineCount) ?? (sameRun ? current.refineCount : 0);
  const pivotCount = type === "quality.pivot_requested"
    ? count ?? (sameRun ? current.pivotCount : 0)
    : readNonNegativeInteger(trace.pivotCount) ?? (sameRun ? current.pivotCount : 0);
  const stale = trace.stale === true;
  const verifiedCritic = type === "quality.completed"
    && stage === "promote"
    && decision === "proceed"
    && trace.independentVerification === true
    && !stale
    ? findVerifiedCritic(baseHistory, iteration, { artifactHash, reviewedArtifactHash, currentArtifactHash })
    : undefined;
  const terminalArtifactRefs = verifiedCritic
    ? [...new Set([...artifactRefs, ...evidenceRefs, ...verifiedCritic.artifactRefs, ...verifiedCritic.evidenceRefs])].slice(0, 64)
    : artifactRefs;
  const entry: QualityReviewHistoryEntry = {
    event: type === "quality.gate_evaluated" ? "gate"
      : type === "quality.refine_requested" ? "refine"
        : type === "quality.pivot_requested" ? "pivot" : "completed",
    stage,
    decision,
    iteration,
    ...(reason ? { reason } : {}),
    failures,
    evidenceRefs,
    artifactRefs: terminalArtifactRefs,
    ...(artifactHash ? { artifactHash } : verifiedCritic?.artifactHash ? { artifactHash: verifiedCritic.artifactHash } : {}),
    ...(reviewedArtifactHash ? { reviewedArtifactHash } : verifiedCritic?.reviewedArtifactHash ? { reviewedArtifactHash: verifiedCritic.reviewedArtifactHash } : {}),
    ...(currentArtifactHash ? { currentArtifactHash } : verifiedCritic?.currentArtifactHash ? { currentArtifactHash: verifiedCritic.currentArtifactHash } : {}),
    ...(verifiedCritic?.reviewerId ? { reviewerId: verifiedCritic.reviewerId }
      : provider && model ? { reviewerId: `${stage}:${provider}:${model}` } : {}),
    ...(reviewerRunId ? { reviewerRunId } : verifiedCritic?.reviewerRunId ? { reviewerRunId: verifiedCritic.reviewerRunId } : {}),
    ...(provider ? { provider } : verifiedCritic?.provider ? { provider: verifiedCritic.provider } : {}),
    ...(model ? { model } : verifiedCritic?.model ? { model: verifiedCritic.model } : {}),
    ...(route ? { route } : verifiedCritic?.route ? { route: verifiedCritic.route } : {}),
    ...(count === undefined ? {} : { count }),
    ...(limit === undefined ? {} : { limit }),
    independentVerification: type === "quality.completed"
      ? verifiedCritic !== undefined
      : trace.independentVerification === true,
    stale,
    startedAt,
  };
  return {
    runId,
    graphId,
    profile,
    currentStage: stage,
    iteration,
    refineCount,
    pivotCount,
    latestDecision: decision,
    history: [...baseHistory, entry].slice(-MAX_QUALITY_REVIEW_HISTORY),
  };
}

function findVerifiedCritic(
  history: readonly QualityReviewHistoryEntry[],
  iteration: number,
  terminalHashes: {
    readonly artifactHash: string | undefined;
    readonly reviewedArtifactHash: string | undefined;
    readonly currentArtifactHash: string | undefined;
  },
): QualityReviewHistoryEntry | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.event === "refine" || entry?.event === "pivot") break;
    if (
      !entry || entry.iteration !== iteration || entry.event !== "gate" || entry.stage !== "critic"
      || entry.decision !== "proceed" || !entry.independentVerification || entry.stale
      || !entry.reviewerRunId || !qualityHashesAgree(entry) || !qualityHashesAgree(terminalHashes)
    ) continue;
    const criticHash = entry.currentArtifactHash ?? entry.reviewedArtifactHash ?? entry.artifactHash;
    const terminalHash = terminalHashes.currentArtifactHash ?? terminalHashes.reviewedArtifactHash ?? terminalHashes.artifactHash;
    if (criticHash && terminalHash && criticHash !== terminalHash) continue;
    return entry;
  }
  return undefined;
}

function qualityHashesAgree(value: {
  readonly reviewedArtifactHash?: string | undefined;
  readonly currentArtifactHash?: string | undefined;
}): boolean {
  return !value.reviewedArtifactHash || !value.currentArtifactHash
    || value.reviewedArtifactHash === value.currentArtifactHash;
}

function readQualityProfile(value: unknown): QualityProfile | undefined {
  return value === "minimal" || value === "standard" || value === "deep" || value === "creator"
    ? value
    : undefined;
}

function readWorkNodeStatus(value: unknown): WorkNodeStatus | undefined {
  return typeof value === "string" && [
    "proposed",
    "approved",
    "ready",
    "running",
    "blocked",
    "requires_action",
    "completed",
    "failed",
    "cancelled",
  ].includes(value)
    ? value as WorkNodeStatus
    : undefined;
}

function readQualityStage(value: unknown): "explore" | "plan" | "work" | "critic" | "promote" | undefined {
  return value === "explore" || value === "plan" || value === "work" || value === "critic" || value === "promote"
    ? value
    : undefined;
}

function readQualityGateStatus(
  value: unknown,
): "proceed" | "refine" | "pivot" | "block" | "unproven" | undefined {
  return value === "proceed" || value === "refine" || value === "pivot" || value === "block" || value === "unproven"
    ? value
    : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readQualityArtifactRefs(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 64);
}

function createStartedActivity(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startedAt: number;
  readonly input: TraceRecord | undefined;
  readonly current: ToolActivity | undefined;
  readonly agentRunId: string | undefined;
}): ToolActivity {
  const target = input.current?.target ?? deriveToolTarget(input.input);
  return {
    id: input.current?.id ?? `tool:${input.toolCallId}`,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    kind: input.current?.kind ?? classifyToolActivityKind(input.toolName),
    intent: input.current?.intent ?? deriveToolIntent(input.toolName, input.input),
    status: "running",
    ...(target ? { target } : {}),
    startedAt: input.startedAt,
    ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
  };
}

function createCompletedActivity(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startedAt: number;
  readonly input: TraceRecord | undefined;
  readonly trace: TraceRecord;
  readonly current: ToolActivity | undefined;
  readonly agentRunId: string | undefined;
}): ToolActivity {
  const completedAt = readTimestamp(input.trace, "completedAt") ?? Date.now();
  const durationMs = readTimestamp(input.trace, "durationMs") ?? Math.max(0, completedAt - input.startedAt);
  const failed = input.trace.isError === true;
  const outputMetric = deriveToolOutputMetric(readNonEmptyString(input.trace, "output"));
  const kind = input.current?.kind ?? classifyToolActivityKind(input.toolName);

  const target = input.current?.target ?? deriveToolTarget(input.input);
  const preview = deriveToolActivityPreview({ kind, trace: input.trace, input: input.input });
  return {
    id: input.current?.id ?? `tool:${input.toolCallId}`,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    kind,
    intent: input.current?.intent ?? deriveToolIntent(input.toolName, input.input),
    status: failed ? "failed" : "completed",
    ...(target ? { target } : {}),
    ...(preview ? { preview } : {}),
    summary: [
      failed ? "failed" : "completed",
      `${durationMs}ms`,
      ...(outputMetric ? [outputMetric] : []),
    ].join(" · "),
    startedAt: input.startedAt,
    completedAt,
    ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
  };
}

export const UNIFIED_DIFF_HUNK_RE = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m;

const UNIFIED_DIFF_HUNK_LINE_RE = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/;

const UNIFIED_DIFF_FILE_BOUNDARY_RE = /^(?:diff --git |--- |\+\+\+ )/;

/**
 * Count added/removed lines inside the unified-diff hunks embedded in a tool
 * output. Returns undefined when the output carries no hunk header at all, so
 * callers can render `+N −M` stats only for genuine diff output. File-level
 * boundary lines (`diff --git`, `--- `, `+++ `) end the current hunk instead of
 * being miscounted as content, which keeps multi-file patches honest.
 */
export function countUnifiedDiffLines(
  output: string | undefined,
): { readonly additions: number; readonly deletions: number } | undefined {
  const normalized = output?.trim();
  if (!normalized || !UNIFIED_DIFF_HUNK_RE.test(normalized)) {
    return undefined;
  }
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of normalized.split(/\r?\n/)) {
    if (UNIFIED_DIFF_HUNK_LINE_RE.test(line)) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (UNIFIED_DIFF_FILE_BOUNDARY_RE.test(line)) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

/**
 * Pull a unified diff out of a completed write/patch call.
 *
 * Only patches are carried. A diff is what a reviewer needs to see and it is
 * self-describing; arbitrary tool stdout is not, and carrying it would undo
 * the reason raw output was excluded from snapshots in the first place. The
 * tool's own input is checked first — patch tools receive the diff as an
 * argument — then its output, for tools that echo the applied patch.
 */
export function deriveToolActivityPreview(input: {
  readonly kind: ToolActivityKind;
  readonly trace: TraceRecord;
  readonly input: TraceRecord | undefined;
}): string | undefined {
  if (input.kind !== "write" && input.kind !== "delete") {
    return undefined;
  }
  const candidates = [
    readNonEmptyString(input.input, "patch"),
    readNonEmptyString(input.input, "diff"),
    readNonEmptyString(input.trace, "output"),
  ];
  for (const candidate of candidates) {
    if (candidate && UNIFIED_DIFF_HUNK_RE.test(candidate)) {
      return boundToolActivityPreview(candidate);
    }
  }
  return undefined;
}

function capToolActivity(activity: readonly ToolActivity[]): readonly ToolActivity[] {
  const retained = [...activity];
  while (retained.length > MAX_TOOL_ACTIVITY) {
    const coalescibleIndex = retained.findIndex(isCoalescibleToolActivity);
    retained.splice(coalescibleIndex === -1 ? 0 : coalescibleIndex, 1);
  }
  return retained;
}

function classifyToolActivityKind(toolName: string): ToolActivityKind {
  const normalized = toolName.toLowerCase();
  if (normalized === "ask_user") {
    return "interaction";
  }
  if (normalized.includes("delete") || normalized.includes("remove")) {
    return "delete";
  }
  if (normalized.includes("write") || normalized.includes("edit") || normalized.includes("patch")) {
    return "write";
  }
  if (normalized.includes("read") || normalized.includes("search") || normalized.includes("find")
    || normalized.includes("glob") || normalized.includes("list") || normalized.includes("inspect")) {
    return normalized.includes("search") || normalized.includes("find") || normalized.includes("glob")
      ? "search"
      : "read";
  }
  if (normalized.includes("shell") || normalized.includes("command") || normalized.includes("execute")
    || normalized.includes("run") || normalized.includes("build") || normalized.includes("test")) {
    return "execute";
  }
  return "other";
}

function deriveToolIntent(toolName: string, input: TraceRecord | undefined): string {
  const declaredIntent = readNonEmptyString(input, "i") ?? readNonEmptyString(input, "intent");
  if (declaredIntent) {
    return declaredIntent;
  }
  const target = deriveToolTarget(input);
  return target ? `${toolName}: ${target}` : toolName;
}

function deriveToolTarget(input: TraceRecord | undefined): string | undefined {
  return readNonEmptyString(input, "path")
    ?? readNonEmptyString(input, "file")
    ?? readNonEmptyString(input, "url");
}

export function deriveToolOutputMetric(output: string | undefined): string | undefined {
  const normalized = output?.trim();
  if (!normalized) {
    return undefined;
  }
  if (/^\(no matches\)$/i.test(normalized)) {
    return "no matches";
  }
  const lineCount = normalized.split(/\r?\n/).length;
  return `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
}

function asRecord(value: unknown): TraceRecord | undefined {
  return typeof value === "object" && value !== null
    ? value as TraceRecord
    : undefined;
}

function readNonEmptyString(record: TraceRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readTimestamp(record: TraceRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
