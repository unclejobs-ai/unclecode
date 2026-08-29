import { createHash } from "node:crypto";
import { posix } from "node:path";

import type {
  EvolutionIsolationAttestation,
  EvolutionProposal,
  EvolutionValidationContext,
} from "@second-claude/core";
import { redactAgentOpsSecrets } from "@unclecode/agentops-db";
import type { EvolutionProposalProjection as AgentConsoleEvolutionProposalProjection } from "@unclecode/contracts";

export const MAX_EVOLUTION_SUMMARY_CHARS = 512;
const CANONICAL_UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMMIT_ID = /^[a-f0-9]{40,64}$/;

export type EvolutionAssetKind = "file" | "symlink" | "special" | "unreadable";

export type EvolutionAssetDigest = {
  readonly path: string;
  readonly sha256: string;
  readonly kind: EvolutionAssetKind;
  readonly size: number;
};

export type EvolutionCandidateSnapshot = {
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly patchHash: string;
  readonly changedAssets: readonly EvolutionAssetDigest[];
};

export type EvolutionProtectedSnapshot = {
  readonly entries: readonly EvolutionAssetDigest[];
};

export type EvolutionCheckResult = {
  readonly id: string;
  readonly status: "passed" | "failed";
  readonly score: number;
  readonly durationMs: number;
};

export type EvolutionBenchmarkResult = {
  readonly score: number;
  readonly summary: string;
  readonly checks: readonly EvolutionCheckResult[];
};

export type EvolutionEvaluationProofContext = {
  readonly runId: string;
  readonly proposalId: string;
  readonly candidateId: string;
  readonly creatorId: string;
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly baselineWorktreeHash: string;
  readonly candidateWorktreeHash: string;
  readonly candidateArtifactHash: string;
  readonly evaluatorHash: string;
  readonly evaluatorAssetsHash: string;
  readonly evaluatorEnvironmentHash: string;
  readonly suiteHash: string;
  readonly suiteAssetsHash: string;
  readonly manifestHash: string;
  readonly thresholdsHash: string;
  readonly thresholdAssetHash: string;
};

export type EvolutionEvaluationProofBinding = EvolutionEvaluationProofContext & {
  readonly providerRunId: string;
  readonly verificationMatrixArtifactHash: string;
  readonly independentReviewerId: string;
  readonly independentReviewArtifactHash: string;
  readonly baselineResultHash: string;
  readonly candidateResultHash: string;
  readonly baselineObservationHash: string;
  readonly candidateObservationHash: string;
  readonly metrics: Readonly<Record<string, number>>;
  readonly metricsHash: string;
  readonly observedAt: string;
  readonly proofHash: string;
};

export type EvolutionEvaluatorResult =
  | {
      readonly status: "completed";
      readonly environmentHash: string;
      readonly integratedProof: {
        readonly status: "proven" | "unproven";
        readonly reasons: readonly string[];
        readonly binding?: EvolutionEvaluationProofBinding | undefined;
      };
      readonly baseline: EvolutionBenchmarkResult;
      readonly candidate: EvolutionBenchmarkResult;
    }
  | {
      readonly status: "failed" | "timeout" | "cancelled";
      readonly summary: string;
    };

export type EvolutionEvaluatorDefinition = {
  readonly id: string;
  readonly definition: string;
  readonly version: string;
  readonly assets: readonly string[];
};

export type EvolutionCreatorEdit = {
  readonly path: string;
  readonly content: string;
};

export type EvolutionCreatorEditResult =
  | {
      readonly status: "completed";
      readonly summary: string;
      readonly edits: readonly EvolutionCreatorEdit[];
    }
  | {
      readonly status: "failed" | "timeout" | "cancelled";
      readonly summary: string;
    };

export type EvolutionSuiteDefinition = {
  readonly id: string;
  readonly version: string;
  readonly assets: readonly string[];
  readonly checks: readonly { readonly id: string; readonly weight: number }[];
  readonly thresholds: {
    readonly minimumCandidateScore: number;
    readonly minimumDelta: number;
    readonly maximumRegression: number;
  };
  readonly environment: Readonly<Record<string, string>>;
};

export type CreatorEvolutionConfig = {
  readonly evaluator: EvolutionEvaluatorDefinition;
  readonly policyAssets: readonly string[];
  /** Exact host-computed identity of the evaluator runtime and containment policy. */
  readonly evaluatorEnvironmentHash: string;
  readonly suite: EvolutionSuiteDefinition;
  readonly attestorId: string;
  readonly maxAttestationAgeMs: number;
  readonly bounds: {
    readonly creatorTimeoutMs: number;
    readonly evaluatorTimeoutMs: number;
    readonly maxOutputBytes: number;
    readonly maxChangedAssets: number;
  };
};

export type EvolutionRepositoryIdentity = {
  readonly baseCommit: string;
  readonly baseBranch: string;
  readonly baseWorktree: string;
  readonly hostCurrentBranch: string;
  readonly hostCurrentWorktree: string;
};

export type EvolutionCleanupResource = {
  readonly kind: "branch" | "worktree" | "baseline-worktree";
  readonly identity: string;
};

export type PreparedEvolutionCandidate = {
  readonly candidateId: string;
  readonly branch: string;
  readonly worktree: string;
  readonly baselineWorktree: string;
  readonly resources: readonly EvolutionCleanupResource[];
};

export type EvolutionCleanupProjection = {
  readonly status: "completed" | "retained" | "failed";
  readonly resources: readonly (EvolutionCleanupResource & {
    readonly status: "removed" | "retained" | "cleanup-failed";
  })[];
  readonly summary?: string;
};

export type EvolutionProposalProjection = AgentConsoleEvolutionProposalProjection;

export type CreatorEvolutionResult = {
  readonly status: EvolutionProposalProjection["state"];
  readonly recorded: boolean;
  readonly projection: EvolutionProposalProjection;
  readonly proposal?: EvolutionProposal;
  readonly context?: EvolutionValidationContext;
};

export type CreatorEvolutionHost = {
  withLifecycleLock?<T>(
    input: {
      readonly runId: string;
      readonly workspaceRoot: string;
      readonly signal?: AbortSignal | undefined;
    },
    operation: () => Promise<T>,
  ): Promise<T>;
  loadRecord(input: { readonly runId: string }): Promise<{ readonly result: CreatorEvolutionResult } | undefined>;
  verifyRecordedCandidate(input: {
    readonly result: CreatorEvolutionResult;
    readonly workspaceRoot: string;
    readonly mutableTargets: readonly string[];
    readonly evaluator: Readonly<EvolutionEvaluatorDefinition>;
    readonly policyAssets: readonly string[];
    readonly suite: Readonly<EvolutionSuiteDefinition>;
    readonly evaluatorEnvironmentHash: string;
    readonly attestorId: string;
    readonly maxAttestationAgeMs: number;
  }): Promise<readonly string[]>;
  resolveBase(input: {
    readonly runId: string;
    readonly workspaceRoot: string;
    readonly snapshotTargets: readonly string[];
  }): Promise<EvolutionRepositoryIdentity>;
  prepareCandidate(input: {
    readonly runId: string;
    readonly workspaceRoot: string;
    readonly candidateId: string;
    readonly branch: string;
    readonly base: EvolutionRepositoryIdentity;
  }): Promise<PreparedEvolutionCandidate>;
  snapshotProtectedAssets(input: {
    readonly workspaceRoot: string;
    readonly candidate: PreparedEvolutionCandidate;
    readonly assets: readonly string[];
  }): Promise<EvolutionProtectedSnapshot>;
  runCreator(input: {
    readonly runId: string;
    readonly prompt: string;
    readonly creatorId: string;
    readonly candidate: PreparedEvolutionCandidate;
    readonly mutableTargets: readonly string[];
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly status: "completed" | "failed" | "timeout" | "cancelled"; readonly summary: string }>;
  inspectCandidate(input: {
    readonly workspaceRoot: string;
    readonly candidate: PreparedEvolutionCandidate;
    readonly base: EvolutionRepositoryIdentity;
  }): Promise<EvolutionCandidateSnapshot>;
  sealCandidate(input: {
    readonly workspaceRoot: string;
    readonly candidate: PreparedEvolutionCandidate;
    readonly changedAssets: readonly EvolutionAssetDigest[];
  }): Promise<void>;
  runEvaluator(input: {
    readonly runId: string;
    readonly baselineWorktree: string;
    readonly candidateWorktree: string;
    readonly evaluator: Readonly<EvolutionEvaluatorDefinition>;
    readonly suite: Readonly<EvolutionSuiteDefinition>;
    readonly expectedEnvironmentHash: string;
    readonly proofContext: Readonly<EvolutionEvaluationProofContext>;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly signal: AbortSignal;
  }): Promise<EvolutionEvaluatorResult>;
  resolveIsolation(input: {
    readonly workspaceRoot: string;
    readonly base: EvolutionRepositoryIdentity;
    readonly candidate: PreparedEvolutionCandidate;
  }): Promise<EvolutionIsolationAttestation | undefined>;
  cleanup(input: {
    readonly runId: string;
    readonly workspaceRoot: string;
    readonly candidate: PreparedEvolutionCandidate;
    readonly resources: readonly EvolutionCleanupResource[];
    readonly retainCandidate: boolean;
    readonly reason: string;
  }): Promise<EvolutionCleanupProjection>;
  record(input: { readonly result: CreatorEvolutionResult }): Promise<void>;
};

export type CreatorEvolutionRunInput = {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly prompt: string;
  readonly creatorId: string;
  readonly mutableTargets: readonly string[];
  readonly dispatchEvolutionProposed: (event: {
    readonly runId: string;
    readonly proposal: EvolutionProposal;
    readonly context: EvolutionValidationContext;
  }) => Promise<{
    readonly action: "proceed" | "refine" | "pivot" | "block" | "unproven";
    readonly failures: readonly string[];
  }>;
  readonly signal: AbortSignal;
};

type EvolutionExecution = {
  readonly input: CreatorEvolutionRunInput;
  readonly candidateId: string;
  readonly proposalId: string;
  readonly createdAt: string;
  evaluatorHash: string;
  policyHash: string;
  suiteHash: string;
  readonly thresholdsHash: string;
  readonly artifactRef: string;
  base?: EvolutionRepositoryIdentity;
  candidate?: PreparedEvolutionCandidate;
  candidateSnapshot?: EvolutionCandidateSnapshot;
  protectedSnapshot?: EvolutionProtectedSnapshot;
  evaluation?: Extract<EvolutionEvaluatorResult, { readonly status: "completed" }>;
  comparison?: NonNullable<EvolutionProposalProjection["comparison"]>;
  isolation?: EvolutionIsolationAttestation | undefined;
};

type TerminalInput = {
  readonly status: EvolutionProposalProjection["state"];
  readonly failures: readonly string[];
  readonly summary: string;
  readonly retainCandidate?: boolean;
  readonly proposal?: EvolutionProposal;
  readonly context?: EvolutionValidationContext;
};

/**
 * UncleCode-owned creator lifecycle. Every filesystem, process, evaluator,
 * attestation, persistence, and cleanup side effect is an explicit host
 * boundary; SCC remains a pure validation hook invoked by the caller.
 */
export class CreatorEvolutionService {
  private readonly config: Readonly<CreatorEvolutionConfig>;
  private readonly host: CreatorEvolutionHost;
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, Promise<CreatorEvolutionResult>>();
  private readonly retained = new Map<string, EvolutionExecution>();

  constructor(input: {
    readonly config: CreatorEvolutionConfig;
    readonly host: CreatorEvolutionHost;
    readonly now?: () => Date;
  }) {
    this.config = deepFreeze(cloneConfig(input.config));
    this.host = input.host;
    this.now = input.now ?? (() => new Date());
  }

  run(input: CreatorEvolutionRunInput): Promise<CreatorEvolutionResult> {
    const identity = canonicalHash({
      runId: input.runId,
      creatorId: input.creatorId,
      mutableTargets: [...input.mutableTargets].sort(),
    });
    const existing = this.inFlight.get(identity);
    if (existing) return existing;
    const running = this.execute(input).finally(() => {
      this.inFlight.delete(identity);
    });
    this.inFlight.set(identity, running);
    return running;
  }

  /** Revalidates retained candidate evidence after downstream completion hooks. */
  verifyFresh(result: CreatorEvolutionResult): Promise<CreatorEvolutionResult> {
    const execution = this.retained.get(result.projection.id);
    const operation = (): Promise<CreatorEvolutionResult> => this.verifyFreshLocked(result);
    return execution && this.host.withLifecycleLock
      ? this.host.withLifecycleLock({
        runId: execution.input.runId,
        workspaceRoot: execution.input.workspaceRoot,
        signal: execution.input.signal,
        }, operation)
      : operation();
  }

  private async verifyFreshLocked(result: CreatorEvolutionResult): Promise<CreatorEvolutionResult> {
    if (!result.recorded || result.status !== "pr-ready") return result;
    const execution = this.retained.get(result.projection.id);
    if (
      !execution?.base
      || !execution.candidate
      || !execution.candidateSnapshot
      || !execution.protectedSnapshot
      || !result.proposal
      || !result.context
    ) {
      return result;
    }

    const failures: string[] = [];
    if (
      result.projection.hashes.evaluatorEnvironment !== this.config.evaluatorEnvironmentHash
      || result.proposal.validationEvidence.length !== 1
      || result.proposal.validationEvidence[0]?.artifactHash
        !== evaluationEvidenceArtifactHash(
          execution.candidateSnapshot,
          this.config.evaluatorEnvironmentHash,
          execution.evaluation?.integratedProof.binding?.proofHash,
        )
    ) {
      failures.push("EVOLUTION_EVALUATION_ENVIRONMENT_MISMATCH");
    }
    try {
      const [candidate, protectedAssets, isolation] = await Promise.all([
        this.host.inspectCandidate({
          workspaceRoot: execution.input.workspaceRoot,
          candidate: execution.candidate,
          base: execution.base,
        }),
        this.host.snapshotProtectedAssets({
          workspaceRoot: execution.input.workspaceRoot,
          candidate: execution.candidate,
          assets: protectedAssetPaths(this.config),
        }),
        this.host.resolveIsolation({
          workspaceRoot: execution.input.workspaceRoot,
          base: execution.base,
          candidate: execution.candidate,
        }),
      ]);
      if (candidateFingerprint(candidate) !== candidateFingerprint(execution.candidateSnapshot)) {
        failures.push("EVOLUTION_CANDIDATE_STALE");
      }
      failures.push(...protectedMutationCodes(execution.protectedSnapshot, protectedAssets, this.config));
      failures.push(...validateCurrentIsolation(
        result.proposal,
        isolation,
        this.config.attestorId,
        this.config.maxAttestationAgeMs,
        canonicalNow(this.now),
      ));
    } catch {
      failures.push("EVOLUTION_CANDIDATE_STALE");
    }
    if (failures.length === 0) return result;
    return this.finish(execution, {
      status: "stale",
      failures: [...new Set(failures)],
      summary: "Candidate or protected host evidence changed after completion validation.",
      proposal: result.proposal,
      context: result.context,
    });
  }

  private execute(input: CreatorEvolutionRunInput): Promise<CreatorEvolutionResult> {
    const operation = (): Promise<CreatorEvolutionResult> => this.executeLocked(input);
    return this.host.withLifecycleLock
      ? this.host.withLifecycleLock({ runId: input.runId, workspaceRoot: input.workspaceRoot, signal: input.signal }, operation)
      : operation();
  }

  private async executeLocked(input: CreatorEvolutionRunInput): Promise<CreatorEvolutionResult> {
    const loaded = await this.host.loadRecord({ runId: input.runId });
    if (loaded?.result.recorded === true) {
      if (loaded.result.status !== "pr-ready") return loaded.result;
      const identityFailures = [
        ...(loaded.result.projection.creatorId === input.creatorId ? [] : ["EVOLUTION_RECORDED_IDENTITY_MISMATCH"]),
        ...(loaded.result.projection.evaluatorId === this.config.evaluator.id ? [] : ["EVOLUTION_RECORDED_IDENTITY_MISMATCH"]),
        ...(loaded.result.projection.attestorId === this.config.attestorId ? [] : ["EVOLUTION_RECORDED_IDENTITY_MISMATCH"]),
        ...(loaded.result.projection.heldOutBenchmarkId === this.config.suite.id ? [] : ["EVOLUTION_RECORDED_IDENTITY_MISMATCH"]),
        ...(loaded.result.projection.hashes.evaluatorEnvironment === this.config.evaluatorEnvironmentHash
          ? []
          : ["EVOLUTION_EVALUATION_ENVIRONMENT_MISMATCH"]),
      ];
      let hostFailures: readonly string[];
      try {
        hostFailures = await this.host.verifyRecordedCandidate({
          result: loaded.result,
          workspaceRoot: input.workspaceRoot,
          mutableTargets: input.mutableTargets,
          evaluator: this.config.evaluator,
          policyAssets: this.config.policyAssets,
          suite: this.config.suite,
          evaluatorEnvironmentHash: this.config.evaluatorEnvironmentHash,
          attestorId: this.config.attestorId,
          maxAttestationAgeMs: this.config.maxAttestationAgeMs,
        });
      } catch {
        hostFailures = ["EVOLUTION_CANDIDATE_STALE"];
      }
      const failures = [...new Set([...identityFailures, ...hostFailures])];
      return failures.length === 0
        ? loaded.result
        : this.invalidateRecorded(input, loaded.result, failures);
    }

    const createdAt = canonicalNow(this.now);
    const seed = canonicalHash({
      runId: input.runId,
      creatorId: input.creatorId,
      evaluatorId: this.config.evaluator.id,
      suiteId: this.config.suite.id,
      mutableTargets: [...input.mutableTargets].sort(),
    }).slice("sha256:".length, "sha256:".length + 20);
    const candidateId = `candidate-${seed}`;
    const execution: EvolutionExecution = {
      input,
      candidateId,
      proposalId: `evolution-${seed}`,
      createdAt,
      evaluatorHash: canonicalHash({
        id: this.config.evaluator.id,
        definition: this.config.evaluator.definition,
        version: this.config.evaluator.version,
      }),
      policyHash: canonicalHash({ assets: [...this.config.policyAssets].sort() }),
      suiteHash: canonicalHash(this.config.suite),
      thresholdsHash: canonicalHash(this.config.suite.thresholds),
      artifactRef: `.unclecode/artifacts/${safeIdentity(input.runId)}/evolution-proposal.json`,
    };

    const identityFailures = validateIdentityConfiguration(input, this.config);
    const targetFailures = validateMutableTargets(input.mutableTargets, protectedAssetPaths(this.config));
    const configFailures = validateConfig(this.config);
    const initialFailures = [...identityFailures, ...targetFailures, ...configFailures];
    if (initialFailures.length > 0) {
      return this.finish(execution, {
        status: "failed",
        failures: initialFailures,
        summary: "Creator evolution configuration failed closed.",
      });
    }
    if (input.signal.aborted) {
      return this.finish(execution, {
        status: "cancelled",
        failures: ["EVOLUTION_CANCELLED"],
        summary: "Creator evolution was cancelled before candidate preparation.",
      });
    }

    try {
      execution.base = await this.host.resolveBase({
        runId: input.runId,
        workspaceRoot: input.workspaceRoot,
        snapshotTargets: [...new Set([
          ...input.mutableTargets,
          ...protectedAssetPaths(this.config),
        ])].sort(),
      });
    } catch (error) {
      return this.finish(execution, {
        status: "failed",
        failures: ["EVOLUTION_BASE_RESOLUTION_FAILED"],
        summary: errorSummary("Base resolution failed", error),
      });
    }
    if (!COMMIT_ID.test(execution.base.baseCommit)) {
      return this.finish(execution, {
        status: "failed",
        failures: ["EVOLUTION_INVALID_BASE_COMMIT"],
        summary: "Creator evolution requires an immutable base commit identity.",
      });
    }

    const branch = `unclecode/evolve/${candidateId}`;
    try {
      execution.candidate = await this.host.prepareCandidate({
        runId: input.runId,
        workspaceRoot: input.workspaceRoot,
        candidateId,
        branch,
        base: execution.base,
      });
    } catch (error) {
      return this.finish(execution, {
        status: "failed",
        failures: ["EVOLUTION_CANDIDATE_PREPARATION_FAILED"],
        summary: errorSummary("Candidate preparation failed", error),
      });
    }
    const preparedFailures = validatePreparedCandidate(execution.base, execution.candidate, candidateId, branch);
    if (preparedFailures.length > 0) {
      return this.finish(execution, {
        status: "failed",
        failures: preparedFailures,
        summary: "Candidate isolation identities are invalid.",
      });
    }

    try {
      execution.protectedSnapshot = await this.host.snapshotProtectedAssets({
        workspaceRoot: input.workspaceRoot,
        candidate: execution.candidate,
        assets: protectedAssetPaths(this.config),
      });
    } catch (error) {
      return this.finish(execution, {
        status: "failed",
        failures: ["EVOLUTION_PROTECTED_SNAPSHOT_FAILED"],
        summary: errorSummary("Protected asset snapshot failed", error),
      });
    }
    const protectedFailures = validateProtectedSnapshot(
      execution.protectedSnapshot,
      protectedAssetPaths(this.config),
    );
    if (protectedFailures.length > 0) {
      return this.finish(execution, {
        status: "failed",
        failures: protectedFailures,
        summary: "Protected asset snapshot is incomplete or unsafe.",
      });
    }
    execution.policyHash = protectedGroupHash(execution.protectedSnapshot, this.config.policyAssets);
    execution.evaluatorHash = canonicalHash({
      definition: this.config.evaluator,
      assets: protectedGroupHash(execution.protectedSnapshot, this.config.evaluator.assets),
    });
    execution.suiteHash = canonicalHash({
      definition: this.config.suite,
      assets: protectedGroupHash(execution.protectedSnapshot, this.config.suite.assets),
    });

    let creatorResult: Awaited<ReturnType<CreatorEvolutionHost["runCreator"]>>;
    try {
      creatorResult = await this.host.runCreator({
        runId: input.runId,
        prompt: input.prompt,
        creatorId: input.creatorId,
        candidate: execution.candidate,
        mutableTargets: [...input.mutableTargets],
        timeoutMs: this.config.bounds.creatorTimeoutMs,
        maxOutputBytes: this.config.bounds.maxOutputBytes,
        signal: input.signal,
      });
    } catch (error) {
      return this.finish(execution, {
        status: input.signal.aborted ? "cancelled" : "failed",
        failures: [input.signal.aborted ? "EVOLUTION_CANCELLED" : "EVOLUTION_CREATOR_FAILED"],
        summary: errorSummary("Creator execution failed", error),
      });
    }
    if (creatorResult.status !== "completed") {
      const status = creatorResult.status === "cancelled" ? "cancelled" : "failed";
      const failure = creatorResult.status === "timeout"
        ? "EVOLUTION_CREATOR_TIMEOUT"
        : creatorResult.status === "cancelled"
          ? "EVOLUTION_CANCELLED"
          : "EVOLUTION_CREATOR_FAILED";
      return this.finish(execution, {
        status,
        failures: [failure],
        summary: creatorResult.summary,
      });
    }

    let unsealed: EvolutionCandidateSnapshot;
    try {
      unsealed = await this.host.inspectCandidate({
        workspaceRoot: input.workspaceRoot,
        candidate: execution.candidate,
        base: execution.base,
      });
    } catch (error) {
      return this.finish(execution, {
        status: "failed",
        failures: ["EVOLUTION_CANDIDATE_SNAPSHOT_FAILED"],
        summary: errorSummary("Candidate snapshot failed", error),
      });
    }
    const unsealedFailures = validateCandidateSnapshot(
      unsealed,
      execution.base.baseCommit,
      input.mutableTargets,
      protectedAssetPaths(this.config),
      this.config.bounds.maxChangedAssets,
      false,
    );
    if (unsealedFailures.length > 0) {
      execution.candidateSnapshot = unsealed;
      return this.finish(execution, {
        status: "failed",
        failures: unsealedFailures,
        summary: "Candidate changed an unsafe or undeclared asset.",
      });
    }

    try {
      await this.host.sealCandidate({
        workspaceRoot: input.workspaceRoot,
        candidate: execution.candidate,
        changedAssets: unsealed.changedAssets,
      });
      execution.candidateSnapshot = await this.host.inspectCandidate({
        workspaceRoot: input.workspaceRoot,
        candidate: execution.candidate,
        base: execution.base,
      });
    } catch (error) {
      return this.finish(execution, {
        status: "failed",
        failures: ["EVOLUTION_CANDIDATE_SEAL_FAILED"],
        summary: errorSummary("Candidate sealing failed", error),
      });
    }
    const sealedFailures = validateCandidateSnapshot(
      execution.candidateSnapshot,
      execution.base.baseCommit,
      input.mutableTargets,
      protectedAssetPaths(this.config),
      this.config.bounds.maxChangedAssets,
      true,
    );
    if (sealedFailures.length > 0) {
      return this.finish(execution, {
        status: "failed",
        failures: sealedFailures,
        summary: "Sealed candidate artifact is invalid.",
      });
    }

    const proofContext = evaluationProofContext(execution, this.config);
    let evaluatorResult: EvolutionEvaluatorResult;
    try {
      evaluatorResult = await this.host.runEvaluator({
        runId: input.runId,
        baselineWorktree: execution.candidate.baselineWorktree,
        candidateWorktree: execution.candidate.worktree,
        evaluator: this.config.evaluator,
        suite: this.config.suite,
        expectedEnvironmentHash: this.config.evaluatorEnvironmentHash,
        proofContext,
        timeoutMs: this.config.bounds.evaluatorTimeoutMs,
        maxOutputBytes: this.config.bounds.maxOutputBytes,
        signal: input.signal,
      });
    } catch (error) {
      return this.finish(execution, {
        status: input.signal.aborted ? "cancelled" : "failed",
        failures: [input.signal.aborted ? "EVOLUTION_CANCELLED" : "EVOLUTION_EVALUATOR_FAILED"],
        summary: errorSummary("Evaluator execution failed", error),
      });
    }
    if (evaluatorResult.status !== "completed") {
      const evaluatorFailure = evaluatorResult.status === "timeout"
        ? "EVOLUTION_EVALUATOR_TIMEOUT"
        : evaluatorResult.status === "cancelled"
          ? "EVOLUTION_CANCELLED"
          : "EVOLUTION_EVALUATOR_FAILED";
      return this.finish(execution, {
        status: evaluatorResult.status === "cancelled" ? "cancelled" : "failed",
        failures: [evaluatorFailure],
        summary: evaluatorResult.summary,
      });
    }
    execution.evaluation = sanitizeEvaluation(evaluatorResult);
    const evaluationFailures = validateEvaluation(
      execution.evaluation,
      this.config.suite,
      this.config.evaluatorEnvironmentHash,
      proofContext,
      canonicalNow(this.now),
      this.config.maxAttestationAgeMs,
    );
    if (evaluationFailures.length > 0) {
      return this.finish(execution, {
        status: "failed",
        failures: evaluationFailures,
        summary: "Held-out evaluator returned invalid or mismatched results.",
      });
    }

    let postEvaluationCandidate: EvolutionCandidateSnapshot;
    let postEvaluationProtected: EvolutionProtectedSnapshot;
    try {
      [postEvaluationCandidate, postEvaluationProtected] = await Promise.all([
        this.host.inspectCandidate({
          workspaceRoot: input.workspaceRoot,
          candidate: execution.candidate,
          base: execution.base,
        }),
        this.host.snapshotProtectedAssets({
          workspaceRoot: input.workspaceRoot,
          candidate: execution.candidate,
          assets: protectedAssetPaths(this.config),
        }),
      ]);
    } catch (error) {
      return this.finish(execution, {
        status: "failed",
        failures: ["EVOLUTION_POST_EVALUATION_SNAPSHOT_FAILED"],
        summary: errorSummary("Post-evaluation snapshot failed", error),
      });
    }
    if (candidateFingerprint(postEvaluationCandidate) !== candidateFingerprint(execution.candidateSnapshot)) {
      return this.finish(execution, {
        status: "stale",
        failures: ["EVOLUTION_CANDIDATE_STALE"],
        summary: `Candidate evaluation: ${execution.evaluation.candidate.summary}. Candidate changed after evaluation.`,
      });
    }
    const protectedMutationFailures = protectedMutationCodes(
      execution.protectedSnapshot,
      postEvaluationProtected,
      this.config,
    );
    if (protectedMutationFailures.length > 0) {
      return this.finish(execution, {
        status: "failed",
        failures: protectedMutationFailures,
        summary: "A protected evaluator, policy, or benchmark asset changed during evolution.",
      });
    }

    execution.comparison = compareEvaluation(execution.evaluation, this.config.suite);
    if (!execution.comparison.passed) {
      return this.finish(execution, {
        status: "rejected",
        failures: ["EVOLUTION_THRESHOLD_FAILED"],
        summary: `Held-out comparison rejected candidate ${execution.evaluation.candidate.score} against baseline ${execution.evaluation.baseline.score}.`,
      });
    }
    if (execution.evaluation.integratedProof.status !== "proven") {
      return this.finish(execution, {
        status: "rejected",
        failures: ["EVOLUTION_INTEGRATED_PROOF_UNPROVEN"],
        summary: "Held-out comparison passed, but trusted integrated proof remains unproven.",
      });
    }

    try {
      execution.isolation = await this.host.resolveIsolation({
        workspaceRoot: input.workspaceRoot,
        base: execution.base,
        candidate: execution.candidate,
      });
    } catch (error) {
      return this.finish(execution, {
        status: "failed",
        failures: ["MISSING_ISOLATION_ATTESTATION"],
        summary: errorSummary("Isolation attestation failed", error),
      });
    }

    const proposal: EvolutionProposal = {
      candidateId,
      creatorId: input.creatorId,
      isolatedBranch: execution.candidate.branch,
      isolatedWorktree: execution.candidate.worktree,
      changedAssets: execution.candidateSnapshot.changedAssets.map((entry) => entry.path),
      evaluatorId: this.config.evaluator.id,
      heldOutBenchmarkId: this.config.suite.id,
      baselineScore: execution.evaluation.baseline.score,
      candidateScore: execution.evaluation.candidate.score,
      validationEvidence: [{
        kind: "metric",
        artifactHash: evaluationEvidenceArtifactHash(
          execution.candidateSnapshot,
          this.config.evaluatorEnvironmentHash,
          execution.evaluation.integratedProof.binding?.proofHash,
        ),
        producerId: input.creatorId,
        result: "pass",
        timestamp: createdAt,
      }],
      humanApproval: "pending",
    };
    const context: EvolutionValidationContext = {
      evaluatorAssets: [...this.config.evaluator.assets],
      policyAssets: [...this.config.policyAssets],
      benchmarkAssets: [...this.config.suite.assets],
      evaluationTimestamp: execution.isolation?.timestamp ?? createdAt,
      maxAttestationAgeMs: this.config.maxAttestationAgeMs,
      ...(execution.isolation === undefined ? {} : { isolation: execution.isolation }),
    };
    const isolationFailures = [...new Set([
      ...validateIsolationLocally(proposal, context, this.config.attestorId),
      ...validateCurrentIsolation(
        proposal,
        execution.isolation,
        this.config.attestorId,
        this.config.maxAttestationAgeMs,
        canonicalNow(this.now),
      ),
    ])];
    if (isolationFailures.length > 0) {
      return this.finish(execution, {
        status: "failed",
        failures: isolationFailures,
        summary: "Host isolation attestation is missing, invalid, stale, or mismatched.",
        proposal,
        context,
      });
    }

    let dispatched: Awaited<ReturnType<CreatorEvolutionRunInput["dispatchEvolutionProposed"]>>;
    try {
      dispatched = await input.dispatchEvolutionProposed({ runId: input.runId, proposal, context });
    } catch (error) {
      return this.finish(execution, {
        status: "failed",
        failures: ["EVOLUTION_VALIDATION_DISPATCH_FAILED"],
        summary: errorSummary("Evolution validation dispatch failed", error),
        proposal,
        context,
      });
    }
    if (dispatched.action !== "proceed") {
      return this.finish(execution, {
        status: "failed",
        failures: dispatched.failures.length > 0
          ? dispatched.failures
          : ["EVOLUTION_PROPOSAL_INVALID"],
        summary: "SCC or a trusted lifecycle hook rejected the evolution proposal.",
        proposal,
        context,
      });
    }

    let postDispatchCandidate: EvolutionCandidateSnapshot;
    try {
      postDispatchCandidate = await this.host.inspectCandidate({
        workspaceRoot: input.workspaceRoot,
        candidate: execution.candidate,
        base: execution.base,
      });
    } catch (error) {
      return this.finish(execution, {
        status: "stale",
        failures: ["EVOLUTION_CANDIDATE_STALE"],
        summary: errorSummary("Candidate freshness check failed", error),
        proposal,
        context,
      });
    }
    if (candidateFingerprint(postDispatchCandidate) !== candidateFingerprint(execution.candidateSnapshot)) {
      return this.finish(execution, {
        status: "stale",
        failures: ["EVOLUTION_CANDIDATE_STALE"],
        summary: "Candidate changed after proposal validation.",
        proposal,
        context,
      });
    }

    return this.finish(execution, {
      status: "pr-ready",
      failures: [],
      summary: `Held-out comparison passed: ${execution.evaluation.baseline.score} → ${execution.evaluation.candidate.score}. Human approval remains pending.`,
      retainCandidate: true,
      proposal,
      context,
    });
  }

  private async invalidateRecorded(
    input: CreatorEvolutionRunInput,
    result: CreatorEvolutionResult,
    verificationFailures: readonly string[],
  ): Promise<CreatorEvolutionResult> {
    const failures = [...new Set([...result.projection.failures, ...verificationFailures])];
    let cleanup: EvolutionCleanupProjection = result.projection.cleanup;
    const branch = result.projection.isolatedBranch;
    const worktree = result.projection.isolatedWorktree;
    const baselineWorktree = result.projection.cleanup.resources
      .find((resource) => resource.kind === "baseline-worktree")?.identity
      ?? result.context?.isolation?.baseWorktree;
    if (branch && worktree && baselineWorktree) {
      const resources = result.projection.cleanup.resources.map(({ kind, identity }) => ({ kind, identity }));
      try {
        cleanup = await this.host.cleanup({
          runId: input.runId,
          workspaceRoot: input.workspaceRoot,
          candidate: {
            candidateId: result.projection.candidateId,
            branch,
            worktree,
            baselineWorktree,
            resources,
          },
          resources,
          retainCandidate: false,
          reason: "Recorded evolution candidate evidence became stale.",
        });
      } catch (error) {
        failures.push("EVOLUTION_CLEANUP_FAILED");
        cleanup = {
          status: "failed",
          resources: result.projection.cleanup.resources.map(({ kind, identity }) => ({
            kind,
            identity,
            status: "cleanup-failed",
          })),
          summary: boundedSummary(error instanceof Error ? error.message : String(error)),
        };
      }
    } else {
      failures.push("EVOLUTION_CLEANUP_FAILED");
      cleanup = {
        status: "failed",
        resources: result.projection.cleanup.resources,
        summary: "Recorded candidate cleanup identities were incomplete.",
      };
    }
    const projection: EvolutionProposalProjection = {
      ...result.projection,
      state: "stale",
      stale: true,
      cleanup,
      failures: [...new Set(failures)].slice(0, 32).map(boundedIdentity),
      summary: "Recorded candidate or protected host evidence changed after persistence.",
    };
    const recorded: CreatorEvolutionResult = { ...result, status: "stale", recorded: true, projection };
    try {
      await this.host.record({ result: recorded });
      this.retained.delete(projection.id);
      return recorded;
    } catch (error) {
      return {
        ...recorded,
        status: "failed",
        recorded: false,
        projection: {
          ...projection,
          state: "failed",
          failures: [...new Set([...projection.failures, "EVOLUTION_RECORD_FAILED"])],
          summary: boundedSummary(errorSummary("Evolution stale record failed", error)),
        },
      };
    }
  }

  private async finish(execution: EvolutionExecution, terminal: TerminalInput): Promise<CreatorEvolutionResult> {
    const failures = [...new Set(terminal.failures)];
    let cleanup: EvolutionCleanupProjection = {
      status: "completed",
      resources: [],
    };
    if (execution.candidate) {
      try {
        cleanup = await this.host.cleanup({
          runId: execution.input.runId,
          workspaceRoot: execution.input.workspaceRoot,
          candidate: execution.candidate,
          resources: execution.candidate.resources,
          retainCandidate: terminal.retainCandidate === true,
          reason: terminal.summary,
        });
      } catch (error) {
        cleanup = {
          status: "failed",
          resources: execution.candidate.resources.map((resource) => ({
            ...resource,
            status: "cleanup-failed",
          })),
          summary: boundedSummary(error instanceof Error ? error.message : String(error)),
        };
        failures.push("EVOLUTION_CLEANUP_FAILED");
      }
    }
    const status = terminal.status === "pr-ready" && cleanup.status === "failed"
      ? "failed"
      : terminal.status;
    const projection = projectResult(execution, {
      ...terminal,
      status,
      failures: [...new Set(failures)],
    }, cleanup, this.config);
    const provisional: CreatorEvolutionResult = {
      status,
      recorded: false,
      projection,
      ...(terminal.proposal === undefined ? {} : { proposal: terminal.proposal }),
      ...(terminal.context === undefined ? {} : { context: terminal.context }),
    };
    const recorded: CreatorEvolutionResult = { ...provisional, recorded: true };
    try {
      await this.host.record({ result: recorded });
      if (recorded.status === "pr-ready" && cleanup.status === "retained") {
        this.retained.set(recorded.projection.id, execution);
      } else {
        this.retained.delete(recorded.projection.id);
      }
      return recorded;
    } catch (error) {
      let failedCleanup = cleanup;
      const recordFailures = [...new Set([...projection.failures, "EVOLUTION_RECORD_FAILED"])];
      if (execution.candidate && terminal.retainCandidate === true) {
        try {
          failedCleanup = await this.host.cleanup({
            runId: execution.input.runId,
            workspaceRoot: execution.input.workspaceRoot,
            candidate: execution.candidate,
            resources: execution.candidate.resources,
            retainCandidate: false,
            reason: "Evolution proposal persistence failed before ownership transfer.",
          });
        } catch (cleanupError) {
          recordFailures.push("EVOLUTION_CLEANUP_FAILED");
          failedCleanup = {
            status: "failed",
            resources: execution.candidate.resources.map((resource) => ({
              ...resource,
              status: "cleanup-failed",
            })),
            summary: boundedSummary(cleanupError instanceof Error ? cleanupError.message : String(cleanupError)),
          };
        }
      }
      return {
        ...provisional,
        status: "failed",
        projection: {
          ...projection,
          state: "failed",
          cleanup: failedCleanup,
          failures: [...new Set(recordFailures)],
          summary: boundedSummary(errorSummary("Evolution record failed", error)),
        },
      };
    }
  }
}

function projectResult(
  execution: EvolutionExecution,
  terminal: TerminalInput,
  cleanup: EvolutionCleanupProjection,
  config: Readonly<CreatorEvolutionConfig>,
): EvolutionProposalProjection {
  const snapshot = execution.candidateSnapshot;
  const evaluation = execution.evaluation;
  return {
    id: execution.proposalId,
    runId: boundedIdentity(execution.input.runId),
    candidateId: execution.candidateId,
    creatorId: boundedIdentity(execution.input.creatorId),
    evaluatorId: boundedIdentity(config.evaluator.id),
    attestorId: boundedIdentity(config.attestorId),
    state: terminal.status,
    isolation: "worktree",
    ...(execution.candidate === undefined
      ? {}
      : {
          isolatedBranch: boundedIdentity(execution.candidate.branch),
          isolatedWorktree: boundedIdentity(execution.candidate.worktree),
        }),
    heldOutBenchmark: evaluation !== undefined,
    heldOutBenchmarkId: boundedIdentity(config.suite.id),
    humanApproval: "pending",
    mergeRequiresHumanApproval: true,
    stale: terminal.status === "stale",
    changedAssets: (snapshot?.changedAssets ?? []).map((entry) => ({
      path: boundedPath(entry.path),
      sha256: entry.sha256,
    })),
    hashes: {
      ...(snapshot === undefined
        ? execution.base === undefined ? {} : { baseCommit: execution.base.baseCommit }
        : {
            baseCommit: snapshot.baseCommit,
            candidateCommit: snapshot.candidateCommit,
            patch: snapshot.patchHash,
            candidateArtifact: candidateArtifactHash(snapshot),
          }),
      evaluator: execution.evaluatorHash,
      evaluatorEnvironment: config.evaluatorEnvironmentHash,
      policy: execution.policyHash,
      suite: execution.suiteHash,
      ...(evaluation === undefined
        ? {}
        : {
            baselineResult: canonicalHash(evaluation.baseline),
            candidateResult: canonicalHash(evaluation.candidate),
          }),
    },
    ...(execution.comparison === undefined ? {} : { comparison: execution.comparison }),
    ...(execution.isolation === undefined
      ? {}
      : {
          attestation: {
            timestamp: execution.isolation.timestamp,
            maxAgeMs: config.maxAttestationAgeMs,
            branchExists: execution.isolation.branchExists,
            worktreeExists: execution.isolation.worktreeExists,
          },
        }),
    cleanup,
    failures: terminal.failures.slice(0, 32).map(boundedIdentity),
    summary: boundedSummary(terminal.summary),
    artifactRefs: [execution.artifactRef],
    createdAt: execution.createdAt,
  };
}

function validateIdentityConfiguration(
  input: CreatorEvolutionRunInput,
  config: Readonly<CreatorEvolutionConfig>,
): string[] {
  const failures: string[] = [];
  if (!input.runId.trim() || !input.creatorId.trim() || !config.evaluator.id.trim() || !config.attestorId.trim()) {
    failures.push("EVOLUTION_IDENTITY_MISSING");
  }
  if (input.creatorId === config.evaluator.id) failures.push("CREATOR_EVALUATOR_CONFLICT");
  if (config.attestorId === input.creatorId || config.attestorId === config.evaluator.id) {
    failures.push("ISOLATION_ATTESTOR_CONFLICT");
  }
  return failures;
}

function validateConfig(config: Readonly<CreatorEvolutionConfig>): string[] {
  const failures: string[] = [];
  if (!SHA256.test(config.evaluatorEnvironmentHash)) {
    failures.push("EVOLUTION_EVALUATION_ENVIRONMENT_INVALID");
  }
  const boundedPositive = [
    config.bounds.creatorTimeoutMs,
    config.bounds.evaluatorTimeoutMs,
    config.bounds.maxOutputBytes,
    config.bounds.maxChangedAssets,
  ].every((value) => Number.isInteger(value) && value > 0 && value <= 3_600_000);
  if (!boundedPositive) failures.push("EVOLUTION_RESOURCE_BOUNDS_INVALID");
  if (
    !Number.isInteger(config.maxAttestationAgeMs)
    || config.maxAttestationAgeMs < 0
    || config.maxAttestationAgeMs > 3_600_000
  ) {
    failures.push("EVOLUTION_ATTESTATION_AGE_INVALID");
  }
  const { minimumCandidateScore, minimumDelta, maximumRegression } = config.suite.thresholds;
  if (
    !finiteScore(minimumCandidateScore)
    || !Number.isFinite(minimumDelta)
    || minimumDelta < -1
    || minimumDelta > 1
    || !Number.isFinite(maximumRegression)
    || maximumRegression < 0
    || maximumRegression > 1
  ) {
    failures.push("EVOLUTION_THRESHOLDS_INVALID");
  }
  if (config.suite.checks.length === 0 || new Set(config.suite.checks.map((entry) => entry.id)).size !== config.suite.checks.length) {
    failures.push("EVOLUTION_SUITE_INVALID");
  }
  return failures;
}

function validateMutableTargets(targets: readonly string[], protectedPaths: readonly string[]): string[] {
  if (targets.length === 0) return ["EVOLUTION_MUTABLE_TARGETS_MISSING"];
  const failures = new Set<string>();
  for (const target of targets) {
    const pathFailure = validateRelativeAssetPath(target);
    if (pathFailure) failures.add(pathFailure);
    if (hasRepositoryControlSegment(target)) failures.add("EVOLUTION_REPOSITORY_CONTROL_MODIFIED");
    if (
      isProtectedCandidateTarget(target)
      || protectedPaths.some((asset) => pathMatchesTarget(asset, target) || pathMatchesTarget(target, asset))
    ) {
      failures.add("EVOLUTION_PROTECTED_TARGET_DECLARED");
    }
  }
  return [...failures];
}

function isProtectedCandidateTarget(value: string): boolean {
  const segments = value.toLowerCase().split("/");
  const basename = segments.at(-1) ?? "";
  return segments.some((segment) =>
    segment === "test"
    || segment === "tests"
    || segment === "__tests__"
    || segment === "config"
    || segment === "scripts"
    || segment === "fixture"
    || segment === "fixtures")
    || /(?:^|\.)(?:test|spec|fixture)\.[^.]+$/.test(basename)
    || basename === "package.json"
    || basename === "package-lock.json"
    || basename === "npm-shrinkwrap.json"
    || basename === "pnpm-lock.yaml"
    || basename === "yarn.lock"
    || basename.startsWith("tsconfig")
    || basename.includes(".config.");
}

function validatePreparedCandidate(
  base: EvolutionRepositoryIdentity,
  candidate: PreparedEvolutionCandidate,
  expectedCandidateId: string,
  expectedBranch: string,
): string[] {
  const failures: string[] = [];
  if (candidate.candidateId !== expectedCandidateId || candidate.branch !== expectedBranch) {
    failures.push("EVOLUTION_CANDIDATE_IDENTITY_MISMATCH");
  }
  if (!candidate.worktree.trim() || !candidate.baselineWorktree.trim()) {
    failures.push("MISSING_ISOLATED_WORKTREE");
  }
  if (candidate.branch === base.baseBranch || candidate.branch === base.hostCurrentBranch) {
    failures.push("BRANCH_NOT_ISOLATED");
  }
  if (
    candidate.worktree === base.baseWorktree
    || candidate.worktree === base.hostCurrentWorktree
    || candidate.worktree === candidate.baselineWorktree
  ) {
    failures.push("WORKTREE_NOT_ISOLATED");
  }
  return failures;
}

function validateProtectedSnapshot(
  snapshot: EvolutionProtectedSnapshot,
  expectedPaths: readonly string[],
): string[] {
  const failures = new Set<string>();
  const byPath = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  for (const path of expectedPaths) {
    const entry = byPath.get(path);
    if (!entry) {
      failures.add("EVOLUTION_PROTECTED_ASSET_MISSING");
      continue;
    }
    if (entry.kind !== "file" || !SHA256.test(entry.sha256) || entry.size < 0) {
      failures.add("EVOLUTION_UNSUPPORTED_ASSET");
    }
  }
  return [...failures];
}

function validateCandidateSnapshot(
  snapshot: EvolutionCandidateSnapshot,
  baseCommit: string,
  mutableTargets: readonly string[],
  protectedPaths: readonly string[],
  maxChangedAssets: number,
  sealed: boolean,
): string[] {
  const failures = new Set<string>();
  if (snapshot.baseCommit !== baseCommit) failures.add("EVOLUTION_BASE_COMMIT_MISMATCH");
  if (!SHA256.test(snapshot.patchHash)) failures.add("EVOLUTION_PATCH_HASH_INVALID");
  if (sealed && (!COMMIT_ID.test(snapshot.candidateCommit) || snapshot.candidateCommit === baseCommit)) {
    failures.add("EVOLUTION_CANDIDATE_COMMIT_INVALID");
  }
  if (snapshot.changedAssets.length === 0) failures.add("EVOLUTION_NO_CHANGED_ASSETS");
  if (snapshot.changedAssets.length > maxChangedAssets) failures.add("EVOLUTION_CHANGED_ASSET_LIMIT_EXCEEDED");
  const seen = new Set<string>();
  for (const entry of snapshot.changedAssets) {
    const pathFailure = validateRelativeAssetPath(entry.path);
    if (pathFailure) failures.add(pathFailure);
    if (hasRepositoryControlSegment(entry.path)) failures.add("EVOLUTION_REPOSITORY_CONTROL_MODIFIED");
    if (isProtectedCandidateTarget(entry.path)) failures.add("EVOLUTION_PROTECTED_TARGET_DECLARED");
    if (entry.kind !== "file" || !SHA256.test(entry.sha256) || entry.size < 0) {
      failures.add("EVOLUTION_UNSUPPORTED_ASSET");
    }
    if (!mutableTargets.some((target) => pathMatchesTarget(entry.path, target))) {
      failures.add("EVOLUTION_UNDECLARED_ASSET");
    }
    if (protectedPaths.includes(entry.path)) failures.add("EVOLUTION_PROTECTED_ASSET_MODIFIED");
    if (seen.has(entry.path)) failures.add("EVOLUTION_DUPLICATE_CHANGED_ASSET");
    seen.add(entry.path);
  }
  return [...failures];
}

function validateRelativeAssetPath(value: string): string | undefined {
  if (
    !value
    || value.includes("\\")
    || value.includes("\0")
    || posix.isAbsolute(value)
    || posix.normalize(value) !== value
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return "EVOLUTION_PATH_ESCAPE";
  }
  return undefined;
}

function hasRepositoryControlSegment(value: string): boolean {
  return value.split("/").some((segment) =>
    segment === ".git"
    || segment === ".unclecode"
    || segment === ".gitattributes"
    || segment === ".gitmodules");
}

function pathMatchesTarget(path: string, target: string): boolean {
  const normalizedTarget = target.endsWith("/") ? target.slice(0, -1) : target;
  return path === normalizedTarget || path.startsWith(`${normalizedTarget}/`);
}

function validateEvaluation(
  evaluation: Extract<EvolutionEvaluatorResult, { readonly status: "completed" }>,
  suite: Readonly<EvolutionSuiteDefinition>,
  expectedEnvironmentHash: string,
  expectedProofContext: Readonly<EvolutionEvaluationProofContext>,
  evaluatedAt: string,
  maximumProofAgeMs: number,
): string[] {
  const failures = new Set<string>();
  if (!SHA256.test(evaluation.environmentHash)) failures.add("EVOLUTION_EVALUATION_ENVIRONMENT_INVALID");
  if (evaluation.environmentHash !== expectedEnvironmentHash) {
    failures.add("EVOLUTION_EVALUATION_ENVIRONMENT_MISMATCH");
  }
  if (
    (evaluation.integratedProof.status !== "proven" && evaluation.integratedProof.status !== "unproven")
    || !Array.isArray(evaluation.integratedProof.reasons)
    || evaluation.integratedProof.reasons.some((reason) => typeof reason !== "string" || reason.length === 0)
  ) {
    failures.add("EVOLUTION_INTEGRATED_PROOF_INVALID");
  }
  if (evaluation.integratedProof.status === "proven") {
    const binding = evaluation.integratedProof.binding;
    const observedAtMs = Date.parse(binding?.observedAt ?? "");
    const evaluatedAtMs = Date.parse(evaluatedAt);
    const metrics = binding?.metrics;
    const contextMatches = binding !== undefined && (Object.keys(expectedProofContext) as (keyof EvolutionEvaluationProofContext)[])
      .every((key) => binding[key] === expectedProofContext[key]);
    const metricsValid = metrics !== undefined
      && Object.keys(metrics).length > 0
      && Object.entries(metrics).every(([key, value]) => key.length > 0 && Number.isFinite(value));
    if (
      evaluation.integratedProof.reasons.length !== 0
      || binding === undefined
      || !contextMatches
      || binding.baselineResultHash !== benchmarkResultHash(evaluation.baseline)
      || binding.candidateResultHash !== benchmarkResultHash(evaluation.candidate)
      || !SHA256.test(binding.baselineObservationHash)
      || !SHA256.test(binding.candidateObservationHash)
      || !binding.providerRunId.trim()
      || !SHA256.test(binding.verificationMatrixArtifactHash)
      || !binding.independentReviewerId.trim()
      || binding.independentReviewerId === expectedProofContext.creatorId
      || !SHA256.test(binding.independentReviewArtifactHash)
      || !metricsValid
      || binding.metricsHash !== canonicalHash(metrics)
      || !CANONICAL_UTC_MILLISECONDS.test(binding.observedAt)
      || !Number.isFinite(observedAtMs)
      || !Number.isFinite(evaluatedAtMs)
      || observedAtMs > evaluatedAtMs
      || evaluatedAtMs - observedAtMs > maximumProofAgeMs
      || binding.proofHash !== evaluationProofHash(binding)
    ) {
      failures.add("EVOLUTION_INTEGRATED_PROOF_INVALID");
    }
  }
  const expectedChecks = suite.checks.map((entry) => entry.id);
  for (const result of [evaluation.baseline, evaluation.candidate]) {
    if (!finiteScore(result.score)) failures.add("EVOLUTION_EVALUATION_SCORE_INVALID");
    if (
      result.checks.length !== expectedChecks.length
      || result.checks.some((entry, index) => entry.id !== expectedChecks[index])
    ) {
      failures.add("EVOLUTION_SUITE_MISMATCH");
    }
    for (const check of result.checks) {
      if (!finiteScore(check.score) || !Number.isFinite(check.durationMs) || check.durationMs < 0) {
        failures.add("EVOLUTION_EVALUATION_RESULT_INVALID");
      }
    }
  }
  return [...failures];
}

function evaluationProofHash(binding: EvolutionEvaluationProofBinding): string {
  const { proofHash: _proofHash, ...evidence } = binding;
  return canonicalHash(evidence);
}

function benchmarkResultHash(result: EvolutionBenchmarkResult): string {
  return canonicalHash({ score: result.score, checks: result.checks });
}

function sanitizeEvaluation(
  evaluation: Extract<EvolutionEvaluatorResult, { readonly status: "completed" }>,
): Extract<EvolutionEvaluatorResult, { readonly status: "completed" }> {
  const integratedProof = evaluation.integratedProof ?? {
    status: "unproven" as const,
    reasons: ["HOST_INTEGRATED_PROOF_MISSING"],
  };
  return {
    status: "completed",
    environmentHash: evaluation.environmentHash,
    integratedProof: {
      status: integratedProof.status,
      reasons: integratedProof.reasons.map((reason) => boundedSummary(reason)),
      ...(integratedProof.binding === undefined
        ? {}
        : {
            binding: {
              ...integratedProof.binding,
              metrics: { ...integratedProof.binding.metrics },
            },
          }),
    },
    baseline: {
      score: evaluation.baseline.score,
      summary: boundedSummary(evaluation.baseline.summary),
      checks: evaluation.baseline.checks.map((entry) => ({ ...entry })),
    },
    candidate: {
      score: evaluation.candidate.score,
      summary: boundedSummary(evaluation.candidate.summary),
      checks: evaluation.candidate.checks.map((entry) => ({ ...entry })),
    },
  };
}

function compareEvaluation(
  evaluation: Extract<EvolutionEvaluatorResult, { readonly status: "completed" }>,
  suite: Readonly<EvolutionSuiteDefinition>,
): NonNullable<EvolutionProposalProjection["comparison"]> {
  const baselineById = new Map(evaluation.baseline.checks.map((entry) => [entry.id, entry]));
  const checksPass = evaluation.candidate.checks.every((entry) => {
    const baseline = baselineById.get(entry.id);
    return entry.status === "passed"
      && baseline !== undefined
      && baseline.score - entry.score <= suite.thresholds.maximumRegression;
  });
  const delta = evaluation.candidate.score - evaluation.baseline.score;
  const passed = checksPass
    && evaluation.candidate.score >= suite.thresholds.minimumCandidateScore
    && delta >= suite.thresholds.minimumDelta;
  return {
    baselineScore: evaluation.baseline.score,
    candidateScore: evaluation.candidate.score,
    delta,
    passed,
    thresholdsHash: canonicalHash(suite.thresholds),
  };
}

function validateIsolationLocally(
  proposal: EvolutionProposal,
  context: EvolutionValidationContext,
  expectedAttestorId: string,
): string[] {
  const isolation = context.isolation;
  if (!isolation) return ["MISSING_ISOLATION_ATTESTATION"];
  const failures = new Set<string>();
  const evaluationMs = Date.parse(context.evaluationTimestamp);
  const attestationMs = Date.parse(isolation.timestamp);
  if (
    !CANONICAL_UTC_MILLISECONDS.test(context.evaluationTimestamp)
    || !CANONICAL_UTC_MILLISECONDS.test(isolation.timestamp)
    || !Number.isFinite(evaluationMs)
    || !Number.isFinite(attestationMs)
    || attestationMs > evaluationMs
    || isolation.attestorId !== expectedAttestorId
  ) {
    failures.add("INVALID_ISOLATION_ATTESTATION");
  }
  if (Number.isFinite(evaluationMs) && Number.isFinite(attestationMs)
    && evaluationMs - attestationMs > context.maxAttestationAgeMs) {
    failures.add("STALE_ISOLATION_ATTESTATION");
  }
  if (
    isolation.candidateId !== proposal.candidateId
    || isolation.candidateBranch !== proposal.isolatedBranch
    || isolation.candidateWorktree !== proposal.isolatedWorktree
  ) {
    failures.add("ISOLATION_ATTESTATION_MISMATCH");
  }
  if (!isolation.branchExists) failures.add("ISOLATED_BRANCH_NOT_FOUND");
  if (!isolation.worktreeExists) failures.add("ISOLATED_WORKTREE_NOT_FOUND");
  if (isolation.candidateBranch === isolation.baseBranch || isolation.candidateBranch === isolation.hostCurrentBranch) {
    failures.add("BRANCH_NOT_ISOLATED");
  }
  if (isolation.candidateWorktree === isolation.baseWorktree || isolation.candidateWorktree === isolation.hostCurrentWorktree) {
    failures.add("WORKTREE_NOT_ISOLATED");
  }
  if (isolation.attestorId === proposal.creatorId || isolation.attestorId === proposal.evaluatorId) {
    failures.add("ISOLATION_ATTESTOR_CONFLICT");
  }
  return [...failures];
}

function validateCurrentIsolation(
  proposal: EvolutionProposal,
  isolation: EvolutionIsolationAttestation | undefined,
  expectedAttestorId: string,
  maxAgeMs: number,
  checkedAt: string,
): string[] {
  if (!isolation) return ["MISSING_ISOLATION_ATTESTATION"];
  const failures = validateIsolationLocally(proposal, {
    evaluatorAssets: [],
    policyAssets: [],
    benchmarkAssets: [],
    evaluationTimestamp: isolation.timestamp,
    maxAttestationAgeMs: maxAgeMs,
    isolation,
  }, expectedAttestorId);
  const attestedAt = Date.parse(isolation.timestamp);
  const checkedAtMs = Date.parse(checkedAt);
  if (
    !CANONICAL_UTC_MILLISECONDS.test(checkedAt)
    || !Number.isFinite(attestedAt)
    || !Number.isFinite(checkedAtMs)
    || attestedAt > checkedAtMs
  ) {
    failures.push("INVALID_ISOLATION_ATTESTATION");
  } else if (checkedAtMs - attestedAt > maxAgeMs) {
    failures.push("STALE_ISOLATION_ATTESTATION");
  }
  return [...new Set(failures)];
}

function protectedMutationCodes(
  before: EvolutionProtectedSnapshot,
  after: EvolutionProtectedSnapshot,
  config: Readonly<CreatorEvolutionConfig>,
): string[] {
  const failures: string[] = [];
  if (protectedGroupHash(before, config.evaluator.assets) !== protectedGroupHash(after, config.evaluator.assets)) {
    failures.push("EVOLUTION_EVALUATOR_ASSET_MUTATED");
  }
  if (protectedGroupHash(before, config.policyAssets) !== protectedGroupHash(after, config.policyAssets)) {
    failures.push("EVOLUTION_POLICY_ASSET_MUTATED");
  }
  if (protectedGroupHash(before, config.suite.assets) !== protectedGroupHash(after, config.suite.assets)) {
    failures.push("EVOLUTION_BENCHMARK_ASSET_MUTATED");
  }
  return failures;
}

function protectedGroupHash(snapshot: EvolutionProtectedSnapshot, assets: readonly string[]): string {
  const selected = snapshot.entries
    .filter((entry) => assets.includes(entry.path))
    .map((entry) => ({ path: entry.path, sha256: entry.sha256, kind: entry.kind, size: entry.size }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return canonicalHash(selected);
}

function candidateArtifactHash(snapshot: EvolutionCandidateSnapshot): string {
  return canonicalHash({
    baseCommit: snapshot.baseCommit,
    candidateCommit: snapshot.candidateCommit,
    patchHash: snapshot.patchHash,
    changedAssets: snapshot.changedAssets
      .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  });
}

function evaluationEvidenceArtifactHash(
  snapshot: EvolutionCandidateSnapshot,
  evaluatorEnvironmentHash: string,
  proofHash: string | undefined,
): string {
  return canonicalHash({
    candidateArtifact: candidateArtifactHash(snapshot),
    evaluatorEnvironmentHash,
    proofHash,
  });
}

function candidateFingerprint(snapshot: EvolutionCandidateSnapshot): string {
  return canonicalHash(snapshot);
}

function protectedAssetPaths(config: Readonly<CreatorEvolutionConfig>): readonly string[] {
  return [...new Set([
    ...config.evaluator.assets,
    ...config.policyAssets,
    ...config.suite.assets,
  ])].sort();
}

function evaluationProofContext(
  execution: EvolutionExecution,
  config: Readonly<CreatorEvolutionConfig>,
): EvolutionEvaluationProofContext {
  if (!execution.base || !execution.candidate || !execution.candidateSnapshot || !execution.protectedSnapshot) {
    throw new Error("Evolution proof context requires a sealed candidate and protected snapshot.");
  }
  const protectedByPath = new Map(execution.protectedSnapshot.entries.map((entry) => [entry.path, entry]));
  const assetHash = (paths: readonly string[]): string => canonicalHash(paths
    .map((path) => protectedByPath.get(path))
    .filter((entry): entry is EvolutionAssetDigest => entry !== undefined)
    .map(({ path, sha256, kind, size }) => ({ path, sha256, kind, size }))
    .sort((left, right) => left.path.localeCompare(right.path)));
  const manifest = config.suite.assets.find((path) => path.endsWith("/manifest.json") || path === "manifest.json");
  const thresholdAsset = config.suite.assets.find((path) => path.endsWith("/thresholds.json") || path === "thresholds.json");
  return {
    runId: execution.input.runId,
    proposalId: execution.proposalId,
    candidateId: execution.candidateId,
    creatorId: execution.input.creatorId,
    baseCommit: execution.base.baseCommit,
    candidateCommit: execution.candidateSnapshot.candidateCommit,
    baselineWorktreeHash: canonicalHash({
      path: execution.candidate.baselineWorktree,
      commit: execution.base.baseCommit,
    }),
    candidateWorktreeHash: canonicalHash({
      path: execution.candidate.worktree,
      commit: execution.candidateSnapshot.candidateCommit,
    }),
    candidateArtifactHash: candidateArtifactHash(execution.candidateSnapshot),
    evaluatorHash: execution.evaluatorHash,
    evaluatorAssetsHash: assetHash(config.evaluator.assets),
    evaluatorEnvironmentHash: config.evaluatorEnvironmentHash,
    suiteHash: execution.suiteHash,
    suiteAssetsHash: assetHash(config.suite.assets),
    manifestHash: manifest === undefined
      ? assetHash(config.suite.assets)
      : protectedByPath.get(manifest)?.sha256 ?? canonicalHash({ missing: manifest }),
    thresholdsHash: execution.thresholdsHash,
    thresholdAssetHash: thresholdAsset === undefined
      ? execution.thresholdsHash
      : protectedByPath.get(thresholdAsset)?.sha256 ?? canonicalHash({ missing: thresholdAsset }),
  };
}

function finiteScore(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function canonicalNow(now: () => Date): string {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError("Evolution clock returned an invalid date.");
  }
  return date.toISOString();
}

function canonicalHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot hash a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError(`Cannot hash value of type ${typeof value}.`);
}

function cloneConfig(config: CreatorEvolutionConfig): CreatorEvolutionConfig {
  return {
    evaluator: {
      id: config.evaluator.id,
      definition: config.evaluator.definition,
      version: config.evaluator.version,
      assets: [...config.evaluator.assets],
    },
    policyAssets: [...config.policyAssets],
    evaluatorEnvironmentHash: config.evaluatorEnvironmentHash,
    suite: {
      id: config.suite.id,
      version: config.suite.version,
      assets: [...config.suite.assets],
      checks: config.suite.checks.map((entry) => ({ ...entry })),
      thresholds: { ...config.suite.thresholds },
      environment: { ...config.suite.environment },
    },
    attestorId: config.attestorId,
    maxAttestationAgeMs: config.maxAttestationAgeMs,
    bounds: { ...config.bounds },
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function boundedSummary(value: string): string {
  const redacted = redactAgentOpsSecrets(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return redacted.length <= MAX_EVOLUTION_SUMMARY_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_EVOLUTION_SUMMARY_CHARS - 14)} … truncated`;
}

function boundedIdentity(value: string): string {
  return redactAgentOpsSecrets(value).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 256);
}

function boundedPath(value: string): string {
  return boundedIdentity(value).slice(0, 1_000);
}

function safeIdentity(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return safe || "evolution-run";
}

function errorSummary(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
