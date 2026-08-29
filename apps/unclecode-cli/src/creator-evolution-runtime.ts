import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  CreatorEvolutionService,
  createGitCreatorEvolutionHost,
  type AgentOpsRecorder,
  type AppReasoningConfig,
  type EvolutionBenchmarkResult,
  type EvolutionEvaluatorResult,
  type WorkTurnAgent,
} from "@unclecode/orchestrator";
// @ts-expect-error The trusted harness is authored as an executable ESM module.
import * as heldOutBenchmark from "../../../scripts/held-out-benchmark.mjs";

const {
  HELD_OUT_V1_EVALUATOR_ASSETS,
  HELD_OUT_V1_SUITE_ASSETS,
  runHeldOutComparison,
} = heldOutBenchmark;

const CREATOR_TIMEOUT_MS = 10 * 60_000;
const CREATOR_POST_ABORT_SETTLEMENT_GRACE_MS = 1_000;
const EVALUATOR_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 16_384;

export type HostHeldOutEvaluation = {
  readonly baselineResult: unknown;
  readonly candidateResult: unknown;
  readonly verification: {
    readonly providerRunId: string;
    readonly fullVerificationMatrix: {
      readonly status: "passed";
      readonly artifactHash: string;
    };
    readonly independentFinalReview: {
      readonly status: "passed";
      readonly reviewerId: string;
      readonly artifactHash: string;
    };
  };
};

export function createWorkCreatorEvolutionService(input: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly reasoning: AppReasoningConfig;
  readonly recorder: AgentOpsRecorder;
  readonly createCreatorAgent: () => WorkTurnAgent | Promise<WorkTurnAgent>;
  /** Host-only live evaluator. Candidate output cannot provide or replace this callback. */
  readonly evaluateHeldOutWorktrees?: ((input: {
    readonly runId: string;
    readonly baselineWorktree: string;
    readonly candidateWorktree: string;
    readonly signal: AbortSignal;
  }) => Promise<HostHeldOutEvaluation>) | undefined;
  /** Optional operational override; production defaults to the ten-minute creator budget. */
  readonly creatorTimeoutMs?: number;
  /** Creator providers receive abort, then this finite grace before their edit envelope is detached. */
  readonly creatorAbortSettlementGraceMs?: number;
}): CreatorEvolutionService {
  const policyAssets = ["AGENTS.md"].filter((asset) => existsSync(join(input.cwd, asset)));
  const immutableEvaluatorEnvironment = Object.freeze(evaluatorEnvironment(input.env));
  const evaluator = {
    id: "unclecode-held-out-evaluator-v1",
    definition: "Trusted UncleCode held-out v1 evaluator; creator has no evaluator capability",
    version: "1.0.0",
    assets: HELD_OUT_V1_EVALUATOR_ASSETS,
  } as const;
  const suite = {
    id: "unclecode-held-out-v1",
    version: "1.0.0",
    assets: HELD_OUT_V1_SUITE_ASSETS,
    checks: [{ id: "held-out-v1", weight: 1 }],
    thresholds: {
      // The trusted harness enforces its full aggregate/domain/frontier/critic
      // gate set. These generic bounds only preserve the normalized result.
      minimumCandidateScore: 0,
      minimumDelta: -1,
      maximumRegression: 1,
    },
    environment: {
      locale: "C",
      timezone: "UTC",
      network: "host-enforced-disabled",
      scripts: "held-out-benchmark-v1",
    },
  } as const;
  const evaluatorEnvironmentHash = sha256(canonicalJson({
    evaluator,
    environment: suite.environment,
    runtimeEnvironmentHash: sha256(canonicalJson(immutableEvaluatorEnvironment)),
    containmentPolicy: "unclecode-evolution-sandbox-v1",
  }));
  const config = {
    evaluator,
    policyAssets,
    evaluatorEnvironmentHash,
    suite,
    attestorId: "unclecode-git-attestor",
    maxAttestationAgeMs: 5 * 60_000,
    bounds: {
      creatorTimeoutMs: input.creatorTimeoutMs ?? CREATOR_TIMEOUT_MS,
      evaluatorTimeoutMs: EVALUATOR_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxChangedAssets: 64,
    },
  } as const;

  const host = createGitCreatorEvolutionHost({
    workspaceRoot: input.cwd,
    async generateCreatorEdits(request) {
      const agent = await input.createCreatorAgent();
      const strictPrompt = [
        request.prompt,
        "",
        "<unclecode_creator_evolution>",
        "You have no tools and no filesystem access. Return proposed file bodies only.",
        "You may propose edits only for these host-owned targets:",
        ...request.mutableTargets.map((target) => `- ${target}`),
        "Do not modify evaluator, policy, benchmark, repository-control, or threshold assets.",
        "Do not merge, push, publish, deploy, release, or approve the candidate.",
        'Return exactly one JSON object: {"files":[{"path":"relative/path","content":"complete file body"}]}.',
        "Do not use Markdown fences or include commentary outside the JSON object.",
        "</unclecode_creator_evolution>",
      ].join("\n");
      try {
        const outcome = await runBoundedCreatorOperation({
          signal: request.signal,
          timeoutMs: request.timeoutMs,
          abortSettlementGraceMs: input.creatorAbortSettlementGraceMs
            ?? CREATOR_POST_ABORT_SETTLEMENT_GRACE_MS,
          run: (signal) => agent.runTurn(strictPrompt, [], { signal }),
          onTerminate: () => agent.clear(),
        });
        if (outcome.status !== "completed") return outcome;
        return {
          status: "completed" as const,
          summary: "Creator returned bounded edits for host validation.",
          edits: parseCreatorEdits(outcome.value.text, request.maxOutputBytes),
        };
      } catch (error) {
        return {
          status: request.signal.aborted ? "cancelled" as const : "failed" as const,
          summary: boundUtf8(error instanceof Error ? error.message : String(error), request.maxOutputBytes),
        };
      }
    },
    async runEvaluator(request): Promise<EvolutionEvaluatorResult> {
      try {
        if (!input.evaluateHeldOutWorktrees) {
          const unavailable: EvolutionBenchmarkResult = {
            score: 0,
            summary: "Host integrated held-out evaluation is unavailable; offline fixtures cannot authorize this candidate.",
            checks: [{ id: "held-out-v1", status: "passed", score: 0, durationMs: 0 }],
          };
          return {
            status: "completed",
            environmentHash: request.expectedEnvironmentHash,
            integratedProof: {
              status: "unproven",
              reasons: ["HOST_HELD_OUT_EVALUATION_UNAVAILABLE"],
            },
            baseline: unavailable,
            candidate: unavailable,
          };
        }
        const outcome = await runBounded(
          request.signal,
          request.timeoutMs,
          async (signal) => {
            signal.throwIfAborted();
            const evaluation = await input.evaluateHeldOutWorktrees!({
              runId: request.runId,
              baselineWorktree: request.baselineWorktree,
              candidateWorktree: request.candidateWorktree,
              signal,
            });
            signal.throwIfAborted();
            assertHeldOutResultIdentity(
              evaluation.baselineResult,
              request.proofContext.baseCommit,
              "baseline",
            );
            assertHeldOutResultIdentity(
              evaluation.candidateResult,
              request.proofContext.candidateCommit,
              "candidate",
            );
            const report = runHeldOutComparison({
              suiteRoot: join(input.cwd, "benchmarks", "held-out", "v1"),
              baselineResult: evaluation.baselineResult,
              candidateResult: evaluation.candidateResult,
              trustedProof: evaluation.verification,
            });
            signal.throwIfAborted();
            return { evaluation, report };
          },
        );
        if (outcome.status !== "completed") return outcome;
        const { evaluation, report } = outcome.value;
        const baseline: EvolutionBenchmarkResult = {
          score: report.baseline.qualityPercent / 100,
          summary: boundUtf8(
            `Held-out baseline quality ${report.baseline.qualityPercent}%.`,
            request.maxOutputBytes,
          ),
          checks: [{
            id: "held-out-v1",
            status: "passed",
            score: report.baseline.qualityPercent / 100,
            durationMs: 0,
          }],
        };
        const candidate: EvolutionBenchmarkResult = {
          score: report.candidate.qualityPercent / 100,
          summary: boundUtf8(
            `Held-out candidate quality ${report.candidate.qualityPercent}%; comparison gates ${report.comparison.passed ? "passed" : "failed"}.`,
            request.maxOutputBytes,
          ),
          checks: [{
            id: "held-out-v1",
            status: report.comparison.passed ? "passed" : "failed",
            score: report.candidate.qualityPercent / 100,
            durationMs: 0,
          }],
        };
        const metrics = heldOutObservedMetrics(report);
        const proofEvidence = {
          ...request.proofContext,
          providerRunId: evaluation.verification.providerRunId,
          verificationMatrixArtifactHash: evaluation.verification.fullVerificationMatrix.artifactHash,
          independentReviewerId: evaluation.verification.independentFinalReview.reviewerId,
          independentReviewArtifactHash: evaluation.verification.independentFinalReview.artifactHash,
          baselineResultHash: benchmarkResultHash(baseline),
          candidateResultHash: benchmarkResultHash(candidate),
          baselineObservationHash: sha256(canonicalJson(evaluation.baselineResult)),
          candidateObservationHash: sha256(canonicalJson(evaluation.candidateResult)),
          metrics,
          metricsHash: sha256(canonicalJson(metrics)),
          observedAt: new Date().toISOString(),
        };
        return {
          status: "completed",
          environmentHash: request.expectedEnvironmentHash,
          integratedProof: {
            status: report.integratedProof.status,
            reasons: [...report.integratedProof.reasons],
            ...(report.integratedProof.status === "proven"
              ? {
                  binding: {
                    ...proofEvidence,
                    proofHash: sha256(canonicalJson(proofEvidence)),
                  },
                }
              : {}),
          },
          baseline,
          candidate,
        };
      } catch (error) {
        return {
          status: request.signal.aborted ? "cancelled" : "failed",
          summary: boundUtf8(error instanceof Error ? error.message : String(error), request.maxOutputBytes),
        };
      }
    },
    recordAgentOps(result) {
      const proposal = result.projection;
      input.recorder.recordEvolutionProposal({
        id: proposal.id,
        runId: proposal.runId,
        candidateId: proposal.candidateId,
        state: proposal.state,
        creatorId: proposal.creatorId,
        evaluatorId: proposal.evaluatorId,
        attestorId: proposal.attestorId,
        humanApproval: "pending",
        stale: proposal.stale,
        hashes: proposal.hashes,
        artifactRefs: proposal.artifactRefs,
        cleanupStatus: proposal.cleanup.status,
        summary: proposal.summary,
      });
    },
  });
  return new CreatorEvolutionService({ config, host });
}

function heldOutObservedMetrics(report: {
  readonly baseline: Record<string, unknown>;
  readonly candidate: Record<string, unknown>;
  readonly comparison: Record<string, unknown>;
}): Readonly<Record<string, number>> {
  const metrics: Record<string, number> = {};
  const collect = (prefix: string, value: unknown): void => {
    if (typeof value === "number" && Number.isFinite(value)) {
      metrics[prefix] = value;
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, nested] of Object.entries(value)) collect(`${prefix}.${key}`, nested);
  };
  collect("baseline", report.baseline);
  collect("candidate", report.candidate);
  collect("comparison", report.comparison);
  return metrics;
}

function assertHeldOutResultIdentity(value: unknown, expectedCommit: string, label: string): void {
  if (
    !value
    || typeof value !== "object"
    || (value as { evidenceMode?: unknown }).evidenceMode !== "live-provider"
    || (value as { commit?: unknown }).commit !== expectedCommit
  ) {
    throw new Error(`Host ${label} held-out result is not bound to the evaluated worktree commit.`);
  }
}

function benchmarkResultHash(result: EvolutionBenchmarkResult): string {
  return sha256(canonicalJson({ score: result.score, checks: result.checks }));
}

type BoundedOutcome<T> =
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "timeout" | "cancelled"; readonly summary: string };

/**
 * Bounds a no-tools creator provider after cancellation. The provider can only
 * return an edit envelope; once the grace expires its promise is detached and
 * no late value can cross into host validation or filesystem mutation.
 */
export async function runBoundedCreatorOperation<T>(input: {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly abortSettlementGraceMs: number;
  readonly run: (signal: AbortSignal) => Promise<T>;
  readonly onTerminate?: (() => void) | undefined;
}): Promise<BoundedOutcome<T>> {
  if (input.signal.aborted) {
    try {
      input.onTerminate?.();
    } catch {
      // The host boundary is already closed; provider cleanup is best effort.
    }
    return { status: "cancelled", summary: "Evolution execution was cancelled." };
  }
  if (!Number.isFinite(input.abortSettlementGraceMs) || input.abortSettlementGraceMs < 0) {
    throw new RangeError("Creator abort settlement grace must be a finite non-negative duration.");
  }

  const controller = new AbortController();
  let cause: "timeout" | "cancelled" | undefined;
  let resolveAborted!: (cause: "timeout" | "cancelled") => void;
  const aborted = new Promise<"timeout" | "cancelled">((resolve) => {
    resolveAborted = resolve;
  });
  const requestAbort = (next: "timeout" | "cancelled", reason: unknown): void => {
    if (cause !== undefined) return;
    cause = next;
    controller.abort(reason);
    try {
      input.onTerminate?.();
    } catch {
      // Detachment still closes the host boundary when provider cleanup fails.
    }
    resolveAborted(next);
  };
  const abortListener = () => requestAbort("cancelled", input.signal.reason);
  input.signal.addEventListener("abort", abortListener, { once: true });
  const timeout = setTimeout(() => {
    requestAbort("timeout", new Error(`Evolution execution exceeded ${input.timeoutMs}ms.`));
  }, input.timeoutMs);

  const running = Promise.resolve().then(() => {
    controller.signal.throwIfAborted();
    return input.run(controller.signal);
  });
  // Install both handlers immediately so a detached provider can never create
  // an unhandled rejection after the lifecycle has released its durable lock.
  const settled = running.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  try {
    const first = await Promise.race([
      settled.then((result) => ({ kind: "settled" as const, result })),
      aborted.then((abortCause) => ({ kind: "aborted" as const, abortCause })),
    ]);
    if (first.kind === "settled") {
      if (cause !== undefined) return creatorAbortOutcome(cause, input.timeoutMs);
      if (!first.result.ok) throw first.result.error;
      return { status: "completed", value: first.result.value };
    }

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        settled.then(() => undefined),
        new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, input.abortSettlementGraceMs);
        }),
      ]);
    } finally {
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    }
    return creatorAbortOutcome(first.abortCause, input.timeoutMs);
  } finally {
    clearTimeout(timeout);
    input.signal.removeEventListener("abort", abortListener);
  }
}

function creatorAbortOutcome(
  cause: "timeout" | "cancelled",
  timeoutMs: number,
): BoundedOutcome<never> {
  return cause === "timeout"
    ? { status: "timeout", summary: `Evolution execution exceeded ${timeoutMs}ms.` }
    : { status: "cancelled", summary: "Evolution execution was cancelled." };
}

async function runBounded<T>(
  signal: AbortSignal,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  onTerminate?: (() => void) | undefined,
): Promise<BoundedOutcome<T>> {
  if (signal.aborted) return { status: "cancelled", summary: "Evolution execution was cancelled." };
  const controller = new AbortController();
  let cause: "timeout" | "cancelled" | undefined;
  let terminationRequested = false;
  const requestTermination = (): void => {
    if (terminationRequested) return;
    terminationRequested = true;
    try {
      onTerminate?.();
    } catch {
      // The aborted operation still owns settlement; cancellation callbacks are best effort.
    }
  };
  const abortListener = () => {
    cause = "cancelled";
    controller.abort(signal.reason);
    requestTermination();
  };
  signal.addEventListener("abort", abortListener, { once: true });
  const timeout = setTimeout(() => {
    cause = "timeout";
    controller.abort(new Error(`Evolution execution exceeded ${timeoutMs}ms.`));
    requestTermination();
  }, timeoutMs);
  timeout.unref?.();
  const running = Promise.resolve().then(() => {
    controller.signal.throwIfAborted();
    return run(controller.signal);
  });
  try {
    const settled = await running.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    if (cause === "timeout") return { status: "timeout", summary: `Evolution execution exceeded ${timeoutMs}ms.` };
    if (cause === "cancelled") return { status: "cancelled", summary: "Evolution execution was cancelled." };
    if (!settled.ok) throw settled.error;
    return { status: "completed", value: settled.value };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortListener);
  }
}

function evaluatorEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TMPDIR", "TMP", "TEMP", "HOME"];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of inherited) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return {
    ...environment,
    CI: "1",
    TZ: "UTC",
    LANG: "C",
    LC_ALL: "C",
    npm_config_offline: "true",
    npm_config_proxy: "",
    npm_config_https_proxy: "",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    NO_PROXY: "",
    no_proxy: "",
  };
}

function parseCreatorEdits(value: string, maximumBytes: number): readonly { readonly path: string; readonly content: string }[] {
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new Error("Creator edit response exceeds its bound.");
  const parsed = JSON.parse(value) as { files?: unknown };
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.files)) {
    throw new Error("Creator must return a JSON files array.");
  }
  return parsed.files.map((entry) => {
    if (
      !entry
      || typeof entry !== "object"
      || typeof (entry as { path?: unknown }).path !== "string"
      || typeof (entry as { content?: unknown }).content !== "string"
    ) {
      throw new Error("Creator returned an invalid file edit.");
    }
    return {
      path: (entry as { path: string }).path,
      content: (entry as { content: string }).content,
    };
  });
}

function boundUtf8(value: string, maximumBytes: number): string {
  const buffer = Buffer.from(value.replace(/[\u0000-\u001f\u007f]/g, " ").trim(), "utf8");
  return buffer.byteLength <= maximumBytes
    ? buffer.toString("utf8")
    : `${buffer.subarray(0, Math.max(0, maximumBytes - 16)).toString("utf8")} … truncated`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError("Unsupported evaluator metadata.");
}
