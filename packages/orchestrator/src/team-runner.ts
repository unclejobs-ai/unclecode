/**
 * TeamRunner — coordinator that creates a team run, sweeps stale locks,
 * spawns worker child processes that re-bind via UNCLECODE_TEAM_RUN_* env,
 * and emits started/running/accepted/errored/killed checkpoints based on
 * worker exit codes. Workers publish their own team_step entries; the
 * coordinator does not interpret worker stdout.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type {
  PersonaId,
  TeamGateLevel,
  TeamRunManifest,
  TeamRunStatus,
  TeamRuntimeMode,
} from "@unclecode/contracts";
import {
  createTeamRun,
  generateRunId,
  getTeamRunRoot,
  getTeamRunsRoot,
  lockTeamRun,
} from "@unclecode/session-store";

import { TeamBinding } from "./team-binding.js";
import { sweepStaleLocks } from "./disk-ownership-registry.js";

export type TeamRunnerOptions = {
  readonly dataRoot: string;
  readonly objective: string;
  readonly persona: PersonaId;
  readonly lanes?: number;
  readonly gate?: TeamGateLevel;
  readonly runtime?: TeamRuntimeMode;
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

export type WorkerSpec = {
  readonly workerId: string;
  readonly persona: PersonaId;
  readonly task: string;
};

export type WorkerCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};

export type DispatchOptions = {
  readonly workerCommand: WorkerCommand;
  readonly workers: ReadonlyArray<WorkerSpec>;
  readonly extraEnv?: Readonly<Record<string, string>>;
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
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
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

  const childEnv: Record<string, string> = {
    ...filterEnv(process.env),
    ...input.binding.envForChild(),
    ...(input.dispatch.extraEnv ?? {}),
  };

  const outcomes = await Promise.all(
    input.dispatch.workers.map((spec) =>
      runWorker({
        spec,
        command: input.dispatch.workerCommand,
        env: childEnv,
        cwd: input.dispatch.cwd ?? process.cwd(),
        ...(input.dispatch.onStdout !== undefined ? { onStdout: input.dispatch.onStdout } : {}),
        ...(input.dispatch.onStderr !== undefined ? { onStderr: input.dispatch.onStderr } : {}),
        ...(input.dispatch.perWorkerTimeoutMs !== undefined
          ? { timeoutMs: input.dispatch.perWorkerTimeoutMs }
          : {}),
      }),
    ),
  );

  const allCompleted = outcomes.every((o) => o.status === "completed");
  const anyKilled = outcomes.some((o) => o.status === "killed");
  const finalStatus: TeamRunStatus = allCompleted
    ? "accepted"
    : anyKilled
      ? "killed"
      : "errored";

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

// Workers inherit the full coordinator env minus undefined values. Callers
// that need to scrub credentials must pass `extraEnv` overrides; this helper
// does not denylist by name to avoid silently dropping legitimate per-host
// vars (HOME, PATH, *_TOKEN used by the agent itself).
function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") filtered[key] = value;
  }
  return filtered;
}

function runWorker(input: {
  readonly spec: WorkerSpec;
  readonly command: WorkerCommand;
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly onStdout?: (workerId: string, line: string) => void;
  readonly onStderr?: (workerId: string, line: string) => void;
  readonly timeoutMs?: number;
}): Promise<WorkerOutcome> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const args = [
      ...input.command.args,
      "--worker-id",
      input.spec.workerId,
      "--persona",
      input.spec.persona,
      "--task",
      input.spec.task,
    ];
    const child = spawn(input.command.command, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
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
        child.kill("SIGKILL");
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
      const exitCode = typeof code === "number" ? code : -1;
      const status: WorkerOutcome["status"] = killedByTimeout
        ? "killed"
        : exitCode === 0
          ? "completed"
          : "failed";
      finish(status, exitCode, signal ?? null);
    });
  });
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
  const teamRunsRoot = getTeamRunsRoot(dataRoot);
  if (!existsSync(teamRunsRoot)) {
    return [];
  }
  return readdirSync(teamRunsRoot)
    .filter((name) => name.startsWith("tr_"))
    .filter((name) => {
      try {
        return statSync(join(teamRunsRoot, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((runId) => ({ runId, runRoot: getTeamRunRoot(dataRoot, runId) }));
}

export function generateRunIdForCli(): string {
  return generateRunId();
}
