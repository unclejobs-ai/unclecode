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
  readonly manifestId: string;
  readonly evidenceRefs: readonly string[];
};

export type WorkGraph = {
  readonly id: string;
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
  readonly startedAt: number;
  readonly completedAt?: number;
};

export type AgentConsoleSnapshot = {
  readonly profileId: ContextProfileId;
  readonly manifest?: PersistedPromptManifest;
  readonly pendingDecision?: AskUserQuestionRequest;
  readonly workGraph?: WorkGraph;
  readonly activity: readonly ToolActivity[];
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
export function createAgentConsoleSnapshot(input: AgentConsoleSnapshot): AgentConsoleSnapshot {
  return {
    profileId: input.profileId,
    ...(input.manifest ? { manifest: input.manifest } : {}),
    ...(input.pendingDecision ? { pendingDecision: input.pendingDecision } : {}),
    ...(input.workGraph ? { workGraph: input.workGraph } : {}),
    activity: input.activity.map((activity) => ({
      id: activity.id,
      toolCallId: activity.toolCallId,
      toolName: activity.toolName,
      kind: activity.kind,
      intent: activity.intent,
      status: activity.status,
      ...(activity.target === undefined ? {} : { target: activity.target }),
      ...(activity.summary === undefined ? {} : { summary: activity.summary }),
      startedAt: activity.startedAt,
      ...(activity.completedAt === undefined ? {} : { completedAt: activity.completedAt }),
    })),
  };
}

const MAX_PERSISTED_TOOL_ACTIVITY = 80;
const WORK_NODE_STATUS_SET = new Set<string>(WORK_NODE_STATUSES);
const TOOL_ACTIVITY_KIND_SET = new Set<string>(TOOL_ACTIVITY_KINDS);
const TOOL_ACTIVITY_STATUS_SET = new Set<string>(TOOL_ACTIVITY_STATUSES);

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
  const activityValue = record.activity;

  if (
    (hasOwn(record, "manifest") && !manifest)
    || (hasOwn(record, "pendingDecision") && !pendingDecision)
    || (hasOwn(record, "workGraph") && !workGraph)
    || !Array.isArray(activityValue)
  ) {
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
  if (
    !record
    || !isNonEmptyString(record.id)
    || !Array.isArray(record.nodes)
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
  return { id: record.id, approval: record.approval, nodes: parsedNodes };
}

function parseWorkNode(value: unknown): WorkNode | undefined {
  const record = asRecord(value);
  const dependsOn = parseStringList(record?.dependsOn);
  const fileOwnership = parseStringList(record?.fileOwnership);
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
    || !isNonEmptyString(record.manifestId)
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
    manifestId: record.manifestId,
    evidenceRefs,
  };
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
    || (hasOwn(record, "completedAt") && !isNonNegativeInteger(record.completedAt))
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
    startedAt: record.startedAt,
    ...(typeof record.completedAt === "number" ? { completedAt: record.completedAt } : {}),
  };
}
