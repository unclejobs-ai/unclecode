/**
 * `unclecode team` subcommand surface — record/list/inspect/abort runs and
 * dispatch worker child processes via TeamRunner.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  generateRunIdForCli,
  listTeamRuns,
  parseLanesSpec,
  runRustCommandSync,
  runLaneDoctor,
  startTeamRun,
  type ParsedLaneSpec,
} from "@unclecode/orchestrator";
import type { PersonaId, TeamGateLevel, TeamIsolationMode, TeamRuntimeMode } from "@unclecode/contracts";
import {
  appendTeamCheckpoint,
  getRunStatusFromCheckpoints,
  readTeamCheckpoints,
  readTeamRunManifest,
  verifyTeamRunChain,
} from "@unclecode/session-store";

type RunOptions = {
  readonly persona?: string;
  readonly lanes?: string;
  readonly gate?: string;
  readonly runtime?: string;
  readonly isolation?: string;
  readonly record?: string;
  readonly dispatch?: boolean;
  readonly workerTimeout?: string;
  readonly quiet?: boolean;
};

type TeamRunRustConfig = {
  readonly persona: PersonaId;
  readonly gate: TeamGateLevel;
  readonly runtime: TeamRuntimeMode;
  readonly isolation: TeamIsolationMode;
  readonly workerTimeoutMs: number;
  readonly dataRoot: string;
  readonly createdBy: string;
  readonly cliEntry: string | null;
};

export async function handleTeamRun(objective: string[], options: RunOptions): Promise<void> {
  if (objective.length === 0) {
    throw new Error("`unclecode team run` requires an objective string.");
  }
  const runConfig = resolveTeamRunRustConfig(options);
  const { persona, gate, runtime, isolation } = runConfig;
  const laneSpecs = parseLanesSpec(options.lanes ?? "1");
  const dataRoot = runConfig.dataRoot;
  const runId = options.record?.trim() || generateRunIdForCli();

  const handle = startTeamRun({
    dataRoot,
    runId,
    objective: objective.join(" "),
    persona,
    lanes: laneSpecs.length,
    gate,
    runtime,
    isolation,
    workspaceRoot: process.cwd(),
    createdBy: runConfig.createdBy,
  });
  handle.start();

  if (options.quiet) {
    process.stdout.write(`${handle.runId}\n`);
  } else {
    process.stdout.write(`RUN_ID=${handle.runId}\n`);
    process.stdout.write(`RUN_ROOT=${handle.runRoot}\n`);
    process.stdout.write(
      `persona=${persona} lanes=${formatLanesSummary(laneSpecs)} gate=${gate} runtime=${runtime} isolation=${isolation}\n`,
    );
  }

  if (!options.dispatch) {
    handle.release();
    return;
  }

  try {
    const cliEntry = resolveCliEntry(runConfig);
    const task = objective.join(" ");
    const workers = laneSpecs.map((lane, idx) => ({
      workerId: `w${idx + 1}`,
      persona,
      task,
      runtime: lane.runtime,
      ...(lane.model !== undefined ? { model: lane.model } : {}),
      ...(lane.extras !== undefined ? { extras: lane.extras } : {}),
    }));
    const timeoutMs = runConfig.workerTimeoutMs;

    if (!options.quiet) {
      process.stdout.write(`Dispatching ${workers.length} worker(s)…\n`);
    }
    const result = await handle.dispatch({
      workerCommand: { command: process.execPath, args: [cliEntry, "team", "worker"] },
      workers,
      perWorkerTimeoutMs: timeoutMs,
      ...(options.quiet
        ? {}
        : {
            onStdout: (id: string, line: string) =>
              void process.stdout.write(`[${id}] ${line}\n`),
            onStderr: (id: string, line: string) =>
              void process.stderr.write(`[${id}!] ${line}\n`),
          }),
    });

    if (!options.quiet) {
      process.stdout.write(`Final status: ${result.status}\n`);
      for (const outcome of result.outcomes) {
        process.stdout.write(
          `  ${outcome.workerId} ${outcome.persona.padEnd(22)} ${outcome.status.padEnd(9)} exit=${outcome.exitCode} ${outcome.durationMs}ms isolation=${outcome.isolation}\n`,
        );
        if (outcome.changePatchPath !== undefined) {
          process.stdout.write(`    patch=${outcome.changePatchPath}\n`);
        }
      }
      if (result.sweep.swept > 0) {
        process.stdout.write(`Stale lock sweep: removed=${result.sweep.swept} live=${result.sweep.live}\n`);
      }
    }

    if (result.status !== "accepted") {
      process.exitCode = 1;
    }
  } finally {
    handle.release();
  }
}

function resolveCliEntry(config: TeamRunRustConfig): string {
  if (!config.cliEntry) {
    throw new Error("team run --dispatch: cannot resolve CLI entrypoint from process.argv[1].");
  }
  return config.cliEntry;
}

export function handleTeamStatus(runId?: string): void {
  const dataRoot = resolveDataRoot();
  const runs = listTeamRuns(dataRoot);
  if (runs.length === 0) {
    process.stdout.write("No team runs recorded.\n");
    return;
  }
  const target = runId
    ? runs.find((entry) => entry.runId === runId)
    : runs.at(-1);
  if (!target) {
    process.stderr.write(`Run not found: ${runId}\n`);
    process.exitCode = 1;
    return;
  }
  printRunSummary(target.runRoot);
}

export function handleTeamList(): void {
  const dataRoot = resolveDataRoot();
  const runs = listTeamRuns(dataRoot);
  if (runs.length === 0) {
    process.stdout.write("No team runs recorded.\n");
    return;
  }
  for (const entry of runs) {
    const checkpoints = readTeamCheckpoints(entry.runRoot);
    const status = getRunStatusFromCheckpoints(checkpoints) ?? "(no checkpoints)";
    const manifest = readTeamRunManifest(entry.runRoot);
    process.stdout.write(
      `${entry.runId}  ${manifest.persona.padEnd(22)} ${status.padEnd(11)} ${manifest.objective}\n`,
    );
  }
}

export function handleTeamInspect(runId: string, options: { readonly verify?: boolean }): void {
  const dataRoot = resolveDataRoot();
  const runs = listTeamRuns(dataRoot);
  const target = runs.find((entry) => entry.runId === runId);
  if (!target) {
    process.stderr.write(`Run not found: ${runId}\n`);
    process.exitCode = 1;
    return;
  }
  printRunSummary(target.runRoot);
  if (options.verify) {
    const verification = verifyTeamRunChain(target.runRoot);
    if (verification.ok) {
      process.stdout.write(`Chain: VERIFIED (${verification.verifiedLines} entries)\n`);
    } else {
      process.stdout.write(
        `Chain: BROKEN at line ${verification.brokenAt} (expected ${verification.expectedHash}, actual ${verification.actualHash})\n`,
      );
      process.exitCode = 1;
    }
  }
}

export function handleTeamDoctor(): void {
  const report = runLaneDoctor();
  for (const lane of report.lanes) {
    const tag = lane.status === "ok" ? "OK   " : "MISS ";
    const detail = lane.reason ? `  — ${lane.reason}` : "";
    process.stdout.write(`${tag} ${lane.runtime.padEnd(10)}${detail}\n`);
  }
  process.stdout.write(`\nReady: ${report.summary.ok}/${report.lanes.length}  Missing: ${report.summary.missing}\n`);
  if (report.summary.ok === 0) process.exitCode = 1;
}

export function handleTeamAbort(runId: string): void {
  const dataRoot = resolveDataRoot();
  const runs = listTeamRuns(dataRoot);
  const target = runs.find((entry) => entry.runId === runId);
  if (!target) {
    process.stderr.write(`Run not found: ${runId}\n`);
    process.exitCode = 1;
    return;
  }
  const manifest = readTeamRunManifest(target.runRoot);
  const lockPath = join(target.runRoot, ".lock");
  if (existsSync(lockPath)) {
    process.stderr.write(
      `Run is still locked by ${readFileSync(lockPath, "utf8").trim()}; manual SIGTERM may be required.\n`,
    );
  }
  appendTeamCheckpoint(target.runRoot, {
    type: "team_run",
    runId: manifest.runId,
    persona: manifest.persona,
    status: "aborted",
    objective: manifest.objective,
    lanes: manifest.lanes,
    timestamp: new Date().toISOString(),
  });
  process.stdout.write(`Aborted ${runId}\n`);
}

function printRunSummary(runRoot: string): void {
  const manifest = readTeamRunManifest(runRoot);
  const checkpoints = readTeamCheckpoints(runRoot);
  const status = getRunStatusFromCheckpoints(checkpoints) ?? "(no checkpoints)";
  process.stdout.write(`RUN_ID:    ${manifest.runId}\n`);
  process.stdout.write(`RUN_ROOT:  ${runRoot}\n`);
  process.stdout.write(`Persona:   ${manifest.persona}\n`);
  process.stdout.write(`Lanes:     ${manifest.lanes}\n`);
  process.stdout.write(`Gate:      ${manifest.gate}\n`);
  process.stdout.write(`Runtime:   ${manifest.runtime}\n`);
  process.stdout.write(`Isolation: ${manifest.isolation ?? "shared"}\n`);
  process.stdout.write(`Status:    ${status}\n`);
  process.stdout.write(`Steps:     ${checkpoints.filter((cp) => cp.type === "team_step").length}\n`);
  process.stdout.write(`Objective: ${manifest.objective}\n`);
}

function formatLanesSummary(specs: readonly ParsedLaneSpec[]): string {
  const counts = new Map<string, number>();
  for (const s of specs) counts.set(s.runtime, (counts.get(s.runtime) ?? 0) + 1);
  const parts = [...counts.entries()].map(([k, v]) => (v > 1 ? `${k}x${v}` : k));
  return `${specs.length} [${parts.join(",")}]`;
}

function resolveDataRoot(): string {
  return resolveTeamRunRustConfig({}).dataRoot;
}

function resolveTeamRunRustConfig(options: RunOptions): TeamRunRustConfig {
  const parsed = JSON.parse(
    runRustCommandSync(
      ["rust", "team", "run-config"],
      process.cwd(),
      JSON.stringify({
        cwd: process.cwd(),
        argv1: process.argv[1],
        env: process.env,
        options,
      }),
    ),
  ) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("Rust team run config returned invalid payload");
  }
  const workerTimeoutMs = parsed.workerTimeoutMs;
  if (
    typeof parsed.persona !== "string"
    || typeof parsed.gate !== "string"
    || typeof parsed.runtime !== "string"
    || typeof parsed.isolation !== "string"
    || typeof parsed.dataRoot !== "string"
    || typeof parsed.createdBy !== "string"
    || (parsed.cliEntry !== null && typeof parsed.cliEntry !== "string")
    || typeof workerTimeoutMs !== "number"
    || !Number.isSafeInteger(workerTimeoutMs)
    || workerTimeoutMs < 0
  ) {
    throw new Error("Rust team run config returned invalid fields");
  }
  return {
    persona: parsed.persona as PersonaId,
    gate: parsed.gate as TeamGateLevel,
    runtime: parsed.runtime as TeamRuntimeMode,
    isolation: parsed.isolation as TeamIsolationMode,
    workerTimeoutMs,
    dataRoot: parsed.dataRoot,
    createdBy: parsed.createdBy,
    cliEntry: parsed.cliEntry,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
