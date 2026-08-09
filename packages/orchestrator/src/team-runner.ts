/**
 * TeamRunner — coordinator that creates a team run, sweeps stale locks,
 * spawns worker child processes that re-bind via UNCLECODE_TEAM_RUN_* env,
 * and emits started/running/accepted/errored/killed checkpoints based on
 * worker exit codes. Workers publish their own team_step entries; the
 * coordinator does not interpret worker stdout.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type {
  PersonaId,
  TeamGateLevel,
  TeamIsolationMode,
  TeamRunManifest,
  TeamRunStatus,
  TeamRuntimeMode,
  WorkerSpec as ContractWorkerSpec,
} from "@unclecode/contracts";

import {
  createTeamRun,
  generateRunId,
  lockTeamRun,
} from "@unclecode/session-store";

import { TeamBinding } from "./team-binding.js";
import { sweepStaleLocks } from "./disk-ownership-registry.js";
import { runRustCommandSync } from "./rust-command.js";

export function buildWindowsTreeKillArgs(pid: number): readonly string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid worker PID: ${pid}`);
  }
  return ["/PID", String(pid), "/T", "/F"];
}

function killWorkerProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) {
    child.kill(signal);
    return;
  }
  if (process.platform === "win32") {
    const taskkill = spawn("taskkill", buildWindowsTreeKillArgs(child.pid), {
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.once("error", () => {
      child.kill(signal);
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (
      typeof error !== "object"
      || error === null
      || !("code" in error)
      || error.code !== "ESRCH"
    ) {
      child.kill(signal);
    }
  }
}

export type TeamRunnerOptions = {
  readonly dataRoot: string;
  readonly objective: string;
  readonly persona: PersonaId;
  readonly lanes?: number;
  readonly gate?: TeamGateLevel;
  readonly runtime?: TeamRuntimeMode;
  readonly isolation?: TeamIsolationMode;
  readonly workspaceRoot: string;
  readonly createdBy: string;
  readonly runId?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly codeState?: TeamRunManifest["codeState"];
};

export type TeamRunnerHandle = {
  readonly runId: string;
  readonly runRoot: string;
  readonly binding: TeamBinding;
  readonly release: () => void;
  start(): void;
  setStatus(status: TeamRunStatus): void;
  dispatch(options: DispatchOptions): Promise<DispatchResult>;
};

/**
 * Canonical WorkerSpec lives in @unclecode/contracts. Re-exported here so
 * existing imports from `@unclecode/orchestrator` keep resolving without
 * downstream breakage. `runtime` is required; `model`/`extras` optional.
 */
export type WorkerSpec = ContractWorkerSpec;

export type WorkerCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};

export type DispatchOptions = {
  readonly workerCommand: WorkerCommand;
  readonly workers: ReadonlyArray<WorkerSpec>;
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly isolation?: TeamIsolationMode;
  readonly cwd?: string;
  readonly onStdout?: (workerId: string, line: string) => void;
  readonly onStderr?: (workerId: string, line: string) => void;
  readonly perWorkerTimeoutMs?: number;
};

export type WorkerOutcome = {
  readonly workerId: string;
  readonly persona: PersonaId;
  readonly status: "completed" | "failed" | "killed";
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly isolation: TeamIsolationMode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
  readonly changePatchPath?: string;
};

const WORKER_STREAM_CAP_BYTES = 1_000_000;

export type DispatchResult = {
  readonly status: TeamRunStatus;
  readonly outcomes: ReadonlyArray<WorkerOutcome>;
  readonly sweep: { readonly swept: number; readonly live: number };
};

export function startTeamRun(options: TeamRunnerOptions): TeamRunnerHandle {
  ensureDataRoot(options.dataRoot);
  const ref = createTeamRun({
    dataRoot: options.dataRoot,
    objective: options.objective,
    persona: options.persona,
    lanes: options.lanes ?? 1,
    gate: options.gate ?? "strict",
    runtime: options.runtime ?? "local",
    isolation: options.isolation ?? "shared",
    workspaceRoot: options.workspaceRoot,
    createdBy: options.createdBy,
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.codeState !== undefined ? { codeState: options.codeState } : {}),
  });

  const binding = new TeamBinding({
    runId: ref.runId,
    runRoot: ref.runRoot,
    role: "coordinator",
    workspaceRoot: options.workspaceRoot,
  });

  const release = lockTeamRun(ref.runRoot, options.createdBy);

  const handle: TeamRunnerHandle = {
    runId: ref.runId,
    runRoot: ref.runRoot,
    binding,
    release,
    start() {
      binding.publish({
        type: "team_run",
        runId: ref.runId,
        persona: options.persona,
        status: "started",
        objective: options.objective,
        lanes: options.lanes ?? 1,
        timestamp: new Date().toISOString(),
      });
    },
    setStatus(status: TeamRunStatus) {
      binding.publish({
        type: "team_run",
        runId: ref.runId,
        persona: options.persona,
        status,
        objective: options.objective,
        lanes: options.lanes ?? 1,
        timestamp: new Date().toISOString(),
      });
    },
    async dispatch(dispatchOptions: DispatchOptions): Promise<DispatchResult> {
      return runDispatch({
        binding,
        runRoot: ref.runRoot,
        runId: ref.runId,
        persona: options.persona,
        objective: options.objective,
        lanes: options.lanes ?? 1,
        workspaceRoot: options.workspaceRoot,
        isolation: options.isolation ?? "shared",
        dispatch: dispatchOptions,
      });
    },
  };

  return handle;
}

async function runDispatch(input: {
  readonly binding: TeamBinding;
  readonly runRoot: string;
  readonly runId: string;
  readonly persona: PersonaId;
  readonly objective: string;
  readonly lanes: number;
  readonly workspaceRoot: string;
  readonly isolation: TeamIsolationMode;
  readonly dispatch: DispatchOptions;
}): Promise<DispatchResult> {
  const sweep = sweepStaleLocks(input.runRoot);

  input.binding.publish({
    type: "team_run",
    runId: input.runId,
    persona: input.persona,
    status: "running",
    objective: input.objective,
    lanes: input.lanes,
    timestamp: new Date().toISOString(),
  });

  const childEnv = resolveChildEnv({
    baseEnv: process.env,
    bindingEnv: input.binding.envForChild(),
    ...(input.dispatch.extraEnv !== undefined ? { extraEnv: input.dispatch.extraEnv } : {}),
  });
  const isolation = input.dispatch.isolation ?? input.isolation;
  const workspaces: Array<{
    readonly spec: WorkerSpec;
    readonly cwd: string;
    readonly prepared?: PreparedWorkerWorktree;
  }> = [];
  let baselineCommit: string | undefined;
  try {
    for (const spec of input.dispatch.workers) {
      if (isolation === "worktree") {
        const prepared = prepareWorkerWorktree({
          workspaceRoot: input.workspaceRoot,
          runRoot: input.runRoot,
          runId: input.runId,
          workerId: spec.workerId,
          ...(baselineCommit !== undefined ? { baselineCommit } : {}),
        });
        if (baselineCommit === undefined) baselineCommit = prepared.baselineCommit;
        workspaces.push({ spec, cwd: prepared.worktreePath, prepared });
      } else {
        workspaces.push({
          spec,
          cwd: input.dispatch.cwd ?? input.workspaceRoot,
        });
      }
    }
  } catch (error) {
    for (const workspace of workspaces) {
      if (workspace.prepared === undefined) continue;
      try {
        finalizeWorkerWorktree({
          workspaceRoot: input.workspaceRoot,
          runRoot: input.runRoot,
          workerId: workspace.spec.workerId,
          prepared: workspace.prepared,
        });
      } catch {
        // Preserve the original setup error; worktree preparation performs its own rollback.
      }
    }
    throw error;
  }

  const outcomes = await Promise.all(
    workspaces.map(async (workspace) => {
      const outcome = await runWorker({
        spec: workspace.spec,
        command: input.dispatch.workerCommand,
        env: childEnv,
        cwd: workspace.cwd,
        isolation,
        ...(input.dispatch.onStdout !== undefined ? { onStdout: input.dispatch.onStdout } : {}),
        ...(input.dispatch.onStderr !== undefined ? { onStderr: input.dispatch.onStderr } : {}),
        ...(input.dispatch.perWorkerTimeoutMs !== undefined
          ? { timeoutMs: input.dispatch.perWorkerTimeoutMs }
          : {}),
      });
      if (workspace.prepared === undefined) return outcome;
      try {
        const finalized = finalizeWorkerWorktree({
          workspaceRoot: input.workspaceRoot,
          runRoot: input.runRoot,
          workerId: workspace.spec.workerId,
          prepared: workspace.prepared,
        });
        return {
          ...outcome,
          ...(finalized.changePatchPath !== undefined
            ? { changePatchPath: finalized.changePatchPath }
            : {}),
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          ...outcome,
          status: "failed" as const,
          exitCode: outcome.exitCode === 0 ? -1 : outcome.exitCode,
          stderr: `${outcome.stderr}${outcome.stderr.endsWith("\n") || outcome.stderr.length === 0 ? "" : "\n"}Failed to finalize isolated worktree: ${detail}\n`,
        };
      }
    }),
  );

  const finalStatus = resolveDispatchStatus(outcomes);

  input.binding.publish({
    type: "team_run",
    runId: input.runId,
    persona: input.persona,
    status: finalStatus,
    objective: input.objective,
    lanes: input.lanes,
    timestamp: new Date().toISOString(),
  });

  return { status: finalStatus, outcomes, sweep };
}

type PreparedWorkerWorktree = {
  readonly worktreePath: string;
  readonly baselineCommit: string;
};

function prepareWorkerWorktree(input: {
  readonly workspaceRoot: string;
  readonly runRoot: string;
  readonly runId: string;
  readonly workerId: string;
  readonly baselineCommit?: string;
}): PreparedWorkerWorktree {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "team", "worktree-prepare"],
      input.workspaceRoot,
      JSON.stringify(input),
    ),
  ) as unknown;
  if (
    !isRecord(parsed)
    || typeof parsed.worktreePath !== "string"
    || typeof parsed.baselineCommit !== "string"
  ) {
    throw new Error("Rust team worktree prepare returned invalid payload");
  }
  return {
    worktreePath: parsed.worktreePath,
    baselineCommit: parsed.baselineCommit,
  };
}

function finalizeWorkerWorktree(input: {
  readonly workspaceRoot: string;
  readonly runRoot: string;
  readonly workerId: string;
  readonly prepared: PreparedWorkerWorktree;
}): { readonly changePatchPath?: string } {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "team", "worktree-finalize"],
      input.workspaceRoot,
      JSON.stringify({
        workspaceRoot: input.workspaceRoot,
        runRoot: input.runRoot,
        workerId: input.workerId,
        worktreePath: input.prepared.worktreePath,
        baselineCommit: input.prepared.baselineCommit,
      }),
    ),
  ) as unknown;
  if (
    !isRecord(parsed)
    || (parsed.changePatchPath !== null && typeof parsed.changePatchPath !== "string")
  ) {
    throw new Error("Rust team worktree finalize returned invalid payload");
  }
  return parsed.changePatchPath === null
    ? {}
    : { changePatchPath: parsed.changePatchPath };
}

function runWorker(input: {
  readonly spec: WorkerSpec;
  readonly command: WorkerCommand;
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly isolation: TeamIsolationMode;
  readonly onStdout?: (workerId: string, line: string) => void;
  readonly onStderr?: (workerId: string, line: string) => void;
  readonly timeoutMs?: number;
}): Promise<WorkerOutcome> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const args = buildWorkerSpawnArgs(input.command.args, input.spec);
    const child = spawn(input.command.command, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const stdoutBuf = createCappedBuffer(WORKER_STREAM_CAP_BYTES);
    const stderrBuf = createCappedBuffer(WORKER_STREAM_CAP_BYTES);
    const stdoutTail = { pending: "" };
    const stderrTail = { pending: "" };
    let killedByTimeout = false;
    let timer: NodeJS.Timeout | null = null;

    const emitLines = (
      tail: { pending: string },
      chunk: string,
      callback: ((id: string, line: string) => void) | undefined,
      flushRemainder: boolean,
    ): void => {
      if (callback === undefined) return;
      const buffered = tail.pending + chunk;
      const lines = buffered.split(/\r?\n/);
      tail.pending = flushRemainder ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (line.length > 0) callback(input.spec.workerId, line);
      }
      if (flushRemainder && tail.pending.length > 0) {
        callback(input.spec.workerId, tail.pending);
        tail.pending = "";
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdoutBuf.append(text);
      emitLines(stdoutTail, text, input.onStdout, false);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrBuf.append(text);
      emitLines(stderrTail, text, input.onStderr, false);
    });

    if (input.timeoutMs && input.timeoutMs > 0) {
      timer = setTimeout(() => {
        killedByTimeout = true;
        killWorkerProcessTree(child, "SIGKILL");
      }, input.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }

    const finish = (status: WorkerOutcome["status"], exitCode: number, signal: NodeJS.Signals | null, stderrSuffix?: string): void => {
      if (timer) clearTimeout(timer);
      emitLines(stdoutTail, "", input.onStdout, true);
      emitLines(stderrTail, "", input.onStderr, true);
      if (stderrSuffix !== undefined) stderrBuf.append(`${stderrSuffix}\n`);
      resolve({
        workerId: input.spec.workerId,
        persona: input.spec.persona,
        isolation: input.isolation,
        status,
        exitCode,
        signal,
        stdout: stdoutBuf.value,
        stderr: stderrBuf.value,
        stdoutTruncated: stdoutBuf.truncated,
        stderrTruncated: stderrBuf.truncated,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on("error", (error) => {
      finish("failed", -1, null, error instanceof Error ? error.message : String(error));
    });
    child.on("close", (code, signal) => {
      const outcome = resolveWorkerCloseOutcome({ killedByTimeout, code, signal });
      finish(outcome.status, outcome.exitCode, outcome.signal);
    });
  });
}

function buildWorkerSpawnArgs(baseArgs: ReadonlyArray<string>, spec: WorkerSpec): string[] {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "team", "worker-spawn-args"],
      process.cwd(),
      JSON.stringify({ baseArgs, spec }),
    ),
  ) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.args) || !parsed.args.every((arg) => typeof arg === "string")) {
    throw new Error("Rust team worker spawn args returned invalid payload");
  }
  return parsed.args;
}

function resolveDispatchStatus(outcomes: ReadonlyArray<WorkerOutcome>): TeamRunStatus {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "team", "dispatch-status"],
      process.cwd(),
      JSON.stringify({ outcomes }),
    ),
  ) as unknown;
  if (!isRecord(parsed) || typeof parsed.status !== "string") {
    throw new Error("Rust team dispatch status returned invalid payload");
  }
  return parsed.status as TeamRunStatus;
}

function resolveChildEnv(input: {
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly bindingEnv: Readonly<Record<string, string>>;
  readonly extraEnv?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "team", "child-env"],
      process.cwd(),
      JSON.stringify(input),
    ),
  ) as unknown;
  if (!isRecord(parsed) || !isStringRecord(parsed.env)) {
    throw new Error("Rust team child env returned invalid payload");
  }
  return parsed.env;
}

function resolveWorkerCloseOutcome(input: {
  readonly killedByTimeout: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}): Pick<WorkerOutcome, "status" | "exitCode" | "signal"> {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "team", "worker-close-outcome"],
      process.cwd(),
      JSON.stringify(input),
    ),
  ) as unknown;
  if (
    !isRecord(parsed)
    || !isWorkerOutcomeStatus(parsed.status)
    || typeof parsed.exitCode !== "number"
    || !Number.isSafeInteger(parsed.exitCode)
    || (parsed.signal !== null && typeof parsed.signal !== "string")
  ) {
    throw new Error("Rust team worker close outcome returned invalid payload");
  }
  return {
    status: parsed.status,
    exitCode: parsed.exitCode,
    signal: parsed.signal as NodeJS.Signals | null,
  };
}

function isWorkerOutcomeStatus(value: unknown): value is WorkerOutcome["status"] {
  return value === "completed" || value === "failed" || value === "killed";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value)
    && Object.values(value).every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createCappedBuffer(capBytes: number): {
  append(text: string): void;
  readonly value: string;
  readonly truncated: boolean;
} {
  let value = "";
  let truncated = false;
  return {
    append(text: string) {
      if (truncated) return;
      const next = value + text;
      if (next.length > capBytes) {
        value = next.slice(0, capBytes);
        truncated = true;
      } else {
        value = next;
      }
    },
    get value() {
      return value;
    },
    get truncated() {
      return truncated;
    },
  };
}

function ensureDataRoot(dataRoot: string): void {
  const teamRunsRoot = join(dataRoot, "team-runs");
  if (!existsSync(teamRunsRoot)) {
    mkdirSync(teamRunsRoot, { recursive: true });
  }
}

export function listTeamRuns(dataRoot: string): ReadonlyArray<{
  readonly runId: string;
  readonly runRoot: string;
}> {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "team", "list-runs"],
      process.cwd(),
      JSON.stringify({ dataRoot }),
    ),
  ) as unknown;
  if (
    !isRecord(parsed)
    || !Array.isArray(parsed.runs)
    || !parsed.runs.every((run) =>
      isRecord(run) && typeof run.runId === "string" && typeof run.runRoot === "string"
    )
  ) {
    throw new Error("Rust team run list returned invalid payload");
  }
  return parsed.runs;
}

export function generateRunIdForCli(): string {
  return generateRunId();
}
