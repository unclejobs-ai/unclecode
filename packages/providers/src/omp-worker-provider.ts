/**
 * Node-side adapter for the OMP work executor.
 *
 * UncleCode's work/executor agents delegate their whole turn to OMP: OMP picks
 * the route, runs its own tool loop, resolves its own credentials from its own
 * profile, and reports its own token and cost counters. This adapter is the
 * Node half of that boundary — it implements the existing `LlmProvider` surface
 * by spawning the Bun worker (`omp-worker-entry`), forwarding cancellation, and
 * translating the worker's wire contract into UncleCode's turn result.
 *
 * There is deliberately no fallback. If OMP is missing, unauthenticated, or
 * cannot serve the selector, the turn fails with the worker's stable error code
 * instead of quietly landing on another provider or another credential.
 *
 * The selector is fixed for the life of the provider — no environment variable
 * feeds it and `updateRuntimeSettings` cannot move it — because the
 * work/executor route is contractually one OMP model, not whatever the shell
 * happens to be pointed at.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findOmpInstall, resolveBunExecutable } from "./omp-install.js";
import {
  OMP_WORKER_DEFAULT_MODEL,
  OmpWorkerError,
  parseOmpWorkerResultLine,
  toOmpWorkerFailure,
  type OmpWorkerErrorCode,
  type OmpWorkerRequest,
  type OmpWorkerResult,
  type OmpWorkerUsage,
} from "./omp-worker-entry.js";
import { redactSecrets } from "./redaction.js";
import type {
  AgentTurnResult,
  LlmProvider,
  ProviderInputAttachment,
  ProviderTokenUsage,
  ProviderTraceListener,
  ProviderTurnOptions,
  RuntimeReasoningConfig,
} from "./runtime.js";

/** Provider trace identity for every turn routed through OMP. */
export const OMP_WORKER_PROVIDER_ID = "omp";

/** How much worker stderr is quoted back when the boundary itself fails. */
const OMP_WORKER_STDERR_EXCERPT_LIMIT = 2000;

/** Grace between SIGTERM and SIGKILL when a cancelled worker refuses to leave. */
const OMP_WORKER_FORCE_KILL_DELAY_MS = 2_000;

/**
 * POSIX lets the worker lead its own process group so cancellation reaches
 * OMP's tool children; Windows has no equivalent, so only the child is killed.
 */
const OMP_WORKER_USES_PROCESS_GROUPS = process.platform !== "win32";

export class OmpWorkerProviderError extends Error {
  public readonly code: OmpWorkerErrorCode;

  public constructor(code: OmpWorkerErrorCode, message: string) {
    super(message);
    this.name = "OmpWorkerProviderError";
    this.code = code;
  }
}

export type OmpWorkerRunner = (input: {
  readonly request: OmpWorkerRequest;
  readonly signal?: AbortSignal | undefined;
}) => Promise<OmpWorkerResult>;

export type CreateOmpWorkerProviderArgs = {
  readonly cwd: string;
  /**
   * Fixed for the whole life of the provider and defaulted to
   * `kimi-code/k3`. No environment variable feeds this: the work/executor
   * route is pinned to one OMP selector by contract.
   */
  readonly model?: string | undefined;
  readonly reasoning: RuntimeReasoningConfig;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Bun boundary overrides; production resolves both from the OMP install. */
  readonly bunPath?: string | undefined;
  readonly workerEntryPath?: string | undefined;
  /** Whole-transport override so tests need neither Bun nor an OMP install. */
  readonly runWorker?: OmpWorkerRunner | undefined;
};

/**
 * Spawn the Bun worker for one request. The Bun child process is the only
 * supported boundary: OMP's sources cannot be loaded from Node, so a missing
 * Bun or a missing OMP install is reported as `OMP_UNAVAILABLE` rather than
 * being worked around.
 *
 * Cancellation terminates the worker's whole process group, because OMP runs
 * its tool loop out of process: killing the Bun child alone would strand its
 * descendants.
 */
export function createOmpWorkerRunner(args: {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly bunPath?: string | undefined;
  readonly workerEntryPath?: string | undefined;
  /** SIGTERM→SIGKILL grace for a cancelled turn; defaults to two seconds. */
  readonly forceKillDelayMs?: number | undefined;
}): OmpWorkerRunner {
  const env = args.env ?? process.env;
  const entryPath = args.workerEntryPath ?? resolveWorkerEntryPath();
  const forceKillDelayMs = args.forceKillDelayMs ?? OMP_WORKER_FORCE_KILL_DELAY_MS;
  return ({ request, signal }) =>
    new Promise<OmpWorkerResult>((resolve) => {
      const bunPath = args.bunPath ?? resolveBunExecutable(env);
      if (!args.bunPath && !findOmpInstall(env)) {
        resolve(toOmpWorkerFailure(new OmpWorkerError(
          "OMP_UNAVAILABLE",
          "OMP is not installed or could not be located; install `omp` or set UNCLECODE_OMP_BIN.",
        )));
        return;
      }
      const child = spawn(bunPath, [entryPath], {
        cwd: request.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: OMP_WORKER_USES_PROCESS_GROUPS,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let forceTimer: NodeJS.Timeout | undefined;
      const settle = (result: OmpWorkerResult): void => {
        if (settled) return;
        settled = true;
        if (forceTimer) {
          clearTimeout(forceTimer);
          forceTimer = undefined;
        }
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const signalWorker = (workerSignal: NodeJS.Signals): void => {
        const pid = child.pid;
        if (OMP_WORKER_USES_PROCESS_GROUPS && pid !== undefined) {
          try {
            process.kill(-pid, workerSignal);
            return;
          } catch {
            // The group is already gone, or never formed because the spawn
            // failed; fall through so a live child still gets the signal.
          }
        }
        try {
          child.kill(workerSignal);
        } catch {
          // The worker already exited; `close` still settles the turn.
        }
      };
      function onAbort(): void {
        if (settled || forceTimer) return;
        signalWorker("SIGTERM");
        forceTimer = setTimeout(() => {
          forceTimer = undefined;
          if (settled) return;
          signalWorker("SIGKILL");
        }, forceKillDelayMs);
        forceTimer.unref();
      }

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        // A worker that exited on its own, or was killed mid-write by
        // cancellation, tears the request pipe down. That is the worker's own
        // outcome and `close` already carries its real code, so reporting it
        // again here would only mask that code behind a transport failure.
        if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
        settle(toOmpWorkerFailure(new OmpWorkerError(
          "OMP_UNAVAILABLE",
          `Failed to send the OMP worker request to "${bunPath}": ${error.message}`,
        )));
      });
      child.on("error", (error) => {
        settle(toOmpWorkerFailure(new OmpWorkerError(
          "OMP_UNAVAILABLE",
          `Failed to start the Bun OMP worker via "${bunPath}": ${error.message}`,
        )));
      });
      child.on("close", (code) => {
        try {
          settle(parseOmpWorkerResultLine(stdout));
        } catch (error) {
          settle(toOmpWorkerFailure(new OmpWorkerError(
            error instanceof OmpWorkerError ? error.code : "OMP_PROTOCOL_ERROR",
            `${error instanceof Error ? error.message : String(error)} (bun exit ${String(code)})${describeWorkerStderr(stderr)}`,
          )));
        }
      });

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        // An `abort` listener never fires for a signal that aborted before it
        // was attached, so recheck: a cancellation landing between the caller's
        // pre-flight check and this registration would otherwise leave the
        // worker — and OMP's tool children — running for the whole turn.
        if (signal.aborted) onAbort();
      }
      child.stdin.end(JSON.stringify(request), "utf8");
    });
}

class OmpWorkerProvider implements LlmProvider {
  private readonly model: string;
  private reasoning: RuntimeReasoningConfig;
  private traceListener: ProviderTraceListener | undefined;
  private readonly cwd: string;
  private readonly runWorker: OmpWorkerRunner;

  public constructor(args: CreateOmpWorkerProviderArgs) {
    const env = args.env ?? process.env;
    this.cwd = args.cwd;
    this.model = args.model?.trim() || OMP_WORKER_DEFAULT_MODEL;
    this.reasoning = args.reasoning;
    this.runWorker = args.runWorker ?? createOmpWorkerRunner({
      env,
      ...(args.bunPath ? { bunPath: args.bunPath } : {}),
      ...(args.workerEntryPath ? { workerEntryPath: args.workerEntryPath } : {}),
    });
  }

  public async runTurn(
    prompt: string,
    attachments: readonly ProviderInputAttachment[] = [],
    options: ProviderTurnOptions = {},
  ): Promise<AgentTurnResult> {
    if (attachments.length > 0) {
      throw new OmpWorkerProviderError(
        "OMP_PROTOCOL_ERROR",
        "The OMP work executor takes a text prompt only; input attachments are not forwarded.",
      );
    }
    if (options.signal?.aborted) {
      throw createAbortError();
    }
    const request: OmpWorkerRequest = {
      prompt,
      cwd: this.cwd,
      model: this.model,
      reasoning: this.reasoning.effort,
    };
    const result = await this.runWorker({
      request,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (options.signal?.aborted) {
      throw createAbortError();
    }
    if (!result.ok) {
      throw new OmpWorkerProviderError(result.error.code, redactSecrets(result.error.message));
    }
    const text = result.result.text;
    // The pi/native executors stream assistant deltas during a task run, so the
    // dashboard expects assistant output on the trace channel. The worker is
    // non-streaming, so the whole turn lands as one delta rather than none.
    if (text) {
      this.traceListener?.({
        type: "assistant.delta",
        level: "default",
        provider: OMP_WORKER_PROVIDER_ID,
        model: request.model,
        itemId: "omp-worker-text",
        delta: text,
      });
    }
    const usage = toProviderTokenUsage(result.result.usage);
    const costUsd = result.result.usage?.costUsd ?? 0;
    return {
      text,
      ...(usage ? { usage } : {}),
      ...(costUsd > 0 ? { costUsd } : {}),
    };
  }

  /**
   * No-op by construction: every OMP turn runs in a fresh in-memory session, so
   * there is no cross-turn history on this side of the boundary to drop.
   */
  public clear(): void {}

  /**
   * Reasoning is retargetable between turns; the selector is not. The
   * work/executor route is pinned to the model resolved at construction, so a
   * model switch made elsewhere in the shell must never silently re-route an
   * executor turn onto a different OMP model.
   */
  public updateRuntimeSettings(settings: {
    reasoning?: RuntimeReasoningConfig | undefined;
    model?: string | undefined;
  }): void {
    if (settings.reasoning) {
      this.reasoning = settings.reasoning;
    }
  }

  /**
   * OMP runs its tool loop out of process and the worker emits no per-tool
   * payloads, so the only trace this provider raises is the final assistant
   * delta from {@link runTurn}.
   */
  public setTraceListener(listener?: ProviderTraceListener): void {
    this.traceListener = listener;
  }

  // `updateAuthToken` is intentionally absent: OMP resolves credentials from
  // its own profile (OMP_PROFILE / PI_CODING_AGENT_DIR), and accepting an
  // UncleCode bearer token here would imply an authority this route lacks.
}

export function createOmpWorkerProvider(args: CreateOmpWorkerProviderArgs): LlmProvider {
  return new OmpWorkerProvider(args);
}

function resolveWorkerEntryPath(): string {
  const modulePath = fileURLToPath(import.meta.url);
  const extension = path.extname(modulePath) === ".ts" ? ".ts" : ".js";
  return path.join(path.dirname(modulePath), `omp-worker-entry${extension}`);
}

function toProviderTokenUsage(usage: OmpWorkerUsage | undefined): ProviderTokenUsage | undefined {
  if (!usage) return undefined;
  if (
    usage.inputTokens <= 0
    && usage.outputTokens <= 0
    && usage.cacheReadTokens <= 0
    && usage.cacheWriteTokens <= 0
  ) {
    return undefined;
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens > 0 ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens > 0 ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
  };
}

function describeWorkerStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  const excerpt = trimmed.length > OMP_WORKER_STDERR_EXCERPT_LIMIT
    ? `${trimmed.slice(0, OMP_WORKER_STDERR_EXCERPT_LIMIT)}…`
    : trimmed;
  return `: ${redactSecrets(excerpt)}`;
}

function createAbortError(): Error {
  const error = new Error("The OMP work executor turn was aborted.");
  error.name = "AbortError";
  return error;
}
