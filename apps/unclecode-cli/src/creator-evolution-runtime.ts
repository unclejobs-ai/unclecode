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
  runContainedEvolutionCommand,
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
  readonly createCreatorAgent: () => WorkTurnAgent | Promise<WorkTurnAgent>;
}): CreatorEvolutionService {
  const policyAssets = ["AGENTS.md"].filter((asset) => existsSync(join(input.cwd, asset)));
  const benchmarkAssets = ["package.json"].filter((asset) => existsSync(join(input.cwd, asset)));
  const immutableEvaluatorEnvironment = Object.freeze(evaluatorEnvironment(input.env));
  const evaluator = {
    id: "unclecode-guardian-evaluator-v1",
    definition: "UncleCode host guardian checks; creator has no evaluator capability",
    version: "1.0.0",
    assets: [] as readonly string[],
  } as const;
  const suite = {
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
      network: "host-enforced-disabled",
      scripts: "check,test",
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
      creatorTimeoutMs: CREATOR_TIMEOUT_MS,
      evaluatorTimeoutMs: EVALUATOR_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxChangedAssets: 64,
    },
  } as const;

  const host = createGitCreatorEvolutionHost({
    workspaceRoot: input.cwd,
    lifecycleLockTimeoutMs: CREATOR_TIMEOUT_MS + EVALUATOR_TIMEOUT_MS + 60_000,
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
        const outcome = await runBounded(
          request.signal,
          request.timeoutMs,
          (signal) => agent.runTurn(strictPrompt, [], { signal }),
          () => agent.clear(),
        );
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
      const evaluate = async (cwd: string, signal: AbortSignal): Promise<EvolutionBenchmarkResult> => {
        const outcome = await runWorkspaceGuardianChecks({
          cwd,
          env: { ...immutableEvaluatorEnvironment },
          scripts: ["check", "test"],
          timeoutMs: Math.max(1_000, Math.floor(request.timeoutMs / 2)),
          signal,
        }, {
          async execFile(command, args, options) {
            const contained = await runContainedEvolutionCommand({
              cwd: options.cwd,
              workspaceRoot: input.cwd,
              command,
              args,
              environment: options.env ?? immutableEvaluatorEnvironment,
              timeoutMs: options.timeout ?? Math.max(1_000, Math.floor(request.timeoutMs / 2)),
              maxOutputBytes: request.maxOutputBytes,
              readablePaths: existsSync(join(input.cwd, "node_modules"))
                ? [join(input.cwd, "node_modules")]
                : [],
              ...(options.signal ? { signal: options.signal } : {}),
            });
            if (contained.status !== "completed") {
              const error = new Error(`Contained evaluator ${contained.status}: ${contained.stderr}`.trim()) as Error & {
                stdout?: string;
                stderr?: string;
              };
              error.stdout = contained.stdout;
              error.stderr = contained.stderr;
              throw error;
            }
            return { stdout: contained.stdout, stderr: contained.stderr };
          },
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
          async (signal) => ({
            baseline: await evaluate(request.baselineWorktree, signal),
            candidate: await evaluate(request.candidateWorktree, signal),
          }),
        );
        if (outcome.status !== "completed") return outcome;
        return {
          status: "completed",
          environmentHash: request.expectedEnvironmentHash,
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
