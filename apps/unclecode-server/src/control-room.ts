import { basename } from "node:path";

const MAX_RUNS = 128;
const MAX_CONTEXT_SOURCES = 64;
const MAX_HISTORY = 64;
const MAX_DIAGNOSTICS = 32;
const MAX_ARTIFACTS = 64;
const MAX_EVOLUTION_PROPOSALS = 32;
const MAX_CACHE_TELEMETRY = 32;
const MAX_TEXT = 800;

export type ControlRoomLocale = "en" | "ko";
export type RuntimeSessionState = "idle" | "running" | "pause_pending" | "paused" | "requires_action" | "completed" | "failed" | "cancelled";

export type RuntimeContextSource = {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
  readonly tokenEstimate?: number;
};

export type RuntimeSessionSource = {
  readonly sessionId: string;
  readonly projectPath: string;
  readonly locale: ControlRoomLocale;
  readonly state: RuntimeSessionState;
  readonly revision: number;
  readonly updatedAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly agentConsole?: Readonly<Record<string, unknown>>;
  readonly context?: {
    readonly included?: readonly RuntimeContextSource[];
    readonly excluded?: readonly RuntimeContextSource[];
    readonly compacted?: boolean;
    readonly receiptId?: string;
  };
};

export type RuntimeCacheTelemetrySnapshot = {
  readonly name: string;
  readonly hits: number;
  readonly misses: number;
  readonly hitRate?: number;
  readonly evictions: number;
  readonly byteEvictions: number;
  readonly invalidations: number;
  readonly currentSize: number;
  readonly maxEntries: number;
  readonly maxRetainedBytes: number;
  readonly retainedBytesEstimate: number;
};

export type RuntimeReadSource = {
  readonly generatedAt: number;
  readonly sessions: readonly RuntimeSessionSource[];
  readonly system?: {
    readonly providers?: readonly Readonly<Record<string, unknown>>[];
    readonly plugins?: readonly Readonly<Record<string, unknown>>[];
    readonly cleanup?: readonly Readonly<Record<string, unknown>>[];
    readonly caches?: readonly RuntimeCacheTelemetrySnapshot[];
  };
};

export type ControlRoomDiagnostic = {
  readonly runId: string;
  readonly source: string;
  readonly trust: string;
  readonly pluginId: string;
  readonly hook: string;
  readonly status: string;
  readonly exitStatus?: number;
  readonly error: string;
  readonly dedupeKey: string;
};

export type ControlRoomRun = {
  readonly id: string;
  readonly project: string;
  readonly locale: ControlRoomLocale;
  readonly state: RuntimeSessionState;
  readonly revision: number;
  readonly updatedAt?: string;
  readonly model: string;
  readonly provider: string;
  readonly attentionReason?: string;
  readonly quality: {
    readonly recorded: boolean;
    readonly provenance: "Quality Engine (SCC)" | "not-recorded";
    readonly profile: string;
    readonly stage: string;
    readonly phase: "plan" | "do" | "check" | "act" | "unknown";
    readonly gate: string;
    readonly iteration: number;
    readonly independentVerification: boolean;
    readonly refineCount: number;
    readonly pivotCount: number;
    readonly findings: readonly string[];
    readonly history: readonly Readonly<Record<string, unknown>>[];
  };
  readonly graph: {
    readonly id?: string;
    readonly nodes: readonly Readonly<Record<string, unknown>>[];
  };
  readonly timeline: readonly Readonly<Record<string, unknown>>[];
  readonly context: {
    readonly included: readonly RuntimeContextSource[];
    readonly excluded: readonly RuntimeContextSource[];
    readonly compacted: boolean;
    readonly receiptId?: string;
  };
  readonly agents: readonly Readonly<Record<string, unknown>>[];
  readonly jobs: readonly Readonly<Record<string, unknown>>[];
  readonly artifacts: readonly {
    readonly ref: string;
    readonly hash?: string;
    readonly stale: boolean;
    readonly verified: boolean;
  }[];
  readonly evolve: readonly Readonly<Record<string, unknown>>[];
  readonly system: { readonly diagnostics: readonly ControlRoomDiagnostic[] };
};

export type ControlRoomProjection = {
  readonly version: 1;
  readonly generatedAt: number;
  readonly bounds: {
    readonly runs: number;
    readonly contextSources: number;
    readonly history: number;
  };
  readonly runs: readonly ControlRoomRun[];
  readonly system: RuntimeReadSource["system"];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayOfRecords(value: unknown, limit: number): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) ? value.filter(isRecord).slice(-limit).map(item => sanitizeRecord(item)) : [];
}

function redactText(value: unknown, max = MAX_TEXT): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  const redacted = text
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, match => `${match.split(/[=:]/, 1)[0]}=[REDACTED]`)
    .replace(/\b(?:sk|ghp|xoxb)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

function sanitizeRecord(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input).slice(0, 48)) {
    if (/prompt|content|raw|output|projectPath/i.test(key)) continue;
    if (typeof value === "string") output[key] = redactText(value);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) output[key] = value;
    else if (Array.isArray(value)) output[key] = value.slice(0, 32).map(item => typeof item === "string" ? redactText(item) : isRecord(item) ? sanitizeRecord(item) : item);
    else if (isRecord(value)) output[key] = sanitizeRecord(value);
  }
  return output;
}

function cacheTelemetry(
  value: readonly RuntimeCacheTelemetrySnapshot[] | undefined,
): readonly RuntimeCacheTelemetrySnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).slice(0, MAX_CACHE_TELEMETRY).map((entry) => {
    const nonnegative = (key: string) => {
      const candidate = entry[key];
      return typeof candidate === "number" && Number.isFinite(candidate)
        ? Math.max(0, candidate)
        : 0;
    };
    const hits = nonnegative("hits");
    const misses = nonnegative("misses");
    const lookups = hits + misses;
    return {
      name: redactText(entry.name, 120),
      hits,
      misses,
      hitRate: lookups > 0 ? hits / lookups : 0,
      evictions: nonnegative("evictions"),
      byteEvictions: nonnegative("byteEvictions"),
      invalidations: nonnegative("invalidations"),
      currentSize: nonnegative("currentSize"),
      maxEntries: nonnegative("maxEntries"),
      maxRetainedBytes: nonnegative("maxRetainedBytes"),
      retainedBytesEstimate: nonnegative("retainedBytesEstimate"),
    };
  });
}

function projectedRecord(
  input: Readonly<Record<string, unknown>>,
  fields: {
    readonly strings?: readonly string[];
    readonly numbers?: readonly string[];
    readonly booleans?: readonly string[];
  },
): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {};
  for (const key of fields.strings ?? []) {
    if (typeof input[key] === "string") output[key] = redactText(input[key]);
  }
  for (const key of fields.numbers ?? []) {
    if (typeof input[key] === "number" && Number.isFinite(input[key])) output[key] = input[key];
  }
  for (const key of fields.booleans ?? []) {
    if (typeof input[key] === "boolean") output[key] = input[key];
  }
  return output;
}

/**
 * Project only the bounded evidence fields from a recorded console proposal.
 * The console checkpoint is the recording boundary; arbitrary creator output
 * and unknown future fields never become control-room API fields by accident.
 */
function evolutionFrom(consoleRecord: Readonly<Record<string, unknown>>): readonly Readonly<Record<string, unknown>>[] {
  const proposals = Array.isArray(consoleRecord.evolutionProposals)
    ? consoleRecord.evolutionProposals.filter(isRecord).slice(-MAX_EVOLUTION_PROPOSALS)
    : [];
  const allowedStates = new Set(["pr-ready", "rejected", "failed", "cancelled", "stale"]);
  return proposals.flatMap((proposal) => {
    if (
      typeof proposal.id !== "string"
      || typeof proposal.runId !== "string"
      || typeof proposal.candidateId !== "string"
      || !allowedStates.has(String(proposal.state))
      || proposal.isolation !== "worktree"
      || proposal.mergeRequiresHumanApproval !== true
    ) {
      return [];
    }
    const output: Record<string, unknown> = {
      ...projectedRecord(proposal, {
        strings: [
          "id", "runId", "candidateId", "creatorId", "evaluatorId", "attestorId", "state",
          "isolation", "isolatedBranch", "isolatedWorktree", "heldOutBenchmarkId", "humanApproval",
          "summary", "createdAt",
        ],
        booleans: ["heldOutBenchmark", "mergeRequiresHumanApproval", "stale"],
      }),
    };
    if (Array.isArray(proposal.changedAssets)) {
      output.changedAssets = proposal.changedAssets.filter(isRecord).slice(0, 64).map(asset => projectedRecord(asset, {
        strings: ["path", "sha256"],
      }));
    }
    if (isRecord(proposal.hashes)) {
      output.hashes = projectedRecord(proposal.hashes, {
        strings: [
          "baseCommit", "candidateCommit", "patch", "candidateArtifact", "evaluator", "policy", "suite",
          "evaluatorEnvironment", "baselineResult", "candidateResult",
        ],
      });
    }
    if (isRecord(proposal.comparison)) {
      output.comparison = projectedRecord(proposal.comparison, {
        strings: ["thresholdsHash"],
        numbers: ["baselineScore", "candidateScore", "delta"],
        booleans: ["passed"],
      });
    }
    if (isRecord(proposal.attestation)) {
      output.attestation = projectedRecord(proposal.attestation, {
        strings: ["timestamp"],
        numbers: ["maxAgeMs"],
        booleans: ["branchExists", "worktreeExists"],
      });
    }
    if (isRecord(proposal.cleanup)) {
      const cleanup: Record<string, unknown> = {
        ...projectedRecord(proposal.cleanup, { strings: ["status", "summary"] }),
      };
      if (Array.isArray(proposal.cleanup.resources)) {
        cleanup.resources = proposal.cleanup.resources.filter(isRecord).slice(0, 16).map(resource => projectedRecord(resource, {
          strings: ["kind", "identity", "status"],
        }));
      }
      output.cleanup = cleanup;
    }
    if (Array.isArray(proposal.failures)) {
      output.failures = proposal.failures.filter((value): value is string => typeof value === "string").slice(0, 32).map(value => redactText(value, 320));
    }
    if (Array.isArray(proposal.artifactRefs)) {
      output.artifactRefs = proposal.artifactRefs.filter((value): value is string => typeof value === "string").slice(0, 32).map(value => redactText(value, 320));
    }
    return [output];
  });
}

function stringField(record: Readonly<Record<string, unknown>> | undefined, key: string, fallback: string): string {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? redactText(value) : fallback;
}

function numberField(record: Readonly<Record<string, unknown>> | undefined, key: string): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanField(record: Readonly<Record<string, unknown>> | undefined, key: string): boolean {
  return record?.[key] === true;
}

function pdcaPhase(stage: string): "plan" | "do" | "check" | "act" | "unknown" {
  if (stage === "explore" || stage === "plan") return "plan";
  if (stage === "work") return "do";
  if (stage === "critic") return "check";
  if (stage === "promote") return "act";
  return "unknown";
}

function projectName(projectPath: string): string {
  const leaf = basename(projectPath.trim());
  return redactText(leaf || "workspace", 120);
}

function contextSources(values: readonly RuntimeContextSource[] | undefined): readonly RuntimeContextSource[] {
  return (values ?? []).slice(0, MAX_CONTEXT_SOURCES).map(item => ({
    id: redactText(item.id, 160),
    label: redactText(item.label, 240),
    reason: redactText(item.reason, 240),
    ...(typeof item.tokenEstimate === "number" ? { tokenEstimate: Math.max(0, item.tokenEstimate) } : {}),
  }));
}

function diagnosticsFrom(consoleRecord: Readonly<Record<string, unknown>>): readonly ControlRoomDiagnostic[] {
  const input = Array.isArray(consoleRecord.pluginDiagnostics) ? consoleRecord.pluginDiagnostics : [];
  return input.filter(isRecord).slice(-MAX_DIAGNOSTICS).map(item => ({
    runId: stringField(item, "runId", "unknown"),
    source: stringField(item, "source", "external"),
    trust: stringField(item, "trust", "unknown"),
    pluginId: stringField(item, "pluginId", "unknown"),
    hook: stringField(item, "hook", "unknown"),
    status: stringField(item, "status", "error"),
    ...(typeof item.exitStatus === "number" ? { exitStatus: item.exitStatus } : {}),
    error: redactText(item.error ?? "Plugin invocation failed"),
    dedupeKey: stringField(item, "dedupeKey", "unknown"),
  }));
}

function stringList(record: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const values = record[key];
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string")
    : [];
}

function isFreshHashBoundAttestation(entry: Readonly<Record<string, unknown>> | undefined): boolean {
  return entry !== undefined
    && entry.decision === "proceed"
    && typeof entry.reviewerRunId === "string"
    && typeof entry.artifactHash === "string"
    && typeof entry.reviewedArtifactHash === "string"
    && entry.reviewedArtifactHash === entry.currentArtifactHash
    && entry.independentVerification === true
    && entry.stale !== true;
}

function isFreshIndependentCritic(entry: Readonly<Record<string, unknown>> | undefined): boolean {
  return entry?.event === "gate" && entry.stage === "critic" && isFreshHashBoundAttestation(entry);
}

function terminalQualityAggregate(
  history: readonly Readonly<Record<string, unknown>>[],
): Readonly<Record<string, unknown>> | undefined {
  const terminalIndex = history.findLastIndex((entry) => entry.event === "completed");
  if (terminalIndex < 0) {
    const latest = history.at(-1);
    return latest ? { ...latest, authoritativeCriticVerification: isFreshIndependentCritic(latest) } : undefined;
  }
  const terminal = history[terminalIndex];
  if (!terminal) return undefined;
  let review = isFreshHashBoundAttestation(terminal) ? terminal : undefined;
  if (!review && terminal.decision === "proceed" && terminal.stale !== true) {
    for (let index = terminalIndex - 1; index >= 0; index -= 1) {
      const candidate = history[index];
      if (candidate?.event === "refine" || candidate?.event === "pivot") break;
      if (candidate?.iteration === terminal.iteration && isFreshIndependentCritic(candidate)) {
        review = candidate;
        break;
      }
    }
  }
  const terminalArtifactRefs = stringList(terminal, "artifactRefs");
  const reviewArtifactRefs = review ? stringList(review, "artifactRefs") : [];
  const artifactRefs = terminalArtifactRefs.length > 0
    ? terminalArtifactRefs
    : reviewArtifactRefs.length > 0 ? reviewArtifactRefs : review ? stringList(review, "evidenceRefs") : [];
  return {
    ...terminal,
    artifactRefs,
    ...(typeof terminal.artifactHash === "string" ? { artifactHash: terminal.artifactHash }
      : typeof review?.artifactHash === "string" ? { artifactHash: review.artifactHash } : {}),
    ...(typeof terminal.reviewedArtifactHash === "string" ? { reviewedArtifactHash: terminal.reviewedArtifactHash }
      : typeof review?.reviewedArtifactHash === "string" ? { reviewedArtifactHash: review.reviewedArtifactHash } : {}),
    ...(typeof terminal.currentArtifactHash === "string" ? { currentArtifactHash: terminal.currentArtifactHash }
      : typeof review?.currentArtifactHash === "string" ? { currentArtifactHash: review.currentArtifactHash } : {}),
    ...(typeof terminal.reviewerRunId === "string" ? { reviewerRunId: terminal.reviewerRunId }
      : typeof review?.reviewerRunId === "string" ? { reviewerRunId: review.reviewerRunId } : {}),
    authoritativeCriticVerification: terminal.decision === "proceed"
      && terminal.stale !== true && isFreshHashBoundAttestation(review),
    independentVerification: terminal.decision === "proceed"
      && terminal.stale !== true && isFreshHashBoundAttestation(review),
  };
}

function artifactsFrom(history: readonly Readonly<Record<string, unknown>>[]): ControlRoomRun["artifacts"] {
  const seen = new Set<string>();
  const output: Array<ControlRoomRun["artifacts"][number]> = [];
  for (const entry of history.slice().reverse()) {
    const refs = Array.isArray(entry.artifactRefs) ? entry.artifactRefs : [];
    for (const refValue of refs) {
      if (typeof refValue !== "string" || seen.has(refValue) || output.length >= MAX_ARTIFACTS) continue;
      seen.add(refValue);
      const reviewerEvidence = entry.authoritativeCriticVerification === true;
      output.push({
        ref: redactText(refValue, 320),
        stale: entry.stale === true,
        verified: reviewerEvidence,
      });
    }
  }
  return output;
}

function projectRun(session: RuntimeSessionSource): ControlRoomRun {
  const consoleRecord = isRecord(session.agentConsole) ? session.agentConsole : {};
  const qualityRecord = isRecord(consoleRecord.qualityReview) ? consoleRecord.qualityReview : undefined;
  const graphRecord = isRecord(consoleRecord.workGraph) ? consoleRecord.workGraph : undefined;
  const qualityRecorded = qualityRecord !== undefined
    || typeof graphRecord?.qualityProfile === "string";
  const history = arrayOfRecords(qualityRecord?.history, MAX_HISTORY);
  const aggregate = terminalQualityAggregate(history);
  const stage = stringField(aggregate, "stage", stringField(qualityRecord, "currentStage", stringField(graphRecord, "currentStage", "unknown")));
  const gate = stringField(aggregate, "decision", stringField(qualityRecord, "latestDecision", stringField(graphRecord, "gateStatus", "unproven")));
  const latest = aggregate ?? history.at(-1);
  const failures = Array.isArray(latest?.failures)
    ? latest.failures.filter((value): value is string => typeof value === "string").slice(0, 32).map(value => redactText(value, 320))
    : [];
  const currentReview = aggregate ?? history.at(-1);
  const independentVerification = currentReview !== undefined
    && booleanField(currentReview, "authoritativeCriticVerification");
  const profile = stringField(qualityRecord, "profile", stringField(graphRecord, "qualityProfile", "unknown"));
  const metadata = isRecord(session.metadata) ? session.metadata : {};
  const attentionReason = session.state === "requires_action"
    ? session.locale === "ko" ? "보안 승인 또는 사용자 결정이 필요합니다." : "Security approval or user decision required"
    : gate === "block" || gate === "pivot" || gate === "refine"
      ? failures[0] ?? (session.locale === "ko" ? `품질 게이트: ${gate}` : `Quality gate: ${gate}`)
      : undefined;
  // Creator state is an attestation, not something that can be inferred from
  // a profile name or a proceed gate. Until the runtime records a proposal,
  // the control room must show no candidate rather than fabricate one.
  const evolve = evolutionFrom(consoleRecord);

  return {
    id: redactText(session.sessionId, 180),
    project: projectName(session.projectPath),
    locale: session.locale,
    state: session.state,
    revision: Math.max(0, session.revision),
    ...(session.updatedAt ? { updatedAt: redactText(session.updatedAt, 80) } : {}),
    model: stringField(metadata, "model", "unknown"),
    provider: stringField(metadata, "provider", "unknown"),
    ...(attentionReason ? { attentionReason } : {}),
    quality: {
      recorded: qualityRecorded,
      provenance: qualityRecorded ? "Quality Engine (SCC)" : "not-recorded",
      profile,
      stage,
      phase: pdcaPhase(stage),
      gate,
      iteration: numberField(qualityRecord, "iteration") || numberField(graphRecord, "iteration"),
      independentVerification,
      refineCount: numberField(qualityRecord, "refineCount"),
      pivotCount: numberField(qualityRecord, "pivotCount"),
      findings: failures,
      history,
    },
    graph: {
      ...(typeof graphRecord?.id === "string" ? { id: redactText(graphRecord.id, 180) } : {}),
      nodes: arrayOfRecords(graphRecord?.nodes, 96),
    },
    timeline: history,
    context: {
      included: contextSources(session.context?.included),
      excluded: contextSources(session.context?.excluded),
      compacted: session.context?.compacted === true,
      ...(session.context?.receiptId ? { receiptId: redactText(session.context.receiptId, 180) } : {}),
    },
    agents: arrayOfRecords(consoleRecord.agents, 64),
    jobs: arrayOfRecords(consoleRecord.jobs, 64),
    artifacts: artifactsFrom(aggregate ? [aggregate] : history),
    evolve,
    system: { diagnostics: diagnosticsFrom(consoleRecord) },
  };
}

export function createControlRoomProjection(source: RuntimeReadSource): ControlRoomProjection {
  return {
    version: 1,
    generatedAt: source.generatedAt,
    bounds: { runs: MAX_RUNS, contextSources: MAX_CONTEXT_SOURCES, history: MAX_HISTORY },
    runs: source.sessions.slice(0, MAX_RUNS).map(projectRun),
    system: source.system
      ? {
          ...source.system,
          ...(source.system.caches ? { caches: cacheTelemetry(source.system.caches) } : {}),
        }
      : undefined,
  };
}
