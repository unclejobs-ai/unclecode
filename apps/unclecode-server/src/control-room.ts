import { basename } from "node:path";
import {
  parsePluginDiagnosticProjection,
  type ControlRoomPendingDecision,
} from "@unclecode/contracts";
import {
  SYSTEM_OBSERVABILITY_BOUNDS,
  projectSystemObservability,
  type ControlRoomSystemProjection,
  type RuntimeSystemObservabilitySource,
} from "./system-observability.js";
import { redactRuntimeDiagnostic } from "./runtime-error-redaction.js";

export type { RuntimeCacheTelemetrySnapshot } from "./system-observability.js";

const MAX_RUNS = 128;
const MAX_CONTEXT_SOURCES = 64;
const MAX_HISTORY = 64;
const MAX_DIAGNOSTICS = 32;
const MAX_ARTIFACTS = 64;
const MAX_EVOLUTION_PROPOSALS = 32;
const MAX_DECISION_QUESTIONS = 8;
const MAX_DECISION_OPTIONS = 16;
const MAX_TEXT = 800;
const MAX_DECISION_TITLE = 240;
const MAX_DECISION_QUESTION = 400;
const MAX_DECISION_DESCRIPTION = 320;
const MAX_DECISION_LABEL = 240;
const SAFE_DECISION_ID = /^[A-Za-z0-9._:-]{1,160}$/;

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

export type RuntimeReadSource = {
  readonly generatedAt: number;
  readonly sessions: readonly RuntimeSessionSource[];
  readonly system?: RuntimeSystemObservabilitySource;
};

export type ControlRoomDiagnostic = {
  readonly runId: string;
  readonly source: string;
  readonly trust: string;
  readonly pluginId: string;
  readonly hook: string;
  readonly status: string;
  readonly exitStatus?: string;
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
  readonly pendingDecision?: ControlRoomPendingDecision;
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
    readonly system: typeof SYSTEM_OBSERVABILITY_BOUNDS;
  };
  readonly runs: readonly ControlRoomRun[];
  readonly system: ControlRoomSystemProjection;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayOfRecords(value: unknown, limit: number): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) ? value.filter(isRecord).slice(-limit).map(item => sanitizeRecord(item)) : [];
}

function redactText(value: unknown, max = MAX_TEXT): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return redactRuntimeDiagnostic(text, max);
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

/**
 * Project decisions only when their answer identities can round-trip exactly.
 * Display-only prose is bounded and redacted, while IDs and option labels are
 * either safe as-is or the whole decision is omitted.
 */
function pendingDecisionFrom(
  consoleRecord: Readonly<Record<string, unknown>>,
): ControlRoomPendingDecision | undefined {
  const decision = isRecord(consoleRecord.pendingDecision) ? consoleRecord.pendingDecision : undefined;
  if (
    !decision
    || (decision.kind !== "security-approval" && decision.kind !== "user-decision")
    || typeof decision.id !== "string"
    || !SAFE_DECISION_ID.test(decision.id)
    || !Array.isArray(decision.questions)
    || decision.questions.length === 0
    || decision.questions.length > MAX_DECISION_QUESTIONS
  ) {
    return undefined;
  }

  const questionIds = new Set<string>();
  const questions: ControlRoomPendingDecision["questions"][number][] = [];
  for (const candidate of decision.questions) {
    if (
      !isRecord(candidate)
      || typeof candidate.id !== "string"
      || !SAFE_DECISION_ID.test(candidate.id)
      || questionIds.has(candidate.id)
      || typeof candidate.question !== "string"
      || candidate.question.trim().length === 0
      || !Array.isArray(candidate.options)
      || candidate.options.length === 0
      || candidate.options.length > MAX_DECISION_OPTIONS
      || (candidate.multi !== undefined && typeof candidate.multi !== "boolean")
    ) {
      return undefined;
    }
    questionIds.add(candidate.id);

    const labels = new Set<string>();
    const options: ControlRoomPendingDecision["questions"][number]["options"][number][] = [];
    for (const optionCandidate of candidate.options) {
      if (!isRecord(optionCandidate) || typeof optionCandidate.label !== "string") return undefined;
      const label = optionCandidate.label;
      if (
        label.length === 0
        || label.length > MAX_DECISION_LABEL
        || label.trim() !== label
        || redactText(label, MAX_DECISION_LABEL) !== label
        || labels.has(label)
        || (optionCandidate.description !== undefined && typeof optionCandidate.description !== "string")
      ) {
        return undefined;
      }
      labels.add(label);
      options.push({
        label,
        ...(typeof optionCandidate.description === "string"
          ? { description: redactText(optionCandidate.description, MAX_DECISION_DESCRIPTION) }
          : {}),
      });
    }

    const recommended = candidate.recommended;
    if (recommended !== undefined && (!Number.isSafeInteger(recommended) || Number(recommended) < 0 || Number(recommended) >= options.length)) {
      return undefined;
    }
    questions.push({
      id: candidate.id,
      question: redactText(candidate.question, MAX_DECISION_QUESTION),
      options,
      ...(candidate.multi === true ? { multi: true } : {}),
      ...(typeof recommended === "number" ? { recommended } : {}),
    });
  }

  return {
    kind: decision.kind,
    id: decision.id,
    ...(typeof decision.title === "string" && decision.title.trim().length > 0
      ? { title: redactText(decision.title, MAX_DECISION_TITLE) }
      : {}),
    questions,
  };
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
  return input.slice(-MAX_DIAGNOSTICS).flatMap((item) => {
    const diagnostic = parsePluginDiagnosticProjection(item);
    if (!diagnostic) return [];
    return [{
      runId: diagnostic.runId,
      source: diagnostic.source,
      trust: diagnostic.trustLane,
      pluginId: diagnostic.pluginId,
      hook: diagnostic.hookName,
      status: diagnostic.status,
      ...(diagnostic.exitStatus === undefined ? {} : { exitStatus: diagnostic.exitStatus }),
      error: redactText(diagnostic.errorMessage, 512),
      dedupeKey: diagnostic.dedupeKey,
    }];
  });
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
  const pendingDecision = pendingDecisionFrom(consoleRecord);
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
    ? pendingDecision?.kind === "security-approval"
      ? session.locale === "ko" ? "보안 승인이 필요합니다." : "Security approval required"
      : pendingDecision?.kind === "user-decision"
        ? session.locale === "ko" ? "사용자 결정이 필요합니다." : "User decision required"
        : session.locale === "ko" ? "운영자 작업이 필요합니다." : "Operator action required"
    : gate === "block" || gate === "pivot" || gate === "refine"
      ? failures[0] ?? (session.locale === "ko" ? `품질 게이트: ${gate}` : `Quality gate: ${gate}`)
      : undefined;
  // Creator state is an attestation, not something that can be inferred from
  // a profile name or a proceed gate. Until the runtime records a proposal,
  // the control room must show no candidate rather than fabricate one.
  const evolve = evolutionFrom(consoleRecord);

  return {
    ...(pendingDecision ? { pendingDecision } : {}),
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
    bounds: {
      runs: MAX_RUNS,
      contextSources: MAX_CONTEXT_SOURCES,
      history: MAX_HISTORY,
      system: SYSTEM_OBSERVABILITY_BOUNDS,
    },
    runs: source.sessions.slice(0, MAX_RUNS).map(projectRun),
    system: projectSystemObservability(source.system),
  };
}
