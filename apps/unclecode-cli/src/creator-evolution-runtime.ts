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

import { runWorkspaceGuardianChecks } from "./guardian-checks.js";

const CREATOR_TIMEOUT_MS = 10 * 60_000;
const EVALUATOR_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 16_384;

export function createWorkCreatorEvolutionService(input: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly reasoning: AppReasoningConfig;
  readonly recorder: AgentOpsRecorder;
  readonly createCreatorAgent: (cwd: string) => WorkTurnAgent;
}): CreatorEvolutionService {
  const policyAssets = ["AGENTS.md"].filter((asset) => existsSync(join(input.cwd, asset)));
  const benchmarkAssets = ["package.json"].filter((asset) => existsSync(join(input.cwd, asset)));
  const immutableEvaluatorEnvironment = Object.freeze(evaluatorEnvironment(input.env));
  const evaluatorEnvironmentHash = sha256(canonicalJson(immutableEvaluatorEnvironment));
  const config = {
    evaluator: {
      id: "unclecode-guardian-evaluator-v1",
      definition: "UncleCode host guardian checks; creator has no evaluator capability",
      version: "1.0.0",
      assets: [] as readonly string[],
    },
    policyAssets,
    suite: {
      id: "unclecode-held-out-guardian-v1",
      version: "1.0.0",
      assets: benchmarkAssets,
      checks: [{ id: "guardian", weight: 1 }],
      thresholds: {
        minimumCandidateScore: 1,
        minimumDelta: 0,
        maximumRegression: 0,
      },
      environment: {
        locale: "C",
        timezone: "UTC",
        network: "npm-offline-policy",
        scripts: "check,test",
      },
    },
    attestorId: "unclecode-git-attestor",
    maxAttestationAgeMs: 5 * 60_000,
    bounds: {
      creatorTimeoutMs: CREATOR_TIMEOUT_MS,
      evaluatorTimeoutMs: EVALUATOR_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxChangedAssets: 64,
    },
  } as const;

  const host = createGitCreatorEvolutionHost({
    workspaceRoot: input.cwd,
    async runCreator(request) {
      const agent = input.createCreatorAgent(request.candidate.worktree);
      const strictPrompt = [
        request.prompt,
        "",
        "<unclecode_creator_evolution>",
        `Work only inside this isolated worktree: ${request.candidate.worktree}`,
        "You may modify only these host-owned targets:",
        ...request.mutableTargets.map((target) => `- ${target}`),
        "Do not modify evaluator, policy, benchmark, repository-control, or threshold assets.",
        "Do not merge, push, publish, deploy, release, or approve the candidate.",
        "</unclecode_creator_evolution>",
      ].join("\n");
      try {
        const outcome = await runBounded(
          request.signal,
          request.timeoutMs,
          () => agent.runTurn(strictPrompt, [], { signal: request.signal }),
          () => agent.clear(),
        );
        if (outcome.status !== "completed") return outcome;
        return {
          status: "completed" as const,
          summary: boundUtf8(outcome.value.text, request.maxOutputBytes),
        };
      } catch (error) {
        return {
          status: request.signal.aborted ? "cancelled" as const : "failed" as const,
          summary: boundUtf8(error instanceof Error ? error.message : String(error), request.maxOutputBytes),
        };
      }
    },
    async runEvaluator(request): Promise<EvolutionEvaluatorResult> {
      const evaluate = async (cwd: string): Promise<EvolutionBenchmarkResult> => {
        const outcome = await runWorkspaceGuardianChecks({
          cwd,
          env: { ...immutableEvaluatorEnvironment },
          scripts: ["check", "test"],
          timeoutMs: Math.max(1_000, Math.floor(request.timeoutMs / 2)),
          signal: request.signal,
        });
        const proven = outcome.checks.length > 0;
        const passed = proven && outcome.checks.every((check) => check.status === "passed");
        return {
          score: passed ? 1 : 0,
          summary: boundUtf8(
            proven ? outcome.summary : "No executable held-out guardian checks were available.",
            request.maxOutputBytes,
          ),
          checks: [{
            id: "guardian",
            status: passed ? "passed" : "failed",
            score: passed ? 1 : 0,
            durationMs: 0,
          }],
        };
      };
      try {
        const outcome = await runBounded(
          request.signal,
          request.timeoutMs,
          async () => ({
            baseline: await evaluate(request.baselineWorktree),
            candidate: await evaluate(request.candidateWorktree),
          }),
        );
        if (outcome.status !== "completed") return outcome;
        return {
          status: "completed",
          environmentHash: sha256(canonicalJson({
            evaluator: request.evaluator,
            environment: request.suite.environment,
            runtimeEnvironmentHash: evaluatorEnvironmentHash,
          })),
          baseline: outcome.value.baseline,
          candidate: outcome.value.candidate,
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

type BoundedOutcome<T> =
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "timeout" | "cancelled"; readonly summary: string };

async function runBounded<T>(
  signal: AbortSignal,
  timeoutMs: number,
  run: () => Promise<T>,
  onTimeout?: (() => void) | undefined,
): Promise<BoundedOutcome<T>> {
  if (signal.aborted) return { status: "cancelled", summary: "Evolution execution was cancelled." };
  let timeout: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      run().then((value): BoundedOutcome<T> => ({ status: "completed", value })),
      new Promise<BoundedOutcome<T>>((resolve) => {
        timeout = setTimeout(() => {
          onTimeout?.();
          resolve({ status: "timeout", summary: `Evolution execution exceeded ${timeoutMs}ms.` });
        }, timeoutMs);
        timeout.unref?.();
        abortListener = () => resolve({ status: "cancelled", summary: "Evolution execution was cancelled." });
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortListener) signal.removeEventListener("abort", abortListener);
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
    NO_PROXY: "*",
    no_proxy: "*",
  };
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
